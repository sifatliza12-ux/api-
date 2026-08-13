// V2 AI API Creator — natural-language intent parser.
//
// Converts a single natural-language automation request ("Create an API to
// search for flights from Dhaka to Dubai on FlightRadar.") into a strict,
// validated, structured intent. Nothing in this file names a specific
// website OR a specific AI vendor — actually PROPOSING an intent from the
// raw command text is delegated to whichever AIProvider is active (see
// aiProviders/index.js: rule-based by default, Ollama or Anthropic only if
// explicitly configured). This module's job is unchanged from Phase 1: take
// whatever a provider proposes and validate/sanitize it into a shape the
// rest of ForgeFlow can trust, identically regardless of which provider
// produced it.
const { getProvider } = require('./aiProviders');
const { IntentValidationError } = require('./aiProviders/errors');

const VALID_PARAM_TYPES = new Set(['text', 'number', 'date', 'select', 'boolean']);

// Below this confidence, a future confirmation screen should ask "is this
// the website you meant?" rather than proceed silently — see requirement 3
// ("target website safety"). Exposed as a named constant (not inlined) so a
// later UI/controller can reuse the exact same threshold instead of
// duplicating the number.
const SITE_CONFIRMATION_CONFIDENCE_THRESHOLD = 0.7;

const MAX_TASK_LENGTH = 300;
const MAX_SITE_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2000;
const MAX_PARAM_NAME_LENGTH = 60;
const MAX_LABEL_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_VALUE_LENGTH = 500;
const MAX_PARAMETERS = 20;

// --- Normalization helpers -------------------------------------------------
// Deliberately self-contained rather than importing from
// ruleBasedParameterizer.js: that module's toCamelCase/toWords are private
// (unexported) V1 parameterization internals, and Phase 1's instruction is
// "do not modify existing parameterization behavior unless absolutely
// necessary" — exporting from a file V1 depends on for a V2-only caller
// isn't necessary when the normalization logic itself is a few lines.
const toWords = (raw) => String(raw || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/[^a-zA-Z0-9\s]/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const toCamelCase = (raw) => {
  const words = toWords(raw);
  if (!words.length) return '';
  return words[0].toLowerCase() + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
};

const toLabel = (raw) => {
  const words = toWords(raw);
  if (!words.length) return '';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
};

const truncate = (value, maxLength) => String(value ?? '').slice(0, maxLength);

const isPlausibleUrl = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

// Normalizes one raw parameter candidate into the safe shape ForgeFlow's
// parameter model expects. Returns null only when there is truly nothing
// usable to name it from (empty/symbols-only name AND no label/value to
// derive a fallback from either) — every other imperfection (bad type, an
// over-length string, a missing label) is sanitized in place rather than
// dropping the whole parameter, matching this module's "coerce what's
// recoverable, reject only what isn't" philosophy.
const sanitizeParameter = (raw, index, usedNames) => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  let name = toCamelCase(truncate(raw.name, MAX_PARAM_NAME_LENGTH));
  if (!name) {
    name = toCamelCase(truncate(raw.label, MAX_PARAM_NAME_LENGTH)) || `param${index + 1}`;
  }

  let uniqueName = name;
  let suffix = 2;
  while (usedNames.has(uniqueName)) {
    uniqueName = `${name}${suffix}`;
    suffix += 1;
  }
  usedNames.add(uniqueName);

  let type = raw.type;
  if (!VALID_PARAM_TYPES.has(type)) {
    console.warn('[nlIntentParser] unsupported parameter type from model, coercing to "text"', { name: uniqueName, receivedType: type });
    type = 'text';
  }

  const label = truncate(raw.label, MAX_LABEL_LENGTH).trim() || toLabel(uniqueName) || uniqueName;

  return {
    name: uniqueName,
    type,
    value: typeof raw.value === 'string' ? truncate(raw.value, MAX_VALUE_LENGTH) : '',
    label,
    description: typeof raw.description === 'string' ? truncate(raw.description, MAX_DESCRIPTION_LENGTH) : ''
  };
};

// Coerces a raw confidence value into a safe 0..1 number. A missing/garbled
// confidence is treated as "unknown" (0) rather than rejected outright — per
// requirement 3, an unknown/low confidence is exactly the SAFE default that
// forces a future confirmation screen to ask the user, so silently trusting
// a bad number here would be worse than clamping it down.
const sanitizeConfidence = (raw) => {
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(1, Math.max(0, num));
};

// Validates and sanitizes the raw tool_use input from Claude into the strict
// intent shape this module promises callers. Throws IntentValidationError
// only for shapes that cannot be safely repaired (see the class comment
// above); everything else is coerced into a safe value, with a console.warn
// left behind so a genuinely bad model response is still visible in logs.
const sanitizeIntent = (rawInput) => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new IntentValidationError('Model did not return a structured intent object.', { rawInput });
  }

  const rawTask = rawInput.task;
  if (typeof rawTask !== 'string' || !rawTask.trim()) {
    throw new IntentValidationError('Model did not return a usable task description.', { rawInput });
  }
  const task = truncate(rawTask.trim(), MAX_TASK_LENGTH);

  const rawParameters = rawInput.parameters;
  if (!Array.isArray(rawParameters)) {
    throw new IntentValidationError('Model returned a malformed parameters list.', { rawInput });
  }
  if (rawParameters.length > MAX_PARAMETERS) {
    console.warn('[nlIntentParser] model returned more parameters than expected, truncating', { count: rawParameters.length });
  }

  const usedNames = new Set();
  const parameters = rawParameters
    .slice(0, MAX_PARAMETERS)
    .map((raw, index) => sanitizeParameter(raw, index, usedNames))
    .filter(Boolean);

  // Missing entirely (the user simply didn't name a site) is an expected,
  // legitimate outcome — not malformed output — so it gets a safe default
  // rather than a thrown error. A targetSite present but of the wrong
  // fundamental shape (e.g. a string instead of an object) IS malformed:
  // there's no safe way to guess what the model meant by it.
  const rawSite = rawInput.targetSite;
  if (rawSite !== undefined && rawSite !== null && (typeof rawSite !== 'object' || Array.isArray(rawSite))) {
    throw new IntentValidationError('Model returned a malformed targetSite.', { rawInput });
  }

  const siteName = truncate(typeof rawSite?.name === 'string' ? rawSite.name.trim() : '', MAX_SITE_NAME_LENGTH);
  const rawUrl = typeof rawSite?.url === 'string' ? rawSite.url.trim() : '';
  let confidence = sanitizeConfidence(rawSite?.confidence);
  let url = null;

  if (rawUrl) {
    if (isPlausibleUrl(rawUrl) && rawUrl.length <= MAX_URL_LENGTH) {
      url = rawUrl;
    } else {
      // A URL that doesn't even parse is worse than no URL at all — surface
      // that uncertainty by capping confidence rather than passing through
      // a value nothing downstream could actually navigate to.
      console.warn('[nlIntentParser] model returned an unparseable URL, dropping it', { rawUrl });
      confidence = Math.min(confidence, 0.3);
    }
  }

  // A name-less site can't be confidently anything — never let a stray
  // high confidence number pass through unopposed by a real name.
  if (!siteName) {
    confidence = 0;
  }

  return {
    targetSite: {
      name: siteName,
      url,
      confidence,
      needsConfirmation: confidence < SITE_CONFIRMATION_CONFIDENCE_THRESHOLD
    },
    task,
    parameters
  };
};

// Parses one natural-language command into a validated structured intent.
// Same entry point regardless of whether the text came from typing or
// browser speech recognition (that's a frontend concern only — this
// function has no knowledge of voice at all) AND regardless of which
// AIProvider is active: whichever provider aiProviders/index.js resolves
// proposes the raw intent, and this function validates/sanitizes it
// identically every time.
const parseIntent = async (nlCommand) => {
  const provider = getProvider();
  const rawIntent = await provider.parseIntent(nlCommand);
  return sanitizeIntent(rawIntent);
};

module.exports = {
  parseIntent,
  sanitizeIntent,
  IntentValidationError,
  SITE_CONFIRMATION_CONFIDENCE_THRESHOLD,
  VALID_PARAM_TYPES
};
