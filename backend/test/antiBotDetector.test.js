// Tests for antiBotDetector.js (V2 Phase 0 foundation). classifySignals is
// pure and tested directly against hand-built signal fixtures (no site
// names); detectPageBlock gets one Playwright-driven smoke test to confirm
// the page.evaluate wiring works end-to-end.
//
// Run with: node backend/test/antiBotDetector.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { chromium } = require('playwright');
const { classifySignals, detectPageBlock, REASONS } = require('../services/antiBotDetector');

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

const run = async () => {
  await test('classifySignals: flags a reCAPTCHA iframe as blocked/captcha', async () => {
    const result = classifySignals({ url: 'https://example.com/search', title: 'Search', bodyText: '', hasCaptchaIframe: true });
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, REASONS.CAPTCHA);
  });

  await test('classifySignals: flags "verify you are human" body text as captcha even without an iframe', async () => {
    const result = classifySignals({ url: 'https://example.com/search', title: 'Search', bodyText: 'Please verify you are human to continue.' });
    assert.strictEqual(result.reason, REASONS.CAPTCHA);
  });

  await test('classifySignals: flags a "just a moment" interstitial title as a bot challenge', async () => {
    const result = classifySignals({ url: 'https://example.com/', title: 'Just a moment...', bodyText: '' });
    assert.strictEqual(result.reason, REASONS.BOT_CHALLENGE);
  });

  await test('classifySignals: a password field alone on an ordinary results page is NOT flagged (common header widget)', async () => {
    const result = classifySignals({
      url: 'https://example.com/flights/search-results',
      title: 'Flight results',
      bodyText: 'Showing 12 flights from Dhaka to Dubai',
      passwordFieldCount: 1
    });
    assert.strictEqual(result.blocked, false);
  });

  await test('classifySignals: a password field on a page that looks like a real login screen IS flagged as a login wall', async () => {
    const result = classifySignals({
      url: 'https://example.com/login',
      title: 'Log in',
      bodyText: 'Please log in to continue',
      passwordFieldCount: 1
    });
    assert.strictEqual(result.reason, REASONS.LOGIN_WALL);
  });

  await test('classifySignals: an ordinary page with none of these signals is not blocked', async () => {
    const result = classifySignals({ url: 'https://example.com/search?q=flights', title: 'Search results', bodyText: 'Dhaka to Dubai, 3 results found.' });
    assert.deepStrictEqual(result, { blocked: false, reason: REASONS.NONE, message: null, matchedSignals: [] });
  });

  let browser;
  await test('detectPageBlock: recognizes a hand-built CAPTCHA-shaped fixture page end-to-end', async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await (await browser.newContext()).newPage();
    const html = '<html><head><title>Security check</title></head><body><p>Please verify you are human before continuing.</p></body></html>';
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded' });
    const result = await detectPageBlock(page);
    await browser.close();
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, REASONS.CAPTCHA);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
