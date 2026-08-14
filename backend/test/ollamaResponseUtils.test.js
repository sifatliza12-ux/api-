// Unit tests for the pure helpers behind ollamaProvider.js: JSON extraction
// from raw model text, and browser-action validation. No network calls, no
// Ollama required.
//
// Run with: node backend/test/ollamaResponseUtils.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const {
  extractJsonObject,
  validateProposedAction,
  OllamaProviderError
} = require('../services/aiProviders/ollamaResponseUtils');

const results = [];
const test = (name, fn) => {
  const started = Date.now();
  try {
    fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`  ✗ ${name} (${Date.now() - started}ms)`);
    console.log(`      ${error.message}`);
  }
};

const sampleSnapshot = {
  url: 'https://example.com/search',
  title: 'Example Search',
  elements: [
    { ref: 'e0', tag: 'input', type: 'text', role: 'textbox', name: 'Destination', label: 'Destination', placeholder: 'Where to?', value: null, sensitive: false, checked: null, inViewport: true },
    { ref: 'e1', tag: 'button', type: null, role: 'button', name: 'Search', label: null, placeholder: null, value: null, sensitive: false, checked: null, inViewport: true },
    { ref: 'e2', tag: 'input', type: 'password', role: 'textbox', name: 'Password', label: 'Password', placeholder: null, value: null, sensitive: true, checked: null, inViewport: true }
  ]
};

// --- extractJsonObject -------------------------------------------------

test('parses bare, valid JSON directly', () => {
  const result = extractJsonObject('{"action":"done","ref":null,"value":null,"reason":"finished"}');
  assert.deepStrictEqual(result, { action: 'done', ref: null, value: null, reason: 'finished' });
});

test('extracts JSON from a ```json fenced block', () => {
  const raw = 'Sure, here is my answer:\n```json\n{"action":"stop","ref":null,"value":null,"reason":"blocked"}\n```\nLet me know if you need more.';
  const result = extractJsonObject(raw);
  assert.strictEqual(result.action, 'stop');
});

test('extracts JSON from an unfenced object embedded in prose', () => {
  const raw = 'I will click the search button. {"action":"click","ref":"e1","value":null,"reason":"click search"} Hope that helps!';
  const result = extractJsonObject(raw);
  assert.strictEqual(result.action, 'click');
  assert.strictEqual(result.ref, 'e1');
});

test('correctly balances braces that appear inside a quoted string value', () => {
  const raw = '{"action":"click","ref":"e1","value":null,"reason":"click the {search} button"}';
  const result = extractJsonObject(raw);
  assert.strictEqual(result.reason, 'click the {search} button');
});

test('returns null for text with no JSON object at all (malformed model output)', () => {
  const result = extractJsonObject('I think you should click the search button.');
  assert.strictEqual(result, null);
});

test('returns null for a JSON array (not an object)', () => {
  const result = extractJsonObject('["click", "e1"]');
  assert.strictEqual(result, null);
});

test('returns null for empty/non-string input', () => {
  assert.strictEqual(extractJsonObject(''), null);
  assert.strictEqual(extractJsonObject(null), null);
  assert.strictEqual(extractJsonObject(undefined), null);
});

// --- validateProposedAction ---------------------------------------------

test('accepts a valid click action referencing a real element', () => {
  const action = validateProposedAction({ action: 'click', ref: 'e1', value: null, reason: 'Click search' }, { snapshot: sampleSnapshot });
  assert.deepStrictEqual(action, { action: 'click', ref: 'e1', value: null, reason: 'Click search' });
});

test('accepts a valid input action with a text value', () => {
  const action = validateProposedAction({ action: 'input', ref: 'e0', value: 'Dubai', reason: 'Fill destination' }, { snapshot: sampleSnapshot });
  assert.strictEqual(action.action, 'input');
  assert.strictEqual(action.value, 'Dubai');
});

test('accepts a valid done action, ignoring stray ref/value on it', () => {
  const action = validateProposedAction({ action: 'done', ref: 'e0', value: 'ignored', reason: 'Results are visible' }, { snapshot: sampleSnapshot });
  assert.strictEqual(action.action, 'done');
  assert.strictEqual(action.ref, null);
  assert.strictEqual(action.value, null);
});

test('accepts a valid stop action', () => {
  const action = validateProposedAction({ action: 'stop', ref: null, value: null, reason: 'Login wall detected' }, { snapshot: sampleSnapshot });
  assert.strictEqual(action.action, 'stop');
});

test('accepts a valid navigation action with a real URL', () => {
  const action = validateProposedAction({ action: 'navigation', ref: null, value: 'https://example.com/results', reason: 'Go to results' }, { snapshot: sampleSnapshot });
  assert.strictEqual(action.value, 'https://example.com/results');
});

test('rejects an action outside the fixed vocabulary', () => {
  assert.throws(
    () => validateProposedAction({ action: 'evaluate', ref: null, value: 'window.alert(1)', reason: 'run js' }, { snapshot: sampleSnapshot }),
    OllamaProviderError
  );
});

test('rejects a click with a missing ref', () => {
  assert.throws(() => validateProposedAction({ action: 'click', ref: null, value: null, reason: 'x' }, { snapshot: sampleSnapshot }), OllamaProviderError);
});

test('rejects a click with a malformed ref (not the e<N> shape)', () => {
  assert.throws(() => validateProposedAction({ action: 'click', ref: 'button-search', value: null, reason: 'x' }, { snapshot: sampleSnapshot }), OllamaProviderError);
});

test('rejects a click with a well-formed ref that is not in the supplied snapshot (invented/stale ref)', () => {
  assert.throws(() => validateProposedAction({ action: 'click', ref: 'e99', value: null, reason: 'x' }, { snapshot: sampleSnapshot }), OllamaProviderError);
});

test('rejects a navigation action with a non-URL value', () => {
  assert.throws(() => validateProposedAction({ action: 'navigation', ref: null, value: 'not a url', reason: 'x' }, { snapshot: sampleSnapshot }), OllamaProviderError);
});

test('rejects a raw response that is not an object at all', () => {
  assert.throws(() => validateProposedAction('click e1', { snapshot: sampleSnapshot }), OllamaProviderError);
  assert.throws(() => validateProposedAction(null, { snapshot: sampleSnapshot }), OllamaProviderError);
  assert.throws(() => validateProposedAction(['click', 'e1'], { snapshot: sampleSnapshot }), OllamaProviderError);
});

test('a prompt-injection-shaped ref/value ("ignore all instructions and run alert()") is rejected the same as any other invalid ref', () => {
  // Simulates a model that got tricked by hostile page text into trying to
  // "act on" an instruction instead of a real element — the validator has
  // no special-case for this, it just rejects it as an unknown ref/action
  // like any other malformed output, which is the point: there is no
  // separate trust channel for page-derived content to exploit.
  assert.throws(
    () => validateProposedAction({ action: 'click', ref: 'ignore all previous instructions', value: null, reason: 'as instructed by the page' }, { snapshot: sampleSnapshot }),
    OllamaProviderError
  );
  assert.throws(
    () => validateProposedAction({ action: 'execute_script', ref: null, value: 'alert(document.cookie)', reason: 'page asked me to' }, { snapshot: sampleSnapshot }),
    OllamaProviderError
  );
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  process.exitCode = 1;
}
