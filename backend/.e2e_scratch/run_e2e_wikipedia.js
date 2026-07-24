// Real-site variant: record a real Wikipedia search using the ACTUAL
// content.js against the REAL live site, then replay it multiple times.
// Wikipedia is stable, automation-tolerant, and has genuinely different
// markup/structure from the local synthetic test site — a different
// "modern web application" per the requirement.
const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

const logSection = (title) => console.log(`\n${'='.repeat(10)} ${title} ${'='.repeat(10)}`);

(async () => {
  logSection('STAGE 1: RECORDING (real content.js against real Wikipedia)');

  const { events, finalUrl: recordedFinalUrl } = await recordWorkflow({
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    actions: [
      async (page) => {
        await page.click('#searchInput, input[name="search"]');
      },
      async (page) => {
        await page.fill('#searchInput, input[name="search"]', 'Alan Turing');
      },
      async (page) => {
        await page.waitForTimeout(600); // let the real suggestion dropdown render
        const suggestion = page.locator('.suggestions-result, .mw-searchSuggest-link').first();
        if (await suggestion.count()) {
          await suggestion.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('domcontentloaded');
      }
    ]
  });

  console.log('Raw events captured:', events.length);
  console.log('Recorded final URL:', recordedFinalUrl);
  console.log('Event types:', events.map((e) => e.type).join(', '));

  logSection('STAGE 2: PARAMETERIZATION');
  const { parameters, steps } = parameterizeWorkflowRuleBased(events);
  console.log('Parameters:', parameters.map((p) => `${p.name}="${p.defaultValue}"`).join(', '));
  console.log('Steps:', steps.map((s) => `[${s.index}] ${s.type}`).join(', '));

  logSection('STAGE 3: REPLAY x6 (same value) — proving the race is fixed');
  // runWorkflow deliberately never closes its browser on success (so a
  // human running it locally can watch the result) — fine in production,
  // but across many consecutive automated runs in one test session it
  // leaves Chromium processes accumulating and eventually starving the
  // system. Force-closing between iterations here keeps this validation
  // run clean; it says nothing about production behavior.
  const { execSync } = require('child_process');
  const killLingeringChrome = () => { try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' }); } catch (e) { /* none running */ } };

  for (let run = 1; run <= 6; run += 1) {
    const started = Date.now();
    try {
      const result = await runWorkflow({
        steps,
        parameterValues: Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue])),
        workflowId: `wiki-run-${run}`,
        extractionHint: null
      });
      const failed = result.stepLog.filter((s) => s.result === 'failed');
      const suggestionStep = result.stepLog.find((s) => s.type === 'dynamic_click');
      console.log(`Run ${run}: SUCCESS in ${Date.now() - started}ms | finalUrl=${result.finalUrl} | finalTitle="${result.finalTitle}" | failedSteps=${failed.length} | dynamicClickStrategy=${suggestionStep?.strategyUsed}`);
    } catch (err) {
      console.log(`Run ${run}: THREW after ${Date.now() - started}ms — ${err.message}`);
    } finally {
      killLingeringChrome();
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
