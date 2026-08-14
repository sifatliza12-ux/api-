// Pure helpers for ollamaProvider.js — no network calls, no Playwright, no
// dependency on nlIntentParser.js (kept out of that require graph
// deliberately; see errors.js's comment on why the cycle matters). Split out
// from ollamaProvider.js so both the JSON-extraction and action-validation
// logic can be unit-tested directly, without mocking fetch.
//
// Local models (even with Ollama's format:"json" request flag) are not
// perfectly reliable about emitting bare, valid JSON — they sometimes wrap
// it in markdown fences, or prepend a sentence of prose. extractJsonObject
// tries progressively looser strategies before giving up.

class OllamaProviderError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'OllamaProviderError';
    this.details = details;
  }
}

// The action vocabulary the AI Creator's (not-yet-built) browser agent will
// support. Deliberately a closed allowlist: decideNextAction can NEVER
// return anything outside this set, which is what makes "the model cannot
// invent arbitrary browser commands or request JS execution" true by
// construction rather than by convention.
const ACTION_VOCABULARY = new Set(['navigation', 'click', 'input', 'change', 'calendar_date', 'keydown', 'done', 'stop']);
const ACTIONS_REQUIRING_REF = new Set(['click', 'input', 'change', 'calendar_date', 'keydown']);

// Matches pageSnapshotBuilder.js's `ref: \`e${index}\`` format exactly — the
// only ref shape that could ever legitimately appear in a snapshot.
const REF_PATTERN = /^e\d+$/;

const MAX_REASON_LENGTH = 500;

// Finds the first top-level {...} object in `text`, respecting string
// literals (so a brace inside a quoted value, e.g. {"reason":"click the
// {button}"}, doesn't throw off the depth count). Returns the substring, or
// null if no balanced object is found.
const findBalancedJsonObject = (text) => {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

// Tries, in order: the raw text as-is; the contents of a ```...``` /
// ```json...``` fence if present; the first balanced {...} substring found
// anywhere in the text. Returns the first candidate that parses to a plain
// (non-array, non-null) object, or null if none do.
const extractJsonObject = (rawText) => {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;

  const trimmed = rawText.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const balanced = findBalancedJsonObject(trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // try the next candidate
    }
  }
  return null;
};

const isPlausibleUrl = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

// Validates a raw proposed action from decideNextAction against the fixed
// vocabulary, and — for any action that targets an element — that the ref
// is both well-formed AND actually present in the snapshot that was handed
// to the model. This is what makes "only reference elements actually
// present in the supplied snapshot" true rather than just requested: an
// invented or stale ref is rejected here before it ever reaches Playwright.
//
// Throws OllamaProviderError for anything structurally wrong (wrong shape,
// unknown action, missing/invalid/unknown ref, non-URL navigation value) —
// there's no "coerce it into something safe" option here the way
// nlIntentParser.sanitizeIntent has for parameter types, because a bad
// action reference isn't a cosmetic issue, it's the difference between
// clicking the right element and clicking nothing (or, worse, resolving to
// the wrong one).
const validateProposedAction = (raw, { snapshot } = {}) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OllamaProviderError('Model did not return a structured action object.', { raw });
  }

  const action = raw.action;
  if (typeof action !== 'string' || !ACTION_VOCABULARY.has(action)) {
    throw new OllamaProviderError(`Model returned an action outside the allowed vocabulary: ${JSON.stringify(action)}.`, { raw });
  }

  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, MAX_REASON_LENGTH) : '';

  if (ACTIONS_REQUIRING_REF.has(action)) {
    const ref = raw.ref;
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
      throw new OllamaProviderError(`Action "${action}" requires a valid element ref (e.g. "e3"); got ${JSON.stringify(ref)}.`, { raw });
    }
    const knownRefs = new Set((snapshot?.elements || []).map((el) => el.ref));
    if (!knownRefs.has(ref)) {
      throw new OllamaProviderError(`Action "${action}" referenced ref "${ref}", which is not present in the supplied page snapshot.`, { raw, knownRefs: Array.from(knownRefs) });
    }
    const value = typeof raw.value === 'string' ? raw.value : null;
    return { action, ref, value, reason };
  }

  if (action === 'navigation') {
    if (!isPlausibleUrl(raw.value)) {
      throw new OllamaProviderError(`Action "navigation" requires a valid http(s) URL in "value"; got ${JSON.stringify(raw.value)}.`, { raw });
    }
    return { action, ref: null, value: raw.value.trim(), reason };
  }

  // done | stop — terminal actions. Any ref/value the model attached is
  // ignored rather than rejected: nothing downstream ever acts on a ref for
  // these, so there's no operational risk in a stray extra field.
  return { action, ref: null, value: null, reason };
};

module.exports = {
  extractJsonObject,
  validateProposedAction,
  isPlausibleUrl,
  OllamaProviderError,
  ACTION_VOCABULARY,
  ACTIONS_REQUIRING_REF,
  REF_PATTERN
};
