// A tiny, self-contained local HTTP fixture representing a GENERIC "named
// site with a search box and a list of results" — the shape the demo journey
// exercises, but modeled on NO real site. The site name, the query, and the
// record fields are all arbitrary/parameterized, so nothing in the discovery
// -> navigation -> interaction -> extraction path can be hardcoded to it. Used
// by aiCreatorEndToEnd.e2e.test.js to prove that whole chain end to end with a
// real browser and the real extraction pipeline, offline and deterministically.
//
// It intentionally has the two properties that matter for the proof:
//   * a real <form> GET submit from the home page to /results?q=... (real
//     cross-page navigation, so the agent's interaction genuinely changes the
//     page — not an in-place DOM trick), and
//   * a /results page rendering a REPEATING grid of records with consistent
//     structure, which is what the DOM auto-detect extractor keys off of.
const http = require('http');
const { URL } = require('url');

const HOME_PAGE = (siteName) => `<!doctype html><html><head><title>${siteName}</title></head><body>
  <h1>${siteName}</h1>
  <p>Welcome to ${siteName}. Search the catalog below.</p>
  <form action="/results" method="get">
    <label for="q">Search</label>
    <input id="q" name="q" type="text" placeholder="Search the catalog" />
    <button id="go" type="submit">Search</button>
  </form>
</body></html>`;

// Six records so the extractor's "repeating sibling structure" auto-detect has
// an unambiguous group to lock onto. Each record carries a heading, a
// currency-shaped value, and a third free-text field, so the generic field
// namer produces a real, page-derived schema (a title, a price, and a further
// field) rather than anything pre-baked.
const RESULTS_PAGE = (siteName, query) => {
  const records = [1, 2, 3, 4, 5, 6].map((i) => `
    <div class="record">
      <h3 class="record-title">${query} Result ${i}</h3>
      <span class="record-price">$${i * 1000 + 99}</span>
      <span class="record-note">${i % 2 ? 'Available now' : 'Limited stock'}</span>
    </div>`).join('');
  return `<!doctype html><html><head><title>${siteName} — results for ${query}</title></head><body>
  <h1>${siteName}: 6 results for "${query}"</h1>
  <div id="results">${records}</div>
</body></html>`;
};

// Resolves to a live server bound to a random loopback port. `siteName` lets a
// test pick any name so the fixture is provably not special-cased.
const startListingServer = ({ siteName = 'ExampleCatalog' } = {}) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (parsed.pathname === '/results') {
      res.end(RESULTS_PAGE(siteName, parsed.searchParams.get('q') || ''));
      return;
    }
    res.end(HOME_PAGE(siteName));
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ server, baseUrl: `http://127.0.0.1:${port}`, siteName });
  });
});

module.exports = { startListingServer };
