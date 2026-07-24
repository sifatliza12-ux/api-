// Reproduction script: records a real TodoMVC session (add a todo, toggle its
// checkbox) using the ACTUAL content.js locator-capture logic, then feeds the
// captured events through the ACTUAL ruleBasedParameterizer + replayEngine to
// see exactly what locator candidates got recorded for the toggle checkbox
// and whether replay actually succeeds.
process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

(async () => {
  const { events } = await recordWorkflow({
    baseUrl: 'https://todomvc.com/examples/react/dist/',
    actions: [
      async (page) => {
        await page.click('.new-todo');
        await page.fill('.new-todo', 'Buy milk');
        await page.press('.new-todo', 'Enter');
        await page.waitForSelector('.todo-list li', { timeout: 5000 });
      },
      async (page) => {
        await page.click('.todo-list li .toggle');
        await page.waitForSelector('.todo-list li.completed', { timeout: 5000 });
      }
    ]
  });

  console.log('Captured', events.length, 'raw events');
  events.forEach((e, i) => {
    console.log(`\n--- event ${i}: ${e.type} ---`);
    console.log('selector:', e.selector);
    console.log('locators:', JSON.stringify(e.locators, null, 2));
  });

  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('\n\n=== STEPS AFTER PARAMETERIZATION ===');
  steps.forEach((s) => console.log(`[${s.index}] ${s.type} selector=${s.selector} locators=${JSON.stringify(s.locators)}`));

  console.log('\n\n=== REPLAY ===');
  try {
    const result = await runWorkflow({
      steps,
      parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
      workflowId: 'repro-todomvc',
      extractionHint: null
    });
    console.log('Replay result success. stepLog:');
    result.stepLog.forEach((s) => console.log(`  [${s.index}] ${s.type} result=${s.result} reason=${s.failureReason || ''}`));
  } catch (err) {
    console.log('Replay THREW:', err.message);
    if (err.stepLog) {
      err.stepLog.forEach((s) => console.log(`  [${s.index}] ${s.type} result=${s.result} reason=${s.failureReason || ''}`));
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('REPRO SCRIPT CRASHED:', err);
  process.exit(1);
});
