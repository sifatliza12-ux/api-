// Loads the real unpacked extension and opens every page touched by the
// pending uncommitted diff (popup, settings, my-purchases, roles.js is
// shared) plus marketplace (uses the same paymentConfig pattern already),
// watching for JS errors / failed script loads. Not a functional test —
// just "does anything throw on load."
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const EXTENSION_PATH = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st\\extension';
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-smoke-${Date.now()}`);

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
  console.log('Extension ID:', extensionId);

  const pagesToCheck = ['popup/popup.html', 'settings/settings.html', 'my-purchases/my-purchases.html', 'marketplace/marketplace.html'];
  let anyError = false;

  for (const rel of pagesToCheck) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(`chrome-extension://${extensionId}/${rel}`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const realErrors = errors.filter((e) => !/Failed to load resource|401|net::ERR_FAILED.*api-production/i.test(e));
    console.log(`--- ${rel} ---`);
    if (realErrors.length) {
      anyError = true;
      console.log('ERRORS:', JSON.stringify(realErrors, null, 2));
    } else {
      console.log('OK (no JS errors)', errors.length ? `(${errors.length} network/auth-only messages ignored)` : '');
    }
    await page.close();
  }

  await context.close();
  process.exit(anyError ? 1 : 0);
})().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
