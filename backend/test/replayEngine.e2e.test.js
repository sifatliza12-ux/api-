// End-to-end replay engine test suite. Unlike the unit-style checks that
// hand-build a `steps` array, the primary test here (recordThenReplaySpa)
// drives the ACTUAL recording pipeline: the real extension/content/
// content.js, injected into a real Playwright page, capturing real DOM
// events from real interactions, fed through the real
// ruleBasedParameterizer.js, then replayed through the real
// replayEngine.js — the same code path production uses end to end, not an
// approximation of it. This is what proves a workflow recorded moments
// earlier can be replayed successfully, repeatedly, in the same run.
//
// Run with: node backend/test/replayEngine.e2e.test.js
// (No test framework dependency — plain Node + assert, consistent with
// the rest of this backend having none.)
process.env.FORGEFLOW_HEADLESS = process.env.FORGEFLOW_HEADLESS || 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { startTestSpaServer } = require('./fixtures/testSpaServer');
const { recordWorkflow } = require('./fixtures/recordingHarness');
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { runWorkflow } = require('../services/replayEngine');

const encode = (html) => `data:text/html,${encodeURIComponent(html)}`;

const results = [];

const test = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`  ✗ ${name} (${Date.now() - started}ms)`);
    console.log(`      ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// Primary test: record a real workflow against a realistic local "modern
// SPA" (dynamic IDs, debounced autocomplete, native-form navigation, a
// post-navigation consent overlay) using the REAL content.js, parameterize
// it with the REAL parameterizer, then replay it multiple times — with the
// SAME value and with a DIFFERENT one — proving the full pipeline holds up,
// not just replayEngine.js in isolation.
// ---------------------------------------------------------------------------
const recordThenReplaySpa = async () => {
  const server = await startTestSpaServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/`;

  try {
    const { events } = await recordWorkflow({
      baseUrl,
      actions: [
        (page) => page.fill('input[placeholder="Search destinations"]', 'Paris'),
        async (page) => {
          await page.waitForSelector('[role="option"]', { timeout: 3000 });
          await page.click('[role="option"]:has-text("Paris, France")');
        },
        async (page) => {
          await page.click('button[aria-label="Search trips"]');
          await page.waitForLoadState('domcontentloaded');
        }
      ]
    });

    assert.ok(events.length >= 5, `expected at least 5 recorded events, got ${events.length}`);

    const { parameters, steps } = parameterizeWorkflowRuleBased(events);
    assert.strictEqual(parameters.length, 1, `expected exactly 1 parameter, got ${parameters.length}`);
    assert.strictEqual(parameters[0].defaultValue, 'Paris', `expected the destination parameter's default to be "Paris", got "${parameters[0].defaultValue}"`);

    const paramName = parameters[0].name;

    // Same recorded value, 3 consecutive replays — proves consistency, not
    // a one-off fluke.
    for (let run = 1; run <= 3; run += 1) {
      const result = await runWorkflow({
        steps,
        parameterValues: { [paramName]: 'Paris' },
        workflowId: `e2e-test-run-${run}`,
        extractionHint: null
      });
      const failed = result.stepLog.filter((s) => s.result === 'failed');
      assert.strictEqual(failed.length, 0, `run ${run}: ${failed.length} step(s) failed: ${JSON.stringify(failed.map((s) => s.failureReason))}`);
      assert.ok(result.finalUrl.includes('Paris'), `run ${run}: expected finalUrl to contain "Paris", got ${result.finalUrl}`);
    }

    // A DIFFERENT parameter value — proves this isn't just replaying a
    // frozen recording, the substitution genuinely drives a different
    // outcome end to end.
    const overrideResult = await runWorkflow({
      steps,
      parameterValues: { [paramName]: 'Tokyo, Japan' },
      workflowId: 'e2e-test-run-override',
      extractionHint: null
    });
    const overrideFailed = overrideResult.stepLog.filter((s) => s.result === 'failed');
    assert.strictEqual(overrideFailed.length, 0, `override run: ${overrideFailed.length} step(s) failed`);
    assert.ok(overrideResult.finalUrl.includes('Tokyo'), `override run: expected finalUrl to contain "Tokyo", got ${overrideResult.finalUrl}`);
  } finally {
    server.close();
  }
};

// ---------------------------------------------------------------------------
// Focused regression checks for each previously-fixed failure mode —
// hand-built steps, direct runWorkflow calls, fast and deterministic.
// ---------------------------------------------------------------------------

const overlayJsClickFallback = async () => {
  const html = `<html><body><button id="target" onclick="window.__c='t'">Book</button><div style="position:fixed;inset:0;background:white;z-index:1000;"></div></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'click', selector: '#target', locators: [{ strategy: 'css', value: '#target' }], value: '', meta: { tag: 'button' } }
    ],
    parameterValues: {},
    workflowId: 'e2e-test-overlay-fallback',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the click to recover from a permanent overlay via force/JS-click fallback');
};

const cookieBannerAutoDismiss = async () => {
  const html = `<html><body><button id="target" onclick="window.__c='t'">Book</button><div id="cb" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;"><button aria-label="Accept all" onclick="document.getElementById('cb').remove()">Accept</button></div></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'click', selector: '#target', locators: [{ strategy: 'css', value: '#target' }], value: '', meta: { tag: 'button' } }
    ],
    parameterValues: {},
    workflowId: 'e2e-test-cookie-banner',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the click to succeed after auto-dismissing the cookie banner');
};

const calendarMonthsForward = async () => {
  const html = `<html><body>
<div role="application"><div role="heading" id="cap"></div><button aria-label="Next month" id="next">Next</button><div role="grid" id="grid"></div></div>
<script>
let cur = new Date(2026,0,1);
const mn=['January','February','March','April','May','June','July','August','September','October','November','December'];
function render(delay){ document.getElementById('grid').innerHTML=''; setTimeout(()=>{
  document.getElementById('cap').textContent = mn[cur.getMonth()]+' '+cur.getFullYear();
  const days = new Date(cur.getFullYear(),cur.getMonth()+1,0).getDate();
  let h=''; for(let d=1;d<=days;d++){ const iso=cur.getFullYear()+'-'+String(cur.getMonth()+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); h+='<span data-date="'+iso+'" onclick="window.__p=\\''+iso+'\\'">'+d+'</span>'; }
  document.getElementById('grid').innerHTML=h;
}, delay||0); }
document.getElementById('next').addEventListener('click', ()=>{cur.setMonth(cur.getMonth()+1); render(200);});
render(0);
</script></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'calendar_date', selector: 'span', locators: null, value: '{{checkin}}', meta: null }
    ],
    parameterValues: { checkin: '2026-04-10' },
    workflowId: 'e2e-test-calendar',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the calendar to navigate 3 months forward and select the target date');
};

const skipLinkRejected = async () => {
  const html = `<html><body><span style="position:absolute;top:-9999px;">Skip to main content</span><span onclick="window.__c='real'">Book Now</span></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'click', selector: 'span', locators: null, value: '', meta: { tag: 'span' } }
    ],
    parameterValues: {},
    workflowId: 'e2e-test-skip-link',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the click to skip the offscreen "Skip to main content" link and find the real target');
};

const hiddenDuplicateRejected = async () => {
  const html = `<html><body><button class="a" style="display:none">Hidden</button><button class="a" onclick="window.__c='v'">Visible</button></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'click', selector: '.a', locators: [{ strategy: 'css', value: '.a' }], value: '', meta: { tag: 'button' } }
    ],
    parameterValues: {},
    workflowId: 'e2e-test-hidden-duplicate',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the click to skip a hidden duplicate match and find the visible one');
};

const dynamicClickNormalCase = async () => {
  const html = `<html><body><div role="listbox"><span role="option" onclick="window.__c='picked'">Paris, France</span></div></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'dynamic_click', selector: 'span', locators: null, value: '{{dest}}', meta: null }
    ],
    parameterValues: { dest: 'Paris, France' },
    workflowId: 'e2e-test-dynamic-click-normal',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected a normal (non-race) dynamic_click to still succeed');
  assert.notStrictEqual(result.stepLog[1].strategyUsed, 'navigation-already-occurred', 'the abort-on-navigation guard should not fire when nothing navigated');
};

// Generic reproduction of the "tried 1 locator candidate(s)" failure mode:
// the recorded/requested value never appears as visible text on the page at
// all (site copy changed, different content on this replay, or — as seen in
// production — the expected content simply never rendered), while the
// element itself is still uniquely identifiable by its recorded structural
// selector. Nothing about this scenario names any real site; it only
// exercises getCandidateList's narrowing + waitForActionableElement's
// widening.
const dynamicClickFallbackWhenLiveTextMissing = async () => {
  const html = `<html><body><div role="listbox"><span class="opt-only" onclick="window.__c='picked'">Nairobi, Kenya</span></div></body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'dynamic_click', selector: '.opt-only', locators: null, value: '{{dest}}', meta: null }
    ],
    parameterValues: { dest: 'London, United Kingdom' },
    workflowId: 'e2e-test-dynamic-click-fallback',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the dynamic_click to fall back to its recorded structural selector once the live-value text never appears');
  assert.strictEqual(result.stepLog[1].strategyUsed, 'css', 'expected the recorded structural candidate, not the live-value text candidate, to be what actually matched');
};

// Proves the widening in the test above did NOT reopen the historical race
// it's built to avoid: a stale, already-present, currently-clickable decoy
// sitting under the same generic structural selector from the moment the
// page loads, while the REAL (live-value) option only renders after a
// short delay — exactly what a debounced autocomplete does. The decoy must
// never win just because the fallback widened; the live-value candidate is
// checked first every round and must still win once it genuinely appears.
const dynamicClickRaceSafetyPreserved = async () => {
  const html = `<html><body>
<div role="listbox"><span class="opt-only" onclick="window.__c='decoy'">Dhaka, Bangladesh</span></div>
<script>
setTimeout(() => {
  document.querySelector('[role="listbox"]').innerHTML =
    '<span class="opt-only" onclick="window.__c=\\'picked\\'">London, United Kingdom</span>';
}, 800);
</script>
</body></html>`;
  const result = await runWorkflow({
    steps: [
      { index: 0, type: 'navigation', value: encode(html), meta: null },
      { index: 1, type: 'dynamic_click', selector: '.opt-only', locators: null, value: '{{dest}}', meta: null }
    ],
    parameterValues: { dest: 'London, United Kingdom' },
    workflowId: 'e2e-test-dynamic-click-race',
    extractionHint: null
  });
  assert.strictEqual(result.stepLog[1].result, 'success', 'expected the dynamic_click to succeed once the real suggestion renders');
  assert.strictEqual(result.stepLog[1].strategyUsed, 'text', 'expected the LIVE VALUE candidate to win the click, not the structural fallback matching the decoy');
};

(async () => {
  console.log('Replay engine E2E test suite\n');

  await test('record + replay x3 + override (real content.js, real parameterizer, real replay)', recordThenReplaySpa);
  await test('overlay recovery: force/JS-click fallback on a permanently covered element', overlayJsClickFallback);
  await test('overlay recovery: cookie banner auto-dismissed after navigation', cookieBannerAutoDismiss);
  await test('calendar: month-aware navigation reaches a target 3 months forward', calendarMonthsForward);
  await test('visibility: off-screen "Skip to main content" link is rejected in favor of the real target', skipLinkRejected);
  await test('visibility: hidden duplicate match is rejected in favor of the visible one', hiddenDuplicateRejected);
  await test('dynamic_click: normal case (no race) still succeeds', dynamicClickNormalCase);
  await test('dynamic_click: falls back to recorded structural selector when live-value text never appears', dynamicClickFallbackWhenLiveTextMissing);
  await test('dynamic_click: fallback widening does not reopen the stale-decoy race', dynamicClickRaceSafetyPreserved);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);

  process.exit(failed > 0 ? 1 : 0);
})();
