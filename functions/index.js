import crypto from 'node:crypto';
import net from 'node:net';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore('wall-calendar');
const authDoc = db.doc('wallcal/auth');     // { refreshToken, email, deviceKey }
const configDoc = db.doc('wallcal/config'); // { rows: [...] }

const CLIENT_ID = defineString('GOOGLE_CLIENT_ID');
const CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const BASE_URL = defineString('BASE_URL');
// Comma-separated IPs or CIDR ranges allowed to use the board, e.g. "203.0.113.10, 2001:db8::/64"
const ALLOWED_IPS = defineString('ALLOWED_IPS', { default: '' });

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'];
const PALETTE = ['#3A3A44', '#1F5BC4', '#A82A66', '#8A4F00', '#23703A', '#5B3FA8', '#0E6E7A', '#B23A1E'];

const DEFAULT_DISPLAY = { showNames: true, showImages: true, imageFill: false };
const IMAGE_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_LENGTH = 250_000; // ~190 KB; the browser downscales photos to 480x480 before saving

let accessToken = null; // per-instance cache: { token, expiresAt }
let allowList = null;   // net.BlockList built from ALLOWED_IPS

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const redirectUri = () => `${BASE_URL.value().replace(/\/$/, '')}/auth/callback`;

// ---------- OAuth state (stateless, HMAC-signed so any instance can verify it) ----------

function sign(value) {
  return crypto.createHmac('sha256', CLIENT_SECRET.value()).update(value).digest('base64url');
}

function makeState() {
  const payload = `${Date.now()}.${crypto.randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

function validState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  return expected.length === given.length
    && crypto.timingSafeEqual(expected, given)
    && Date.now() - Number(parts[0]) < 10 * 60_000;
}

// ---------- Home network only ----------

function getAllowList() {
  if (allowList) return allowList;
  allowList = new net.BlockList();
  for (const entry of ALLOWED_IPS.value().split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const type = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    if (prefix) allowList.addSubnet(address, Number(prefix), type);
    else allowList.addAddress(address, type);
  }
  return allowList;
}

// Firebase Hosting replaces any client-sent X-Forwarded-For with "<visitor>,<Google front end>",
// so the visitor is the next-to-last hop.
function clientIp(req) {
  const hops = String(req.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length >= 2 ? hops[hops.length - 2] : hops[0] || '';
}

function ipAllowed(ip) {
  if (!ALLOWED_IPS.value().trim()) return true;
  if (!net.isIP(ip)) return false;
  return getAllowList().check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

// ---------- Device key: the board is private to devices that signed in as the owner ----------

async function requireDevice(req) {
  const auth = (await authDoc.get()).data();
  if (!auth?.refreshToken) throw new HttpError(401, 'not_connected');
  const given = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(auth.deviceKey);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'unauthorized');
  }
  return auth;
}

// ---------- Google ----------

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID.value(), client_secret: CLIENT_SECRET.value(), ...params }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

async function getAccessToken(auth) {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.token;
  const { ok, body } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  if (!ok) {
    if (body.error === 'invalid_grant') {
      // Access was revoked or expired: forget the token so the board asks to reconnect
      await authDoc.update({ refreshToken: '' });
      accessToken = null;
      throw new HttpError(401, 'not_connected');
    }
    throw new HttpError(502, `Google token error: ${body.error || 'unknown'}`);
  }
  accessToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return accessToken.token;
}

async function google(auth, urlPath, query = {}) {
  const token = await getAccessToken(auth);
  const url = new URL(`https://www.googleapis.com/calendar/v3${urlPath}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) accessToken = null;
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Google API ${res.status}`);
  return res.json();
}

async function listCalendars(auth) {
  const items = [];
  let pageToken;
  do {
    const data = await google(auth, '/users/me/calendarList', pageToken ? { showHidden: 'true', pageToken } : { showHidden: 'true' });
    items.push(...data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items.map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    primary: !!c.primary,
    selected: !!c.selected,
  }));
}

async function listEvents(auth, calendarId, timeMin, timeMax) {
  const events = [];
  let pageToken;
  do {
    const data = await google(auth, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin, timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      ...(pageToken ? { pageToken } : {}),
    });
    events.push(...data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return events
    .filter((e) => e.status !== 'cancelled')
    .filter((e) => !e.attendees?.some((a) => a.self && a.responseStatus === 'declined'))
    .map((e) => ({
      id: e.id,
      title: e.summary || '(uden titel)',
      allDay: !!e.start.date,
      start: e.start.date || e.start.dateTime,
      end: e.end.date || e.end.dateTime,
      location: e.location || '',
      description: e.description || '',
    }));
}

async function getConfig(auth) {
  const config = (await configDoc.get()).data();
  if (config) return { ...config, display: { ...DEFAULT_DISPLAY, ...config.display } };
  // First visit: one row per calendar that's switched on in Google Calendar
  const calendars = await listCalendars(auth);
  const fresh = {
    rows: calendars.filter((c) => c.selected).slice(0, 6).map((c, i) => ({
      id: crypto.randomUUID(),
      name: c.primary ? 'Familien' : c.name,
      color: PALETTE[i % PALETTE.length],
      calendarId: c.id,
      visible: true,
      image: '',
    })),
    display: DEFAULT_DISPLAY,
  };
  await configDoc.set(fresh);
  return fresh;
}

function sanitizeConfig(input) {
  if (!input || !Array.isArray(input.rows)) throw new HttpError(400, 'rows mangler');
  const hex = /^#[0-9a-fA-F]{6}$/;
  return {
    rows: input.rows.slice(0, 20).map((r) => ({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : crypto.randomUUID(),
      name: String(r.name || '').trim().slice(0, 40) || 'Ny række',
      color: hex.test(r.color) ? r.color : PALETTE[0],
      calendarId: String(r.calendarId || '').slice(0, 300),
      visible: r.visible !== false,
      image: typeof r.image === 'string' && r.image.length <= MAX_IMAGE_LENGTH && IMAGE_PATTERN.test(r.image) ? r.image : '',
    })),
    display: {
      showNames: input.display?.showNames !== false,
      showImages: input.display?.showImages !== false,
      imageFill: input.display?.imageFill === true,
    },
  };
}

// ---------- Routes ----------

const routes = {
  'GET /auth/google': async (req, res) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: CLIENT_ID.value(),
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state: makeState(),
    });
    res.redirect(url.toString());
  },

  'GET /auth/callback': async (req, res) => {
    if (!validState(req.query.state)) return res.redirect('/?error=state');
    if (req.query.error) return res.redirect('/?error=denied');

    const { ok, body } = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(req.query.code || ''),
      redirect_uri: redirectUri(),
    });
    if (!ok || !body.refresh_token) return res.redirect('/?error=token');

    // id_token comes straight from Google's token endpoint over TLS, so its payload can be read as-is
    let email = '';
    try { email = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url')).email || ''; } catch {}

    const existing = (await authDoc.get()).data();
    // The first account to connect owns the board; other accounts can't take it over
    if (existing?.email && existing.email !== email) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(body.refresh_token)}`, { method: 'POST' }).catch(() => {});
      return res.redirect('/?error=account');
    }

    const deviceKey = existing?.deviceKey || crypto.randomBytes(24).toString('base64url');
    await authDoc.set({ refreshToken: body.refresh_token, email, deviceKey });
    accessToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    res.redirect(`/?k=${deviceKey}`);
  },

  'POST /auth/logout': async (req, res) => {
    const auth = await requireDevice(req);
    if (auth.refreshToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(auth.refreshToken)}`, { method: 'POST' }).catch(() => {});
    }
    await Promise.all([authDoc.delete(), configDoc.delete()]);
    accessToken = null;
    res.json({ ok: true });
  },

  'GET /api/status': async (req, res) => {
    const auth = (await authDoc.get()).data();
    let authorized = false;
    try { await requireDevice(req); authorized = true; } catch {}
    res.json({
      connected: !!auth?.refreshToken,
      claimed: !!auth?.email,
      authorized,
      email: authorized ? auth.email : '',
    });
  },

  'GET /api/calendars': async (req, res) => {
    res.json({ calendars: await listCalendars(await requireDevice(req)) });
  },

  'GET /api/config': async (req, res) => {
    res.json(await getConfig(await requireDevice(req)));
  },

  'PUT /api/config': async (req, res) => {
    await requireDevice(req);
    const config = sanitizeConfig(req.body);
    await configDoc.set(config);
    res.json(config);
  },

  'GET /api/events': async (req, res) => {
    const auth = await requireDevice(req);
    const { timeMin, timeMax } = req.query;
    if (!timeMin || !timeMax || isNaN(Date.parse(timeMin)) || isNaN(Date.parse(timeMax))) {
      throw new HttpError(400, 'timeMin og timeMax skal være ISO-datoer');
    }
    const config = await getConfig(auth);
    const rows = config.rows.filter((r) => r.visible && r.calendarId);
    const ids = [...new Set(rows.map((r) => r.calendarId))];
    const results = await Promise.all(ids.map(async (id) => {
      try { return [id, { events: await listEvents(auth, id, timeMin, timeMax) }]; }
      catch (err) {
        if (err.status === 401) throw err;
        return [id, { events: [], error: err.message }];
      }
    }));
    const byCalendar = Object.fromEntries(results);
    res.json({
      rows: rows.map((r) => ({ ...r, ...byCalendar[r.calendarId] })),
      display: config.display,
      syncedAt: new Date().toISOString(),
    });
  },
};

export const wallcalendar = onRequest(
  { region: 'europe-west1', secrets: [CLIENT_SECRET], maxInstances: 2, memory: '256MiB' },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const handler = routes[`${req.method} ${req.path}`];
    try {
      if (!ipAllowed(clientIp(req))) throw new HttpError(403, 'forbidden_ip');
      if (!handler) throw new HttpError(404, 'Not found');
      await handler(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message });
    }
  },
);
