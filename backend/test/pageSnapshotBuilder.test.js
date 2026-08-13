// Tests for pageSnapshotBuilder.js (V2 Phase 0 foundation) — verifies the
// snapshot correctly identifies interactive elements, skips hidden/disabled
// ones, redacts sensitive values, and produces locators that
// replayEngine.locatorFromCandidate can actually resolve. Hand-built generic
// DOM fixtures only — no site names, no site-specific markup.
//
// Run with: node backend/test/pageSnapshotBuilder.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { chromium } = require('playwright');
const { buildPageSnapshot } = require('../services/pageSnapshotBuilder');
const { locatorFromCandidate } = require('../services/replayEngine');

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

let browser;
let page;

const withPage = async (html, fn) => {
  await page.goto(encode(html), { waitUntil: 'domcontentloaded' });
  await fn();
};

const run = async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  page = await (await browser.newContext()).newPage();

  await test('finds a labeled input and an enabled button, ignoring a hidden input and a disabled button', async () => {
    await withPage(`<html><body>
      <label for="origin">From</label><input id="origin" type="text" placeholder="City" />
      <input type="hidden" name="secret" value="x" />
      <button disabled>Disabled</button>
      <button id="search-btn">Search</button>
    </body></html>`, async () => {
      const snapshot = await buildPageSnapshot(page);

      const origin = snapshot.elements.find((el) => el.tag === 'input' && el.label === 'From');
      assert.ok(origin, 'expected to find the labeled "From" input');
      assert.strictEqual(origin.placeholder, 'City');

      assert.ok(!snapshot.elements.some((el) => el.type === 'hidden'), 'hidden input must not be included');
      assert.ok(!snapshot.elements.some((el) => el.tag === 'button' && el.name === 'Disabled'), 'disabled button must not be included');

      const searchBtn = snapshot.elements.find((el) => el.tag === 'button' && el.name === 'Search');
      assert.ok(searchBtn, 'expected to find the enabled Search button');
    });
  });

  await test('produces a locator that replayEngine.locatorFromCandidate resolves to the same element', async () => {
    await withPage('<html><body><button data-testid="submit-btn">Go</button></body></html>', async () => {
      const snapshot = await buildPageSnapshot(page);
      const button = snapshot.elements.find((el) => el.tag === 'button');
      assert.ok(button.locators.length, 'expected at least one locator candidate');

      const locator = locatorFromCandidate(page, button.locators[0]);
      await locator.waitFor({ state: 'visible', timeout: 2000 });
      const text = await locator.textContent();
      assert.strictEqual(text.trim(), 'Go');
    });
  });

  await test('redacts a password field\'s value but still reports the field exists and is sensitive', async () => {
    await withPage('<html><body><input type="password" id="pw" value="hunter2" /></body></html>', async () => {
      const snapshot = await buildPageSnapshot(page);
      const pw = snapshot.elements.find((el) => el.type === 'password');
      assert.ok(pw, 'expected to find the password field');
      assert.strictEqual(pw.value, null, 'password value must never be included in the snapshot');
      assert.strictEqual(pw.sensitive, true);
    });
  });

  await test('caps the element count and reports truncation', async () => {
    const manyInputs = Array.from({ length: 10 }, (_, i) => `<input id="f${i}" aria-label="Field ${i}" />`).join('');
    await withPage(`<html><body>${manyInputs}</body></html>`, async () => {
      const snapshot = await buildPageSnapshot(page, { maxElements: 3 });
      assert.strictEqual(snapshot.elements.length, 3);
      assert.strictEqual(snapshot.totalFound, 10);
      assert.strictEqual(snapshot.truncated, true);
    });
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close().catch(() => {});
  process.exitCode = 1;
});
