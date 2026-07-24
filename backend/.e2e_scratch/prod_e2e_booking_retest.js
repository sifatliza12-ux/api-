// Scoped re-test after the findCoveringCloseControl timeout fix: ONLY the
// Booking.com scenario, against the REAL unpacked extension and the REAL
// deployed Railway backend (same PROD_API_BASE as prod_e2e.js, unmodified).
// Goal: confirm the replay either completes successfully, or fails cleanly
// within the replay engine's own bounded timeout — never hangs.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const REPO_ROOT = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st';
const EXTENSION_PATH = path.join(REPO_ROOT, 'extension');
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-prod-e2e-booking-${Date.now()}`);
const PROD_API_BASE = 'https://api-production-6bcb.up.railway.app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenario = {
  name: 'booking-com-destination-search',
  siteUrl: 'https://www.booking.com/',
  record: async (pageA) => {
    await pageA.waitForTimeout(2000);
    const cookieBtn = pageA.locator('#onetrust-accept-btn-handler');
    if (await cookieBtn.count()) {
      await cookieBtn.click().catch(() => {});
    }
    await pageA.waitForTimeout(500);

    const destination = pageA.locator('input[name="ss"]');
    let destinationClicked = false;
    for (let attempt = 0; attempt < 3 && !destinationClicked; attempt += 1) {
      try {
        await destination.click({ timeout: 6000 });
        destinationClicked = true;
      } catch (error) {
        await pageA.keyboard.press('Escape').catch(() => {});
        await pageA.waitForTimeout(500);
      }
    }

    let suggestionsVisible = false;
    for (let attempt = 0; attempt < 3 && !suggestionsVisible; attempt += 1) {
      await destination.fill('');
      await destination.type('Paris', { delay: 80 });
      try {
        await pageA.waitForSelector('[data-testid="autocomplete-result"]', { timeout: 6000 });
        suggestionsVisible = true;
      } catch (error) {
        // try again
      }
    }
    await pageA.click('[data-testid="autocomplete-result"] >> nth=0');
    await pageA.waitForTimeout(500);

    let searchClicked = false;
    for (let attempt = 0; attempt < 3 && !searchClicked; attempt += 1) {
      try {
        await pageA.click('button[type="submit"]', { timeout: 6000 });
        searchClicked = true;
      } catch (error) {
        await pageA.keyboard.press('Escape').catch(() => {});
        await pageA.waitForTimeout(500);
      }
    }
    await pageA.waitForURL('**/city/**', { timeout: 15000 }).catch(() => {});
  }
};

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
  console.log('Target backend:', PROD_API_BASE);

  const pageB = await context.newPage();
  await pageB.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pageB.waitForLoadState('domcontentloaded');

  const testEmail = `prod-e2e-booking-retest-${Date.now()}@example.com`;
  const testPassword = 'ProdE2ETest123!';
  console.log('Signing up REAL account on PRODUCTION backend as', testEmail);
  await pageB.click('#show-signup-btn');
  await pageB.fill('#signup-name', 'Prod E2E Booking Retest');
  await pageB.fill('#signup-email', testEmail);
  await pageB.fill('#signup-password', testPassword);
  await pageB.fill('#signup-confirm-password', testPassword);
  await pageB.click('#signup-btn');
  await pageB.waitForSelector('#dashboard-view:not([hidden])', { timeout: 15000 });
  console.log('Signup OK on production. Account:', testEmail);
  await sleep(500);

  const pageA = await context.newPage();
  let parameterizeResponseBody = null;
  let runResponseBody = null;
  let runResponseStatus = null;
  let runHttpError = null;

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.startsWith(PROD_API_BASE)) return;
    if (url.includes('/api/workflows/parameterize') && response.request().method() === 'POST') {
      try { parameterizeResponseBody = await response.json(); } catch (e) { /* ignore */ }
    }
    if (/\/api\/workflows\/[^/]+\/run$/.test(url) && response.request().method() === 'POST') {
      try {
        runResponseStatus = response.status();
        runResponseBody = await response.json();
      } catch (e) { /* ignore */ }
    }
  };
  context.on('response', onResponse);

  const overallStart = Date.now();
  let outcome = { site: scenario.name };

  try {
    await pageA.goto(scenario.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[1/6] Loaded target site:', scenario.siteUrl);

    await pageB.bringToFront();
    await pageB.click('#popup-record-toggle-btn');
    await sleep(400);
    console.log('[2/6] Recording started via real extension popup');

    await pageA.bringToFront();
    await sleep(500);
    await scenario.record(pageA);
    console.log('[3/6] Real user actions performed. Page ended at:', pageA.url());
    await sleep(500);

    const workflowName = `ProdE2E ${scenario.name} retest ${Date.now()}`;
    await pageB.bringToFront();

    pageB.once('dialog', async (dialog) => {
      if (dialog.type() === 'prompt') await dialog.accept(workflowName);
      else await dialog.accept();
    });

    console.log('[4/6] Stopping recording + saving to PRODUCTION backend...');
    await pageB.click('#popup-record-toggle-btn');

    const alertPromise = pageB.waitForEvent('dialog', { timeout: 15000 }).then(async (dialog) => {
      await dialog.accept();
    }).catch(() => {});
    await alertPromise;
    await sleep(1500);

    if (!parameterizeResponseBody?.success || !parameterizeResponseBody?.workflowId) {
      throw new Error(`Save to production failed: ${JSON.stringify(parameterizeResponseBody).slice(0, 500)}`);
    }
    const workflowId = parameterizeResponseBody.workflowId;
    const recordedStepCount = (parameterizeResponseBody.steps || []).length;
    console.log('[4/6] SAVED to production. workflowId:', workflowId, '| recorded steps:', recordedStepCount);

    const pageC = await context.newPage();
    await pageC.goto(`chrome-extension://${extensionId}/my-apis/my-apis.html`);
    await pageC.waitForLoadState('domcontentloaded');
    await sleep(1200);
    console.log('[5/6] Opened My APIs (loading list from PRODUCTION backend)');

    const card = pageC.locator('.api-card', { has: pageC.locator('h3', { hasText: workflowName }) }).first();
    await card.waitFor({ timeout: 15000 });
    await card.locator('.view-api-btn').click();
    await pageC.waitForSelector('.modal-run-api', { timeout: 10000 });

    const runStartedAt = Date.now();
    console.log('[6/6] Clicking Run API — replay executes on PRODUCTION Railway backend (post-fix)...');
    await pageC.click('.modal-run-api');

    // Deliberately generous (3 min) — this must be long enough to prove
    // either a clean completion OR a clean, bounded FAILURE, never a false
    // "still nothing" read caused by MY client giving up too early.
    let uiOutcome = 'unknown';
    try {
      await pageC.waitForSelector('.run-result.run-result--success, .run-result.run-result--error', { timeout: 180000 });
      const cls = await pageC.locator('.run-result').first().getAttribute('class');
      uiOutcome = cls.includes('run-result--success') ? 'ui-success' : 'ui-error';
    } catch (waitErr) {
      uiOutcome = 'client-wait-timeout (still no UI result after 180s)';
    }
    const wallClockMs = Date.now() - runStartedAt;
    const resultText = await pageC.locator('.run-result').innerText().catch(() => null);
    await sleep(800);

    const stepLog = runResponseBody?.stepLog || [];
    const failedSteps = stepLog.filter((s) => s.result === 'failed');

    outcome = {
      site: scenario.name,
      workflowId,
      recordedStepCount,
      replayedStepCount: stepLog.length,
      failedStepCount: failedSteps.length,
      finalUrl: runResponseBody?.finalUrl || null,
      totalDurationMs: runResponseBody?.execution?.durationMs ?? null,
      wallClockMs,
      httpStatus: runResponseStatus,
      uiOutcome,
      engineSuccess: Boolean(runResponseBody?.success),
      engineMessage: runResponseBody?.message || null,
      resultText: (resultText || '').slice(0, 300),
      failedSteps: failedSteps.map((s) => ({ index: s.index, type: s.type, reason: s.failureReason })),
      overallElapsedMs: Date.now() - overallStart
    };

    console.log('\nOUTCOME:', JSON.stringify(outcome, null, 2));
    await pageC.close();
  } catch (err) {
    outcome = { site: scenario.name, error: err.message, overallElapsedMs: Date.now() - overallStart };
    console.error('SCENARIO ERROR:', err.message);
  } finally {
    context.off('response', onResponse);
  }

  const outPath = path.join(__dirname, 'prod_e2e_booking_retest_evidence.json');
  fs.writeFileSync(outPath, JSON.stringify(outcome, null, 2));
  console.log('\nEvidence written to:', outPath);

  await context.close();
  // Success criteria per the task: either the run succeeds cleanly, OR it
  // fails cleanly (a real error surfaced, not a hang) within the bounded
  // wait. Both count as "the replay engine never hung indefinitely."
  const neverHung = outcome.uiOutcome !== 'client-wait-timeout (still no UI result after 180s)';
  process.exit(neverHung ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
