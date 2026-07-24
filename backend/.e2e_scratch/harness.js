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

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startServer } = require('./server');
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { runWorkflow } = require('../services/replayEngine');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', 'extension', 'content', 'content.js');

// The real extension injects content.js with allFrames:false (see
// service-worker.js's injectRecorderIntoTab) — it never runs inside an
// iframe at all. page.addInitScript(), unlike that, applies to EVERY frame
// on the page by default, including ones the recorded workflow has nothing
// to do with (ad iframes, embedded sign-in widgets a real site like
// youtube.com loads on its homepage). Each such iframe would otherwise get
// its own independent copy of content.js, which independently reports its
// OWN frame's "recorder:ready" and records ITS OWN initial navigation —
// polluting the event log with an iframe's unrelated URL (once literally an
// embedded Google sign-in iframe's src), which a later replay would then
// force-navigate the whole page to. Gating on window.top === window.self
// here reproduces the real allFrames:false restriction for this harness so
// it never sees a class of failure the real extension can't experience.
const CONTENT_JS_SOURCE = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
const TOP_FRAME_ONLY_CONTENT_JS = `if (window.top === window.self) {\n${CONTENT_JS_SOURCE}\n}`;

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

const recordWorkflow = async ({ baseUrl, actions }) => {
  const events = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  await installChromeStub(page, (event) => events.push(event));
  // Registered via addInitScript (a CDP-level "run before any page script,
  // on every navigation" hook) rather than page.addScriptTag: addScriptTag
  // inserts a real <script> element and assigns its .text, which a site
  // enforcing Trusted Types (e.g. youtube.com's CSP) refuses outright —
  // addInitScript isn't a DOM injection sink at all, so it isn't subject to
  // that restriction, and it also means content.js only needs registering
  // ONCE here: Playwright automatically re-runs it on every subsequent
  // navigation in this page, so there's no separate 'load'-listener
  // re-injection to maintain either.
  await page.addInitScript({ content: TOP_FRAME_ONLY_CONTENT_JS });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200); // let content.js's own initialize() round-trip complete

    for (const action of actions) {
      await action(page);
    }

    await page.waitForTimeout(200);
    const finalUrl = page.url();
    return { events, finalUrl };
  } finally {
    // MUST run even when an action throws (a real, common case against
    // live sites — a transient timeout, an unexpected overlay) — without
    // this, every such failure leaked an entire orphaned Chrome process
    // that kept running for the rest of this script's lifetime, silently
    // degrading every SUBSEQUENT scenario's timing/reliability and making
    // failures look like they were shifting around at random between
    // scenarios from one run to the next.
    await browser.close().catch(() => {});
  }
};

module.exports = { startServer, recordWorkflow, parameterizeWorkflowRuleBased, runWorkflow };
