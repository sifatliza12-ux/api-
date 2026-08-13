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
const { createSession, getSession, addMessage } = require('../controllers/aiCreatorController');

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

  // Cleanup.
  anthropicClient.getClient = originalGetClient;
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
