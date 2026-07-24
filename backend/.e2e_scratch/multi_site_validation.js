// Multi-site validation suite: drives the REAL unpacked extension (extension/)
// in a real headed Chrome via Playwright against the REAL deployed Railway
// backend (extension/shared/config.js's FORGEFLOW_API_BASE). For each site
// scenario: Record -> Save (POST /api/workflows/parameterize) -> the record
// is persisted in the deployed SQLite DB -> Load (GET, via the My APIs page
// rendering it) -> Replay (POST /api/workflows/:id/run) -> assert every step
// succeeded. One throwaway account, reused across every scenario.
//
// No scenario/action here is fed into the replay engine itself — this file
// only DRIVES a human-shaped recording session against real third-party
// sites. Nothing in backend/services/*.js may branch on any of these
// domains; if a scenario fails, the fix belongs in the generic engine.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

const REPO_ROOT = 'C:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st';
const EXTENSION_PATH = path.join(REPO_ROOT, 'extension');
const USER_DATA_DIR = path.join(os.tmpdir(), `forgeflow-multisite-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  {
    name: 'traditional-form-login',
    category: 'traditional server-rendered page',
    siteUrl: 'https://the-internet.herokuapp.com/login',
    record: async (pageA) => {
      await pageA.click('#username');
      await pageA.fill('#username', 'tomsmith');
      await pageA.click('#password');
      await pageA.fill('#password', 'SuperSecretPassword!');
      await pageA.click('button[type="submit"]');
      await pageA.waitForURL('**/secure', { timeout: 10000 });
    },
    verifyReplay: (result) => (result.finalUrl || '').includes('/secure')
  },
  {
    name: 'react-spa-todomvc-enter-submit',
    category: 'SPA (React) + Enter-key submission + dynamic DOM nodes',
    siteUrl: 'https://todomvc.com/examples/react/dist/',
    record: async (pageA) => {
      await pageA.click('.new-todo');
      await pageA.fill('.new-todo', 'Buy milk');
      await pageA.press('.new-todo', 'Enter');
      await pageA.waitForSelector('.todo-list li', { timeout: 5000 });
      // Toggle the freshly-created (dynamically rendered, non-recorded-index)
      // todo's checkbox — this element did not exist before the Enter step.
      await pageA.click('.todo-list li .toggle');
      await pageA.waitForSelector('.todo-list li.completed', { timeout: 5000 });
    },
    verifyReplay: null // page-state check happens via step success only (SPA, no URL change)
  },
  {
    name: 'delayed-ajax-loading',
    category: 'delayed-loading page',
    siteUrl: 'https://the-internet.herokuapp.com/dynamic_loading/2',
    record: async (pageA) => {
      await pageA.click('#start button');
      await pageA.waitForSelector('#finish h4', { timeout: 10000 });
      await pageA.click('#finish h4');
    },
    verifyReplay: null
  },
  {
    name: 'dom-node-removed-and-regenerated',
    category: 'dynamic DOM mutation / stale elements',
    siteUrl: 'https://the-internet.herokuapp.com/dynamic_controls',
    record: async (pageA) => {
      await pageA.click('#checkbox-example button');
      await pageA.waitForSelector('#checkbox-example #message', { timeout: 10000 });
    },
    verifyReplay: null
  },
  {
    name: 'overlay-dismiss-on-load',
    category: 'websites with overlays / modal-heavy pages',
    siteUrl: 'https://the-internet.herokuapp.com/entry_ad',
    record: async (pageA) => {
      await pageA.click('.modal-footer p');
      await pageA.waitForSelector('#modal', { state: 'hidden', timeout: 5000 }).catch(() => {});
      await pageA.click('h3:has-text("Entry Ad")');
    },
    verifyReplay: null
  },
  {
    name: 'autocomplete-search-enter-submit',
    category: 'dynamic autocomplete/search page + Enter-key submission (different site than the original bug)',
    siteUrl: 'https://duckduckgo.com/',
    record: async (pageA) => {
      await pageA.click('#searchbox_input');
      await pageA.fill('#searchbox_input', 'openai');
      await pageA.waitForTimeout(600);
      await pageA.press('#searchbox_input', 'Enter');
      await pageA.waitForURL('**q=**', { timeout: 10000 }).catch(() => {});
    },
    verifyReplay: (result) => (result.finalUrl || '').includes('q=')
  },
  {
    name: 'infinite-scroll-page',
    category: 'infinite scrolling page',
    siteUrl: 'https://the-internet.herokuapp.com/infinite_scroll',
    record: async (pageA) => {
      const before = await pageA.locator('.jscroll-added').count();
      await pageA.mouse.wheel(0, 3000);
      await pageA.waitForTimeout(800);
      await pageA.mouse.wheel(0, 3000);
      await pageA.waitForTimeout(800);
      await pageA.waitForFunction((n) => document.querySelectorAll('.jscroll-added').length > n, before, { timeout: 8000 }).catch(() => {});
    },
    verifyReplay: null
  }
];

const runScenario = async ({ context, pageB, extensionId, scenario, results }) => {
  console.log(`\n${'='.repeat(12)} ${scenario.name} (${scenario.category}) ${'='.repeat(12)}`);
  const pageA = await context.newPage();
  let parameterizeResponseBody = null;
  let runResponseBody = null;

  const onResponse = async (response) => {
    const url = response.url();
    if (url.includes('/api/workflows/parameterize') && response.request().method() === 'POST') {
      try { parameterizeResponseBody = await response.json(); } catch (e) { /* ignore */ }
    }
    if (/\/api\/workflows\/[^/]+\/run$/.test(url) && response.request().method() === 'POST') {
      try { runResponseBody = await response.json(); } catch (e) { /* ignore */ }
    }
  };
  context.on('response', onResponse);

  try {
    await pageA.goto(scenario.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Loaded', scenario.siteUrl);

    await pageB.bringToFront();
    await pageB.click('#popup-record-toggle-btn');
    await sleep(300);

    await pageA.bringToFront();
    await sleep(500);

    console.log('Recording actions...');
    await scenario.record(pageA);
    const recordedFinalUrl = pageA.url();
    console.log('Recorded final URL:', recordedFinalUrl);
    await sleep(500);

    const workflowName = `MultiSite ${scenario.name} ${Date.now()}`;
    await pageB.bringToFront();

    pageB.once('dialog', async (dialog) => {
      if (dialog.type() === 'prompt') {
        await dialog.accept(workflowName);
      } else {
        await dialog.accept();
      }
    });

    console.log('Stopping recording + saving...');
    await pageB.click('#popup-record-toggle-btn');

    const alertPromise = pageB.waitForEvent('dialog', { timeout: 15000 }).then(async (dialog) => {
      await dialog.accept();
    }).catch(() => {});
    await alertPromise;

    await sleep(1200);

    if (!parameterizeResponseBody?.success || !parameterizeResponseBody?.workflowId) {
      throw new Error(`Save failed: ${JSON.stringify(parameterizeResponseBody).slice(0, 500)}`);
    }
    const workflowId = parameterizeResponseBody.workflowId;
    console.log('SAVED workflow id:', workflowId, '| steps:', (parameterizeResponseBody.steps || []).map((s) => s.type).join(','));

    // --- Load from DB (via the real My APIs page) + Replay ---
    const pageC = await context.newPage();
    await pageC.goto(`chrome-extension://${extensionId}/my-apis/my-apis.html`);
    await pageC.waitForLoadState('domcontentloaded');
    await sleep(1000);

    const card = pageC.locator('.api-card', { has: pageC.locator('h3', { hasText: workflowName }) }).first();
    await card.waitFor({ timeout: 15000 });
    await card.locator('.view-api-btn').click();
    await pageC.waitForSelector('.modal-run-api', { timeout: 10000 });

    console.log('Clicking Run API...');
    await pageC.click('.modal-run-api');
    await pageC.waitForSelector('.run-result', { state: 'visible', timeout: 60000 });
    const resultClass = await pageC.locator('.run-result').getAttribute('class');
    const resultText = await pageC.locator('.run-result').innerText();
    await sleep(800);

    const stepLog = runResponseBody?.stepLog || [];
    const failedSteps = stepLog.filter((s) => s.result === 'failed');
    // Authoritative signal: every recorded step actually succeeded on
    // replay. Recorded-step-count sanity (did we even capture more than the
    // initial navigation?) catches the "recording silently captured nothing"
    // failure mode, which a pure stepLog check would miss entirely (zero
    // steps to fail != zero problems).
    const recordedStepCount = (parameterizeResponseBody.steps || []).length;
    const capturedRealSteps = recordedStepCount > 1;
    const engineSuccess = Boolean(runResponseBody?.success) && failedSteps.length === 0;
    const success = engineSuccess && capturedRealSteps;

    console.log('UI result class:', resultClass);
    console.log('engine success:', runResponseBody?.success, '| failed steps:', failedSteps.length, '| recorded steps:', recordedStepCount);
    if (failedSteps.length) {
      failedSteps.forEach((s) => console.log('  FAILED', JSON.stringify(s).slice(0, 400)));
    }

    results.push({
      name: scenario.name,
      category: scenario.category,
      success,
      workflowId,
      recordedFinalUrl,
      replayFinalUrl: runResponseBody?.finalUrl,
      failedSteps: failedSteps.map((s) => ({ index: s.index, type: s.type, reason: s.failureReason })),
      resultText: resultText?.slice(0, 300)
    });

    await pageC.close();
  } catch (err) {
    console.error('SCENARIO ERROR:', err.message);
    results.push({ name: scenario.name, category: scenario.category, success: false, error: err.message });
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
  console.log('Extension ID:', extensionId);

  const pageB = await context.newPage();
  await pageB.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pageB.waitForLoadState('domcontentloaded');

  const testEmail = `multisite-e2e-${Date.now()}@example.com`;
  const testPassword = 'MultiSiteE2ETest123!';
  console.log('Signing up as', testEmail);
  await pageB.click('#show-signup-btn');
  await pageB.fill('#signup-name', 'MultiSite E2E');
  await pageB.fill('#signup-email', testEmail);
  await pageB.fill('#signup-password', testPassword);
  await pageB.fill('#signup-confirm-password', testPassword);
  await pageB.click('#signup-btn');
  await pageB.waitForSelector('#dashboard-view:not([hidden])', { timeout: 15000 });
  console.log('Signup OK');
  await sleep(500);

  const results = [];
  for (const scenario of SCENARIOS) {
    await runScenario({ context, pageB, extensionId, scenario, results });
  }

  console.log(`\n${'#'.repeat(20)} SUMMARY ${'#'.repeat(20)}`);
  results.forEach((r) => {
    console.log(`${r.success ? 'PASS' : 'FAIL'} | ${r.name} (${r.category})`);
    if (!r.success) {
      console.log('   ', r.error || JSON.stringify(r.failedSteps));
    }
  });
  const allPassed = results.every((r) => r.success);
  console.log(`\nTOTAL: ${results.filter((r) => r.success).length}/${results.length} passed`);

  fs.writeFileSync(path.join(os.tmpdir(), 'multisite-e2e-results.json'), JSON.stringify(results, null, 2));

  await context.close();
  process.exit(allPassed ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
