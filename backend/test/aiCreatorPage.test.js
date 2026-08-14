// Tests for the AI Creator EXTENSION PAGE (extension/ai-creator/) — Phase 3
// frontend wiring. The extension has no test infrastructure of its own (no
// framework, no test files); following this repo's own precedent
// (replayEngine.e2e.test.js already loads real extension/content/content.js
// into a Playwright page via a fixture harness), this loads the REAL
// ai-creator.html/.css/.js over file:// in a real headless Chromium, with
// chrome.storage/chrome.runtime shimmed (there is no real extension
// context outside Chrome) and every backend call intercepted via
// page.route() — no live backend, no live Ollama, ever required.
//
// Two conceptually different example intents (flight vs. hotel/search) are
// used throughout specifically to prove the page renders whatever
// parameters the backend returns, with no task-specific frontend code.
//
// Run with: node backend/test/aiCreatorPage.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', '..', 'extension', 'ai-creator', 'ai-creator.html')).href;

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

// --- Fixtures ---------------------------------------------------------

const FLIGHT_INTENT = {
  targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9, needsConfirmation: false },
  task: 'Search for flights',
  parameters: [
    { name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin', description: 'Departure location' },
    { name: 'destination', type: 'text', value: 'Dubai', label: 'Destination', description: 'Arrival location' }
  ]
};

// Deliberately a totally different shape (city/date/number instead of
// origin/destination) — proves nothing in the page assumes flight-shaped
// parameters. Also needsConfirmation: true, to exercise that gate.
const HOTEL_INTENT = {
  targetSite: { name: 'Booking.com', url: 'https://www.booking.com', confidence: 0.4, needsConfirmation: true },
  task: 'Search hotels',
  parameters: [
    { name: 'city', type: 'text', value: "Cox's Bazar", label: 'City', description: 'Hotel destination' },
    { name: 'check_in', type: 'date', value: '2026-09-10', label: 'Check-in', description: 'Hotel check-in date' },
    { name: 'nights', type: 'number', value: '3', label: 'Number of nights', description: 'Length of stay' }
  ]
};

let sessionCounter = 1000;
const makeSession = ({ sessionId, status = 'awaiting_confirmation', nlCommand = 'test command', intent = null, generatedWorkflowId = null, extraMessages = [] } = {}) => ({
  sessionId: String(sessionId || (sessionCounter += 1)),
  status,
  nlCommand,
  messages: [
    { role: 'user', text: nlCommand, at: new Date().toISOString() },
    ...(intent ? [{ role: 'assistant', type: 'intent', intent, at: new Date().toISOString() }] : []),
    ...extraMessages
  ],
  intent,
  generatedWorkflowId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

// --- Harness ------------------------------------------------------------

const seedChromeShim = (authToken) => {
  window.__ffStorage = authToken
    ? { 'forgeflow.auth': { token: authToken, user: { id: 1, email: 'test@example.com', name: 'Test User' } } }
    : {};
  window.chrome = {
    storage: {
      local: {
        get: (key, cb) => {
          if (typeof key === 'string') { cb({ [key]: window.__ffStorage[key] }); } else { cb({ ...window.__ffStorage }); }
        },
        set: (obj, cb) => { Object.assign(window.__ffStorage, obj); if (cb) cb(); },
        remove: (key, cb) => { delete window.__ffStorage[key]; if (cb) cb(); }
      }
    },
    runtime: { getURL: (p) => p }
  };
};

const fulfillJson = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Builds a page.route handler from an ordered list of
// { test: (url, method) => bool, respond: async (route, request) => void }
// matchers, recording every intercepted request into `calls`, falling back
// to an innocuous 200 for anything unmatched (e.g. notifications.js's own
// background poll) so unrelated shared scripts never error the page out.
const makeRouter = (matchers) => {
  const calls = [];
  const handler = async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    calls.push({ url, method, postData: request.postData() });
    for (const m of matchers) {
      if (m.test(url, method)) {
        await m.respond(route, request);
        return;
      }
    }
    await fulfillJson(route, 200, { success: true });
  };
  return { handler, calls };
};

let browser;

// authToken: null to test the logged-out gate; a string otherwise.
// matchers: backend route handlers (see makeRouter).
// speech: 'fake' | 'unsupported' | undefined (leave real headless Chromium behavior alone)
const withPage = async ({ authToken = 'test-token', matchers = [], speech } = {}, fn) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(seedChromeShim, authToken);
  if (speech === 'fake') {
    await page.addInitScript(() => {
      window.__recognitionInstances = [];
      class FakeRecognition extends EventTarget {
        start() { window.__recognitionInstances.push(this); this.dispatchEvent(new Event('start')); }
        stop() { this.dispatchEvent(new Event('end')); }
      }
      window.SpeechRecognition = FakeRecognition;
      delete window.webkitSpeechRecognition;
    });
  } else if (speech === 'unsupported') {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
      Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    });
  }

  const { handler, calls } = makeRouter(matchers);
  await page.route('http://localhost:5000/**', handler);

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  // ai-creator.js's own DOMContentLoaded init (auth check) has finished once
  // the input is no longer in its initial disabled-by-default state AND the
  // script has had a chance to run — waiting on the mic button's final
  // disabled/enabled state (set synchronously at the end of init, after the
  // auth await) is a reliable "page is ready" signal for both branches.
  await page.waitForFunction(() => document.getElementById('mic-btn') !== null);
  await page.waitForTimeout(50); // let the auth-check microtask queue drain

  try {
    await fn(page, calls);
  } finally {
    await context.close();
  }
};

const run = async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  await test('page loads and shows the empty-state prompt when no conversation exists yet', async () => {
    await withPage({}, async (page) => {
      await assert.doesNotReject(page.title());
      const emptyVisible = await page.isVisible('#chat-empty');
      assert.ok(emptyVisible, 'expected the empty-state prompt to be visible with no session yet');
      const inputDisabled = await page.$eval('#ai-input', (el) => el.disabled);
      assert.strictEqual(inputDisabled, false);
    });
  });

  await test('with no auth token, the input is disabled and the auth note is shown', async () => {
    await withPage({ authToken: null }, async (page) => {
      const noteHidden = await page.$eval('#auth-note', (el) => el.hidden);
      assert.strictEqual(noteHidden, false);
      const inputDisabled = await page.$eval('#ai-input', (el) => el.disabled);
      assert.strictEqual(inputDisabled, true);
    });
  });

  await test('sending a typed command calls POST /api/ai-creator/sessions with the command, and renders the confirmation area', async () => {
    const session = makeSession({ nlCommand: 'Create an API to search for flights from Dhaka to Dubai.', intent: FLIGHT_INTENT });
    const matchers = [{
      test: (url, method) => url.endsWith('/api/ai-creator/sessions') && method === 'POST',
      respond: (route, request) => {
        const body = JSON.parse(request.postData());
        assert.strictEqual(body.command, 'Create an API to search for flights from Dhaka to Dubai.');
        return fulfillJson(route, 201, { success: true, ...session });
      }
    }];

    await withPage({ matchers }, async (page, calls) => {
      await page.fill('#ai-input', 'Create an API to search for flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForSelector('#confirm-area:not([hidden])');

      const createCalls = calls.filter((c) => c.url.endsWith('/api/ai-creator/sessions') && c.method === 'POST');
      assert.strictEqual(createCalls.length, 1, 'expected exactly one create-session call');

      const target = await page.textContent('.ai-confirm-row-value');
      assert.ok(target.includes('FlightRadar24'));
    });
  });

  await test('confirmation area renders a flight-shaped intent (origin/destination) generically', async () => {
    const session = makeSession({ intent: FLIGHT_INTENT });
    const matchers = [{ test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...session }) }];

    await withPage({ matchers }, async (page) => {
      await page.fill('#ai-input', 'Create an API to search for flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForSelector('#confirm-area:not([hidden])');

      const text = await page.textContent('#confirm-area');
      assert.ok(text.includes('Origin'), 'expected the Origin label from the backend intent');
      assert.ok(text.includes('Dhaka'));
      assert.ok(text.includes('Destination'));
      assert.ok(text.includes('Dubai'));
      // No site-confirmation gate for this fixture (needsConfirmation: false).
      assert.ok(text.includes('Confirm & Generate') || text.includes('Confirm &amp; Generate'));
    });
  });

  await test('confirmation area renders a completely different (hotel) parameter set with the SAME code path, and gates on needsConfirmation', async () => {
    const session = makeSession({ intent: HOTEL_INTENT });
    const matchers = [{ test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...session }) }];

    await withPage({ matchers }, async (page) => {
      await page.fill('#ai-input', "Create an API to search hotels in Cox's Bazar.");
      await page.click('#send-btn');
      await page.waitForSelector('#confirm-area:not([hidden])');

      const text = await page.textContent('#confirm-area');
      assert.ok(text.includes('City'));
      assert.ok(text.includes("Cox's Bazar"));
      assert.ok(text.includes('Check-in'));
      assert.ok(text.includes('Number of nights'));
      assert.ok(text.includes('Booking.com'));

      // needsConfirmation: true — the Generate button must NOT be offered
      // until the explicit site-confirmation action is taken.
      const generateVisible = await page.isVisible('#generate-btn');
      assert.strictEqual(generateVisible, false, 'Generate must be gated behind explicit site confirmation');
      const warningVisible = await page.isVisible('.ai-site-warning');
      assert.ok(warningVisible, 'expected an explicit site-confirmation warning');

      await page.click('#confirm-site-btn');
      await page.waitForSelector('#generate-btn');
      assert.ok(await page.isVisible('#generate-btn'), 'Generate should appear once the site is explicitly confirmed');
    });
  });

  await test('a follow-up message calls POST /api/ai-creator/sessions/:id/messages, not a new session', async () => {
    const initialSession = makeSession({ sessionId: 42, intent: FLIGHT_INTENT });
    const correctedIntent = { ...FLIGHT_INTENT, parameters: [{ ...FLIGHT_INTENT.parameters[0], value: 'Chittagong' }, FLIGHT_INTENT.parameters[1]] };
    const followUpSession = makeSession({ sessionId: 42, intent: correctedIntent });

    const matchers = [
      { test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...initialSession }) },
      {
        test: (url, m) => url.endsWith('/api/ai-creator/sessions/42/messages') && m === 'POST',
        respond: (route, request) => {
          const body = JSON.parse(request.postData());
          assert.strictEqual(body.message, 'Actually use Chittagong as the origin.');
          return fulfillJson(route, 200, { success: true, ...followUpSession });
        }
      }
    ];

    await withPage({ matchers }, async (page, calls) => {
      await page.fill('#ai-input', 'Create an API to search flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForSelector('#confirm-area:not([hidden])');

      await page.fill('#ai-input', 'Actually use Chittagong as the origin.');
      await page.click('#send-btn');
      await page.waitForFunction(() => document.querySelector('#confirm-area')?.textContent.includes('Chittagong'));

      const followUpCalls = calls.filter((c) => c.url.includes('/messages'));
      assert.strictEqual(followUpCalls.length, 1);
      const newSessionCalls = calls.filter((c) => c.url.endsWith('/api/ai-creator/sessions') && c.method === 'POST');
      assert.strictEqual(newSessionCalls.length, 1, 'a follow-up must not create a second session');
    });
  });

  await test('Generate calls POST .../generate, polls GET .../sessions/:id while generating, and shows the real success result', async () => {
    const confirmedSession = makeSession({ sessionId: 7, intent: FLIGHT_INTENT });
    let releaseGenerate;
    const generateGate = new Promise((resolve) => { releaseGenerate = resolve; });

    const myApiRecord = {
      id: 501, ownerId: 1, workflowId: '77', name: 'Search for flights', version: 'v1.0', method: 'POST',
      endpoint: '/api/workflows/77/run', description: 'Generated by the AI API Creator', parameters: FLIGHT_INTENT.parameters,
      price: 0, published: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    const matchers = [
      { test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...confirmedSession }) },
      {
        test: (url, m) => url.endsWith('/api/ai-creator/sessions/7/generate') && m === 'POST',
        respond: async (route) => {
          await generateGate; // held open until the test explicitly releases it
          await fulfillJson(route, 200, {
            success: true, ...makeSession({ sessionId: 7, status: 'completed', intent: FLIGHT_INTENT, generatedWorkflowId: '77' }),
            workflowId: '77', myApiId: 501, endpoint: '/api/workflows/77/run', method: 'POST', stepCount: 2
          });
        }
      },
      {
        test: (url, m) => url.endsWith('/api/ai-creator/sessions/7') && m === 'GET',
        respond: (route) => fulfillJson(route, 200, { success: true, ...makeSession({ sessionId: 7, status: 'generating', intent: FLIGHT_INTENT }) })
      },
      {
        test: (url, m) => url.endsWith('/api/my-apis/501') && m === 'GET',
        respond: (route) => fulfillJson(route, 200, myApiRecord)
      }
    ];

    await withPage({ matchers }, async (page, calls) => {
      await page.fill('#ai-input', 'Create an API to search flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForSelector('#generate-btn');
      await page.click('#generate-btn');

      // While the generate POST is deliberately held open, the status area
      // must show the real backend 'generating' state (no fake progress %).
      await page.waitForSelector('#status-area:not([hidden])');
      const statusText = await page.textContent('#status-area');
      assert.ok(statusText.toLowerCase().includes('generat'), 'expected a "generating" status message');
      assert.ok(!/%/.test(statusText), 'must never show a fake percentage');

      // Duplicate-submission prevention: Generate is gone/disabled once busy.
      const generateStillClickable = await page.isVisible('#generate-btn');
      assert.strictEqual(generateStillClickable, false, 'Generate must not be re-offered while a generation is already in flight');

      // Let one real poll tick (POLL_INTERVAL_MS in ai-creator.js) fire
      // before releasing the held-open /generate response, so the GET
      // .../sessions/:id polling path is actually exercised, not assumed.
      await page.waitForTimeout(6300);
      releaseGenerate();
      await page.waitForSelector('#result-area:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#result-area')?.textContent.includes('generated successfully'));

      const pollCalls = calls.filter((c) => c.url.endsWith('/api/ai-creator/sessions/7') && c.method === 'GET');
      assert.ok(pollCalls.length >= 1, 'expected at least one GET .../sessions/:id poll during generation');

      const resultText = await page.textContent('#result-area');
      assert.ok(resultText.includes('/api/workflows/77/run'), 'expected the real endpoint from the backend response');
      assert.ok(await page.isVisible('#run-api-btn'));
      assert.ok(await page.isVisible('#test-api-btn'));
      assert.ok(await page.isVisible('#publish-api-btn'));
      assert.ok(await page.isVisible('#copy-json-btn'));
      assert.ok(await page.isVisible('#download-json-btn'));

      const jsonBlock = await page.textContent('.ai-json-block');
      const parsed = JSON.parse(jsonBlock);
      assert.strictEqual(parsed.id, 501);
      assert.strictEqual(parsed.endpoint, '/api/workflows/77/run');
      // JSON output must never leak internal replay details.
      assert.ok(!jsonBlock.includes('locators'));
      assert.ok(!jsonBlock.includes('selector'));
    });
  });

  await test('a failed generation (e.g. a login wall) shows a real error, never a fake success message', async () => {
    const confirmedSession = makeSession({ sessionId: 9, intent: FLIGHT_INTENT });
    const failedSession = makeSession({
      sessionId: 9, status: 'failed', intent: FLIGHT_INTENT,
      extraMessages: [{ role: 'system', type: 'error', text: 'This page requires logging in before continuing.', at: new Date().toISOString() }]
    });

    const matchers = [
      { test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...confirmedSession }) },
      {
        test: (url, m) => url.endsWith('/api/ai-creator/sessions/9/generate') && m === 'POST',
        respond: (route) => fulfillJson(route, 422, { success: false, ...failedSession, message: 'This page requires logging in before continuing.', agentResult: { stopReason: 'login_wall', stepCount: 1 } })
      }
    ];

    await withPage({ matchers }, async (page) => {
      await page.fill('#ai-input', 'Create an API to search flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForSelector('#generate-btn');
      await page.click('#generate-btn');

      await page.waitForSelector('#error-area:not([hidden])');
      const errorText = await page.textContent('#error-area');
      assert.ok(errorText.includes('logging in'), 'expected the real backend error message');

      const bodyText = await page.textContent('body');
      assert.ok(!bodyText.includes('generated successfully'), 'must never claim success after a failed generation');
      const resultHidden = await page.$eval('#result-area', (el) => el.hidden);
      assert.strictEqual(resultHidden, true);
    });
  });

  await test('voice input (SpeechRecognition) places the transcript into the same textbox, editable, without auto-sending', async () => {
    await withPage({ speech: 'fake' }, async (page) => {
      await page.click('#mic-btn');
      await page.waitForFunction(() => window.__recognitionInstances && window.__recognitionInstances.length === 1);

      await page.evaluate(() => {
        const ev = new Event('result');
        ev.results = [[{ transcript: 'Create an API to find laptops under 80000 taka' }]];
        window.__recognitionInstances[0].dispatchEvent(ev);
      });

      const inputValue = await page.inputValue('#ai-input');
      assert.strictEqual(inputValue, 'Create an API to find laptops under 80000 taka');

      // Not auto-sent — no session has been created from voice input alone.
      const confirmHidden = await page.$eval('#confirm-area', (el) => el.hidden);
      assert.strictEqual(confirmHidden, true);
    });
  });

  await test('unsupported SpeechRecognition disables the mic button and shows a fallback message, typed input still works', async () => {
    const matchers = [{ test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST', respond: (route) => fulfillJson(route, 201, { success: true, ...makeSession({ intent: FLIGHT_INTENT }) }) }];
    await withPage({ speech: 'unsupported', matchers }, async (page) => {
      const micDisabled = await page.$eval('#mic-btn', (el) => el.disabled);
      assert.strictEqual(micDisabled, true);
      const hintHidden = await page.$eval('#voice-hint', (el) => el.hidden);
      assert.strictEqual(hintHidden, false);

      // Typed input must be entirely unaffected.
      await page.fill('#ai-input', 'Create an API to search Amazon for wireless headphones.');
      await page.click('#send-btn');
      await page.waitForSelector('#confirm-area:not([hidden])');
    });
  });

  await test('duplicate submissions are prevented while a request is in flight', async () => {
    let releaseCreate;
    const gate = new Promise((resolve) => { releaseCreate = resolve; });
    const matchers = [{
      test: (url, m) => url.endsWith('/api/ai-creator/sessions') && m === 'POST',
      respond: async (route) => { await gate; await fulfillJson(route, 201, { success: true, ...makeSession({ intent: FLIGHT_INTENT }) }); }
    }];

    await withPage({ matchers }, async (page, calls) => {
      await page.fill('#ai-input', 'Create an API to search for flights from Dhaka to Dubai.');
      await page.click('#send-btn');
      await page.waitForFunction(() => document.getElementById('send-btn').disabled === true);

      // A second click while busy must not fire a second request.
      await page.click('#send-btn', { force: true }).catch(() => {});
      releaseCreate();
      await page.waitForSelector('#confirm-area:not([hidden])');

      const createCalls = calls.filter((c) => c.url.endsWith('/api/ai-creator/sessions') && c.method === 'POST');
      assert.strictEqual(createCalls.length, 1, 'expected exactly one create-session call despite the duplicate click attempt');
    });
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
