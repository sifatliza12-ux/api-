// Full end-to-end verification harness against REAL, independently-hosted
// websites — not our own synthetic test server. This is the harness the
// reliability overhaul requires: for each site it (1) records a brand-new
// workflow using the REAL extension/content/content.js, (2) parameterizes it
// with the REAL ruleBasedParameterizer, (3) SAVES it to the real SQLite-backed
// workflowStore, (4) LOADS it back by id (proving the DB round-trip doesn't
// lose anything a replay needs), (5) replays the LOADED copy through the REAL
// replayEngine.js, and (6) checks the outcome. A failure on one site is
// caught and recorded, not thrown — every other site still gets a full
// attempt, and a complete report is printed (and written to backend/debug/)
// at the end covering every site tried, not just the first failure.
//
// Deliberately NOT part of `npm test` (real websites over real network — too
// slow/flaky to gate every commit on). Run explicitly:
//   node backend/test/replayEngine.realsites.e2e.test.js
process.env.FORGEFLOW_HEADLESS = process.env.FORGEFLOW_HEADLESS || 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Isolated DB file so this never touches (or gets polluted by) the real
// backend/data/forgeflow.db a developer might have running locally.
process.env.DATABASE_DIR = process.env.DATABASE_DIR
  || require('path').join(require('os').tmpdir(), `forgeflow-realsites-test-${Date.now()}`);

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { recordWorkflow } = require('./fixtures/recordingHarness');
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const workflowStore = require('../services/workflowStore');
const { runWorkflow } = require('../services/replayEngine');
const { createUser } = require('../models/User');

const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// ---------------------------------------------------------------------------
// Site definitions. Each is a real, independently-operated, automation-
// tolerant website with a genuinely different DOM/framework from the others
// and from the local synthetic SPA covered by replayEngine.e2e.test.js —
// MediaWiki (server-rendered + a debounced JS autocomplete), a Vue SPA demo
// storefront (client-side login + cart state), and a plain vanilla-JS page
// purpose-built to simulate slow/dynamic loading. Between them they exercise
// input, click, dynamic_click, and change(select) step types, plus delayed
// DOM insertion (not just visibility toggling) on a real third-party host.
// ---------------------------------------------------------------------------
const SITES = [
  {
    name: 'wikipedia-search',
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    record: async (page) => {
      await page.click('#searchInput, input[name="search"]');
      await page.fill('#searchInput, input[name="search"]', 'Alan Turing');
      await page.waitForTimeout(700); // let the real suggestion dropdown render
      const suggestion = page.locator('.suggestions-result, .mw-searchSuggest-link').first();
      if (await suggestion.count()) {
        await suggestion.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded');
    },
    // Which recorded (destination-like) parameter to override on the second
    // replay, and what the final URL should contain for each value — proves
    // this isn't just replaying a frozen recording.
    paramOverride: { from: 'Alan Turing', to: 'Marie Curie' },
    expectUrlContains: { default: 'Turing', override: 'Curie' }
  },
  {
    name: 'saucedemo-login-cart-sort',
    baseUrl: 'https://www.saucedemo.com/',
    record: async (page) => {
      await page.fill('#user-name', 'standard_user');
      await page.fill('#password', 'secret_sauce');
      await page.click('#login-button');
      await page.waitForSelector('.inventory_list', { timeout: 10000 });
      await page.click('#add-to-cart-sauce-labs-backpack');
      await page.selectOption('[data-test="product-sort-container"]', 'lohi');
      await page.waitForTimeout(300);
    },
    paramOverride: null,
    // content.js correctly NEVER records a real password value (it records
    // the literal string "[REDACTED]" for any sensitive field — see
    // SENSITIVE_FIELD_PATTERN in extension/content/content.js) — a security
    // feature, not a bug. That means the password PARAMETER's own recorded
    // "default" is deliberately unusable and must be supplied at run time,
    // exactly like a real user would type their own password into the
    // parameter form rather than trusting whatever default the recording
    // happened to have. This harness supplies the real one here so replay
    // can actually log in.
    forcedParamValues: { password: 'secret_sauce' },
    // Reaching (and staying on) inventory.html proves the login form
    // actually submitted successfully — a failed/rejected login stays on
    // the root "/" login page instead.
    expectUrlContains: { default: 'inventory.html' }
  },
  {
    name: 'the-internet-dynamic-loading',
    baseUrl: 'https://the-internet.herokuapp.com/dynamic_loading/2',
    record: async (page) => {
      await page.click('#start button');
      // Example 2 on this page REMOVES and RE-ADDS the finish element
      // (rather than merely toggling visibility) after a ~5s delay behind a
      // real loading spinner (class="loading") — a genuine DOM-mutation /
      // detached-node / slow-render case on a real third-party host, not a
      // synthetic approximation of one.
      await page.waitForSelector('#finish h4', { state: 'visible', timeout: 10000 });
      await page.click('#finish h4');
    },
    paramOverride: null,
    expectUrlContains: null
  }
];

const logSection = (title) => console.log(`\n${'='.repeat(12)} ${title} ${'='.repeat(12)}`);

// runWorkflow deliberately never closes its browser on success (see its own
// comment — the point of "Run API" is letting a human watch the result), so
// back-to-back runWorkflow calls in this harness would otherwise accumulate
// live Chromium instances all competing for the same CPU/network — real
// resource contention that was directly observed turning an ordinary
// sub-second `.fill()` on a fresh input into a 30+ second one purely from
// system load, not any real replay-engine defect. Production's single
// "click Run, look at the window" usage pattern never hits this; a harness
// that calls runWorkflow repeatedly in a tight loop must clean up between
// calls to get a trustworthy signal.
const killLingeringChromium = () => {
  if (process.platform !== 'win32') {
    try { require('child_process').execSync('pkill -f chromium', { stdio: 'ignore' }); } catch (e) { /* none running */ }
    return;
  }
  // Playwright's actual headless process is chrome-headless-shell.exe, NOT
  // chrome.exe — killing only chrome.exe (as the earlier scratch harness
  // did) silently kills nothing, since Playwright never launches that name
  // in headless mode. Both are targeted here so cleanup actually works
  // regardless of which one a given Playwright/channel config launches.
  for (const image of ['chrome-headless-shell.exe', 'chrome.exe']) {
    try { require('child_process').execSync(`taskkill /F /IM ${image} /T`, { stdio: 'ignore' }); } catch (e) { /* none running */ }
  }
};

const runSite = async (site, ownerId) => {
  const siteReport = { name: site.name, stages: {}, ok: false, error: null };

  logSection(`RECORDING: ${site.name}`);
  const { events } = await recordWorkflow({ baseUrl: site.baseUrl, actions: [site.record] });
  siteReport.stages.recording = { eventCount: events.length, eventTypes: events.map((e) => e.type) };
  assert.ok(events.length > 0, `${site.name}: expected at least 1 recorded event, got 0`);
  console.log(`Recorded ${events.length} events:`, events.map((e) => e.type).join(', '));

  logSection(`PARAMETERIZING: ${site.name}`);
  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  siteReport.stages.parameterizing = { parameterCount: parameters.length, stepCount: steps.length };
  console.log(`Parameters: ${parameters.map((p) => `${p.name}="${p.defaultValue}"`).join(', ') || '(none)'}`);
  console.log(`Steps: ${steps.map((s) => `[${s.index}] ${s.type}`).join(', ')}`);

  logSection(`SAVING TO DB: ${site.name}`);
  const saved = workflowStore.saveWorkflow({
    ownerId,
    name: `realsite-e2e-${site.name}`,
    description: 'Automated reliability-harness recording',
    parameters,
    steps
  });
  siteReport.stages.saved = { workflowId: saved.workflowId };
  console.log(`Saved as workflowId=${saved.workflowId}`);

  logSection(`LOADING FROM DB: ${site.name}`);
  const loaded = workflowStore.getWorkflow(saved.workflowId);
  assert.ok(loaded, `${site.name}: failed to load workflow ${saved.workflowId} back from the DB`);
  assert.strictEqual(loaded.steps.length, steps.length, `${site.name}: step count changed across DB round-trip`);
  siteReport.stages.loaded = { stepCount: loaded.steps.length, parameterCount: loaded.parameters.length };
  console.log(`Loaded back ${loaded.steps.length} steps, ${loaded.parameters.length} parameter(s) — DB round-trip intact`);

  const defaultValues = {
    ...Object.fromEntries(loaded.parameters.map((p) => [p.name, p.defaultValue])),
    ...(site.forcedParamValues || {})
  };

  logSection(`REPLAYING (default values): ${site.name}`);
  const result = await runWorkflow({
    steps: loaded.steps,
    parameterValues: defaultValues,
    workflowId: `realsite-e2e-${site.name}-default`,
    extractionHint: loaded.extractionHint
  });
  const failedSteps = result.stepLog.filter((s) => s.result === 'failed');
  siteReport.stages.replayDefault = {
    finalUrl: result.finalUrl,
    stepCount: result.stepLog.length,
    failedSteps: failedSteps.map((s) => ({ index: s.index, type: s.type, reason: s.failureReason })),
    stepLog: result.stepLog.map((s) => ({
      index: s.index, type: s.type, result: s.result, strategyUsed: s.strategyUsed,
      retries: s.retries, matchCount: s.matchCount, visibleCount: s.visibleCount,
      forceClickFallbackUsed: s.forceClickFallbackUsed || false, jsClickFallbackUsed: s.jsClickFallbackUsed || false,
      blockersDismissed: s.blockersDismissed, durationMs: s.durationMs
    }))
  };
  assert.strictEqual(failedSteps.length, 0, `${site.name}: ${failedSteps.length} step(s) failed on replay: ${JSON.stringify(failedSteps.map((s) => s.reason))}`);

  if (site.expectUrlContains) {
    assert.ok(result.finalUrl.includes(site.expectUrlContains.default), `${site.name}: expected finalUrl to contain "${site.expectUrlContains.default}", got ${result.finalUrl}`);
  }

  if (site.paramOverride) {
    killLingeringChromium();
    logSection(`REPLAYING (overridden parameter value): ${site.name}`);
    const overriddenParamName = loaded.parameters[0]?.name;
    const overrideValues = { ...defaultValues, [overriddenParamName]: site.paramOverride.to };
    const overrideResult = await runWorkflow({
      steps: loaded.steps,
      parameterValues: overrideValues,
      workflowId: `realsite-e2e-${site.name}-override`,
      extractionHint: loaded.extractionHint
    });
    const overrideFailed = overrideResult.stepLog.filter((s) => s.result === 'failed');
    siteReport.stages.replayOverride = {
      finalUrl: overrideResult.finalUrl,
      failedSteps: overrideFailed.map((s) => ({ index: s.index, type: s.type, reason: s.failureReason }))
    };
    assert.strictEqual(overrideFailed.length, 0, `${site.name}: ${overrideFailed.length} step(s) failed on the overridden-value replay`);
    assert.ok(overrideResult.finalUrl.includes(site.expectUrlContains.override), `${site.name}: expected overridden finalUrl to contain "${site.expectUrlContains.override}", got ${overrideResult.finalUrl}`);
  }

  siteReport.ok = true;
  return siteReport;
};

(async () => {
  console.log('Replay engine REAL-SITE E2E verification harness\n');
  console.log(`(isolated test DB: ${process.env.DATABASE_DIR})`);

  const owner = await createUser({ email: `realsites-harness-${Date.now()}@example.com`, password: 'harness-only-not-a-real-account', name: 'Realsites Harness' });

  const reports = [];
  for (const site of SITES) {
    try {
      const report = await runSite(site, owner.id);
      reports.push(report);
      console.log(`\n✓ ${site.name} — all stages passed`);
    } catch (error) {
      reports.push({ name: site.name, ok: false, error: error.message, stack: error.stack });
      console.log(`\n✗ ${site.name} — FAILED: ${error.message}`);
    }
    // Never let one site's browser windows/processes bleed into the next.
    killLingeringChromium();
  }

  logSection('FULL REPORT');
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const reportPath = path.join(DEBUG_DIR, `realsites-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));

  const passed = reports.filter((r) => r.ok).length;
  for (const r of reports) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  }
  console.log(`\n${passed}/${reports.length} sites fully passed (record -> save -> load -> replay -> verify)`);
  console.log(`Full JSON report: ${reportPath}`);
  console.log(`Per-step screenshots/diagnostics: ${DEBUG_DIR}`);

  process.exit(passed === reports.length ? 0 : 1);
})().catch((error) => {
  console.error('HARNESS CRASHED:', error);
  process.exit(1);
});
