// Regression suite for getStableEventTarget (extension/content/content.js).
// Drives the REAL content.js (via recordWorkflow) against hand-built generic
// DOM fixtures — no site names, no site-specific selectors — reproducing the
// SHAPE of failure confirmed in production (a click landing on a decorative/
// transient child instead of the stable interactive element that actually
// owns the interaction), not any one site's markup.
//
// Run with: node backend/test/recorderStableTarget.e2e.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { recordWorkflow } = require('./fixtures/recordingHarness');

const encode = (html) => `data:text/html,${encodeURIComponent(html)}`;

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

const firstClick = (events) => events.find((e) => e.type === 'click');

// ---------------------------------------------------------------------------
// 1. Nested interactive elements: a click physically lands on a decorative
// child (an icon <span>) sitting inside a real <button>. event.target is the
// span; the button is the stable, always-present, semantically-correct thing
// to record.
// ---------------------------------------------------------------------------
const nestedInteractiveAncestor = async () => {
  const html = `<html><body>
<button id="stable-btn" onclick="window.__picked='button'"><span class="icon">*</span> Book now</button>
</body></html>`;
  const { events } = await recordWorkflow({
    baseUrl: encode(html),
    actions: [(page) => page.click('.icon')]
  });
  const click = firstClick(events);
  assert.ok(click, 'expected a click event to be recorded');
  assert.strictEqual(click.selector, '#stable-btn', `expected the recorded selector to be the stable <button> (#stable-btn), got ${click.selector}`);
  assert.strictEqual(click.meta && click.meta.tag, 'button', `expected the recorded target's tag to be "button", got ${click.meta && click.meta.tag}`);
};

// ---------------------------------------------------------------------------
// 2. Overlay/hover scenario: a decorative, absolutely-positioned overlay
// <div> sits on top of a real, stable <a> (the general shape of both a
// Material-style ripple effect and a hover-triggered preview layer — no
// specific site's markup). Clicking the overlay's own coordinates is exactly
// what happens when a real cursor lands on whatever transient layer happens
// to be on top; the <a> underneath is what should be recorded.
// ---------------------------------------------------------------------------
const overlayHoverAncestor = async () => {
  const html = `<html><body>
<a id="stable-link" href="javascript:void(0)" onclick="window.__picked='link'" style="position:relative;display:inline-block;padding:20px;">
  Open item
  <div class="hover-preview-overlay" style="position:absolute;inset:0;"></div>
</a>
</body></html>`;
  const { events } = await recordWorkflow({
    baseUrl: encode(html),
    actions: [(page) => page.click('.hover-preview-overlay')]
  });
  const click = firstClick(events);
  assert.ok(click, 'expected a click event to be recorded');
  assert.strictEqual(click.selector, '#stable-link', `expected the recorded selector to be the stable <a> (#stable-link), got ${click.selector}`);
  assert.strictEqual(click.meta && click.meta.tag, 'a', `expected the recorded target's tag to be "a", got ${click.meta && click.meta.tag}`);
};

// ---------------------------------------------------------------------------
// 3. Shadow DOM boundary: the decorative element clicked lives INSIDE an
// open shadow root; the real interactive ancestor (a <button>) is in light
// DOM, enclosing the shadow host. .closest()/.parentElement cannot cross a
// shadow boundary upward — only event.composedPath() can, which is exactly
// why getStableEventTarget uses it. Proves the composedPath choice matters,
// not just the interactive-ancestor concept.
// ---------------------------------------------------------------------------
const shadowDomBoundary = async () => {
  const html = `<html><body>
<button id="host-btn" onclick="window.__picked='host'"><div id="sr-container"></div></button>
<script>
  const root = document.getElementById('sr-container').attachShadow({ mode: 'open' });
  const span = document.createElement('span');
  span.className = 'decorative';
  span.textContent = 'icon';
  root.appendChild(span);
</script>
</body></html>`;
  const { events } = await recordWorkflow({
    baseUrl: encode(html),
    actions: [(page) => page.locator('#sr-container').locator('.decorative').click()]
  });
  const click = firstClick(events);
  assert.ok(click, 'expected a click event to be recorded');
  assert.strictEqual(click.selector, '#host-btn', `expected the recorded selector to cross the shadow boundary to the stable <button> (#host-btn), got ${click.selector}`);
  assert.strictEqual(click.meta && click.meta.tag, 'button', `expected the recorded target's tag to be "button", got ${click.meta && click.meta.tag}`);
};

// ---------------------------------------------------------------------------
// 4. Target already interactive: a plain click directly on a real <button>
// with no decorative layer at all must still resolve to itself — proves the
// helper narrows, it never redirects a click that was already correct.
// ---------------------------------------------------------------------------
const alreadyInteractiveUnchanged = async () => {
  const html = `<html><body><button id="plain-btn" onclick="window.__picked='plain'">Book now</button></body></html>`;
  const { events } = await recordWorkflow({
    baseUrl: encode(html),
    actions: [(page) => page.click('#plain-btn')]
  });
  const click = firstClick(events);
  assert.ok(click, 'expected a click event to be recorded');
  assert.strictEqual(click.selector, '#plain-btn', `expected the recorded selector to still be the clicked button itself, got ${click.selector}`);
};

(async () => {
  console.log('Recorder getStableEventTarget regression suite\n');

  await test('nested interactive elements: icon inside a <button> resolves to the button', nestedInteractiveAncestor);
  await test('overlay/hover scenario: decorative overlay over an <a> resolves to the <a>', overlayHoverAncestor);
  await test('shadow DOM boundary: decorative element in a shadow root resolves to the light-DOM <button> host', shadowDomBoundary);
  await test('already-interactive target: a direct button click is left unchanged', alreadyInteractiveUnchanged);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);

  process.exit(failed > 0 ? 1 : 0);
})();
