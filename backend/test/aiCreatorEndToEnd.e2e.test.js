// Phase 6 end-to-end proof: the COMPLETE demo-equivalent core journey, run
// against a controlled local fixture with a REAL headless browser and the
// REAL, unmodified services — no behavior mocked away:
//
//   named target (url = null)
//     -> siteDiscovery.discoverTargetSite  (real ranking + real live-page
//        verification; only the web-search backend is injected so the test is
//        offline and deterministic — nothing about the DECISION is faked)
//     -> aiBrowserAgent.runBrowserAgent    (real navigation to the discovered
//        site + real interaction: fill the search box, submit the form,
//        cross-page navigate to the results page)
//     -> extractPageData                   (real DOM auto-detect structured
//        extraction from the live results page)
//     -> structured JSON records
//
// The ONLY injected pieces are the search backend (so no real search engine is
// hit) and the decision script (so no real LLM is called) — exactly the two
// external dependencies every other suite already stubs. Discovery ranking,
// verification, navigation, interaction, and extraction all run for real.
//
// Run BOTH with different site names AND queries to prove the mechanism is
// generic and not special-cased to any one site or task.
//
// Run with: node backend/test/aiCreatorEndToEnd.e2e.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { chromium } = require('playwright');
const { runBrowserAgent } = require('../services/aiBrowserAgent');
const siteDiscovery = require('../services/siteDiscovery');
const { startListingServer } = require('./fixtures/listingServer');

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
    console.log(`      ${error.stack || error.message}`);
  }
};

// Scripts the interaction a real provider would decide for "search this site":
// fill the one text input with the query, click the one submit button (which
// GET-submits the form and navigates to the results page), then done.
const scriptedSearch = (query) => {
  let i = 0;
  const script = [
    (snapshot) => ({ action: 'input', ref: snapshot.elements.find((el) => el.tag === 'input').ref, value: query, reason: 'fill the search box' }),
    (snapshot) => ({ action: 'click', ref: snapshot.elements.find((el) => el.tag === 'button').ref, value: null, reason: 'submit the search' }),
    () => ({ action: 'done', ref: null, value: null, reason: 'results are shown' })
  ];
  return async (snapshot) => { const step = script[i]; i += 1; return step(snapshot); };
};

// Real siteDiscovery.discoverTargetSite, with ONLY the web-search backend
// injected to return the fixture's home page as the sole candidate. Real
// ranking and real live verification still run; minConfidence is relaxed
// because a loopback host legitimately carries no brand token in its hostname
// (the score then comes from the title + a real page-content verification),
// which is exactly the generic path a non-obvious host would take.
const discoverAgainst = (baseUrl, siteName) => async (args) => siteDiscovery.discoverTargetSite({
  ...args,
  searchResults: async () => [{ url: `${baseUrl}/`, title: `${siteName} official site` }],
  minConfidence: 0.1
});

let browser;

const runJourney = async ({ siteName, query }) => {
  const { server, baseUrl } = await startListingServer({ siteName });
  const page = await (await browser.newContext()).newPage();
  try {
    const agentResult = await runBrowserAgent({
      intent: { task: `search ${siteName} for ${query}`, targetSite: { name: siteName, url: null } },
      page,
      decideNextAction: scriptedSearch(query),
      discoverTargetSite: discoverAgainst(baseUrl, siteName)
    });
    return { agentResult, baseUrl };
  } finally {
    await page.context().close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
};

const assertExtractedRecords = (agentResult, query) => {
  assert.strictEqual(agentResult.success, true, 'the full journey should complete successfully');

  // Discovery -> navigation: the FIRST recorded step is a navigation to the
  // discovered site (not about:blank, not a fabricated URL).
  assert.strictEqual(agentResult.steps[0].type, 'navigation', 'the resolved target must be recorded as the first navigation step');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\//.test(agentResult.steps[0].url), `first step should navigate to the discovered fixture, got ${agentResult.steps[0].url}`);

  // Interaction: the query was actually typed into the page.
  const inputStep = agentResult.steps.find((s) => s.type === 'input');
  assert.ok(inputStep && inputStep.value === query, 'the query should have been entered on the live page');

  // Extraction: real structured records pulled from the live results page.
  const extraction = agentResult.extraction;
  assert.ok(extraction, 'a successful run must carry an extraction result');
  assert.strictEqual(extraction.method, 'dom', 'the repeating results grid should be found by the free DOM auto-detect path, not the LLM fallback');
  assert.ok(Array.isArray(extraction.data) && extraction.data.length >= 5, `expected multiple structured records, got ${extraction.data && extraction.data.length}`);

  // The records are REAL (derived from the query we submitted), not fabricated.
  assert.ok(extraction.data.every((rec) => JSON.stringify(rec).includes(query)), 'every extracted record should reflect the query that was actually searched');
  // A page-derived schema formed generically: a heading became a title, a
  // currency-shaped value became a price — inferred from the page, not baked in.
  const first = extraction.data[0];
  assert.ok('title' in first, `expected a generically-named title field; got keys ${Object.keys(first).join(', ')}`);
  assert.ok(Object.values(first).some((v) => typeof v === 'string' && v.trim().startsWith('$')), 'expected a currency-shaped value to be captured');
  console.log(`      extracted ${extraction.data.length} records; sample schema: ${JSON.stringify(first)}`);
};

const run = async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  await test('end-to-end: named target -> discovery -> navigation -> interaction -> extraction (site A / task A)', async () => {
    const { agentResult } = await runJourney({ siteName: 'GadgetHub', query: 'microwave' });
    assertExtractedRecords(agentResult, 'microwave');
  });

  // Same mechanism, structurally different named target AND a different task —
  // proves nothing is hardcoded to one site or one kind of request.
  await test('end-to-end: the SAME pipeline works for a different named target and task (site B / task B)', async () => {
    const { agentResult } = await runJourney({ siteName: 'BookNest', query: 'novel' });
    assertExtractedRecords(agentResult, 'novel');
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
};

run();
