// Post-fix verification: loads the REAL, fixed extension/content/content.js
// into a REAL Chromium instance (isolated-world content script, via
// --load-extension -- NOT page.addInitScript, which runs in the main world
// and is subject to the page's own Trusted Types CSP, unlike a real content
// script). Drives an actual recording session against real youtube.com:
// search -> click a thumbnail -> click the widget's own "Stop & Save
// Recording" button. Then:
//   1. inspects the raw recorded events array (what gets sent to
//      /api/workflows/parameterize as the saved workflow's source data) and
//      asserts no event's selector/locators mention the recorder widget.
//   2. runs the REAL ruleBasedParameterizer service on those events to get
//      the actual "steps" shape that gets persisted as the saved workflow,
//      and asserts the same there.
//   3. only if both are clean, replays the steps through the REAL
//      replayEngine service and reports the outcome.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.FORGEFLOW_HEADLESS = process.env.FORGEFLOW_HEADLESS || 'true';

const path = require('path');
const { chromium } = require('playwright');
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { runWorkflow } = require('../services/replayEngine');

const EXT_PATH = 'c:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st\\extension';
const USER_DATA_DIR = path.join(__dirname, '..', '.tmp-ext-profile-verify');

const WIDGET_MARKERS = ['forgeflow-recorder-widget', 'pill-stop', 'pill pill-stop', 'Stop & Save Recording'];

const findWidgetLeaks = (obj) => {
  const hits = [];
  const seen = new Set();
  const walk = (node, pathStr) => {
    if (node == null || typeof node !== 'object') {
      if (typeof node === 'string' && WIDGET_MARKERS.some((m) => node.includes(m))) {
        hits.push({ path: pathStr, value: node });
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      walk(v, pathStr ? `${pathStr}.${k}` : k);
    }
  };
  walk(obj, '');
  return hits;
};

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    let sw = context.serviceWorkers()[0];
    const deadline = Date.now() + 30000;
    while (!sw && Date.now() < deadline) {
      sw = await Promise.race([
        context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => null),
        new Promise((r) => setTimeout(() => r(context.serviceWorkers()[0]), 3000))
      ]);
    }
    if (!sw) throw new Error('extension service worker never registered within 30s');
    console.log('>> extension loaded, service worker:', sw.url());

    const page = context.pages()[0] || (await context.newPage());
    page.on('dialog', async (dialog) => { console.log('  [dialog]', dialog.message()); await dialog.dismiss().catch(() => {}); });
    page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

    await page.bringToFront();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);

    console.log('>> starting a real recording session');
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      await startRecording(tabs[0].id);
    });
    await page.waitForTimeout(1000);

    const widgetCount = await page.locator('#forgeflow-recorder-widget').count();
    console.log('>> widget present:', widgetCount > 0);

    console.log('>> searching + clicking a thumbnail, same as a real user would');
    await page.click('input#search, input[name="search_query"]');
    await page.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
    await page.press('input#search, input[name="search_query"]', 'Enter');
    await page.waitForURL('**results**', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    await page.waitForSelector('ytd-thumbnail a#thumbnail', { timeout: 15000 }).catch(() => {});
    const thumbs = page.locator('ytd-thumbnail a#thumbnail');
    const thumbCount = await thumbs.count();
    for (let i = 0; i < Math.min(thumbCount, 20); i++) {
      const b = await thumbs.nth(i).boundingBox();
      if (b) {
        console.log(`>> clicking thumbnail #${i}`);
        await thumbs.nth(i).click({ timeout: 5000 }).catch((e) => console.log('thumbnail click threw:', e.message));
        break;
      }
    }
    await page.waitForTimeout(1500);

    console.log('>> clicking the real "Stop & Save Recording" button (pierces open shadow root)');
    await page.locator('[data-role="stop"]').click({ timeout: 5000 })
      .then(() => console.log('>> stop button clicked'))
      .catch((e) => console.log('>> stop button click threw:', e.message));
    await page.waitForTimeout(1000);

    const finalState = await sw.evaluate(async () => chrome.storage.session.get(null));
    const rec = finalState['forgeflow.recorder.state'];
    console.log('\n>> isRecording after stop click:', rec?.isRecording);
    const events = rec?.events || [];
    console.log('>> total recorded events:', events.length);
    events.forEach((e, i) => console.log(`  [${i}] ${e.type} selector=${e.selector} value=${JSON.stringify(e.value).slice(0, 60)}`));
    require('fs').writeFileSync(path.join(__dirname, 'verify_fix_events.json'), JSON.stringify(events, null, 2));

    console.log('\n=== STEP 1: raw recorded events -- widget-leak scan ===');
    const rawLeaks = findWidgetLeaks(events);
    if (rawLeaks.length > 0) {
      console.log('LEAK FOUND in raw events:', JSON.stringify(rawLeaks, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log('CLEAN: no event selector/locator/value mentions the recorder widget.');

    console.log('\n=== STEP 2: real parameterizeWorkflowRuleBased(events) -- widget-leak scan ===');
    const { parameters, steps } = parameterizeWorkflowRuleBased(events);
    steps.forEach((s) => console.log(`  [${s.index}] ${s.type} selector=${s.selector} locators=${JSON.stringify(s.locators)}`));
    const stepLeaks = findWidgetLeaks(steps);
    if (stepLeaks.length > 0) {
      console.log('LEAK FOUND in parameterized steps:', JSON.stringify(stepLeaks, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log('CLEAN: no saved workflow step mentions the recorder widget.');
    require('fs').writeFileSync(path.join(__dirname, 'verify_fix_steps.json'), JSON.stringify({ parameters, steps }, null, 2));

    console.log('\n=== STEP 3: saved workflow confirmed clean -- replaying ===');
    const parameterValues = Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue]));
    let result = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`>> replay attempt ${attempt}`);
        result = await runWorkflow({ steps, parameterValues, workflowId: 'verify-fix-youtube', extractionHint: null });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.log(`>> replay attempt ${attempt} failed:`, e.message);
        // Only retry on transient network errors, not on real selector/step
        // failures -- those would be a genuine regression worth seeing.
        if (!/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|net::/.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (lastErr) throw lastErr;
    console.log('>> replay finalUrl:', result.finalUrl);
    console.log('>> REPLAY SUCCEEDED');
    process.exitCode = 0;
  } catch (err) {
    console.error('CRASH', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
