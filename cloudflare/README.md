# Cloudflare Workers deployment (web/PWA only)

This is the Cloudflare-hosted version of the web app. It does not deploy or require `flutter_app/`. The existing Node.js VPS deployment can remain in use until this version has been tested.

The build copies only the public web files (`index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, and `assets/icon.svg`) into `cloudflare/public/`. The Worker handles login/session/subtitle endpoints, and a SQLite-backed Durable Object handles the private room's WebSocket, presence, playback state, signaling, and subtitle data. Movie files continue to stream directly from their existing links; they are not uploaded to Cloudflare.

## Requirements

- A Cloudflare account with Workers enabled. SQLite-backed Durable Objects are available on both Free and Paid plans; each plan has its own quotas.
- Node.js 20 or newer and npm.
- A Worker subdomain (`workers.dev`) for the first test. A custom domain can be connected after the test passes.

## Install and configure

From this directory:

```bash
cd cloudflare
npm install
```

Set the credentials as encrypted Worker secrets. Choose new, unique passwords (at least 12 characters) and a random session secret of at least 32 characters. Do not reuse credentials that were ever pasted into chat or committed to Git.

```bash
npx wrangler login
npx wrangler secret put TRIBORG_PASSWORD
npx wrangler secret put KIMIBLUE_PASSWORD
npx wrangler secret put KADAR_SESSION_SECRET
```

Wrangler prompts for each value. The session secret must remain unchanged between deployments or all existing sessions will be signed out. If using TURN, also set `TURN_URLS` and `TURN_SECRET` as Worker secrets; otherwise the app uses its current public STUN server.

For local development only, create `cloudflare/.dev.vars` with the same three required assignments. This file is gitignored and must never be committed:

```dotenv
TRIBORG_PASSWORD=replace-with-a-new-long-random-password
KIMIBLUE_PASSWORD=replace-with-a-different-long-random-password
KADAR_SESSION_SECRET=replace-with-a-random-secret-of-at-least-32-characters
```

## Preview and deploy

```bash
npm run dev
```

To run the offline Worker unit tests and build only the public web assets:

```bash
npm test
npm run build
```

Open the local URL printed by Wrangler and test both accounts in separate browser profiles/devices: login/logout, room connection, choosing/removing a film, playback/seek synchronization, subtitles, reconnecting, and voice signaling. A microphone requires HTTPS; a deployed `workers.dev` URL provides it.

When local tests pass:

```bash
npx wrangler whoami
npm run deploy
```

Wrangler prints the deployed URL. Test both accounts and two real phones before moving a custom domain. The Durable Object uses a single fixed private room name and stores room state in SQLite, so playback/subtitle state survives Worker restarts. Session cookies are `Secure`, `HttpOnly`, `SameSite=Strict`, and expire after 30 days.

## Custom domain and limits

To use your own domain, add it under the Worker **Settings → Domains & Routes → Add → Custom Domain** in the Cloudflare dashboard after the `workers.dev` version has passed testing. Cloudflare provisions HTTPS; do not put credentials into source files or frontend JavaScript.

The Free plan can be enough for this small private room, but its daily request, Durable Object, and per-request CPU quotas apply. The Workers Paid plan currently starts at $5/month and includes larger monthly allowances. Monitor actual usage and current quotas in the Cloudflare dashboard before production use. Check current quotas and billing in the Cloudflare dashboard before production use.

## Important

- This folder is an alternate backend for the existing web UI, not a replacement for `server.js`; the Node/VPS deployment remains available.
- Deploy only files generated in `cloudflare/public/`; never copy `.env`, `.dev.vars`, VPS configuration, or server secrets into static assets.
- Room playback state and SRT data are persisted in Durable Object SQLite. During continuous playback, position checkpoints are written periodically; no movie bytes are stored or proxied.
- The app has fixed accounts only. Rotate any credentials previously exposed in chat before deploying.
