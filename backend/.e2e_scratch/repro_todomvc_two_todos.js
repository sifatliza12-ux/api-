process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');
const { condenseEvents } = require('../services/eventCondenser');

(async () => {
  const { events } = await recordWorkflow({
    baseUrl: 'https://todomvc.com/examples/vue/dist/',
    actions: [
      async (page) => {
        await page.click('.new-todo');
        await page.fill('.new-todo', 'Buy milk');
        await page.press('.new-todo', 'Enter');
        await page.waitForSelector('.todo-list li', { timeout: 5000 });
      },
      async (page) => {
        await page.fill('.new-todo', 'Buy eggs');
        await page.press('.new-todo', 'Enter');
        await page.waitForFunction(() => document.querySelectorAll('.todo-list li').length >= 2, { timeout: 5000 });
      },
      async (page) => {
        // Toggle the SECOND todo (Buy eggs)
        await page.click('.todo-list li:nth-child(2) .toggle');
        await page.waitForSelector('.todo-list li.completed', { timeout: 5000 });
      }
    ]
  });

  console.log('=== RAW EVENTS ===');
  events.forEach((e, i) => console.log(`[${i}] ${e.type} selector=${e.selector} value=${JSON.stringify(e.value)}`));

  console.log('\n=== CONDENSED EVENTS ===');
  const condensed = condenseEvents(events);
  condensed.forEach((e) => console.log(`[${e.index}] (orig ${e.originalIndex}) ${e.type} selector=${e.selector} value=${JSON.stringify(e.value)}`));

  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('\n=== PARAMETERS ===');
  parameters.forEach((p) => console.log(`${p.name} = ${JSON.stringify(p.defaultValue)}`));

  console.log('\n=== REPLAY ===');
  try {
    const result = await runWorkflow({
      steps,
      parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
      workflowId: 'repro-two-todos',
      extractionHint: null
    });
    const failed = result.stepLog.filter((s) => s.result === 'failed');
    console.log('Failed steps:', failed.length);
    failed.forEach((s) => console.log(JSON.stringify(s, null, 2)));
    console.log('Final URL:', result.finalUrl);
  } catch (err) {
    console.log('Replay THREW:', err.message);
    if (err.stepLog) err.stepLog.forEach((s) => console.log(JSON.stringify(s)));
  }

  process.exit(0);
})().catch((err) => {
  console.error('REPRO SCRIPT CRASHED:', err);
  process.exit(1);
});
