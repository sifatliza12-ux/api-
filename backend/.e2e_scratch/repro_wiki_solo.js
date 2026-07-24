process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';
const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

(async () => {
  console.log('recording...');
  const { events } = await recordWorkflow({
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    actions: [async (page) => {
      await page.click('#searchInput');
      await page.fill('#searchInput', 'Playwright (software)');
      await page.press('#searchInput', 'Enter');
      await page.waitForLoadState('domcontentloaded');
    }]
  });
  console.log('recorded', events.length, 'events');
  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('replaying...');
  const result = await runWorkflow({ steps, parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])), workflowId: 'wiki-retry', extractionHint: null });
  const failed = result.stepLog.filter((s) => s.result === 'failed');
  console.log('failedSteps', failed.length, 'finalUrl', result.finalUrl);
  process.exit(0);
})().catch((e) => { console.log('THREW', e.message); process.exit(1); });
