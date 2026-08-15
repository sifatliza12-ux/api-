// Unit tests for nlIntentParser.js. No live Anthropic API call —
// anthropicClient.getClient is monkey-patched to return a fake client whose
// messages.create() returns a hand-built tool_use response, so these tests
// run offline and deterministically. anthropicProvider.js (the AIProvider
// wrapping Anthropic, see aiProviders/) is written to call
// anthropicClient.getClient() fresh inside parseIntent() (not destructured
// at module load) specifically so this kind of late patching works
// regardless of require order.
//
// These tests specifically exercise the Anthropic tool-use round-trip (raw
// model output -> nlIntentParser.sanitizeIntent), so AI_PROVIDER is forced
// to "anthropic" here regardless of the environment's default — nlIntentParser
// itself is provider-agnostic (see aiProviders/index.js), and its sanitize
// logic is exercised identically no matter which provider is selected.
//
// Run with: node backend/test/nlIntentParser.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.AI_PROVIDER = 'anthropic';

const assert = require('assert');
const anthropicClient = require('../services/anthropicClient');
const { parseIntent, sanitizeIntent, IntentValidationError, VALID_PARAM_TYPES } = require('../services/nlIntentParser');

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

// Swaps anthropicClient.getClient for a fake that returns whatever tool_use
// input the test wants, restoring the real one afterward even if the test
// body throws.
const withMockedIntentResponse = async (toolInput, fn) => {
  const original = anthropicClient.getClient;
  anthropicClient.getClient = () => ({
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'propose_automation_intent', input: toolInput }]
      })
    }
  });
  try {
    await fn();
  } finally {
    anthropicClient.getClient = original;
  }
};

const withMockedRawResponse = async (rawResponse, fn) => {
  const original = anthropicClient.getClient;
  anthropicClient.getClient = () => ({ messages: { create: async () => rawResponse } });
  try {
    await fn();
  } finally {
    anthropicClient.getClient = original;
  }
};

const run = async () => {
  // 1. Valid natural-language request.
  await test('parses a well-formed model response into a matching structured intent', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 },
      task: 'Search for flights',
      parameters: [
        { name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin City', description: 'Departure city' },
        { name: 'destination', type: 'text', value: 'Dubai', label: 'Destination City', description: 'Arrival city' }
      ]
    }, async () => {
      const intent = await parseIntent('Create an API to search for flights from Dhaka to Dubai on FlightRadar.');
      assert.strictEqual(intent.targetSite.name, 'FlightRadar24');
      assert.strictEqual(intent.targetSite.url, 'https://www.flightradar24.com');
      assert.strictEqual(intent.targetSite.confidence, 0.9);
      assert.strictEqual(intent.targetSite.needsConfirmation, false);
      assert.strictEqual(intent.task, 'Search for flights');
      assert.strictEqual(intent.parameters.length, 2);
      assert.strictEqual(intent.parameters[0].name, 'origin');
      assert.strictEqual(intent.parameters[0].value, 'Dhaka');
    });
  });

  // 2. Multiple parameters.
  await test('preserves every parameter in a multi-parameter response, deduping colliding names', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'Example Travel', url: '', confidence: 0.5 },
      task: 'Search for hotels',
      parameters: [
        { name: 'City', type: 'text', value: 'Paris', label: 'City' },
        { name: 'city', type: 'text', value: 'checkin city dup', label: 'City again' },
        { name: 'checkInDate', type: 'date', value: '2026-09-01', label: 'Check-in' },
        { name: 'guests', type: 'number', value: '2', label: 'Guests' },
        { name: 'freeCancellation', type: 'boolean', value: 'true', label: 'Free cancellation only' }
      ]
    }, async () => {
      const intent = await parseIntent('Create an API to search hotels in Paris, checking in 2026-09-01 for 2 guests with free cancellation.');
      assert.strictEqual(intent.parameters.length, 5);
      const names = intent.parameters.map((p) => p.name);
      assert.strictEqual(new Set(names).size, 5, 'expected all parameter names to be unique after dedupe');
      assert.ok(names.includes('city'));
      assert.ok(names.includes('city2'), 'expected the colliding second "City" to be deduped to city2');
      const dateParam = intent.parameters.find((p) => p.name === 'checkInDate');
      assert.strictEqual(dateParam.type, 'date');
    });
  });

  // 3. Missing target website.
  await test('treats a genuinely unnamed site as zero confidence needing confirmation, without throwing', async () => {
    await withMockedIntentResponse({
      targetSite: { name: '', confidence: 0.8 }, // a stray high confidence with no name must not be trusted
      task: 'Search for flights',
      parameters: [{ name: 'origin', type: 'text', value: 'Dhaka', label: 'Origin' }]
    }, async () => {
      const intent = await parseIntent('Create an API to search for flights from Dhaka.');
      assert.strictEqual(intent.targetSite.name, '');
      assert.strictEqual(intent.targetSite.confidence, 0, 'a name-less site must never carry a nonzero confidence through');
      assert.strictEqual(intent.targetSite.needsConfirmation, true);
    });
  });

  // 4. Ambiguous website.
  await test('preserves a genuinely low (but nonzero) confidence for an ambiguous but named site', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'a travel booking site', confidence: 0.35 },
      task: 'Search for flights',
      parameters: []
    }, async () => {
      const intent = await parseIntent('Create an API to search for flights on some travel site.');
      assert.strictEqual(intent.targetSite.confidence, 0.35);
      assert.strictEqual(intent.targetSite.needsConfirmation, true);
    });
  });

  // 5. Unsupported parameter type returned by model.
  await test('coerces an unsupported parameter type to "text" instead of rejecting the whole intent', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'Example Shop', confidence: 0.8 },
      task: 'Search for products',
      parameters: [{ name: 'price', type: 'currency', value: '19.99', label: 'Price' }]
    }, async () => {
      const intent = await parseIntent('Create an API to search products under a given price.');
      assert.strictEqual(intent.parameters[0].type, 'text');
      assert.ok(VALID_PARAM_TYPES.has(intent.parameters[0].type));
    });
  });

  // 6. Malformed model output.
  await test('throws IntentValidationError when the model never calls the tool', async () => {
    await withMockedRawResponse({ content: [{ type: 'text', text: 'Sure, I can help with that!' }] }, async () => {
      await assert.rejects(() => parseIntent('Create an API to do something.'), IntentValidationError);
    });
  });

  await test('throws IntentValidationError when parameters is not an array', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'Example', confidence: 0.5 },
      task: 'Do something',
      parameters: 'not-an-array'
    }, async () => {
      await assert.rejects(() => parseIntent('Create an API to do something.'), IntentValidationError);
    });
  });

  await test('throws IntentValidationError when task is missing', async () => {
    await withMockedIntentResponse({
      targetSite: { name: 'Example', confidence: 0.5 },
      parameters: []
    }, async () => {
      await assert.rejects(() => parseIntent('Create an API.'), IntentValidationError);
    });
  });

  await test('throws IntentValidationError when targetSite is the wrong fundamental shape', async () => {
    await withMockedIntentResponse({
      targetSite: 'FlightRadar', // a string, not an object — not repairable
      task: 'Search for flights',
      parameters: []
    }, async () => {
      await assert.rejects(() => parseIntent('Create an API to search flights.'), IntentValidationError);
    });
  });

  // 7. Invalid confidence value.
  await test('clamps an out-of-range confidence into 0..1 instead of throwing', async () => {
    const highIntent = sanitizeIntent({ targetSite: { name: 'Example', confidence: 1.7 }, task: 'Do X', parameters: [] });
    assert.strictEqual(highIntent.targetSite.confidence, 1);

    const lowIntent = sanitizeIntent({ targetSite: { name: 'Example', confidence: -3 }, task: 'Do X', parameters: [] });
    assert.strictEqual(lowIntent.targetSite.confidence, 0);

    const nonNumericIntent = sanitizeIntent({ targetSite: { name: 'Example', confidence: 'high' }, task: 'Do X', parameters: [] });
    assert.strictEqual(nonNumericIntent.targetSite.confidence, 0);
  });

  await test('drops an unparseable URL and caps confidence, rather than passing through an unusable value', () => {
    const intent = sanitizeIntent({
      targetSite: { name: 'Example', url: 'not a real url', confidence: 0.95 },
      task: 'Do X',
      parameters: []
    });
    assert.strictEqual(intent.targetSite.url, null);
    assert.ok(intent.targetSite.confidence <= 0.3);
  });

  // --- targetSite.urlSource (Phase 5 URL-trust classification) -------------
  // Downstream (aiBrowserAgent) trusts a user-typed URL outright but treats a
  // model-only URL as a guess to VERIFY. This proves the classification is by
  // whether the URL's host is present in the command — no known-site list.

  await test('urlSource is "user" when the URL host appears verbatim in the command', () => {
    const intent = sanitizeIntent(
      { targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 }, task: 'Search flights', parameters: [] },
      { command: 'Create an API to search flights on flightradar24.com' }
    );
    assert.strictEqual(intent.targetSite.urlSource, 'user');
  });

  await test('urlSource is "model" when a URL is present but its host is nowhere in the command (a model guess)', () => {
    const intent = sanitizeIntent(
      { targetSite: { name: 'FlightRadar24', url: 'https://www.flightradar24.com', confidence: 0.9 }, task: 'Search flights', parameters: [] },
      { command: 'Search for flights on FlightRadar24' } // brand named, but no .com typed → the URL is the model's
    );
    assert.strictEqual(intent.targetSite.urlSource, 'model', 'a URL the user never typed must not be treated as authoritative');
  });

  await test('urlSource is "none" when there is no URL, and defaults to "model" for a URL sanitized without a command', () => {
    const noUrl = sanitizeIntent({ targetSite: { name: 'Walton', confidence: 0.8 }, task: 'Search', parameters: [] }, { command: 'find Walton water heaters' });
    assert.strictEqual(noUrl.targetSite.url, null);
    assert.strictEqual(noUrl.targetSite.urlSource, 'none');

    // No command available (unit-isolated call): a present URL is conservatively 'model', never silently 'user'.
    const noCommand = sanitizeIntent({ targetSite: { name: 'X', url: 'https://x.example', confidence: 0.6 }, task: 'Do X', parameters: [] });
    assert.strictEqual(noCommand.targetSite.urlSource, 'model');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

run();
