# ForgeFlow

A two-sided API marketplace built as a Chrome extension (record a browser workflow, turn it into a callable API, publish or buy them) backed by an Express + SQLite API.

- `extension/` — the Chrome MV3 extension (Creator and Buyer dashboards, marketplace, recording/replay UI). No build step; each page is a plain HTML/CSS/JS trio.
- `backend/` — the Express API. See [`backend/README.md`](backend/README.md) for environment variables and Railway deployment steps.

## Local development

1. Backend: `cd backend && npm install && cp .env.example .env` (fill in `JWT_SECRET`), then `npm run dev`. Defaults to `http://localhost:5000`.
2. Extension: load `extension/` unpacked in `chrome://extensions` (Developer mode → Load unpacked). It points at `http://localhost:5000` out of the box — no extra steps needed for local development.

## Deploying

1. Deploy `backend/` to Railway — full steps, required environment variables, and build/start commands are in [`backend/README.md`](backend/README.md).
2. Point the extension at the deployed backend by regenerating its config before packaging:
   ```
   FORGEFLOW_API_BASE=https://your-app.up.railway.app node extension/shared/generate-config.js
   ```
   This rewrites `extension/shared/config.js` — the extension has no build step, so this is the environment-variable equivalent for it. Do not hand-edit that file directly.
3. Package the extension (zip the `extension/` folder) and load/publish it as usual.
4. Once you know the extension's real `chrome-extension://<id>` origin (after loading/publishing), set `CORS_ORIGIN` on the Railway service to that origin and redeploy — production rejects cross-origin requests until this is set.
