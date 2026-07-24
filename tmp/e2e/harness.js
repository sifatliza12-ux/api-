// Real end-to-end pipeline harness: injects the ACTUAL extension/content/
// content.js into a real Playwright-controlled page, drives REAL DOM events
// (not hand-rolled step objects) to simulate a user recording a workflow,
// captures what content.js actually emits, feeds it through the ACTUAL
// backend/services/ruleBasedParameterizer.js, then replays the result
// through the ACTUAL backend/services/replayEngine.js — the same pipeline
// production uses end to end, against a realistic local "modern SPA" test
// site (dynamic IDs, debounced autocomplete, native-form navigation, a
// post-navigation consent overlay).
process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const path = require('path');
const { chromium } = require('playwright');
const { startServer } = require('./server');
const { parameterizeWorkflowRuleBased } = require('../../backend/services/ruleBasedParameterizer');
const { runWorkflow } = require('../../backend/services/replayEngine');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', 'extension', 'content', 'content.js');

// Wires up window.chrome so the REAL content.js believes it's running
// inside the extension and always in "recording" mode — every event it
// tries to send is forwarded to the Node side via exposeFunction, into the
// SAME array a real service worker would accumulate in
// chrome.storage.session.
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
            cb({
              ok: true,
              state: { isRecording: true, events: [], startedAt: new Date().toISOString() }
            });
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
// chrome.tabs.onUpdated listener does.
const injectContentJsOnEveryLoad = (page) => {
  page.on('load', () => {
    page.addScriptTag({ path: CONTENT_JS_PATH }).catch(() => {});
  });
};

const recordWorkflow = async ({ baseUrl, actions }) => {
  const events = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
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

module.exports = { startServer, recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow };
