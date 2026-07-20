// Drives the ACTUAL extension/content/content.js inside a real
// Playwright-controlled page, so tests exercise the exact same recording
// code production uses — not a hand-rolled approximation of what it might
// capture. window.chrome is stubbed just enough to satisfy content.js's
// own API surface (sendMessage, always reporting "recording"); every event
// it tries to send is forwarded into a plain array via
// page.exposeFunction, the same shape a real service worker would
// accumulate in chrome.storage.session.
const path = require('path');
const { chromium } = require('playwright');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', '..', 'extension', 'content', 'content.js');

const installChromeStub = async (page, onEvent) => {
  await page.exposeFunction('__ffCaptureEvent__', (event) => onEvent(event));
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'recorder-event' && msg.event) {
            window.__ffCaptureEvent__(msg.event);
          }
          if (cb) {
            cb({ ok: true, state: { isRecording: true, events: [], startedAt: new Date().toISOString() } });
          }
        },
        onMessage: { addListener: () => {} },
        lastError: undefined
      }
    };
  });
};

// content.js only exists in the CURRENT document once injected — a fresh
// navigation needs it re-injected, exactly like the real service worker's
// chrome.tabs.onUpdated listener does in production.
const injectContentJsOnEveryLoad = (page) => {
  page.on('load', () => {
    page.addScriptTag({ path: CONTENT_JS_PATH }).catch(() => {});
  });
};

// Records a workflow by driving REAL Playwright interactions (which
// dispatch real DOM events content.js's own listeners pick up) against a
// real page, returning exactly the raw event array a production recording
// session would have produced.
const recordWorkflow = async ({ baseUrl, actions, headless = true }) => {
  const events = [];
  const browser = await chromium.launch({
    headless,
    args: headless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : undefined
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await installChromeStub(page, (event) => events.push(event));
  injectContentJsOnEveryLoad(page);

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: CONTENT_JS_PATH });
  await page.waitForTimeout(200); // let content.js's own initialize() round-trip complete

  for (const action of actions) {
    await action(page);
  }

  await page.waitForTimeout(200);
  const finalUrl = page.url();
  await browser.close();
  return { events, finalUrl };
};

module.exports = { recordWorkflow };
