# Family Wall Calendar for iPad

A week board for the wall: one row per person/Google Calendar, seven days across. Connect a Google account once, choose which calendars to show, and the board keeps itself in sync every 5 minutes.

**Architecture (Firebase):**

- `public/` – static page on **Firebase Hosting**.
- `functions/` – **a single Cloud Function** (`wallcalendar`, europe-west1). Hosting forwards `/api/**` and `/auth/**` to it. It handles Google sign-in and fetches events. It scales to zero, so there is no server to run.
- **Firestore** (dedicated database `wall-calendar`) stores the Google refresh token and the row configuration (`wallcal/auth`, `wallcal/config`). The security rules block all browser access; only the function reads and writes.

**Home network only:** The function rejects every request (including sign-in) that doesn't come from an address in `ALLOWED_IPS` in `functions/.env`. The static page itself is public but contains no calendar data; away from home it just shows "Tavlen kan kun bruges fra hjemmenetværket". If your provider changes your IP or enables IPv6, update `ALLOWED_IPS` and redeploy the function.

**Privacy:** The first Google account to connect owns the board. Every device that signs in with that account gets a secret device key (`?k=…` in the URL). Without the key, the page only shows a sign-in screen. Other Google accounts cannot take over the board.

## 1. Firebase project

```sh
npm install -g firebase-tools
firebase login
firebase use --add            # select/create the project
```

In the [Firebase console](https://console.firebase.google.com/): upgrade to the **Blaze** plan (required for Cloud Functions; usage here stays well within the free tier), and create a **Firestore** database (e.g. `eur3`).

## 2. Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/), for **the same project**:

1. **APIs & Services → Library** → enable the **Google Calendar API**.
2. **OAuth consent screen** (Google Auth Platform): choose *External*, fill in an app name, and add your Google account as a *Test user*. Then set the app to **In production**, otherwise access expires after 7 days. Because the app only requests read access to your own calendars, you can click past the "Google hasn't verified this app" warning.
3. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   Authorized redirect URI: `https://<project>.web.app/auth/callback`
4. Copy the Client ID and Client secret.

## 3. Configure and deploy

```sh
cp functions/.env.example functions/.env    # fill in GOOGLE_CLIENT_ID and BASE_URL
firebase functions:secrets:set GOOGLE_CLIENT_SECRET
cd functions && npm install && cd ..
firebase deploy
```

## 4. Connect and set up the iPad

1. Open `https://<project>.web.app` in **Safari on the iPad** → *Forbind Google-konto* (Connect Google account).
2. The board automatically creates rows for the calendars you have switched on in Google Calendar. Tap the gear in the bottom-right corner to rename rows, change colors, pick a different calendar, hide rows, or drag them into a new order.
3. Share → **Add to Home Screen** while the URL contains `?k=…`. The board then runs full screen and remembers the device. Sign in in Safari first; otherwise the Google sign-in can end up outside the home-screen app.
4. Settings → Display & Brightness → **Auto-Lock: Never**, and optionally use *Guided Access* to lock the iPad to the board.

More devices: open the URL and sign in with the same Google account.

The board fetches new events every 5 minutes and whenever the app comes to the foreground. It rolls over to the new day at midnight and returns to the current week 2 minutes after you browse away. Swipe horizontally to change week, and tap the week number to jump to today.

*Afbryd forbindelse* (Disconnect, under the gear) revokes access at Google and resets the board, so a different account can connect.

## Local development

```sh
firebase emulators:start --only hosting,functions,firestore
```

Add `http://localhost:5000/auth/callback` as an extra redirect URI, and set `BASE_URL=http://localhost:5000` in `functions/.env.local`.
