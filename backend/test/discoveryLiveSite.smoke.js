// MANUAL, OPT-IN live-site smoke for generic target-site discovery. NOT part
// of the automated suite (no other file requires it; it is not a *.test.js and
// is not wired into `npm test`) because it makes REAL web-search + real
// navigation over the network, which is too slow/flaky to gate commits on —
// exactly like ollamaProvider.smoke.js. The offline, deterministic coverage
// lives in siteDiscovery.test.js and aiCreatorEndToEnd.e2e.test.js.
//
// What it proves when run with a network connection: siteDiscovery resolves an
// ARBITRARY named target to a real, verified URL using the real search backend
// — no hardcoded domains. The target name is a CLI arg / env var (a neutral
// default), precisely so nothing here is special-cased to one site.
//
// Usage (from backend/):
//   node test/discoveryLiveSite.smoke.js "Wikipedia"
//   DISCOVERY_SMOKE_TARGET="the official Node.js website" node test/discoveryLiveSite.smoke.js
//
// It never asserts a specific domain (that would be both brittle and a form of
// hardcoding) — it reports, honestly, what discovery found and whether the
// live page verified against the requested name.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.FORGEFLOW_HEADLESS = process.env.FORGEFLOW_HEADLESS || 'true';

const { chromium } = require('playwright');
const { discoverTargetSite } = require('../services/siteDiscovery');

const targetName = process.argv[2] || process.env.DISCOVERY_SMOKE_TARGET || 'Wikipedia';

(async () => {
  const browser = await chromium.launch({
    headless: process.env.FORGEFLOW_HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await (await browser.newContext()).newPage();
  try {
    console.log(`[discovery smoke] resolving named target: "${targetName}" via the real web search backend…`);
    const outcome = await discoverTargetSite({ page, targetName });
    console.log('[discovery smoke] outcome:', JSON.stringify({
      status: outcome.status,
      url: outcome.url || null,
      urlTrust: outcome.urlTrust || null,
      confidence: outcome.confidence ?? null,
      reason: outcome.reason || null,
      candidates: (outcome.candidates || []).map((c) => c.host || c.url)
    }, null, 2));

    if (outcome.status === 'discovered') {
      console.log(`[discovery smoke] SUCCESS — reached and verified ${outcome.url}`);
      process.exitCode = 0;
    } else {
      // Not a hard failure: an ambiguous/unreachable result (or a blocked
      // search engine) is a legitimate, honest outcome to observe manually.
      console.log(`[discovery smoke] discovery did not resolve to a single verified target (status=${outcome.status}). This may be a blocked search backend or a genuinely ambiguous name — inspect the outcome above.`);
      process.exitCode = 0;
    }
  } catch (error) {
    console.log('[discovery smoke] errored (likely no network / search blocked):', error.message);
    process.exitCode = 0;
  } finally {
    await browser.close().catch(() => {});
  }
})();
