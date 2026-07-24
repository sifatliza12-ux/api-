const { startServer, recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

const logSection = (title) => console.log(`\n${'='.repeat(10)} ${title} ${'='.repeat(10)}`);

(async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/`;

  logSection('STAGE 1: RECORDING (real content.js, real DOM events)');

  const { events, finalUrl: recordedFinalUrl } = await recordWorkflow({
    baseUrl,
    actions: [
      async (page) => {
        // Real typing — dispatches real 'input' events content.js listens for.
        await page.fill('input[placeholder="Search destinations"]', 'Paris');
      },
      async (page) => {
        // Wait for the debounced (350ms) suggestion list to actually render —
        // a real user would wait for this too.
        await page.waitForSelector('[role="option"]', { timeout: 3000 });
        await page.click('[role="option"]:has-text("Paris, France")');
      },
      async (page) => {
        await page.click('button[aria-label="Search trips"]');
        await page.waitForLoadState('domcontentloaded');
      }
    ]
  });

  console.log('Raw events captured:', events.length);
  console.log('Recorded final URL:', recordedFinalUrl);
  console.log('Event types:', events.map((e) => e.type).join(', '));

  logSection('STAGE 2: PARAMETERIZATION (real ruleBasedParameterizer.js)');

  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('Parameters extracted:', parameters.length);
  parameters.forEach((p) => console.log(`  - ${p.name} (${p.type}): "${p.defaultValue}"`));
  console.log('Steps:', steps.length);
  steps.forEach((s) => console.log(`  [${s.index}] ${s.type} value=${JSON.stringify(s.value)} selector=${s.selector || '(locators)'}`));

  logSection('STAGE 3: REPLAY — same value as recorded, 3 consecutive runs');

  const destinationParam = parameters.find((p) => p.name.toLowerCase().includes('dest') || p.defaultValue === 'Paris, France') || parameters[0];
  console.log('Using parameter for override testing:', destinationParam?.name);

  for (let run = 1; run <= 3; run += 1) {
    const started = Date.now();
    try {
      const result = await runWorkflow({
        steps,
        parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
        workflowId: `e2e-run-${run}`,
        extractionHint: null
      });
      const failedSteps = result.stepLog.filter((s) => s.result === 'failed');
      console.log(`Run ${run}: SUCCESS in ${Date.now() - started}ms | finalUrl=${result.finalUrl} | finalTitle="${result.finalTitle}" | stepsExecuted=${result.execution.stepsExecuted} | stepsSkipped=${result.execution.stepsSkipped} | failedSteps=${failedSteps.length}`);
      if (failedSteps.length) {
        failedSteps.forEach((s) => console.log(`    FAILED step ${s.index} (${s.type}): ${s.failureReason}`));
      }
    } catch (err) {
      console.log(`Run ${run}: THREW after ${Date.now() - started}ms — ${err.message}`);
      if (err.stepLog) {
        const failed = err.stepLog.find((s) => s.result === 'failed');
        if (failed) {
          console.log('  Failed step detail:', JSON.stringify({
            index: failed.index, type: failed.type, selector: failed.selector,
            matchCount: failed.matchCount, visibleCount: failed.visibleCount,
            retries: failed.retries, strategyUsed: failed.strategyUsed,
            blockersDismissed: failed.blockersDismissed, failureReason: failed.failureReason
          }, null, 2));
        }
      }
    }
  }

  logSection('STAGE 4: REPLAY with a DIFFERENT parameter value (Tokyo instead of Paris)');

  if (destinationParam) {
    const overrideValues = Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue]));
    overrideValues[destinationParam.name] = 'Tokyo, Japan';
    const started = Date.now();
    try {
      const result = await runWorkflow({
        steps,
        parameterValues: overrideValues,
        workflowId: 'e2e-run-override',
        extractionHint: null
      });
      const failedSteps = result.stepLog.filter((s) => s.result === 'failed');
      console.log(`Override run: SUCCESS in ${Date.now() - started}ms | finalUrl=${result.finalUrl} | finalTitle="${result.finalTitle}" | failedSteps=${failedSteps.length}`);
      console.log('Contains "Tokyo"?', result.finalUrl.includes('Tokyo') || result.finalTitle.includes('Tokyo'));
    } catch (err) {
      console.log(`Override run: THREW after ${Date.now() - started}ms — ${err.message}`);
    }
  }

  server.close();
  process.exit(0);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
