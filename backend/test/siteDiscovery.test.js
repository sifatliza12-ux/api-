// Unit tests for the generic target-site discovery module. Fully offline and
// deterministic: the web search, the verification navigation, and the page are
// all injected, so nothing here touches a real browser, a real search engine,
// or any specific website. The point is to prove the MECHANISM is generic —
// the same ranking/decision/verification logic resolves structurally
// different named targets (a consumer brand, an electronics maker, an airline,
// a hotel chain) and refuses to guess when nothing clearly wins — without a
// single site/brand/category branch anywhere.
//
// Run with: node backend/test/siteDiscovery.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const {
  discoverTargetSite,
  rankCandidates,
  verifyDestination,
  tokenizeName,
  registrableLabel
} = require('../services/siteDiscovery');

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
    console.log(`      ${error.message}`);
  }
};

// A verify() stub that succeeds only for the hosts a test whitelists — used
// to model "this candidate really is the target" vs "this one isn't", without
// a browser. `expectedUrl` is what discoverTargetSite passes in.
const verifyFor = (okHosts) => async (page, { expectedUrl }) => {
  let host = '';
  try { host = new URL(expectedUrl).host.replace(/^www\./, ''); } catch (e) { /* ignore */ }
  return okHosts.includes(host)
    ? { ok: true, url: expectedUrl, reason: 'stub-verified' }
    : { ok: false, url: expectedUrl, reason: 'stub-rejected' };
};

// A page stub for verifyDestination's own tests: title()/evaluate() return
// canned strings, and the injected navigate() decides the landed URL.
const pageStub = ({ title = '', body = '' } = {}) => ({
  _url: 'about:blank',
  url() { return this._url; },
  async title() { return title; },
  async evaluate() { return body; }
});

const run = async () => {
  // --- tokenization / label helpers (the generic primitives) --------------

  await test('tokenizeName strips generic filler so "the official Samsung website" ≡ "Samsung"', () => {
    assert.deepStrictEqual(tokenizeName('the official Samsung website'), ['samsung']);
    assert.deepStrictEqual(tokenizeName('Use the Walton website'), ['walton']);
    assert.deepStrictEqual(tokenizeName('Green Leaf Hotels'), ['green', 'leaf', 'hotels']);
  });

  await test('registrableLabel handles plain and two-part public suffixes generically', () => {
    assert.strictEqual(registrableLabel('waltonbd.com'), 'waltonbd');
    assert.strictEqual(registrableLabel('shop.samsung.co.uk'), 'samsung');
    assert.strictEqual(registrableLabel('store.example.com.bd'), 'example');
  });

  // --- ranking picks the right target across DIFFERENT target shapes ------

  const clearWinnerCases = [
    {
      label: 'consumer brand',
      name: 'Walton',
      candidates: [
        { url: 'https://en.wikipedia.org/wiki/Walton', title: 'Walton - Wikipedia' },
        { url: 'https://www.amazon.com/s?k=walton', title: 'Walton products on Amazon' },
        { url: 'https://waltonbd.com/', title: 'Walton - Official Website' }
      ],
      expectHost: 'waltonbd.com'
    },
    {
      label: 'electronics maker',
      name: 'the official Samsung website',
      candidates: [
        { url: 'https://www.bestbuy.com/samsung', title: 'Samsung phones at Best Buy' },
        { url: 'https://www.samsung.com/', title: 'Samsung Official Site' },
        { url: 'https://en.wikipedia.org/wiki/Samsung', title: 'Samsung - Wikipedia' }
      ],
      expectHost: 'samsung.com'
    },
    {
      label: 'airline (flight-shaped task)',
      name: 'SkyWings Air',
      candidates: [
        { url: 'https://www.expedia.com/skywings', title: 'SkyWings flights on Expedia' },
        { url: 'https://www.skywingsair.com/', title: 'SkyWings Air — Book Flights' }
      ],
      expectHost: 'skywingsair.com'
    },
    {
      label: 'hotel chain (hotel-shaped task)',
      name: 'Green Leaf Hotels',
      candidates: [
        { url: 'https://www.tripadvisor.com/green-leaf', title: 'Green Leaf Hotels reviews' },
        { url: 'https://www.greenleafhotels.com/', title: 'Green Leaf Hotels — Rooms & Rates' }
      ],
      expectHost: 'greenleafhotels.com'
    }
  ];

  for (const c of clearWinnerCases) {
    await test(`rankCandidates picks the official ${c.label} target ("${c.name}") over noise`, () => {
      const ranked = rankCandidates(c.name, c.candidates);
      assert.strictEqual(ranked[0].host, c.expectHost, `expected ${c.expectHost}, got ${ranked[0].host} (scores: ${ranked.map((r) => r.host + '=' + r.score).join(', ')})`);
    });
  }

  await test('rankCandidates collapses multiple deep links from the SAME host (not counted as competing)', () => {
    const ranked = rankCandidates('Samsung', [
      { url: 'https://www.samsung.com/phones', title: 'Samsung phones' },
      { url: 'https://www.samsung.com/tablets', title: 'Samsung tablets' },
      { url: 'https://www.samsung.com/', title: 'Samsung' }
    ]);
    assert.strictEqual(ranked.filter((r) => r.host === 'samsung.com').length, 1, 'same host must appear once');
  });

  // --- discoverTargetSite decisions (search + verify injected) ------------

  await test('discovers the intended target when one candidate clearly wins and verifies', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Walton',
      task: 'search for microwave',
      searchResults: async () => ([
        { url: 'https://en.wikipedia.org/wiki/Walton', title: 'Walton - Wikipedia' },
        { url: 'https://waltonbd.com/', title: 'Walton - Official Website' }
      ]),
      verify: verifyFor(['waltonbd.com'])
    });
    assert.strictEqual(outcome.status, 'discovered');
    assert.strictEqual(new URL(outcome.url).host.replace(/^www\./, ''), 'waltonbd.com');
    assert.strictEqual(outcome.urlTrust, 'discovered');
  });

  await test('the SAME mechanism discovers a structurally different target (airline) with no special-casing', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'SkyWings Air',
      task: 'find flights from Dhaka to Dubai',
      searchResults: async () => ([
        { url: 'https://www.expedia.com/skywings', title: 'SkyWings on Expedia' },
        { url: 'https://www.skywingsair.com/', title: 'SkyWings Air — Book Flights' }
      ]),
      verify: verifyFor(['skywingsair.com'])
    });
    assert.strictEqual(outcome.status, 'discovered');
    assert.strictEqual(new URL(outcome.url).host.replace(/^www\./, ''), 'skywingsair.com');
  });

  await test('AMBIGUOUS: two equally-strong unrelated candidates are never silently picked', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Apollo',
      searchResults: async () => ([
        { url: 'https://apollo.com/', title: 'Apollo' },
        { url: 'https://apollo.io/', title: 'Apollo' }
      ]),
      verify: verifyFor(['apollo.com', 'apollo.io']) // even though both would verify, it must not reach verify
    });
    assert.strictEqual(outcome.status, 'ambiguous');
    assert.ok(Array.isArray(outcome.candidates) && outcome.candidates.length >= 2, 'ambiguous result should surface the candidates for the user to choose');
  });

  await test('AMBIGUOUS: a name nothing matches is reported, not force-picked', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Zzxqwerty Nonexistent',
      searchResults: async () => ([
        { url: 'https://www.example.com/', title: 'Example Domain' },
        { url: 'https://www.iana.org/', title: 'IANA' }
      ]),
      verify: verifyFor(['example.com', 'iana.org'])
    });
    assert.strictEqual(outcome.status, 'ambiguous');
  });

  await test('UNREACHABLE: a clear winner that fails live verification is not used', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Walton',
      searchResults: async () => ([
        { url: 'https://waltonbd.com/', title: 'Walton - Official Website' }
      ]),
      verify: verifyFor([]) // nothing verifies
    });
    assert.strictEqual(outcome.status, 'unreachable');
  });

  // --- URL trust: a model-guessed seed URL is never blindly trusted -------

  await test('a model-guessed seed URL that VERIFIES is accepted (discovered)', async () => {
    let searched = false;
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Walton',
      seedUrl: 'https://waltonbd.com/',
      searchResults: async () => { searched = true; return []; },
      verify: verifyFor(['waltonbd.com'])
    });
    assert.strictEqual(outcome.status, 'discovered');
    assert.strictEqual(searched, false, 'a verified seed should short-circuit before any search');
  });

  await test('a model-guessed seed URL that does NOT verify is NOT trusted — falls back to search', async () => {
    let searched = false;
    const outcome = await discoverTargetSite({
      page: null,
      targetName: 'Walton',
      seedUrl: 'https://walton-hallucinated-guess.example/', // model made this up
      searchResults: async () => { searched = true; return [{ url: 'https://waltonbd.com/', title: 'Walton - Official Website' }]; },
      // seed host rejected; the real discovered host accepted
      verify: verifyFor(['waltonbd.com'])
    });
    assert.strictEqual(searched, true, 'an unverified model guess must not short-circuit discovery');
    assert.strictEqual(outcome.status, 'discovered');
    assert.strictEqual(new URL(outcome.url).host.replace(/^www\./, ''), 'waltonbd.com');
  });

  await test('a model-guessed seed URL that does NOT verify AND no name to search → unreachable, never trusted', async () => {
    const outcome = await discoverTargetSite({
      page: null,
      targetName: '',
      seedUrl: 'https://totally-made-up.example/',
      verify: verifyFor([])
    });
    assert.strictEqual(outcome.status, 'unreachable');
  });

  // --- verifyDestination itself (host + name corroboration) ---------------

  await test('verifyDestination passes when host matches and the target name appears on the page', async () => {
    const page = pageStub({ title: 'Walton Official Website', body: 'Welcome to Walton' });
    const res = await verifyDestination(page, {
      targetName: 'Walton',
      expectedUrl: 'https://waltonbd.com/',
      navigate: async (p, url) => { p._url = url; return url; }
    });
    assert.strictEqual(res.ok, true);
  });

  await test('verifyDestination fails when navigation redirects to an unrelated domain', async () => {
    const page = pageStub({ title: 'Some Parked Domain', body: 'buy this domain' });
    const res = await verifyDestination(page, {
      targetName: 'Walton',
      expectedUrl: 'https://waltonbd.com/',
      navigate: async (p) => { p._url = 'https://unrelated-parking.example/'; return p._url; }
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/unrelated domain/i.test(res.reason));
  });

  await test('verifyDestination fails when the destination never mentions the target name', async () => {
    const page = pageStub({ title: 'Completely Different Brand', body: 'nothing relevant here' });
    const res = await verifyDestination(page, {
      targetName: 'Walton',
      expectedUrl: 'https://waltonbd.com/',
      navigate: async (p, url) => { p._url = url; return url; }
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/did not mention/i.test(res.reason));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
