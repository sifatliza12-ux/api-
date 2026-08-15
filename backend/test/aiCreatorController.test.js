// Tests for the AI API Creator controller (session create/status/
// follow-up). Calls the controller functions directly with hand-built
// req/res objects rather than spinning up a real HTTP server — server.js
// isn't structured to export its `app` for testing, and adding an HTTP test
// dependency (e.g. supertest) isn't warranted just for this. This still
// exercises the real store (SQLite) and the real nlIntentParser/sanitizeIntent
// logic end-to-end; only the actual Anthropic network call is mocked (via
// anthropicClient.getClient, the same technique nlIntentParser.test.js uses),
// so no live API call happens and no browser/website is ever touched.
//
// AI_PROVIDER is forced to "anthropic" so these mocks are actually exercised
// — the controller itself has no knowledge of which AIProvider is active
// (that's entirely inside nlIntentParser.js/aiProviders/), so this is purely
// about making this specific test suite deterministic.
//
// Run with: node backend/test/aiCreatorController.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.AI_PROVIDER = 'anthropic';

const assert = require('assert');
const db = require('../db');
const User = require('../models/User');
const anthropicClient = require('../services/anthropicClient');
const sessionStore = require('../services/aiCreationSessionStore');
const browserAgent = require('../services/aiBrowserAgent');
const workflowStore = require('../services/workflowStore');
const myApisStore = require('../services/myApisStore');
const { createSession, getSession, addMessage, generateWorkflow } = require('../controllers/aiCreatorController');

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

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; }
});

const mockIntentResponse = (toolInput) => {
  anthropicClient.getClient = () => ({
    messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'propose_automation_intent', input: toolInput }] }) }
  });
};

const mockMalformedResponse = () => {
  anthropicClient.getClient = () => ({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'I could not find a tool to call.' }] }) }
  });
};

const run = async () => {
  const originalGetClient = anthropicClient.getClient;
  const user = await User.createUser({
    email: `ai-creator-controller-test-${Date.now()}@example.com`,
    password: 'not-a-real-password',
    name: 'AI Creator Controller Test User'
  });
  const otherUser = await User.createUser({
    email: `ai-creator-controller-test-other-${Date.now()}@example.com`,
    password: 'not-a-real-password',
    name: 'Other User'
  });
  const createdSessionIds = [];
  const createdWorkflowIds = [];
  const createdMyApiIds = [];

  // 8. Session creation.
  await test('POST /sessions creates a session and returns the parsed intent (201, awaiting_confirmation)', async () => {
    mockIntentResponse({
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [
        { name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin' },
        { name: 'destination', type: 'text', value: 'Dubai', label: 'Destination' }
      ]
    });

    const req = { body: { command: 'Create an API to search for flights from Dhaka to Dubai on FlightRadar.' }, user };
    const res = makeRes();
    await createSession(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.status, 'awaiting_confirmation');
    assert.ok(res.body.sessionId);
    assert.strictEqual(res.body.intent.targetSite.name, 'FlightRadar24');
    assert.strictEqual(res.body.intent.parameters.length, 2);
    assert.strictEqual(res.body.messages.length, 2, 'expected one user message and one assistant intent message');

    createdSessionIds.push(res.body.sessionId);

    const stored = sessionStore.getById(res.body.sessionId);
    assert.strictEqual(stored.status, 'awaiting_confirmation');
    assert.strictEqual(stored.ownerId, user.id);
  });

  await test('POST /sessions rejects an empty command with 400 and does not create a session', async () => {
    const before = sessionStore.listByOwner(user.id).length;
    const req = { body: { command: '   ' }, user };
    const res = makeRes();
    await createSession(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(sessionStore.listByOwner(user.id).length, before);
  });

  await test('POST /sessions surfaces a malformed model response as 422 and marks the session failed', async () => {
    mockMalformedResponse();
    const req = { body: { command: 'Create an API to do something vague.' }, user };
    const res = makeRes();
    await createSession(req, res);

    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.status, 'failed');
    createdSessionIds.push(res.body.sessionId);
  });

  // 9. Session status retrieval.
  await test('GET /sessions/:id returns the session for its owner', async () => {
    mockIntentResponse({
      targetSite: { name: 'Example Shop', url: '', confidence: 0.4 },
      task: 'Search for products',
      parameters: [{ name: 'query', type: 'text', value: 'shoes', label: 'Search query' }]
    });
    const createReq = { body: { command: 'Create an API to search for shoes on some shop.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    const getReq = { params: { id: createRes.body.sessionId }, user };
    const getRes = makeRes();
    getSession(getReq, getRes);

    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(getRes.body.sessionId, createRes.body.sessionId);
    assert.strictEqual(getRes.body.nlCommand, 'Create an API to search for shoes on some shop.');
    assert.deepStrictEqual(getRes.body.intent, createRes.body.intent);
  });

  await test('GET /sessions/:id returns 404 for another user\'s session', async () => {
    mockIntentResponse({ targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do X', parameters: [] });
    const createReq = { body: { command: 'Create an API to do X.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    const getReq = { params: { id: createRes.body.sessionId }, user: otherUser };
    const getRes = makeRes();
    getSession(getReq, getRes);

    assert.strictEqual(getRes.statusCode, 404);
  });

  await test('GET /sessions/:id returns 404 for a nonexistent id', async () => {
    const getReq = { params: { id: '999999999' }, user };
    const getRes = makeRes();
    getSession(getReq, getRes);
    assert.strictEqual(getRes.statusCode, 404);
  });

  // Follow-up messages.
  await test('POST /sessions/:id/messages re-parses the combined conversation and updates the intent', async () => {
    mockIntentResponse({
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [{ name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin' }]
    });
    const createReq = { body: { command: 'Create an API to search flights from Dhaka on FlightRadar.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    mockIntentResponse({
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [{ name: 'origin', type: 'text', value: 'Chittagong', label: 'Origin' }]
    });
    const msgReq = { params: { id: createRes.body.sessionId }, body: { message: 'Actually use Chittagong as the origin.' }, user };
    const msgRes = makeRes();
    await addMessage(msgReq, msgRes);

    assert.strictEqual(msgRes.statusCode, 200);
    assert.strictEqual(msgRes.body.status, 'awaiting_confirmation');
    assert.strictEqual(msgRes.body.intent.parameters[0].value, 'Chittagong');
    assert.strictEqual(msgRes.body.messages.length, 4, 'expected user+assistant from create, plus user+assistant from the follow-up');
  });

  // Regression test for a reported bug: a follow-up that completely
  // replaces the topic (not just refines a parameter) still returned the
  // STALE original intent, because the prompt sent to the AI provider was
  // an unlabeled flat concatenation of every message with no signal about
  // which one was authoritative. Captures the actual text handed to the
  // (mocked) provider to prove the fix, not just the mocked response.
  await test('POST /sessions/:id/messages: a follow-up that completely changes the topic produces the NEW intent, never the stale one', async () => {
    mockIntentResponse({
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [{ name: 'destination', type: 'text', value: 'Dubai', label: 'Destination' }]
    });
    const createReq = { body: { command: 'Search for flights on FlightRadar24' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);
    assert.strictEqual(createRes.body.intent.targetSite.name, 'FlightRadar24');

    let capturedPromptText = null;
    anthropicClient.getClient = () => ({
      messages: {
        create: async (params) => {
          capturedPromptText = params.messages[0].content;
          return {
            content: [{
              type: 'tool_use',
              name: 'propose_automation_intent',
              input: {
                targetSite: { name: 'Walton', url: null, confidence: 0.5 },
                task: 'Search for water heaters',
                parameters: [{ name: 'product', type: 'text', value: 'water heater', label: 'Product' }]
              }
            }]
          };
        }
      }
    });

    const msgReq = { params: { id: createRes.body.sessionId }, body: { message: 'I said create an API for water heater from Walton' }, user };
    const msgRes = makeRes();
    await addMessage(msgReq, msgRes);

    assert.strictEqual(msgRes.statusCode, 200);
    assert.strictEqual(msgRes.body.intent.targetSite.name, 'Walton');
    assert.strictEqual(msgRes.body.intent.task, 'Search for water heaters');
    assert.notStrictEqual(msgRes.body.intent.targetSite.name, 'FlightRadar24', 'the stale original intent must never be presented as the current confirmation after a clear correction');

    // Both messages must be preserved in the session's own history.
    const userTexts = msgRes.body.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.deepStrictEqual(userTexts, ['Search for flights on FlightRadar24', 'I said create an API for water heater from Walton']);

    // The stored session (not just the HTTP response) must also reflect it.
    const stored = sessionStore.getById(createRes.body.sessionId);
    assert.strictEqual(stored.status, 'awaiting_confirmation');

    // The actual fix: the constructed prompt must label original vs.
    // follow-up and state that a conflicting follow-up is authoritative —
    // this is what was missing before (a bare newline-joined blob).
    assert.ok(capturedPromptText.includes('Search for flights on FlightRadar24'));
    assert.ok(capturedPromptText.includes('I said create an API for water heater from Walton'));
    assert.ok(/follow-?up/i.test(capturedPromptText), 'expected the prompt to explicitly label the follow-up message');
    assert.ok(/most recent|authoritative|supersede/i.test(capturedPromptText), 'expected explicit guidance that a later, conflicting message takes priority');
  });

  await test('POST /sessions/:id/messages: an ordinary follow-up that does NOT correct the intent still preserves the existing site/task context', async () => {
    mockIntentResponse({
      targetSite: { name: 'Example Hotels', url: 'https://www.example-hotels.com', confidence: 0.8 },
      task: 'Search hotels',
      parameters: [{ name: 'nights', type: 'number', value: '2', label: 'Nights' }]
    });
    const createReq = { body: { command: 'Search hotels in Paris for 2 nights on Example Hotels.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    mockIntentResponse({
      targetSite: { name: 'Example Hotels', url: 'https://www.example-hotels.com', confidence: 0.8 },
      task: 'Search hotels',
      parameters: [{ name: 'nights', type: 'number', value: '5', label: 'Nights' }]
    });
    const msgReq = { params: { id: createRes.body.sessionId }, body: { message: 'Make it 5 nights instead.' }, user };
    const msgRes = makeRes();
    await addMessage(msgReq, msgRes);

    assert.strictEqual(msgRes.statusCode, 200);
    assert.strictEqual(msgRes.body.intent.targetSite.name, 'Example Hotels', 'a non-conflicting refinement must preserve the existing site/task context');
    assert.strictEqual(msgRes.body.intent.task, 'Search hotels');
    assert.strictEqual(msgRes.body.intent.parameters[0].value, '5');
  });

  await test('POST /sessions/:id/messages rejects a follow-up while the session is mid-generation (409)', async () => {
    mockIntentResponse({ targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do X', parameters: [] });
    const createReq = { body: { command: 'Create an API to do X.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    // Simulates a Phase-2-only state (no public endpoint reaches this in
    // Phase 1) to prove the guard exists for when one does.
    sessionStore.setStatus(createRes.body.sessionId, 'generating');

    const msgReq = { params: { id: createRes.body.sessionId }, body: { message: 'Never mind, cancel that.' }, user };
    const msgRes = makeRes();
    await addMessage(msgReq, msgRes);

    assert.strictEqual(msgRes.statusCode, 409);
  });

  await test('POST /sessions/:id/messages returns 404 for another user\'s session', async () => {
    mockIntentResponse({ targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do X', parameters: [] });
    const createReq = { body: { command: 'Create an API to do X.' }, user };
    const createRes = makeRes();
    await createSession(createReq, createRes);
    createdSessionIds.push(createRes.body.sessionId);

    const msgReq = { params: { id: createRes.body.sessionId }, body: { message: 'Hello' }, user: otherUser };
    const msgRes = makeRes();
    await addMessage(msgReq, msgRes);

    assert.strictEqual(msgRes.statusCode, 404);
  });

  // Phase 2: browser-agent generation. browserAgent.runBrowserAgent is
  // mocked (same monkey-patch technique as anthropicClient.getClient above)
  // so these tests never launch a real browser or touch a real AI
  // provider — aiBrowserAgent.js's own loop logic is covered separately by
  // test/aiBrowserAgent.test.js. This suite only proves the controller
  // wires session status, workflow persistence, and error handling
  // correctly around whatever the agent returns.
  const originalRunBrowserAgent = browserAgent.runBrowserAgent;

  const createConfirmedSession = async (command, intent) => {
    mockIntentResponse(intent);
    const req = { body: { command }, user };
    const res = makeRes();
    await createSession(req, res);
    createdSessionIds.push(res.body.sessionId);
    return res.body.sessionId;
  };

  await test('POST /sessions/:id/generate saves a workflow and completes the session on success', async () => {
    const sessionId = await createConfirmedSession('Create an API to search for flights from Dhaka to Dubai.', {
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [{ name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin' }]
    });

    // Raw recorded events (aiBrowserAgent.js's actual output shape) — fed
    // through the real, unmodified parameterizeWorkflowRuleBased inside
    // generateWorkflow, so this proves the real pipeline produces a real
    // {{placeholder}}, not a mocked/fabricated one.
    const agentSteps = [
      {
        type: 'input', value: 'Dhaka', selector: '#origin',
        locators: [{ strategy: 'css', value: '#origin' }],
        meta: { fieldContext: { label: 'Origin', ariaLabel: null, placeholder: null, name: null, nearbyText: null } },
        url: 'https://www.flightradar24.com', pageTitle: 'FlightRadar24', timestamp: new Date().toISOString()
      },
      {
        type: 'click', value: 'Search', selector: '#search-btn',
        locators: [{ strategy: 'css', value: '#search-btn' }], meta: null,
        url: 'https://www.flightradar24.com', pageTitle: 'FlightRadar24', timestamp: new Date().toISOString()
      }
    ];
    browserAgent.runBrowserAgent = async () => ({
      success: true, steps: agentSteps, history: [], finalUrl: 'https://www.flightradar24.com/results', finalTitle: 'Results'
    });

    const req = { params: { id: sessionId }, user };
    const res = makeRes();
    await generateWorkflow(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.status, 'completed');
    assert.ok(res.body.workflowId);
    assert.ok(res.body.myApiId, 'expected a My APIs record id in the response');
    assert.strictEqual(res.body.endpoint, `/api/workflows/${res.body.workflowId}/run`);
    assert.strictEqual(res.body.method, 'POST');
    assert.strictEqual(res.body.stepCount, 2);
    createdWorkflowIds.push(res.body.workflowId);
    createdMyApiIds.push(res.body.myApiId);

    const stored = sessionStore.getById(sessionId);
    assert.strictEqual(stored.status, 'completed');
    assert.strictEqual(stored.generatedWorkflowId, res.body.workflowId);

    const workflow = workflowStore.getWorkflow(res.body.workflowId);
    assert.strictEqual(workflow.ownerId, user.id);
    assert.strictEqual(workflow.visibility, 'private');
    assert.strictEqual(workflow.steps.length, 2);
    assert.strictEqual(workflow.steps[0].type, 'input');
    // Proves the REAL, unmodified ruleBasedParameterizer ran on the agent's
    // recorded events (not the AI's stated intent.parameters): the field's
    // recorded label ("Origin") becomes both a real {{origin}} placeholder
    // in the saved step AND a matching workflow.parameters entry.
    assert.strictEqual(workflow.steps[0].value, '{{origin}}', 'the recorded literal value must be replaced with a real placeholder');
    assert.strictEqual(workflow.parameters.length, 1);
    assert.strictEqual(workflow.parameters[0].name, 'origin');
    assert.strictEqual(workflow.parameters[0].defaultValue, 'Dhaka', 'the value typed during generation should be preserved as the default');

    // The part the existing "My APIs"/Run/Publish UI actually reads from —
    // proves generateWorkflow mirrors into myApisStore exactly like the
    // manual-recorder path (workflowController.parameterize) does.
    const myApi = myApisStore.getById(res.body.myApiId);
    assert.ok(myApi, 'expected a my_apis row to exist for the generated workflow');
    assert.strictEqual(myApi.ownerId, user.id);
    assert.strictEqual(myApi.workflowId, res.body.workflowId);
    assert.strictEqual(myApi.endpoint, `/api/workflows/${res.body.workflowId}/run`);
    assert.strictEqual(myApi.published, false);
    assert.strictEqual(myApi.parameters.length, 1);
  });

  await test('POST /sessions/:id/generate marks the session failed (422) when the agent stops without finishing', async () => {
    const sessionId = await createConfirmedSession('Create an API to do something the agent gives up on.', {
      targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do X', parameters: []
    });

    browserAgent.runBrowserAgent = async () => ({
      success: false, stopped: true, stopReason: 'login_wall', message: 'This page requires logging in.', steps: [], history: []
    });

    const req = { params: { id: sessionId }, user };
    const res = makeRes();
    await generateWorkflow(req, res);

    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.status, 'failed');
    assert.strictEqual(res.body.agentResult.stopReason, 'login_wall');

    const stored = sessionStore.getById(sessionId);
    assert.strictEqual(stored.generatedWorkflowId, null, 'no workflow should be saved on a failed run');
  });

  await test('POST /sessions/:id/generate marks the session failed (500) when the agent throws', async () => {
    const sessionId = await createConfirmedSession('Create an API that will error out.', {
      targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do X', parameters: []
    });

    browserAgent.runBrowserAgent = async () => { throw new Error('Playwright crashed'); };

    const req = { params: { id: sessionId }, user };
    const res = makeRes();
    await generateWorkflow(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.status, 'failed');
  });

  await test('POST /sessions/:id/generate rejects a session that is not awaiting_confirmation (409)', async () => {
    const sessionId = await createConfirmedSession('Create an API to do Y.', {
      targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do Y', parameters: []
    });
    sessionStore.setStatus(sessionId, 'completed');

    const req = { params: { id: sessionId }, user };
    const res = makeRes();
    await generateWorkflow(req, res);

    assert.strictEqual(res.statusCode, 409);
  });

  await test('POST /sessions/:id/generate returns 404 for another user\'s session', async () => {
    const sessionId = await createConfirmedSession('Create an API to do Z.', {
      targetSite: { name: 'Example', confidence: 0.5 }, task: 'Do Z', parameters: []
    });

    const req = { params: { id: sessionId }, user: otherUser };
    const res = makeRes();
    await generateWorkflow(req, res);

    assert.strictEqual(res.statusCode, 404);
  });

  browserAgent.runBrowserAgent = originalRunBrowserAgent;

  // Cleanup.
  anthropicClient.getClient = originalGetClient;
  createdMyApiIds.forEach((id) => myApisStore.deleteById(id));
  createdWorkflowIds.forEach((id) => workflowStore.deleteWorkflow(id));
  createdSessionIds.forEach((id) => sessionStore.deleteById(id));
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(otherUser.id);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
