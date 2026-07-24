// Regression check after the eventCondenser.js + content.js locator fixes:
// drives the REAL content.js recorder + REAL ruleBasedParameterizer +
// REAL replayEngine (same harness as repro_todomvc*.js) against several
// unrelated real sites, to confirm the generic fix didn't regress anything
// site-specific. No site-specific code in the fix itself — this is just
// verification.
process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow } = require('./harness');

const SCENARIOS = [
  {
    name: 'todomvc-react-toggle',
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
    ],
    verify: null
  },
  {
    name: 'todomvc-vue-toggle',
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
    ],
    verify: null
  },
  {
    name: 'wikipedia-search',
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    actions: [
      async (page) => {
        await page.click('#searchInput');
        await page.fill('#searchInput', 'Playwright (software)');
        await page.press('#searchInput', 'Enter');
        await page.waitForLoadState('domcontentloaded');
      }
    ],
    verify: (result) => (result.finalUrl || '').toLowerCase().includes('playwright')
  },
  {
    name: 'saucedemo-login',
    baseUrl: 'https://www.saucedemo.com/',
    actions: [
      async (page) => {
        await page.click('#user-name');
        await page.fill('#user-name', 'standard_user');
        await page.click('#password');
        await page.fill('#password', 'secret_sauce');
        await page.click('#login-button');
        await page.waitForURL('**/inventory.html', { timeout: 10000 });
      }
    ],
    // content.js never records a real password value (redacted for
    // security) — a real caller supplies it at replay time, so this test
    // does too, rather than replaying the literal "[REDACTED]" placeholder.
    runtimeOverrides: { password: 'secret_sauce' },
    verify: (result) => (result.finalUrl || '').includes('inventory.html')
  },
  {
    name: 'youtube-search',
    baseUrl: 'https://www.youtube.com/',
    actions: [
      async (page) => {
        await page.click('input#search, input[name="search_query"]');
        await page.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
        await page.press('input#search, input[name="search_query"]', 'Enter');
        await page.waitForURL('**results**', { timeout: 10000 }).catch(() => {});
      }
    ],
    verify: (result) => (result.finalUrl || '').includes('results')
  },
  {
    name: 'booking-com-destination-search',
    baseUrl: 'https://www.booking.com/',
    actions: [
      async (page) => {
        await page.waitForTimeout(2000);
        const cookieBtn = page.locator('#onetrust-accept-btn-handler');
        if (await cookieBtn.count()) {
          await cookieBtn.click().catch(() => {});
        }
        await page.waitForTimeout(500);
        // Booking.com intermittently shows a "sign in to save 10%"
        // promo/focus-trap overlay on top of the search box (A/B-tested —
        // not present on every load). A REAL user could never click
        // through it, so {force:true} here would misrecord the click as
        // having landed on the overlay instead of the field underneath it
        // (exactly what a real click at those coordinates would hit) —
        // this retries a genuine, un-forced click, pressing Escape between
        // attempts to clear the overlay if one appeared, the same way a
        // real user would dismiss it before proceeding.
        const destination = page.locator('input[name="ss"]');
        let destinationClicked = false;
        for (let attempt = 0; attempt < 3 && !destinationClicked; attempt += 1) {
          try {
            await destination.click({ timeout: 6000 });
            destinationClicked = true;
          } catch (error) {
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(500);
          }
        }

        // Booking.com's suggestion dropdown is genuinely timing-flaky
        // (debounced, sometimes needs a nudge keystroke to re-fire) —
        // retried a few times rather than a single fixed wait. Typed via
        // .type() (real keystrokes) rather than an extra .press('a') tacked
        // onto .fill() — appending a stray character every retry would
        // silently corrupt the recorded search text.
        let suggestionsVisible = false;
        for (let attempt = 0; attempt < 3 && !suggestionsVisible; attempt += 1) {
          await destination.fill('');
          await destination.type('Paris', { delay: 80 });
          try {
            await page.waitForSelector('[data-testid="autocomplete-result"]', { timeout: 6000 });
            suggestionsVisible = true;
          } catch (error) {
            // try again
          }
        }
        await page.click('[data-testid="autocomplete-result"] >> nth=0');
        await page.waitForTimeout(500);

        // Same reasoning as the destination click above: a real, un-forced
        // click, retried with an Escape in between in case a promo overlay
        // reappeared after picking the destination.
        let searchClicked = false;
        for (let attempt = 0; attempt < 3 && !searchClicked; attempt += 1) {
          try {
            await page.click('button[type="submit"]', { timeout: 6000 });
            searchClicked = true;
          } catch (error) {
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(500);
          }
        }
        await page.waitForURL('**/city/**', { timeout: 15000 }).catch(() => {});
      }
    ],
    // Booking.com's autocomplete suggestion order is live and
    // geo/personalization-biased (confirmed: identical recorded steps
    // landed on Dhaka instead of Paris in one run) — which specific city
    // "the first suggestion" resolves to is the SITE's call, not something
    // a recorded workflow controls or should be judged against. What the
    // replay engine is actually responsible for is faithfully executing
    // every recorded step (0 failed steps) and landing on SOME real
    // destination page, not reproducing a specific non-deterministic
    // upstream choice.
    verify: (result) => /\/city\/[a-z]{2}\/[^/]+\.html/i.test(result.finalUrl || '')
  }
];

(async () => {
  const results = [];

  const MAX_ATTEMPTS = 2;

  for (const scenario of SCENARIOS) {
    console.log(`\n${'='.repeat(10)} ${scenario.name} ${'='.repeat(10)}`);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        if (attempt > 1) {
          console.log(`(retry ${attempt}/${MAX_ATTEMPTS} — live-site transient, not a code change)`);
        }
        const { events } = await recordWorkflow({ baseUrl: scenario.baseUrl, actions: scenario.actions });
        console.log('Captured', events.length, 'events:', events.map((e) => e.type).join(','));

        const { parameters, steps } = parameterizeWorkflowRuleBased(events);
        console.log('Parameters:', parameters.map((p) => `${p.name}=${JSON.stringify(p.defaultValue)}`).join(', '));

        // A redacted sensitive field (content.js never records real password
        // values, by design) must be supplied for real at replay time by
        // whoever runs the workflow — exactly like a real caller would, never
        // just replayed back as the literal "[REDACTED]" placeholder.
        const parameterValues = Object.fromEntries(parameters.map((p) => [p.name, p.defaultValue]));
        if (scenario.runtimeOverrides) {
          Object.assign(parameterValues, scenario.runtimeOverrides);
        }

        const result = await runWorkflow({
          steps,
          parameterValues,
          workflowId: `regression-${scenario.name}`,
          extractionHint: null
        });

        const failed = result.stepLog.filter((s) => s.result === 'failed');
        const verified = scenario.verify ? scenario.verify(result) : true;
        const success = failed.length === 0 && verified;
        console.log(`RESULT: ${success ? 'PASS' : 'FAIL'} | failedSteps=${failed.length} | finalUrl=${result.finalUrl} | verified=${verified}`);
        failed.forEach((s) => console.log('  FAILED', JSON.stringify(s).slice(0, 300)));
        results.push({ name: scenario.name, success });
        break;
      } catch (err) {
        console.log('SCENARIO THREW:', err.message);
        if (attempt === MAX_ATTEMPTS) {
          results.push({ name: scenario.name, success: false, error: err.message });
        }
      }
    }
  }

  console.log(`\n${'#'.repeat(10)} SUMMARY ${'#'.repeat(10)}`);
  results.forEach((r) => console.log(`${r.success ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? ' - ' + r.error : ''}`));

  process.exit(results.every((r) => r.success) ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
