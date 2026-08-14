// Tests for aiBrowserAgent.js (V2 Phase 2 browser-action agent loop).
// Drives a real headless Chromium page against hand-built data: URL
// fixtures (same technique as pageSnapshotBuilder.test.js) with a scripted,
// injected `decideNextAction` — no real AI provider or network call, so
// this suite is deterministic and doesn't touch Ollama/Anthropic at all.
//
// Run with: node backend/test/aiBrowserAgent.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { chromium } = require('playwright');
const { runBrowserAgent, BrowserAgentError } = require('../services/aiBrowserAgent');

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

// Wraps a fixed sequence of steps (plain action objects, or functions of the
// live snapshot for tests that need to look up a ref dynamically) into a
// decideNextAction-shaped function, plus a call counter for asserting a
// step was (or wasn't) reached.
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

const FORM_HTML = `<html><body>
  <label for="q">Query</label><input id="q" type="text" />
  <button id="go">Search</button>
</body></html>`;

const LOGIN_WALL_HTML = `<html><body>
  <p>Please log in to continue</p>
  <input type="password" id="pw" />
</body></html>`;

const run = async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  page = await (await browser.newContext()).newPage();

  await test('runs input -> click -> done, returning success and replay-shaped steps', async () => {
    await withPage(FORM_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => ({ action: 'input', ref: snapshot.elements.find((el) => el.tag === 'input').ref, value: 'hello', reason: 'fill query' }),
        (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'submit' }),
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Search something', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.stopped, false);
      assert.strictEqual(decide.calls, 3);
      assert.strictEqual(result.steps.length, 2);

      assert.strictEqual(result.steps[0].type, 'input');
      assert.strictEqual(result.steps[0].value, 'hello');
      assert.ok(Array.isArray(result.steps[0].locators) && result.steps[0].locators.length, 'input step should carry locator candidates');

      assert.strictEqual(result.steps[1].type, 'click');
      assert.strictEqual(result.history.length, 3);
    });
  });

  await test('records a navigation action as a plain {type: "navigation", value} step', async () => {
    await withPage(FORM_HTML, async () => {
      const target = encode('<html><body><p>landed</p></body></html>');
      const decide = scriptedDecide([
        () => ({ action: 'navigation', ref: null, value: target, reason: 'go to results' }),
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Go somewhere', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.steps[0], { type: 'navigation', value: target });
      assert.strictEqual(result.finalUrl, target);
    });
  });

  await test('stops with stopReason "model_stop" and executes nothing further when the model returns stop', async () => {
    await withPage(FORM_HTML, async () => {
      const decide = scriptedDecide([
        () => ({ action: 'stop', ref: null, value: null, reason: 'cannot proceed safely' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'X', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stopped, true);
      assert.strictEqual(result.stopReason, 'model_stop');
      assert.strictEqual(result.message, 'cannot proceed safely');
      assert.strictEqual(result.steps.length, 0);
    });
  });

  await test('stops with stopReason "max_steps_exceeded" after the configured cap, without ever calling done', async () => {
    await withPage(FORM_HTML, async () => {
      const decide = scriptedDecide([
        (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'again' }),
        (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'again' }),
        (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'again' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'X', targetSite: {} }, page, decideNextAction: decide, maxSteps: 2 });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stopReason, 'max_steps_exceeded');
      assert.strictEqual(result.steps.length, 2);
      assert.strictEqual(decide.calls, 2, 'must not ask for a 3rd decision once maxSteps is reached');
    });
  });

  await test('detects a login wall and stops WITHOUT ever calling decideNextAction', async () => {
    await withPage(LOGIN_WALL_HTML, async () => {
      const decide = scriptedDecide([]); // any call throws "exhausted"

      const result = await runBrowserAgent({ intent: { task: 'X', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stopReason, 'login_wall');
      assert.strictEqual(decide.calls, 0, 'the model must never be consulted on a detected auth wall');
    });
  });

  await test('throws BrowserAgentError when the decided ref is not in the live snapshot', async () => {
    await withPage(FORM_HTML, async () => {
      const decide = scriptedDecide([
        () => ({ action: 'click', ref: 'e999', value: null, reason: 'bogus ref' })
      ]);

      await assert.rejects(
        () => runBrowserAgent({ intent: { task: 'X', targetSite: {} }, page, decideNextAction: decide }),
        BrowserAgentError
      );
    });
  });

  await test('rejects a call with no intent', async () => {
    await assert.rejects(() => runBrowserAgent({ page, decideNextAction: scriptedDecide([]) }), BrowserAgentError);
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
