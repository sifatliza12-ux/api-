// Focused regression tests for aiBrowserAgent.js's interactability-aware
// candidate resolution — added after a real report: a live site's
// data-testid was shared by a hidden duplicate element (e.g. a
// desktop/mobile duplicated nav), so `.first()` on the shared-selector
// locator sometimes resolved to the HIDDEN one instead of the one
// pageSnapshotBuilder actually found visible, and the click hung for the
// full 10s action timeout before failing the whole generation run.
//
// Every fixture here is generic, hand-built HTML — nothing site-specific,
// no network access, no real AI provider (scripted decideNextAction, same
// technique aiBrowserAgent.test.js already uses).
//
// Run with: node backend/test/aiBrowserAgentInteractability.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { chromium } = require('playwright');
const { runBrowserAgent } = require('../services/aiBrowserAgent');

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

let browser;
let page;

const withPage = async (html, fn) => {
  await page.goto(encode(html), { waitUntil: 'domcontentloaded' });
  await fn();
};

const scriptedDecide = (script) => {
  let i = 0;
  const fn = async (snapshot) => {
    fn.calls += 1;
    if (i >= script.length) {
      throw new Error(`scriptedDecide exhausted after ${i} calls`);
    }
    const step = script[i];
    i += 1;
    return typeof step === 'function' ? step(snapshot) : step;
  };
  fn.calls = 0;
  return fn;
};

// Two elements sharing the exact same data-testid (a data-testid/class/
// structural selector describes a CLASS of elements, not the one specific
// node a snapshot inspected) — the first in DOM order is a hidden decoy,
// exactly the shape of a duplicated desktop/mobile layout. Only the
// visible one is ever findable in a fresh snapshot (pageSnapshotBuilder
// already filters correctly at snapshot time — this proves that).
const HIDDEN_DUPLICATE_HTML = `<html><body>
  <button data-testid="target-btn" style="display:none">Hidden Decoy</button>
  <button data-testid="target-btn" id="visible-target">Visible Target</button>
  <script>
    document.getElementById('visible-target').addEventListener('click', () => {
      document.title = 'Clicked: Visible Target';
    });
  </script>
</body></html>`;

// Same shape, but the decoy is disabled rather than hidden.
const DISABLED_DUPLICATE_HTML = `<html><body>
  <button data-testid="target-btn" disabled>Disabled Decoy</button>
  <button data-testid="target-btn" id="enabled-target">Enabled Target</button>
  <script>
    document.getElementById('enabled-target').addEventListener('click', () => {
      document.title = 'Clicked: Enabled Target';
    });
  </script>
</body></html>`;

// A button that IS visible by pageSnapshotBuilder's own check (non-zero
// size, display/visibility/opacity all fine — pageSnapshotBuilder doesn't
// check obscuring at all, deliberately: overlays are dynamic, a snapshot
// re-check wouldn't help) but is permanently covered by a full-viewport
// overlay at a higher stacking order. A second, genuinely reachable button
// sits above the overlay.
const OBSCURED_HTML = `<html><body>
  <button id="covered-btn" data-testid="covered-btn">Covered Button</button>
  <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.01);z-index:9999;"></div>
  <button id="rescue-btn" data-testid="rescue-btn" style="position:fixed;bottom:10px;right:10px;z-index:10000;">Rescue Button</button>
  <script>
    document.getElementById('covered-btn').addEventListener('click', () => { document.title = 'Clicked: Covered (should never happen)'; });
    document.getElementById('rescue-btn').addEventListener('click', () => { document.title = 'Clicked: Rescue Button'; });
  </script>
</body></html>`;

const SIMPLE_HTML = `<html><body>
  <button id="ok-btn" data-testid="ok-btn">OK Button</button>
  <script>
    document.getElementById('ok-btn').addEventListener('click', () => { document.title = 'Clicked: OK Button'; });
  </script>
</body></html>`;

const run = async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  page = await (await browser.newContext()).newPage();

  await test('a hidden duplicate sharing the same locator is rejected; the visible element the snapshot actually found is clicked instead', async () => {
    await withPage(HIDDEN_DUPLICATE_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => {
          const el = snapshot.elements.find((e) => e.name === 'Visible Target');
          assert.ok(el, 'expected pageSnapshotBuilder to report only the visible duplicate, not the hidden decoy');
          return { action: 'click', ref: el.ref, value: null, reason: 'click the visible target' };
        },
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Click it', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.finalTitle, 'Clicked: Visible Target', 'the click must land on the visible element, never the hidden decoy sharing its testid');
      assert.strictEqual(result.steps.length, 1);
    });
  });

  await test('a disabled duplicate sharing the same locator is rejected; the enabled element is clicked instead', async () => {
    await withPage(DISABLED_DUPLICATE_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => {
          const el = snapshot.elements.find((e) => e.name === 'Enabled Target');
          assert.ok(el, 'expected pageSnapshotBuilder to report only the enabled duplicate, not the disabled decoy');
          return { action: 'click', ref: el.ref, value: null, reason: 'click the enabled target' };
        },
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Click it', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.finalTitle, 'Clicked: Enabled Target', 'the click must land on the enabled element, never the disabled decoy sharing its testid');
    });
  });

  await test('an action failure caused by an obscured (non-interactable) element is reported back to the agent loop, not hung on the exact same impossible click', async () => {
    await withPage(OBSCURED_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => {
          const el = snapshot.elements.find((e) => e.name === 'Covered Button');
          assert.ok(el, 'pageSnapshotBuilder does not check obscuring — this element must still be snapshot-visible');
          return { action: 'click', ref: el.ref, value: null, reason: 'try the covered button' };
        },
        (snapshot) => {
          const el = snapshot.elements.find((e) => e.name === 'Rescue Button');
          return { action: 'click', ref: el.ref, value: null, reason: 'covered button failed — try the rescue button instead' };
        },
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const startedAt = Date.now();
      const result = await runBrowserAgent({ intent: { task: 'Click it', targetSite: {} }, page, decideNextAction: decide });
      const elapsedMs = Date.now() - startedAt;

      assert.strictEqual(result.success, true, 'the run must recover and still complete via the second action');
      assert.strictEqual(result.finalTitle, 'Clicked: Rescue Button', 'the covered button must never actually receive the click');
      assert.strictEqual(decide.calls, 3, 'the model must be asked again after the failed attempt, not left stuck');

      // The failed attempt is reported into history for the model to see,
      // and NOT recorded as a successful step (nothing actually happened).
      assert.strictEqual(result.history.length, 3);
      assert.strictEqual(result.history[0].outcome, 'failed');
      assert.ok(result.history[0].error, 'expected a human-readable reason for the first attempt failing');
      assert.strictEqual(result.steps.length, 1, 'only the successful rescue click should be recorded as a step');

      // The whole point of this fix: a single non-interactable candidate
      // must fail fast and move on, not consume the old 10s action timeout.
      assert.ok(elapsedMs < 8000, `expected the failed attempt to be reported back quickly, not hang toward the old 10s timeout; took ${elapsedMs}ms`);
    });
  });

  await test('an existing valid, unambiguous click action still works exactly as before', async () => {
    await withPage(SIMPLE_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => ({ action: 'click', ref: snapshot.elements.find((e) => e.name === 'OK Button').ref, value: null, reason: 'click it' }),
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Click it', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.finalTitle, 'Clicked: OK Button');
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(result.steps[0].type, 'click');
    });
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
