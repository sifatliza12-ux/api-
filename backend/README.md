# ForgeFlow Backend

Express + SQLite (better-sqlite3) API for the ForgeFlow Chrome extension: auth, recorded-workflow storage, the API marketplace, the manual-approval purchase/wallet flow, notifications, and the Playwright-based workflow replay engine ("Run API").

## Architecture

- **Data**: a single SQLite file, opened and migrated on boot by `db/index.js`. Every store (users, workflows, My APIs, marketplace listings, purchases, purchase requests, wallet transactions, notifications, replay runs) is SQLite-backed — there is no in-memory/sample data left in the request path except the still-unfinished `GET /apis` route in `controllers/apiController.js`, which nothing in the extension currently calls.
- **Auth**: JWT, signed/verified with `JWT_SECRET`. The server refuses to start if it's unset.
- **Replay engine**: `services/replayEngine.js` drives a real Playwright/Chromium browser through a recorded workflow's steps. Visible by default in local development, headless by default in production (see Environment Variables below).
- **Purchases**: manual-approval workflow (buyer submits a payment reference → creator approves/rejects) rather than a live payment gateway. `purchaseRequestController.approvePurchaseRequest` is the single seam a real gateway webhook would plug into later.

## Environment Variables

Copy `.env.example` to `.env` for local development and fill in `JWT_SECRET` (any long random string). Full documentation of every variable, including which ones are production-only, is in `.env.example` itself — read it before deploying.

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | Always | Server refuses to start without it. |
| `PORT` | No | Railway injects this automatically. |
| `NODE_ENV` | Production | Set to `production` on Railway; controls the checks below. |
| `CORS_ORIGIN` | Production | Comma-separated allowed origins. Without it in production, all cross-origin requests are rejected. |
| `FORGEFLOW_HEADLESS` | No | Auto-headless in production, auto-visible in development. Only set to override. |
| `DATABASE_DIR` | Production (recommended) | Points the SQLite file at a persistent Railway Volume. Without it, data is lost on every redeploy. |
| `ANTHROPIC_API_KEY` | No | Only used by the optional Claude-assisted extraction path. |

## Local Development

```
npm install
cp .env.example .env   # then fill in JWT_SECRET
npm run dev
```

`npm install` also runs `playwright install --with-deps chromium` (see `postinstall` in `package.json`) so the replay engine has a browser to drive.

## Deploying to Railway

1. **Create the service** — push this repo (or just `backend/`, depending on your Railway project layout) and let Railway build it with Nixpacks; no Dockerfile is required. Railway auto-detects the `start` script in `package.json` (`node server.js`).
2. **Set service variables** — at minimum `JWT_SECRET` and `NODE_ENV=production`. Add `CORS_ORIGIN` once you know your extension's `chrome-extension://<id>` origin (see below).
3. **Attach a persistent Volume** for the SQLite database and set `DATABASE_DIR` to its mount path — otherwise every redeploy wipes all users, APIs, and purchases. (Alternatively, migrate to Railway's managed Postgres if you outgrow SQLite; that's a larger change than this checklist covers.)
4. **Confirm the Playwright build step** — `postinstall` runs `playwright install --with-deps chromium` automatically on `npm install`. If Railway's build environment can't install the system dependencies this way, switch to a Dockerfile based on `mcr.microsoft.com/playwright` (pin the tag to match the `playwright` version in `package.json`).
5. **Deploy**, then hit `GET /health` on the generated Railway URL to confirm the server is up.
6. **Point the extension at it** — see the root `README.md` for regenerating `extension/shared/config.js` with the deployed URL.
7. **Set `CORS_ORIGIN`** to the extension's real origin once you've loaded/published it and know its id, then redeploy.

### Build & start commands

- Build: `npm install` (Playwright's Chromium install runs automatically via `postinstall`)
- Start: `npm start` (runs `node server.js`)
