// REAL production end-to-end validation: drives the ACTUAL unpacked
// extension/ (loaded via --load-extension, exactly how Chrome loads it for
// a real user) in a real headed-Chromium Playwright session, against the
// ACTUAL deployed Railway backend (https://api-production-6bcb.up.railway.app,
// per extension/shared/config.js — never overridden here). Every save/load/
// replay call is a real HTTP request to production and a real row in the
// production SQLite DB. No local harness, no in-process service imports.
//
// Flow per scenario: sign up once (shared across scenarios) -> open target
// site -> start recording via the popup -> perform real user actions ->
// stop & save (POST /api/workflows/parameterize on production) -> open My
// APIs -> load the saved card (GET, rendered from production) -> click Run
// API (POST /api/workflows/:id/run on production, executed by a REAL
// Playwright browser running server-side on Railway) -> capture the exact
// JSON response for evidence.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const REPO_ROOT = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st';
const EXTENSION_PATH = path.join(REPO_ROOT, 'extension');
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-prod-e2e-${Date.now()}`);
const PROD_API_BASE = 'https://api-production-6bcb.up.railway.app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  {
    name: 'todomvc-react-toggle',
    siteUrl: 'https://todomvc.com/examples/react/dist/',
    record: async (pageA) => {
      await pageA.click('.new-todo');
      await pageA.fill('.new-todo', 'Buy milk');
      await pageA.press('.new-todo', 'Enter');
      await pageA.waitForSelector('.todo-list li', { timeout: 5000 });
      await pageA.click('.todo-list li .toggle');
      await pageA.waitForSelector('.todo-list li.completed', { timeout: 5000 });
    }
  },
  {
    name: 'todomvc-vue-toggle',
    siteUrl: 'https://todomvc.com/examples/vue/dist/',
    record: async (pageA) => {
      await pageA.click('.new-todo');
      await pageA.fill('.new-todo', 'Buy milk');
      await pageA.press('.new-todo', 'Enter');
      await pageA.waitForSelector('.todo-list li', { timeout: 5000 });
      await pageA.click('.todo-list li .toggle');
      await pageA.waitForSelector('.todo-list li.completed', { timeout: 5000 });
    }
  },
  {
    name: 'wikipedia-search',
    siteUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    record: async (pageA) => {
      await pageA.click('#searchInput');
      await pageA.fill('#searchInput', 'Playwright (software)');
      await pageA.press('#searchInput', 'Enter');
      await pageA.waitForLoadState('domcontentloaded');
    }
  },
  {
    name: 'saucedemo-login',
    siteUrl: 'https://www.saucedemo.com/',
    record: async (pageA) => {
      await pageA.click('#user-name');
      await pageA.fill('#user-name', 'standard_user');
      await pageA.click('#password');
      await pageA.fill('#password', 'secret_sauce');
      await pageA.click('#login-button');
      await pageA.waitForURL('**/inventory.html', { timeout: 10000 });
    },
    // content.js never records a real password value (redacted for
    // security) — this fills the REAL value into the run modal's param
    // form before clicking Run API, exactly like a real caller must.
    beforeRun: async (pageC) => {
      await pageC.fill('#param-input-password', 'secret_sauce');
    }
  },
  {
    name: 'youtube-search',
    siteUrl: 'https://www.youtube.com/',
    record: async (pageA) => {
      await pageA.click('input#search, input[name="search_query"]');
      await pageA.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
      await pageA.press('input#search, input[name="search_query"]', 'Enter');
      await pageA.waitForURL('**results**', { timeout: 10000 }).catch(() => {});
    }
  },
  {
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
    },
    verify: (finalUrl) => /\/city\/[a-z]{2}\/[^/]+\.html/i.test(finalUrl || '')
  }
];

const runScenario = async ({ context, pageB, extensionId, scenario, evidence }) => {
  console.log(`\n${'='.repeat(12)} ${scenario.name} ${'='.repeat(12)}`);
  const pageA = await context.newPage();
  let parameterizeResponseBody = null;
  let runResponseBody = null;
  let runResponseStatus = null;

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.startsWith(PROD_API_BASE)) return; // only production backend calls count as evidence
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
    const recordedFinalUrl = pageA.url();
    console.log('[3/6] Real user actions performed. Page ended at:', recordedFinalUrl);
    await sleep(500);

    const workflowName = `ProdE2E ${scenario.name} ${Date.now()}`;
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

    if (scenario.beforeRun) {
      await scenario.beforeRun(pageC);
    }

    const runStartedAt = Date.now();
    console.log('[6/6] Clicking Run API — replay executes on PRODUCTION Railway backend...');
    await pageC.click('.modal-run-api');
    await pageC.waitForSelector('.run-result', { state: 'visible', timeout: 90000 });
    const wallClockMs = Date.now() - runStartedAt;
    const resultText = await pageC.locator('.run-result').innerText();
    await sleep(800);

    const stepLog = runResponseBody?.stepLog || [];
    const failedSteps = stepLog.filter((s) => s.result === 'failed');
    const replayedStepCount = stepLog.length;
    const engineSuccess = Boolean(runResponseBody?.success);
    const verified = scenario.verify ? scenario.verify(runResponseBody?.finalUrl) : true;
    const success = engineSuccess && failedSteps.length === 0 && verified;

    evidence.push({
      site: scenario.name,
      workflowId,
      recordedStepCount,
      replayedStepCount,
      failedStepCount: failedSteps.length,
      finalUrl: runResponseBody?.finalUrl || null,
      totalDurationMs: runResponseBody?.execution?.durationMs ?? null,
      wallClockMs,
      httpStatus: runResponseStatus,
      verified,
      success,
      resultText: (resultText || '').slice(0, 200),
      failedSteps: failedSteps.map((s) => ({ index: s.index, type: s.type, reason: s.failureReason })),
      screenshotPaths: stepLog.map((s) => s.screenshotPath).filter(Boolean),
      productionApiBase: PROD_API_BASE,
      savedAt: new Date().toISOString()
    });

    console.log(`RESULT: ${success ? 'PASS' : 'FAIL'} | replayedSteps=${replayedStepCount} | failedSteps=${failedSteps.length} | finalUrl=${runResponseBody?.finalUrl} | durationMs=${runResponseBody?.execution?.durationMs}`);

    await pageC.close();
  } catch (err) {
    console.error('SCENARIO ERROR:', err.message);
    evidence.push({ site: scenario.name, success: false, error: err.message });
  } finally {
    context.off('response', onResponse);
    await pageA.close().catch(() => {});
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
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = new URL(sw.url()).host;
  console.log('Real unpacked extension loaded. Extension ID:', extensionId);
  console.log('Target backend (from extension/shared/config.js, unmodified):', PROD_API_BASE);

  const pageB = await context.newPage();
  await pageB.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pageB.waitForLoadState('domcontentloaded');

  const testEmail = `prod-e2e-${Date.now()}@example.com`;
  const testPassword = 'ProdE2ETest123!';
  console.log('Signing up REAL account on PRODUCTION backend as', testEmail);
  await pageB.click('#show-signup-btn');
  await pageB.fill('#signup-name', 'Prod E2E');
  await pageB.fill('#signup-email', testEmail);
  await pageB.fill('#signup-password', testPassword);
  await pageB.fill('#signup-confirm-password', testPassword);
  await pageB.click('#signup-btn');
  await pageB.waitForSelector('#dashboard-view:not([hidden])', { timeout: 15000 });
  console.log('Signup OK on production. Account:', testEmail);
  await sleep(500);

  const evidence = [];
  for (const scenario of SCENARIOS) {
    await runScenario({ context, pageB, extensionId, scenario, evidence });
  }

  console.log(`\n${'#'.repeat(20)} EVIDENCE (JSON) ${'#'.repeat(20)}`);
  console.log(JSON.stringify(evidence, null, 2));

  const outPath = path.join(__dirname, 'prod_e2e_evidence.json');
  fs.writeFileSync(outPath, JSON.stringify({ account: testEmail, evidence }, null, 2));
  console.log('\nEvidence written to:', outPath);

  await context.close();
  process.exit(evidence.every((e) => e.success) ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
