// Loads the REAL unpacked extension (extension/) into a real headed Chrome
// instance via Playwright, drives its REAL popup UI to sign up, record a
// brand-new workflow against a live public site, save it (POST
// /api/workflows/parameterize on the DEPLOYED Railway backend), then opens
// the extension's real My APIs page and clicks its real "Run API" button
// (POST /api/workflows/:id/run on the DEPLOYED backend) to replay it.
//
// This does NOT stub chrome.* — it's the actual unpacked extension running
// in a real browser profile, talking to extension/shared/config.js's
// production FORGEFLOW_API_BASE (https://api-production-6bcb.up.railway.app).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const REPO_ROOT = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st';
const EXTENSION_PATH = path.join(REPO_ROOT, 'extension');
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-ext-e2e-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('Extension dir:', EXTENSION_PATH);
  console.log('User data dir:', USER_DATA_DIR);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run'
    ]
  });

  // MV3 service worker registers asynchronously — grab it (or wait for it).
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = new URL(sw.url()).host;
  console.log('Extension ID:', extensionId);

  // --- Page A: the real target site ---------------------------------------
  const siteUrl = 'https://the-internet.herokuapp.com/login';
  const pageA = await context.newPage();
  await pageA.goto(siteUrl, { waitUntil: 'domcontentloaded' });
  console.log('Page A loaded:', siteUrl);

  // --- Page B: the real popup UI, opened as its own page ------------------
  const pageB = await context.newPage();
  await pageB.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pageB.waitForLoadState('domcontentloaded');
  console.log('Popup loaded');

  // Capture the deployed backend's raw responses for hard proof.
  let parameterizeResponseBody = null;
  let runResponseBody = null;
  context.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/workflows/parameterize') && response.request().method() === 'POST') {
      try { parameterizeResponseBody = await response.json(); } catch (e) { /* ignore */ }
      console.log('[network] parameterize response status', response.status());
    }
    if (/\/api\/workflows\/[^/]+\/run$/.test(url) && response.request().method() === 'POST') {
      try { runResponseBody = await response.json(); } catch (e) { /* ignore */ }
      console.log('[network] run response status', response.status());
    }
  });

  // --- Sign up a fresh throwaway account -----------------------------------
  const testEmail = `ext-e2e-${Date.now()}@example.com`;
  const testPassword = 'ExtensionE2ETest123!';
  console.log('Signing up as', testEmail);

  await pageB.click('#show-signup-btn');
  await pageB.fill('#signup-name', 'Extension E2E');
  await pageB.fill('#signup-email', testEmail);
  await pageB.fill('#signup-password', testPassword);
  await pageB.fill('#signup-confirm-password', testPassword);
  await pageB.click('#signup-btn');

  await pageB.waitForSelector('#dashboard-view:not([hidden])', { timeout: 15000 });
  console.log('Signup succeeded — dashboard view visible');

  // Signup may auto-open a Mode Selection tab — harmless, leave it be.
  await sleep(500);

  // --- Start recording -------------------------------------------------
  console.log('Clicking Start Recording...');
  await pageB.click('#popup-record-toggle-btn');
  await sleep(300);

  // Bringing the site tab to front triggers the extension's own
  // chrome.tabs.onActivated listener, which (re)injects content.js and
  // syncs isRecording:true into it — this is what makes the real recording
  // actually target the site tab regardless of which tab originally sent
  // the start-recording message.
  await pageA.bringToFront();
  await sleep(500);

  console.log('Recording a real login flow on', siteUrl);
  await pageA.click('#username');
  await pageA.fill('#username', 'tomsmith');
  await pageA.click('#password');
  await pageA.fill('#password', 'SuperSecretPassword!');
  await pageA.click('button[type="submit"]');
  await pageA.waitForLoadState('domcontentloaded');
  await pageA.waitForURL('**/secure', { timeout: 10000 });
  console.log('Login submitted, landed on', pageA.url());
  await sleep(500);

  // --- Stop recording + save (handle the native prompt/alert dialogs) -----
  const workflowName = `Extension E2E Login ${Date.now()}`;
  await pageB.bringToFront();

  pageB.once('dialog', async (dialog) => {
    console.log('[dialog]', dialog.type(), dialog.message());
    if (dialog.type() === 'prompt') {
      await dialog.accept(workflowName);
    } else {
      await dialog.accept();
    }
  });

  console.log('Clicking Stop Recording...');
  await pageB.click('#popup-record-toggle-btn');

  // The post-save alert() is a SECOND dialog.
  const alertPromise = pageB.waitForEvent('dialog', { timeout: 15000 }).then(async (dialog) => {
    console.log('[dialog]', dialog.type(), dialog.message());
    await dialog.accept();
  }).catch(() => {});
  await alertPromise;

  await sleep(1000);
  console.log('parameterize response:', JSON.stringify(parameterizeResponseBody)?.slice(0, 500));

  if (!parameterizeResponseBody?.success || !parameterizeResponseBody?.workflowId) {
    throw new Error(`Workflow save failed or no workflowId in response: ${JSON.stringify(parameterizeResponseBody)}`);
  }
  const workflowId = parameterizeResponseBody.workflowId;
  console.log('SAVED workflow id:', workflowId, 'name:', parameterizeResponseBody.name);
  console.log('parameters:', JSON.stringify(parameterizeResponseBody.parameters));
  console.log('steps:', JSON.stringify((parameterizeResponseBody.steps || []).map((s) => `${s.index}:${s.type}`)));

  // --- Open the real My APIs page and click the real "Run API" button -----
  const pageC = await context.newPage();
  await pageC.goto(`chrome-extension://${extensionId}/my-apis/my-apis.html`);
  await pageC.waitForLoadState('domcontentloaded');
  await sleep(1000);

  // Find the card for the workflow we just recorded, then click its
  // "View"/details button (.view-api-btn) — that's what actually opens the
  // run modal; the heading itself has no click handler.
  const cardHeading = pageC.locator('.api-card-top h3', { hasText: workflowName });
  await cardHeading.first().waitFor({ timeout: 15000 });
  console.log('Found My APIs card for', workflowName);
  const card = pageC.locator('.api-card', { has: pageC.locator('h3', { hasText: workflowName }) }).first();
  await card.locator('.view-api-btn').click();

  await pageC.waitForSelector('.modal-run-api', { timeout: 10000 });

  // content.js correctly redacts real password values while recording —
  // override the password parameter field with the real one before running,
  // exactly like a real user filling in the parameter form.
  const allParamInputs = await pageC.locator('.modal [data-param-name]').all();
  for (const input of allParamInputs) {
    const paramName = await input.getAttribute('data-param-name');
    if (paramName && /pass/i.test(paramName)) {
      await input.fill('SuperSecretPassword!');
      console.log('Overrode password parameter:', paramName);
    }
  }

  console.log('Clicking Run API...');
  await pageC.click('.modal-run-api');

  await pageC.waitForSelector('.run-result', { state: 'visible', timeout: 60000 });
  const resultClass = await pageC.locator('.run-result').getAttribute('class');
  const resultText = await pageC.locator('.run-result').innerText();
  console.log('UI result class:', resultClass);
  console.log('UI result text:', resultText.slice(0, 800));

  await sleep(1000);
  console.log('run response:', JSON.stringify(runResponseBody)?.slice(0, 2000));

  const proof = {
    extensionId,
    testEmail,
    workflowId,
    workflowName,
    uiResultClass: resultClass,
    uiResultText: resultText,
    runResponse: runResponseBody
  };
  fs.writeFileSync(path.join(path.dirname(USER_DATA_DIR), 'extension-e2e-proof.json'), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(os.tmpdir(), 'extension-e2e-proof.json'), JSON.stringify(proof, null, 2));

  const success = Boolean(runResponseBody?.success) && (runResponseBody?.stepLog || []).every((s) => s.result !== 'failed');

  await context.close();

  if (!success) {
    console.error('REPLAY DID NOT SUCCEED');
    process.exit(1);
  }
  console.log('REPLAY SUCCEEDED END TO END VIA REAL EXTENSION + DEPLOYED BACKEND');
  process.exit(0);
})().catch((err) => {
  console.error('SCRIPT CRASHED:', err);
  process.exit(1);
});
