process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

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
        await page.click('.todo-list li .toggle');
        await page.waitForSelector('.todo-list li.completed', { timeout: 5000 });
      }
    ]
  });

  console.log('Captured', events.length, 'raw events');
  const toggleEvent = events.find((e) => e.type === 'click' && e.selector && e.selector.includes('toggle') || (e.type==='click' && JSON.stringify(e.locators||'').includes('toggle')));
  events.filter(e=>e.type==='click').forEach((e,i) => {
    console.log(`\n--- click event: selector=${e.selector} ---`);
    console.log('locators:', JSON.stringify(e.locators, null, 2));
  });

  const { parameters, steps } = parameterizeWorkflowRuleBased(events);

  console.log('\n=== REPLAY (fresh context, single todo present) ===');
  try {
    const result = await runWorkflow({
      steps,
      parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
      workflowId: 'repro-todomvc-vue',
      extractionHint: null
    });
    const failed = result.stepLog.filter((s) => s.result === 'failed');
    console.log('Replay finished. Failed steps:', failed.length);
    failed.forEach((s) => console.log(JSON.stringify(s, null, 2)));
  } catch (err) {
    console.log('Replay THREW:', err.message);
    if (err.stepLog) err.stepLog.forEach((s) => console.log(JSON.stringify(s)));
  }

  process.exit(0);
})().catch((err) => {
  console.error('REPRO SCRIPT CRASHED:', err);
  process.exit(1);
});
