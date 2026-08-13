// Unit tests for the AI API Creator session store (V2 Phase 0 foundation).
// No browser needed — exercises the SQLite-backed CRUD directly, same
// spirit as the rest of this backend's store modules. Creates and cleans up
// its own throwaway user + sessions in the real local dev database (this
// project has no separate test-database setup yet), matching how the
// existing e2e suite already runs against real infrastructure rather than
// mocks.
//
// Run with: node backend/test/aiCreationSessionStore.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const db = require('../db');
const User = require('../models/User');
const sessionStore = require('../services/aiCreationSessionStore');

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
  const user = await User.createUser({
    email: `ai-creator-test-${Date.now()}@example.com`,
    password: 'not-a-real-password',
    name: 'AI Creator Test User'
  });
  const createdSessionIds = [];

  await test('create() persists a session with default status "created" and empty chat history', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search flights from Dhaka to Dubai' });
    createdSessionIds.push(session.id);
    assert.strictEqual(session.status, 'created');
    assert.deepStrictEqual(session.chatMessages, []);
    assert.strictEqual(session.generatedWorkflowId, null);
    assert.strictEqual(session.ownerId, user.id);
  });

  await test('getById() round-trips exactly what create() returned', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search hotels' });
    createdSessionIds.push(session.id);
    const fetched = sessionStore.getById(session.id);
    assert.deepStrictEqual(fetched, session);
  });

  await test('setStatus() walks the documented state machine and rejects unknown values without mutating the row', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search jobs' });
    createdSessionIds.push(session.id);

    const parsed = sessionStore.setStatus(session.id, 'parsing');
    assert.strictEqual(parsed.status, 'parsing');

    assert.throws(() => sessionStore.setStatus(session.id, 'not_a_real_status'), /Unknown AI creation session status/);
    assert.strictEqual(sessionStore.getById(session.id).status, 'parsing');
  });

  await test('appendMessage() grows chat history without discarding earlier messages', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search recipes' });
    createdSessionIds.push(session.id);

    sessionStore.appendMessage(session.id, { role: 'user', text: 'Create an API to search recipes' });
    const afterSecond = sessionStore.appendMessage(session.id, { role: 'assistant', text: 'Which site should I use?' });

    assert.strictEqual(afterSecond.chatMessages.length, 2);
    assert.strictEqual(afterSecond.chatMessages[0].text, 'Create an API to search recipes');
    assert.strictEqual(afterSecond.chatMessages[1].role, 'assistant');
  });

  await test('setGeneratedWorkflow() links a session to a workflow id, and back to null', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search news' });
    createdSessionIds.push(session.id);

    const linked = sessionStore.setGeneratedWorkflow(session.id, '42');
    assert.strictEqual(linked.generatedWorkflowId, '42');

    const unlinked = sessionStore.setGeneratedWorkflow(session.id, null);
    assert.strictEqual(unlinked.generatedWorkflowId, null);
  });

  await test("listByOwner() only returns the given owner's sessions", async () => {
    const other = await User.createUser({
      email: `ai-creator-test-other-${Date.now()}@example.com`,
      password: 'not-a-real-password',
      name: 'Other User'
    });
    const otherSession = sessionStore.create({ ownerId: other.id, nlCommand: 'Should not show up for user' });

    try {
      const mine = sessionStore.listByOwner(user.id);
      assert.ok(mine.every((s) => s.ownerId === user.id));
      assert.ok(mine.length >= createdSessionIds.length);
      assert.ok(mine.every((s) => s.id !== otherSession.id));
    } finally {
      sessionStore.deleteById(otherSession.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(other.id);
    }
  });

  await test('deleteById() removes the row and is idempotent', async () => {
    const session = sessionStore.create({ ownerId: user.id, nlCommand: 'Create an API to search weather' });
    assert.strictEqual(sessionStore.deleteById(session.id), true);
    assert.strictEqual(sessionStore.getById(session.id), null);
    assert.strictEqual(sessionStore.deleteById(session.id), false);
  });

  // Cleanup — this suite runs against the real local dev database (no
  // isolated test DB exists in this project yet), so leaving rows behind
  // would pollute it on every run.
  createdSessionIds.forEach((id) => sessionStore.deleteById(id));
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
