process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

(async () => {
  const { events } = await recordWorkflow({
    baseUrl: 'https://www.youtube.com/',
    actions: [
      async (page) => {
        page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  [framenavigated]', f.url()); });
        page.on('console', (msg) => { if (msg.text().includes('[Recorder]')) console.log('  [console]', msg.text()); });
        console.log('>> about to click search box');
        await page.click('input#search, input[name="search_query"]');
        console.log('>> clicked, about to fill');
        await page.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
        console.log('>> filled, about to press Enter');
        await page.press('input#search, input[name="search_query"]', 'Enter');
        console.log('>> pressed Enter, waiting for results url');
        await page.waitForURL('**results**', { timeout: 10000 }).catch(() => {});
        console.log('>> done waiting, url=', page.url());
      }
    ]
  });

  events.forEach((e, i) => {
    console.log(`\n--- [${i}] ${e.type} ---`);
    console.log('selector:', e.selector);
    console.log('locators:', JSON.stringify(e.locators, null, 2));
  });

  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('\n=== STEPS ===');
  steps.forEach((s) => console.log(`[${s.index}] ${s.type} selector=${s.selector} locators=${JSON.stringify(s.locators)}`));

  try {
    const result = await runWorkflow({
      steps,
      parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
      workflowId: 'repro-youtube',
      extractionHint: null
    });
    console.log('\nfinalUrl', result.finalUrl);
  } catch (err) {
    console.log('THREW:', err.message);
  }
  process.exit(0);
})().catch((err) => { console.error('CRASH', err); process.exit(1); });
