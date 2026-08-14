// V2 Phase 4 proof: an AI-generated workflow's parameters are not just
// display-only — changing one actually changes what the browser does on
// replay. Exercises the REAL, end-to-end, unmodified pipeline:
//
//   aiBrowserAgent.runBrowserAgent (records raw events)
//     -> ruleBasedParameterizer.parameterizeWorkflowRuleBased (the SAME
//        function workflowController.parameterize uses for a human
//        recording — turns the literal typed value into a real
//        {{placeholder}})
//     -> replayEngine.runWorkflow (the SAME function Run API/Test API
//        already use — substitutes the placeholder with whatever value is
//        supplied at replay time)
//
// Nothing here is mocked except decideNextAction (scripted, same technique
// as aiBrowserAgent.test.js) — no real AI provider call, but a REAL
// headless Chromium for both the "recording" and the "replay" halves.
//
// Run with: node backend/test/aiWorkflowParameterization.e2e.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { runBrowserAgent } = require('../services/aiBrowserAgent');
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { runWorkflow } = require('../services/replayEngine');

const encode = (html) => `data:text/html,${encodeURIComponent(html)}`;

// Submitting the field rewrites the page's own TITLE to encode exactly what
// was submitted — an observable, unambiguous proof available from
// runWorkflow's own return value (finalTitle), with no dependency on the
// separate result-extraction subsystem. Deliberately an in-place DOM
// mutation, not a real navigation: Chrome blocks script-triggered
// navigation to a new data: URL (a security restriction against data: URL
// phishing), which a JS-triggered `location.href = 'data:...'` would hit.
const FIXTURE_HTML = `<html><head><title>Search</title></head><body>
  <label for="q">Origin</label><input id="q" type="text" />
  <button id="go">Search</button>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.title = 'Result: ' + document.getElementById('q').value;
    });
  </script>
</body></html>`;

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

// Scripts a fixed decideNextAction sequence: type `initialValue` into the
// input, click Search, done. Mirrors exactly what a real AIProvider would
// decide for "fill this field, then submit" against this fixture.
const scriptedDecide = (initialValue) => {
  let i = 0;
  const script = [
    (snapshot) => ({ action: 'input', ref: snapshot.elements.find((el) => el.tag === 'input').ref, value: initialValue, reason: 'fill origin' }),
    (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'submit' }),
    () => ({ action: 'done', ref: null, value: null, reason: 'finished' })
  ];
  return async (snapshot) => {
    const step = script[i];
    i += 1;
    return step(snapshot);
  };
};

const run = async () => {
  await test('changing a generated API parameter changes the actual browser action on replay (Dhaka -> Chittagong)', async () => {
    // 1. AI-style recorded workflow contains an initial value ("Dhaka"),
    // recorded via the real aiBrowserAgent loop against a real page.
    const agentResult = await runBrowserAgent({
      intent: { task: 'Search for something', targetSite: { url: encode(FIXTURE_HTML) } },
      decideNextAction: scriptedDecide('Dhaka')
    });
    assert.strictEqual(agentResult.success, true, 'the scripted agent run should complete with done');
    // The initial navigation to targetSite.url is itself recorded as the
    // first event (see aiBrowserAgent.js) — without it, replay would start
    // from about:blank, same as a human recording always starts with one.
    assert.strictEqual(agentResult.steps.length, 3, 'expected an initial navigation, one input event, and one click event');
    assert.strictEqual(agentResult.steps[0].type, 'navigation');
    assert.strictEqual(agentResult.steps[1].value, 'Dhaka', 'the raw recorded event should still hold the literal typed value pre-parameterization');

    // 2. Parameterization converts the value into the existing {{name}}
    // placeholder format, via the REAL, unmodified ruleBasedParameterizer.
    const { parameters, steps } = parameterizeWorkflowRuleBased(agentResult.steps);
    assert.strictEqual(parameters.length, 1, 'expected exactly one parameter to be inferred from the single input event');
    const param = parameters[0];
    assert.strictEqual(param.defaultValue, 'Dhaka');
    assert.strictEqual(steps[1].type, 'input');
    assert.strictEqual(steps[1].value, `{{${param.name}}}`, 'the recorded step must now hold a real placeholder, not the literal value');

    // 3. The saved workflow/API would expose this parameter (workflowStore/
    // myApisStore are untouched passthroughs — proven separately in
    // aiCreatorController.test.js; here we go straight to the replay
    // contract those stores feed).

    // 4 & 5. Run/Test API supplies a DIFFERENT parameter value; replay
    // substitutes it — via the REAL, unmodified replayEngine.runWorkflow,
    // the exact function the existing Run API/Test API endpoints call.
    const replayResult = await runWorkflow({
      steps,
      parameterValues: { [param.name]: 'Chittagong' },
      workflowId: 'phase4-parameterization-proof'
    });

    // 6 & 7. The browser actually received "Chittagong" — proven by the
    // fixture's own title-echo, not an assumption about internal state.
    assert.ok(replayResult.finalTitle.includes('Chittagong'), `expected the replayed page to reflect the NEW parameter value; got title "${replayResult.finalTitle}"`);
    assert.ok(!replayResult.finalTitle.includes('Dhaka'), `the replayed page must NOT reflect the original recorded value; got title "${replayResult.finalTitle}"`);
  });

  await test('replaying with the ORIGINAL default value still works (sanity check on the fixture itself)', async () => {
    const agentResult = await runBrowserAgent({
      intent: { task: 'Search for something', targetSite: { url: encode(FIXTURE_HTML) } },
      decideNextAction: scriptedDecide('Paris')
    });
    const { parameters, steps } = parameterizeWorkflowRuleBased(agentResult.steps);

    const replayResult = await runWorkflow({
      steps,
      parameterValues: { [parameters[0].name]: 'Paris' },
      workflowId: 'phase4-parameterization-proof-default'
    });

    assert.ok(replayResult.finalTitle.includes('Paris'));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
