// Tests for the AI provider abstraction (backend/services/aiProviders/):
// the factory's selection logic, and ruleBasedProvider's honest, narrow
// extraction. No network calls anywhere in this file.
//
// Run with: node backend/test/aiProviders.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

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
  const originalProvider = process.env.AI_PROVIDER;

  // --- Factory selection -----------------------------------------------
  await test('AI_PROVIDER unset defaults to the rule-based provider', () => {
    delete process.env.AI_PROVIDER;
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'rule-based');
  });

  await test('AI_PROVIDER=local resolves to the rule-based provider', () => {
    process.env.AI_PROVIDER = 'local';
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'rule-based');
  });

  await test('AI_PROVIDER=rule-based resolves to the rule-based provider', () => {
    process.env.AI_PROVIDER = 'rule-based';
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'rule-based');
  });

  await test('AI_PROVIDER=ollama resolves to the ollama provider', () => {
    process.env.AI_PROVIDER = 'ollama';
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'ollama');
  });

  await test('AI_PROVIDER=anthropic resolves to the anthropic provider without requiring an API key at require time', () => {
    process.env.AI_PROVIDER = 'anthropic';
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'anthropic');
  });

  await test('AI_PROVIDER=ANTHROPIC (case-insensitive) also resolves to the anthropic provider', () => {
    process.env.AI_PROVIDER = 'ANTHROPIC';
    const { getProvider } = require('../services/aiProviders');
    assert.strictEqual(getProvider().name, 'anthropic');
  });

  await test('an unknown AI_PROVIDER throws a clear error instead of silently picking one', () => {
    process.env.AI_PROVIDER = 'made-up-provider';
    const { getProvider } = require('../services/aiProviders');
    assert.throws(() => getProvider(), /Unknown AI_PROVIDER/);
  });

  await test('never silently resolves to anthropic just because unset -- default stays rule-based', () => {
    delete process.env.AI_PROVIDER;
    const { getProvider } = require('../services/aiProviders');
    assert.notStrictEqual(getProvider().name, 'anthropic');
  });

  process.env.AI_PROVIDER = originalProvider;

  // --- ruleBasedProvider.parseIntent ------------------------------------
  const { parseIntent } = require('../services/aiProviders/ruleBasedProvider');

  await test('extracts origin/destination from a "from X to Y" flight command', async () => {
    const intent = await parseIntent('Create an API to search for flights from Dhaka to Dubai.');
    const names = intent.parameters.map((p) => p.name);
    assert.ok(names.includes('origin'));
    assert.ok(names.includes('destination'));
    const origin = intent.parameters.find((p) => p.name === 'origin');
    const destination = intent.parameters.find((p) => p.name === 'destination');
    assert.strictEqual(origin.value, 'Dhaka');
    assert.strictEqual(destination.value, 'Dubai');
  });

  await test('extracts a destination-only parameter from a bare "to Y" command', async () => {
    const intent = await parseIntent('Make an API for finding flights to Dubai.');
    assert.strictEqual(intent.parameters.length, 1);
    assert.strictEqual(intent.parameters[0].name, 'destination');
    assert.strictEqual(intent.parameters[0].value, 'Dubai');
  });

  await test('extracts a domain-like site with moderate (still-confirmable) confidence', async () => {
    const intent = await parseIntent('Create an API to search flights on flightradar24.com from Dhaka to Dubai.');
    assert.strictEqual(intent.targetSite.name, 'flightradar24.com');
    assert.strictEqual(intent.targetSite.url, 'https://flightradar24.com');
    assert.ok(intent.targetSite.confidence > 0 && intent.targetSite.confidence < 1);
  });

  await test('never fabricates a URL for a bare site NAME with no domain', async () => {
    const intent = await parseIntent('Create an API to search flights on FlightRadar from Dhaka to Dubai.');
    assert.strictEqual(intent.targetSite.name, 'FlightRadar');
    assert.strictEqual(intent.targetSite.url, undefined);
    assert.ok(intent.targetSite.confidence < 0.7, 'a bare name with no domain must stay below the confirmation threshold');
  });

  await test('returns zero confidence and no site name when the command names no site at all', async () => {
    const intent = await parseIntent('Create an API to search for flights from Dhaka to Dubai.');
    assert.strictEqual(intent.targetSite.name, '');
    assert.strictEqual(intent.targetSite.confidence, 0);
  });

  await test('the output feeds directly through sanitizeIntent without throwing (contract compatibility)', async () => {
    const { sanitizeIntent } = require('../services/nlIntentParser');
    const raw = await parseIntent('Create an API to search for flights from Dhaka to Dubai on flightradar24.com.');
    const sanitized = sanitizeIntent(raw);
    assert.strictEqual(sanitized.targetSite.needsConfirmation, true);
    assert.ok(sanitized.parameters.length >= 2);
  });

  await test('decideNextAction fails clearly rather than pretending to act on a page', async () => {
    const { decideNextAction } = require('../services/aiProviders/ruleBasedProvider');
    await assert.rejects(() => decideNextAction({}, {}, []), /not implemented/i);
  });

  // --- ollamaProvider.isAvailable ---------------------------------------
  await test('ollamaProvider reports unavailable when OLLAMA_MODEL is unset', async () => {
    const originalModel = process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_MODEL;
    const ollamaProvider = require('../services/aiProviders/ollamaProvider');
    const result = await ollamaProvider.isAvailable();
    assert.strictEqual(result.available, false);
    process.env.OLLAMA_MODEL = originalModel;
  });

  await test('ollamaProvider reports unavailable when nothing is listening at OLLAMA_BASE_URL', async () => {
    const originalModel = process.env.OLLAMA_MODEL;
    const originalBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_MODEL = 'llama3.1';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1'; // reserved/unused port, fails fast
    const ollamaProvider = require('../services/aiProviders/ollamaProvider');
    const result = await ollamaProvider.isAvailable();
    assert.strictEqual(result.available, false);
    assert.ok(result.reason);
    process.env.OLLAMA_MODEL = originalModel;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
