// A tiny, self-contained local HTTP server simulating a "modern SPA"
// travel-search site, used only by the replay E2E test. Deliberately
// includes the specific characteristics real recorded workflows have to
// survive: React-style dynamic element IDs (regenerated on every page
// load), a debounced autocomplete suggestion list, a native <form> submit
// for navigation, and a post-navigation cookie-consent overlay on the
// results page. No external network dependency, so the test is fast and
// deterministic.
const http = require('http');
const { URL } = require('url');

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
  var DESTINATIONS = ['Paris, France', 'Tokyo, Japan', 'Rome, Italy', 'Cairo, Egypt'];
  var input = document.getElementById('dest-input-${nonce}');
  var box = document.getElementById('suggestions-${nonce}');
  var hiddenQ = document.getElementById('hidden-q-${nonce}');
  var searchBtn = document.getElementById('search-btn-${nonce}');
  var form = document.querySelector('form');

  var debounceTimer = null;
  input.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    var value = input.value.trim().toLowerCase();
    hiddenQ.value = input.value;
    debounceTimer = setTimeout(function () {
      if (!value) { box.style.display = 'none'; box.innerHTML = ''; return; }
      var matches = DESTINATIONS.filter(function (d) { return d.toLowerCase().indexOf(value) !== -1; });
      if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = matches.map(function (d, i) {
        return '<div role="option" class="opt-${nonce}-' + i + '" data-value="' + d + '">' + d + '</div>';
      }).join('');
      box.style.display = 'block';
      Array.prototype.forEach.call(box.children, function (el) {
        el.addEventListener('click', function () {
          input.value = el.getAttribute('data-value');
          hiddenQ.value = el.getAttribute('data-value');
          box.style.display = 'none';
          box.innerHTML = '';
        });
      });
    }, 350); // simulated network debounce
  });

  searchBtn.addEventListener('click', function () {
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
<script>
document.getElementById('accept-${nonce}').addEventListener('click', function () {
  document.getElementById('consent-${nonce}').remove();
});
</script>
</body></html>`;

const randomNonce = () => Math.random().toString(36).slice(2, 8);

const startTestSpaServer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    if (parsed.pathname === '/results') {
      const q = parsed.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(RESULTS_PAGE(q, randomNonce()));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HOME_PAGE(randomNonce()));
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

module.exports = { startTestSpaServer };
