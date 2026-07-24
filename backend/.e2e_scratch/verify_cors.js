// Focused verification: does the production backend's CORS_ORIGIN warning
// actually block real requests from the real unpacked extension, or is it
// just a startup log line? Loads the REAL unpacked extension, executes a
// REAL fetch() from INSIDE an actual extension page's JS context (not from
// Node/curl — the whole question is what the BROWSER enforces for this
// specific request origin), and inspects both success/failure and the
// actual response headers Chrome received.
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const REPO_ROOT = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st';
const EXTENSION_PATH = path.join(REPO_ROOT, 'extension');
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-cors-check-${Date.now()}`);
const PROD_API_BASE = 'https://api-production-6bcb.up.railway.app';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run'
    ]
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  console.log('Real unpacked extension loaded. Extension ID:', extensionId);
  console.log('Extension page origin will be: chrome-extension://' + extensionId);
  console.log('Target backend:', PROD_API_BASE);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  console.log('Loaded real extension page:', page.url());

  // Real fetch(), executed by the extension page's own JS engine — exactly
  // what popup.js / my-apis.js do — not a Node-side request, so it's
  // actually subject to whatever the browser enforces for THIS origin.
  const result = await page.evaluate(async (base) => {
    try {
      const res = await fetch(`${base}/`, { method: 'GET' });
      const headers = {};
      res.headers.forEach((value, key) => { headers[key] = value; });
      const body = await res.text();
      return { ok: true, status: res.status, headers, body: body.slice(0, 200) };
    } catch (err) {
      // A real CORS rejection surfaces here as a generic "Failed to fetch"
      // TypeError — the browser never exposes the real reason to JS, by
      // design, but it DOES reliably throw before any response is usable.
      return { ok: false, errorName: err.name, errorMessage: err.message };
    }
  }, PROD_API_BASE);

  console.log('\n=== Simple GET / from extension page context ===');
  console.log(JSON.stringify(result, null, 2));

  // Also check a real POST with a JSON body + Authorization-shaped header,
  // since that's what the actual save/run calls do (and preflight OPTIONS
  // behaves differently from a simple GET) — this exercises the CORS
  // preflight path that a simple GET above does not.
  const postResult = await page.evaluate(async (base) => {
    try {
      const res = await fetch(`${base}/api/workflows/parameterize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
        body: JSON.stringify({ events: [] })
      });
      const headers = {};
      res.headers.forEach((value, key) => { headers[key] = value; });
      const body = await res.text();
      return { ok: true, status: res.status, headers, body: body.slice(0, 300) };
    } catch (err) {
      return { ok: false, errorName: err.name, errorMessage: err.message };
    }
  }, PROD_API_BASE);

  console.log('\n=== Preflight-triggering POST (with Authorization header) from extension page context ===');
  console.log(JSON.stringify(postResult, null, 2));

  await context.close();

  const corsBlocked = !result.ok || !postResult.ok;
  console.log('\nCONCLUSION:', corsBlocked
    ? 'CORS IS blocking real requests from the extension.'
    : 'CORS is NOT blocking real requests from the extension — the startup warning does not reflect actual runtime behavior for extension-page requests.');

  process.exit(corsBlocked ? 1 : 0);
})().catch((err) => {
  console.error('SCRIPT CRASHED:', err);
  process.exit(2);
});
