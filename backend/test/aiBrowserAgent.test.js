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

      // steps are RAW RECORDED EVENTS (ruleBasedParameterizer.js's input
      // shape), not replay-ready steps — see aiBrowserAgent.js's doc
      // comment. selector/meta.fieldContext are what let the parameterizer
      // name a real {{placeholder}}.
      assert.strictEqual(result.steps[0].type, 'input');
      assert.strictEqual(result.steps[0].value, 'hello');
      assert.ok(Array.isArray(result.steps[0].locators) && result.steps[0].locators.length, 'input step should carry locator candidates');
      assert.ok(result.steps[0].selector, 'input event should carry a single CSS selector string');
      assert.strictEqual(result.steps[0].meta.fieldContext.label, 'Query', 'field label should flow through into meta.fieldContext for parameter naming');

      assert.strictEqual(result.steps[1].type, 'click');
      assert.strictEqual(result.steps[1].value, 'Search', "a click event's value should be the clicked element's own text");
      assert.strictEqual(result.history.length, 3);
    });
  });

  await test('records a navigation action as a raw navigation event (type/value/url, no selector)', async () => {
    await withPage(FORM_HTML, async () => {
      const target = encode('<html><body><p>landed</p></body></html>');
      const decide = scriptedDecide([
        () => ({ action: 'navigation', ref: null, value: target, reason: 'go to results' }),
        () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
      ]);

      const result = await runBrowserAgent({ intent: { task: 'Go somewhere', targetSite: {} }, page, decideNextAction: decide });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.steps[0].type, 'navigation');
      assert.strictEqual(result.steps[0].value, target);
      assert.strictEqual(result.steps[0].url, target, 'ruleBasedParameterizer reads event.url for navigation linking');
      assert.strictEqual(result.steps[0].selector, null);
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

  // --- Generic target-site discovery (Phase 5) ----------------------------
  // The agent's start-URL resolution is exercised with an INJECTED discover
  // function (siteDiscovery is unit-tested separately in siteDiscovery.test.js),
  // so these stay deterministic and offline while proving the branching:
  // a null-URL named target triggers discovery; a trustworthy URL bypasses it;
  // an ambiguous/unreachable outcome stops cleanly without running the loop;
  // a model-guessed URL is handed to discovery as a seed; and a discovered URL
  // feeds the existing decision loop and is recorded as the first step.

  const DISCOVERED_SITE = encode(FORM_HTML);
  const USER_SITE = encode('<html><body><p>user supplied site</p></body></html>');

  await test('discovery: a named target with a null URL triggers discovery, and the discovered URL seeds + records the run', async () => {
    let discoverArgs = null;
    const discover = async (args) => { discoverArgs = args; return { status: 'discovered', url: DISCOVERED_SITE }; };
    const decide = scriptedDecide([
      (snapshot) => ({ action: 'input', ref: snapshot.elements.find((el) => el.tag === 'input').ref, value: 'microwave', reason: 'fill' }),
      (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'submit' }),
      () => ({ action: 'done', ref: null, value: null, reason: 'done' })
    ]);

    const result = await runBrowserAgent({
      intent: { task: 'search for microwave', targetSite: { name: 'Walton', url: null } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.ok(discoverArgs, 'discovery must be invoked when the URL is null but a name is present');
    assert.strictEqual(discoverArgs.targetName, 'Walton');
    assert.strictEqual(discoverArgs.seedUrl, null, 'no model URL to seed with here');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps[0].type, 'navigation');
    assert.strictEqual(result.steps[0].url, DISCOVERED_SITE, 'the discovered URL must be recorded as the first navigation step so replay reproduces it');
    assert.strictEqual(result.steps.length, 3, 'nav + input + click');
  });

  await test('discovery: an explicit user-supplied (trustworthy) URL bypasses discovery entirely', async () => {
    let called = false;
    const discover = async () => { called = true; return { status: 'discovered', url: 'about:blank' }; };
    const decide = scriptedDecide([() => ({ action: 'done', ref: null, value: null, reason: 'done' })]);

    const result = await runBrowserAgent({
      intent: { task: 'x', targetSite: { name: 'Walton', url: USER_SITE, urlSource: 'user' } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(called, false, 'a user-supplied URL must never trigger discovery');
    assert.strictEqual(result.steps[0].url, USER_SITE, 'the trustworthy URL is navigated to directly');
    assert.strictEqual(result.success, true);
  });

  await test('discovery: a legacy intent carrying a URL but no urlSource keeps the existing direct-navigation behavior', async () => {
    let called = false;
    const discover = async () => { called = true; return { status: 'unreachable', reason: 'should not run' }; };
    const decide = scriptedDecide([() => ({ action: 'done', ref: null, value: null, reason: 'done' })]);

    const result = await runBrowserAgent({
      intent: { task: 'x', targetSite: { url: USER_SITE } }, // no urlSource, no name — pre-Phase-5 shape
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(called, false, 'a legacy URL-only intent must behave exactly as before (direct navigation)');
    assert.strictEqual(result.steps[0].url, USER_SITE);
    assert.strictEqual(result.success, true);
  });

  await test('discovery: an AMBIGUOUS outcome stops the run cleanly and never consults the model', async () => {
    const discover = async () => ({ status: 'ambiguous', candidates: [{ host: 'apollo.com' }, { host: 'apollo.io' }], reason: 'several matched' });
    const decide = scriptedDecide([]); // any call throws "exhausted"

    const result = await runBrowserAgent({
      intent: { task: 'x', targetSite: { name: 'Apollo', url: null } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stopReason, 'target_ambiguous');
    assert.strictEqual(decide.calls, 0, 'the model must never be consulted when the target itself is unresolved');
    assert.strictEqual(result.steps.length, 0, 'no workflow steps are recorded when the target was never reached');
    assert.ok(/apollo/i.test(result.message), 'the honest message should surface the candidate sites for the user to choose');
  });

  await test('discovery: an UNREACHABLE outcome stops the run cleanly with an honest reason', async () => {
    const discover = async () => ({ status: 'unreachable', candidates: [], reason: 'no usable candidates' });
    const decide = scriptedDecide([]);

    const result = await runBrowserAgent({
      intent: { task: 'x', targetSite: { name: 'Nonexistent Whatsit', url: null } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stopReason, 'target_unreachable');
    assert.strictEqual(decide.calls, 0);
  });

  await test('discovery: a MODEL-guessed URL is handed to discovery as a seed, never navigated to blindly', async () => {
    let discoverArgs = null;
    const discover = async (args) => { discoverArgs = args; return { status: 'discovered', url: DISCOVERED_SITE }; };
    const decide = scriptedDecide([() => ({ action: 'done', ref: null, value: null, reason: 'done' })]);

    await runBrowserAgent({
      intent: { task: 'x', targetSite: { name: 'Walton', url: 'https://model-guess.example/', urlSource: 'model' } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.ok(discoverArgs, 'a model-sourced URL must go through discovery, not direct navigation');
    assert.strictEqual(discoverArgs.seedUrl, 'https://model-guess.example/', 'the model guess is passed as a seed to VERIFY, not trusted outright');
    assert.strictEqual(discoverArgs.targetName, 'Walton');
  });

  await test('discovery: a task-only (low-confidence) intent asks discovery to auto-select its best candidate', async () => {
    let discoverArgs = null;
    const discover = async (args) => { discoverArgs = args; return { status: 'discovered', url: DISCOVERED_SITE }; };
    const decide = scriptedDecide([() => ({ action: 'done', ref: null, value: null, reason: 'done' })]);

    await runBrowserAgent({
      // needsConfirmation:true == the parser wasn't sure of the site, i.e. the user described a task without naming one.
      intent: { task: 'find hotels', targetSite: { name: 'hotel booking site', url: null, needsConfirmation: true } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(discoverArgs.autoSelectBest, true, 'a task-only request should let discovery auto-select its best candidate rather than block');
  });

  await test('discovery: an explicitly-named (high-confidence) intent does NOT auto-select — the strict ambiguity gate is preserved', async () => {
    let discoverArgs = null;
    const discover = async (args) => { discoverArgs = args; return { status: 'discovered', url: DISCOVERED_SITE }; };
    const decide = scriptedDecide([() => ({ action: 'done', ref: null, value: null, reason: 'done' })]);

    await runBrowserAgent({
      intent: { task: 'search', targetSite: { name: 'Daraz', url: null, needsConfirmation: false } },
      page, decideNextAction: decide, discoverTargetSite: discover
    });

    assert.strictEqual(discoverArgs.autoSelectBest, false, 'an explicitly-named site keeps the strict ambiguity behavior unchanged');
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
