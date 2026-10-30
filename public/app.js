'use strict';

const SYNC_INTERVAL = 5 * 60_000;     // fetch from Google every 5 minutes
const RETURN_TO_TODAY = 2 * 60_000;   // jump back to this week after 2 minutes on another week
const DAY_NAMES = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
const PALETTE = ['#3A3A44', '#1F5BC4', '#A82A66', '#8A4F00', '#23703A', '#5B3FA8', '#0E6E7A', '#B23A1E'];

const $ = (sel) => document.querySelector(sel);

const state = {
  weekStart: startOfWeek(new Date()),
  rows: [],
  calendars: [],
  draft: null,
  display: { showNames: true, showImages: true, imageFill: false },
  draftDisplay: null,
  email: '',
  syncedAt: null,
};

let syncSeq = 0;

const MAX_TITLE = 30;
// Events the viewer tapped open; survives re-renders from background syncs
const expanded = new Set();

// The device key proves this device signed in as the board's owner. It arrives as ?k= after
// Google sign-in and stays in the URL so "Add to Home Screen" keeps it.
const deviceKey = (() => {
  const fromUrl = new URLSearchParams(location.search).get('k');
  try {
    if (fromUrl) localStorage.setItem('deviceKey', fromUrl);
    return fromUrl || localStorage.getItem('deviceKey') || '';
  } catch {
    return fromUrl || '';
  }
})();

let awayTimer = null;

// ---------- Dates ----------

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86_400_000 + 1) / 7);
}

// "2026-10-29" -> local midnight (all-day events have no timezone)
function parseDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

// Danish wall-calendar style: 8, 15.10, 8–16
function clock(d) {
  const m = d.getMinutes();
  return m ? `${d.getHours()}.${String(m).padStart(2, '0')}` : String(d.getHours());
}

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceKey}`, ...(options.headers || {}) },
  });
  if (res.status === 403) {
    showBlocked();
    throw new Error('forbidden_ip');
  }
  if (res.status === 401) {
    showConnect(await api('/api/status').catch(() => null));
    throw new Error('not_connected');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---------- Event layout ----------

function eventsForDay(events, day) {
  const dayStart = day;
  const dayEnd = addDays(day, 1);
  return events
    .map((e) => ({ ...e, s: parseDate(e.start), e: parseDate(e.end) }))
    .filter((e) => e.s < dayEnd && e.e > dayStart)
    .sort((a, b) => (b.allDay - a.allDay) || (a.s - b.s))
    .map((e) => {
      let time = '';
      if (!e.allDay && e.s >= dayStart) {
        const minutes = (e.e - e.s) / 60_000;
        // Long blocks (work, school) read better as a range; short appointments as a start time
        time = minutes >= 120 && e.e <= dayEnd ? `${clock(e.s)}–${clock(e.e)}` : clock(e.s);
      }
      return {
        id: e.id,
        title: e.title,
        time,
        sub: subline(e),
      };
    });
}

function subline(e) {
  if (e.location) return e.location.split(',')[0].trim();
  if (!e.description) return '';
  const text = new DOMParser().parseFromString(e.description, 'text/html').body.textContent || '';
  const first = text.split('\n').map((s) => s.trim()).find(Boolean) || '';
  return first.length > 80 ? `${first.slice(0, 78)}…` : first;
}

function paintAvatar(el, row, showImage) {
  el.style.background = row.color;
  el.textContent = '';
  const useImage = showImage && !!row.image;
  el.classList.toggle('has-image', useImage);
  if (useImage) {
    const img = document.createElement('img');
    img.src = row.image;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = initials(row.name);
  }
}

// Center-crop and downscale a photo to a small square JPEG so it fits in the row config
function resizeImage(file, size = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, size, size,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Billedet kunne ikke læses')); };
    img.src = url;
  });
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

// ---------- Render board ----------

function renderHead() {
  const head = $('#head');
  head.querySelectorAll('.day-head').forEach((n) => n.remove());
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    const cell = document.createElement('div');
    cell.className = `day-head${dayClass(d, i, today)}`;
    cell.innerHTML = '<span class="day-num"></span><span class="day-name"></span>';
    cell.querySelector('.day-num').textContent = d.getDate();
    cell.querySelector('.day-name').textContent = DAY_NAMES[i];
    head.appendChild(cell);
  }
  $('#week-num').textContent = isoWeek(state.weekStart);
  $('#today').classList.toggle('away', !sameDay(state.weekStart, startOfWeek(today)));
}

function dayClass(d, i, today) {
  if (sameDay(d, today)) return ' is-today';
  return i >= 5 ? ' is-weekend' : '';
}

function renderRows() {
  const container = $('#rows');
  container.textContent = '';
  const today = new Date();

  if (!state.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-board';
    empty.textContent = 'Ingen rækker endnu. Tryk på tandhjulet for at vælge kalendere.';
    container.appendChild(empty);
    container.style.gridTemplateRows = '1fr';
    return;
  }

  const weights = [];
  for (const row of state.rows) {
    const el = document.createElement('section');
    el.className = 'row';
    el.setAttribute('aria-label', row.name);

    const label = document.createElement('div');
    label.className = 'row-label';
    label.innerHTML = '<span class="avatar"></span><span class="row-name"></span>';
    paintAvatar(label.querySelector('.avatar'), row, state.display.showImages);
    label.querySelector('.row-name').textContent = row.name;
    label.querySelector('.row-name').hidden = !state.display.showNames;
    if (state.display.showImages && state.display.imageFill && row.image) {
      // The photo covers the whole label cell; the name sits on top of it
      label.classList.add('photo-fill');
      label.querySelector('.avatar').hidden = true;
      const photo = document.createElement('img');
      photo.className = 'row-photo';
      photo.src = row.image;
      photo.alt = '';
      label.prepend(photo);
    }
    el.appendChild(label);

    let maxLines = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(state.weekStart, i);
      const cell = document.createElement('div');
      cell.className = `cell${dayClass(day, i, today)}`;
      const events = eventsForDay(row.events || [], day);
      let lines = 0;
      for (const ev of events) {
        cell.appendChild(renderEvent(ev, row.color, `${row.id}|${ev.id}|${day.toDateString()}`));
        lines += ev.sub ? 1.9 : 1.2;
      }
      maxLines = Math.max(maxLines, lines);
      el.appendChild(cell);
    }
    // Rows with more content get more height; quiet rows (like a shared family calendar) stay compact
    weights.push(Math.min(Math.max(maxLines, 1.6), 5));
    container.appendChild(el);
  }
  container.style.gridTemplateRows = weights.map((w) => `minmax(0, ${w.toFixed(2)}fr)`).join(' ');
  requestAnimationFrame(markOverflow);
}

function renderEvent(ev, color, key) {
  const long = ev.title.length > MAX_TITLE;
  // Long titles are cut to 30 characters; tapping the event shows the full text
  const wrap = document.createElement(long ? 'button' : 'div');
  wrap.className = long ? 'event event-toggle' : 'event';
  const p = document.createElement('p');
  p.style.color = color;
  if (ev.time) {
    const t = document.createElement('span');
    t.className = 'event-time';
    t.textContent = ev.time;
    p.append(t, ' ');
  }
  const title = document.createElement('span');
  title.className = 'event-title';
  p.appendChild(title);
  wrap.appendChild(p);
  if (ev.sub) {
    const sub = document.createElement('span');
    sub.className = 'event-sub';
    sub.textContent = ev.sub;
    wrap.appendChild(sub);
  }
  const paint = () => {
    const open = expanded.has(key);
    title.textContent = long && !open ? `${ev.title.slice(0, MAX_TITLE).trimEnd()}…` : ev.title;
    wrap.classList.toggle('expanded', open);
    if (long) wrap.setAttribute('aria-expanded', String(open));
  };
  if (long) {
    wrap.type = 'button';
    wrap.addEventListener('click', () => {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      paint();
      markOverflow();
    });
  }
  paint();
  return wrap;
}

// Cells that can't fit all events get a "+N" badge
function markOverflow() {
  for (const cell of document.querySelectorAll('.cell')) {
    cell.querySelector('.more')?.remove();
    if (cell.scrollHeight <= cell.clientHeight + 1) continue;
    const bottom = cell.getBoundingClientRect().bottom - 24;
    const hidden = [...cell.querySelectorAll('.event')].filter((e) => e.getBoundingClientRect().bottom > bottom).length;
    if (!hidden) continue;
    const badge = document.createElement('span');
    badge.className = 'more';
    badge.textContent = `+${hidden}`;
    cell.appendChild(badge);
  }
}

function render() {
  renderHead();
  renderRows();
  renderSyncState();
}

function renderSyncState(error) {
  const el = $('#sync-state');
  el.classList.toggle('error', !!error);
  el.classList.remove('syncing');
  if (error) {
    $('#sync-text').textContent = 'Kunne ikke synkronisere – prøver igen';
  } else if (state.syncedAt) {
    $('#sync-text').textContent = `Opdateret ${state.syncedAt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}`;
  }
}

// ---------- Sync ----------

// Tapping the "Opdateret" label fetches from Google right away
async function syncNow() {
  const el = $('#sync-state');
  el.classList.add('syncing');
  el.classList.remove('error');
  $('#sync-text').textContent = 'Synkroniserer…';
  await sync();
  // sync() re-renders the label itself unless the request was superseded or failed early
  if (el.classList.contains('syncing')) renderSyncState();
}

async function sync() {
  // Only the latest request may update the board (e.g. after quickly paging through weeks)
  const seq = ++syncSeq;
  try {
    const timeMin = state.weekStart.toISOString();
    const timeMax = addDays(state.weekStart, 7).toISOString();
    const data = await api(`/api/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`);
    if (seq !== syncSeq) return;
    state.rows = data.rows;
    if (data.display) state.display = data.display;
    state.syncedAt = new Date();
    render();
  } catch (err) {
    if (seq === syncSeq && err.message !== 'not_connected') renderSyncState(true);
  }
}

function goToWeek(offset) {
  state.weekStart = offset === 0 ? startOfWeek(new Date()) : addDays(state.weekStart, offset * 7);
  state.rows = state.rows.map((r) => ({ ...r, events: [] }));
  render();
  sync();
  clearTimeout(awayTimer);
  if (!sameDay(state.weekStart, startOfWeek(new Date()))) {
    awayTimer = setTimeout(() => goToWeek(0), RETURN_TO_TODAY);
  }
}

// ---------- Settings ----------

async function openSettings() {
  $('#settings').hidden = false;
  const [config, cals] = await Promise.all([api('/api/config'), api('/api/calendars')]);
  state.calendars = cals.calendars;
  state.draft = config.rows.map((r) => ({ ...r }));
  state.draftDisplay = { ...state.display, ...config.display };
  renderSettings();
}

function closeSettings() {
  $('#settings').hidden = true;
  state.draft = null;
  state.draftDisplay = null;
}

async function saveSettings() {
  const list = $('#row-list');
  const order = [...list.children].map((li) => li.dataset.id);
  const rows = order.map((id) => state.draft.find((r) => r.id === id));
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ rows, display: state.draftDisplay }) });
  state.display = state.draftDisplay;
  closeSettings();
  await sync();
}

function renderSettings() {
  $('#account-email').textContent = state.email || 'Google-konto';
  $('#show-names').setAttribute('aria-checked', String(state.draftDisplay.showNames));
  $('#show-images').setAttribute('aria-checked', String(state.draftDisplay.showImages));
  $('#image-fill').setAttribute('aria-checked', String(state.draftDisplay.imageFill));
  const list = $('#row-list');
  list.textContent = '';
  const tpl = $('#row-item');

  for (const row of state.draft) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = row.id;

    const avatar = li.querySelector('.avatar');
    const dot = li.querySelector('.dot');
    const clearImage = li.querySelector('.image-clear');
    const paint = () => {
      paintAvatar(avatar, row, true);
      swatch.style.background = row.color;
      clearImage.hidden = !row.image;
      dot.style.background = row.color;
      li.classList.toggle('hidden-row', !row.visible);
    };

    const imageInput = li.querySelector('.image-input');
    imageInput.addEventListener('change', async () => {
      const file = imageInput.files[0];
      imageInput.value = '';
      if (!file) return;
      try { row.image = await resizeImage(file); paint(); }
      catch (e) { alert(e.message); }
    });
    clearImage.addEventListener('click', () => { row.image = ''; paint(); });

    const swatch = li.querySelector('.color-swatch');
    const color = li.querySelector('.color-input');
    color.value = row.color;
    color.addEventListener('input', () => { row.color = color.value.toUpperCase(); paint(); });

    const name = li.querySelector('.name-input');
    name.value = row.name;
    name.addEventListener('input', () => { row.name = name.value; paint(); });

    const select = li.querySelector('.calendar-select');
    select.add(new Option('Vælg kalender…', ''));
    for (const c of state.calendars) select.add(new Option(c.name, c.id));
    if (row.calendarId && !state.calendars.some((c) => c.id === row.calendarId)) {
      select.add(new Option('(ikke tilgængelig)', row.calendarId));
    }
    select.value = row.calendarId || '';
    select.addEventListener('change', () => {
      const wasDefaultName = !row.name || row.name === 'Ny række' || state.calendars.some((c) => c.id === row.calendarId && c.name === row.name);
      row.calendarId = select.value;
      const cal = state.calendars.find((c) => c.id === select.value);
      if (cal && wasDefaultName) { row.name = cal.name; name.value = cal.name; }
      paint();
    });

    const toggle = li.querySelector('.toggle');
    const setToggle = () => {
      toggle.setAttribute('aria-checked', String(row.visible));
      toggle.setAttribute('aria-label', `Vis ${row.name || 'række'} på tavlen`);
    };
    toggle.addEventListener('click', () => { row.visible = !row.visible; setToggle(); paint(); });
    setToggle();

    li.querySelector('.remove').addEventListener('click', () => {
      state.draft = state.draft.filter((r) => r !== row);
      li.remove();
    });

    li.querySelector('.handle').addEventListener('pointerdown', (e) => startDrag(e, li));
    paint();
    list.appendChild(li);
  }
}

function addRow() {
  const used = new Set(state.draft.map((r) => r.calendarId));
  const cal = state.calendars.find((c) => !used.has(c.id));
  state.draft.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: cal ? cal.name : 'Ny række',
    color: PALETTE[state.draft.length % PALETTE.length],
    calendarId: cal ? cal.id : '',
    visible: true,
    image: '',
  });
  renderSettings();
  $('#row-list').lastElementChild?.querySelector('.name-input').focus();
}

// Touch-friendly reordering: drag the handle, siblings swap as you pass their midpoint
function startDrag(e, li) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  const list = li.parentElement;

  const move = (ev) => {
    const siblings = [...list.children].filter((n) => n !== li);
    const after = siblings.find((n) => {
      const r = n.getBoundingClientRect();
      return ev.clientY < r.top + r.height / 2;
    });
    if (after) { if (li.nextElementSibling !== after) list.insertBefore(li, after); }
    else if (list.lastElementChild !== li) list.appendChild(li);
  };
  const end = () => {
    li.classList.remove('dragging');
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    const order = [...list.children].map((n) => n.dataset.id);
    state.draft.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

async function logout() {
  if (!confirm('Afbryd forbindelsen til Google? Tavlen og rækkerne nulstilles.')) return;
  await api('/auth/logout', { method: 'POST' });
  try { localStorage.removeItem('deviceKey'); } catch {}
  closeSettings();
  location.replace('/');
}

// ---------- Screens ----------

function showConnect(status) {
  $('#board').hidden = true;
  $('#settings').hidden = true;
  $('#connect').hidden = false;
  if (status?.claimed && status.connected) {
    $('#connect-text').textContent = 'Denne tavle er privat. Log ind med den Google-konto, der ejer tavlen, for at vise den på denne enhed.';
    $('#connect-btn').lastChild.textContent = ' Log ind med Google';
  }
  const err = new URLSearchParams(location.search).get('error');
  const errEl = $('#connect-error');
  const messages = {
    denied: 'Adgang blev ikke givet. Prøv igen.',
    account: 'Tavlen er allerede forbundet til en anden Google-konto. Log ind med den konto.',
  };
  if (err) {
    errEl.hidden = false;
    errEl.textContent = messages[err] || 'Forbindelsen mislykkedes. Prøv igen.';
  }
}

function showBlocked() {
  $('#board').hidden = true;
  $('#settings').hidden = true;
  $('#connect').hidden = false;
  $('#connect-text').textContent = 'Tavlen kan kun bruges fra hjemmenetværket.';
  $('#connect-btn').hidden = true;
  $('#connect-error').hidden = true;
}

function showBoard() {
  $('#connect').hidden = true;
  $('#board').hidden = false;
  const url = `/?k=${encodeURIComponent(deviceKey)}`;
  if (location.pathname + location.search !== url) history.replaceState(null, '', url);
}

// ---------- Keep the wall display alive ----------

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}

function setupSwipe() {
  let x0 = null, y0 = null;
  const rows = $('#rows');
  rows.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  rows.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) goToWeek(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ---------- Boot ----------

async function init() {
  $('#prev').addEventListener('click', () => goToWeek(-1));
  $('#next').addEventListener('click', () => goToWeek(1));
  $('#today').addEventListener('click', () => goToWeek(0));
  $('#open-settings').addEventListener('click', () => openSettings().catch(() => {}));
  $('#cancel-settings').addEventListener('click', closeSettings);
  $('#save-settings').addEventListener('click', () => saveSettings().catch((e) => alert(e.message)));
  $('#add-row').addEventListener('click', addRow);
  for (const [id, key] of [['#show-names', 'showNames'], ['#show-images', 'showImages'], ['#image-fill', 'imageFill']]) {
    $(id).addEventListener('click', () => {
      state.draftDisplay[key] = !state.draftDisplay[key];
      $(id).setAttribute('aria-checked', String(state.draftDisplay[key]));
    });
  }
  $('#logout').addEventListener('click', logout);
  setupSwipe();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); sync(); }
  });
  document.addEventListener('click', keepAwake, { once: true });
  window.addEventListener('resize', () => requestAnimationFrame(markOverflow));
  $('#sync-state').addEventListener('click', syncNow);

  let status;
  try { status = await api('/api/status'); } catch { return; }
  if (!status.authorized) return showConnect(status);
  state.email = status.email;
  showBoard();
  render();
  await sync();
  keepAwake();

  setInterval(sync, SYNC_INTERVAL);
  // Roll over to the new day at midnight
  let lastDay = new Date().toDateString();
  setInterval(() => {
    const now = new Date();
    if (now.toDateString() !== lastDay) {
      lastDay = now.toDateString();
      goToWeek(0);
    }
  }, 60_000);
}

init();
