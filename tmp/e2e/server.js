// Minimal local HTTP server simulating a "modern SPA" travel-search site:
// dynamic (React-style) element IDs, a debounced autocomplete suggestion
// list, a native form submission for navigation, and a post-navigation
// cookie-consent overlay on the results page. Self-contained, no external
// network dependency, so it's a reproducible target for the E2E harness.
const http = require('http');
const url = require('url');

const HOME_PAGE = (nonce) => `<!doctype html><html><head><title>TripFinder</title></head><body>
<header>
  <div id="root-${nonce}">
    <label for="dest-input-${nonce}">Where to?</label>
    <input id="dest-input-${nonce}" name="destination" placeholder="Search destinations" autocomplete="off" />
    <div id="suggestions-${nonce}" role="listbox" style="display:none;"></div>
  </div>
  <form action="/results" method="get">
    <input type="hidden" id="hidden-q-${nonce}" name="q" value="" />
    <button type="button" id="search-btn-${nonce}" aria-label="Search trips">Search</button>
  </form>
</header>
<script>
(function () {
  const DESTINATIONS = ['Paris, France', 'Tokyo, Japan', 'Rome, Italy', 'Cairo, Egypt'];
  const input = document.getElementById('dest-input-${nonce}');
  const box = document.getElementById('suggestions-${nonce}');
  const hiddenQ = document.getElementById('hidden-q-${nonce}');
  const searchBtn = document.getElementById('search-btn-${nonce}');
  const form = document.querySelector('form');

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const value = input.value.trim().toLowerCase();
    hiddenQ.value = input.value;
    debounceTimer = setTimeout(() => {
      if (!value) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const matches = DESTINATIONS.filter((d) => d.toLowerCase().includes(value));
      if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = matches.map((d, i) =>
        '<div role="option" class="opt-${nonce}-' + i + '" data-value="' + d + '">' + d + '</div>'
      ).join('');
      box.style.display = 'block';
      Array.from(box.children).forEach((el) => {
        el.addEventListener('click', () => {
          input.value = el.getAttribute('data-value');
          hiddenQ.value = el.getAttribute('data-value');
          box.style.display = 'none';
          box.innerHTML = '';
        });
      });
    }, 350); // simulated network debounce
  });

  searchBtn.addEventListener('click', () => {
    hiddenQ.value = input.value;
    form.submit();
  });
})();
</script>
</body></html>`;

const RESULTS_PAGE = (query, nonce) => `<!doctype html><html><head><title>Results for ${query}</title></head><body>
<h1 id="heading-${nonce}">Results for: ${query}</h1>
<div id="consent-${nonce}" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;">
  <div style="position:fixed;bottom:0;left:0;right:0;background:white;padding:16px;">
    <p>We use cookies to improve your trip search.</p>
    <button aria-label="Accept all" id="accept-${nonce}">Accept all</button>
  </div>
</div>
<div class="card-${nonce}-a" style="padding:8px;">
  <h3>Grand Hotel ${query}</h3>
  <p>A lovely place to stay, walking distance from everything worth seeing.</p>
</div>
<div class="card-${nonce}-b" style="padding:8px;">
  <h3>Budget Inn ${query}</h3>
  <p>Clean, simple, affordable rooms near the main station.</p>
</div>
<script>
document.getElementById('accept-${nonce}').addEventListener('click', () => {
  document.getElementById('consent-${nonce}').remove();
});
</script>
</body></html>`;

const randomNonce = () => Math.random().toString(36).slice(2, 8);

const startServer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname === '/results') {
      const q = parsed.query.q || '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(RESULTS_PAGE(q, randomNonce()));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HOME_PAGE(randomNonce()));
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

module.exports = { startServer };
