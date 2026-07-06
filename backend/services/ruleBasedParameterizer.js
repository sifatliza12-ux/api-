const { condenseEvents } = require('./eventCondenser');

// Turns a raw selector fragment ("movie-title", "email_address", "q") into
// word tokens, splitting on camelCase, snake_case, kebab-case, and other
// punctuation.
const toWords = (raw) => String(raw)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/[^a-zA-Z0-9\s]/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const toCamelCase = (raw, maxWords) => {
  const words = toWords(raw).slice(0, maxWords).map((word) => word.toLowerCase());
  if (words.length === 0) {
    return '';
  }
  return words[0] + words.slice(1).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
};

const toLabel = (raw, maxWords) => {
  const words = toWords(raw).slice(0, maxWords);
  if (words.length === 0) {
    return '';
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
};

// Pulls a descriptive fragment out of the CSS selector content.js already
// recorded: an #id, a [name="..."]/[placeholder="..."]/[aria-label="..."]/
// [data-testid="..."] attribute, or (least specific) the first CSS class.
const deriveBaseNameFromSelector = (selector) => {
  if (!selector) {
    return null;
  }

  const idMatch = selector.match(/^#(.+)$/);
  if (idMatch) {
    return idMatch[1];
  }

  const attrMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9]*\[(name|placeholder|aria-label|data-testid)="([^"]*)"\]$/);
  if (attrMatch && attrMatch[2]) {
    return attrMatch[2];
  }

  const classMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9]*\.(.+)$/);
  if (classMatch) {
    const firstClass = classMatch[1].split('.')[0];
    if (firstClass) {
      return firstClass;
    }
  }

  return null;
};

// Rejects text that looks like a machine-generated identifier (React/Radix/MUI
// auto ids, CSS-module class hashes, "input_38473"-style DOM ids) rather than
// something a person actually wrote — so a candidate like this is never used
// as a parameter name/label even if it's the only thing available. A long run
// of digits, a known framework id prefix, a bare generic DOM word, or a single
// opaque low-vowel token are all treated as signs of a generated identifier.
const DIGIT_RUN_PATTERN = /\d{3,}/;
const FRAMEWORK_ID_PREFIX_PATTERN = /^(mui|radix|chakra|css|ember|react|ng|v-|data-v)[-:]/i;
const GENERIC_DOM_WORDS = new Set([
  'input', 'field', 'value', 'text', 'textbox', 'textfield', 'control',
  'element', 'item', 'box', 'data', 'div', 'span', 'container', 'wrapper'
]);
const VOWEL_PATTERN = /[aeiou]/gi;

const looksLikeGarbage = (raw) => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return true;
  }

  if (DIGIT_RUN_PATTERN.test(trimmed) || FRAMEWORK_ID_PREFIX_PATTERN.test(trimmed)) {
    return true;
  }

  const words = toWords(trimmed);
  if (words.length === 0) {
    return true;
  }

  // Multi-word text (e.g. "Enter your email", "customerName") is virtually
  // never a generated identifier — those are always a single opaque token.
  if (words.length > 1) {
    return false;
  }

  const word = words[0].toLowerCase();
  if (GENERIC_DOM_WORDS.has(word)) {
    return true;
  }

  if (word.length >= 6) {
    const vowelCount = (word.match(VOWEL_PATTERN) || []).length;
    if (vowelCount / word.length < 0.2) {
      return true;
    }
  }

  return false;
};

// Longer free-text candidates (a placeholder or nearby sentence) are capped
// to their first few words so the derived name/label stays short and clean
// instead of turning into a run-on phrase.
const MAX_NAME_WORDS = 4;

// Priority order for naming a parameter: visible/semantic text a person
// actually wrote always wins over DOM plumbing. Each candidate is filtered
// through looksLikeGarbage individually — a garbage label falls through to
// the next source rather than poisoning the whole pick.
const CANDIDATE_SOURCES = [
  { key: 'label', describe: (text) => `The value entered for the "${text}" field.` },
  { key: 'ariaLabel', describe: (text) => `The value entered for the "${text}" field.` },
  { key: 'placeholder', describe: (text) => `The value entered into the field labeled "${text}".` },
  { key: 'name', describe: (text) => `The value entered into the "${text}" field.` },
  { key: 'nearbyText', describe: (text) => `The value entered near "${text}" on the page.` }
];

const pickNameSource = (event) => {
  const fieldContext = event.meta?.fieldContext || {};

  for (const candidate of CANDIDATE_SOURCES) {
    const raw = fieldContext[candidate.key];
    if (raw && !looksLikeGarbage(raw)) {
      return { raw, describe: candidate.describe };
    }
  }

  const fromSelector = deriveBaseNameFromSelector(event.selector);
  if (fromSelector && !looksLikeGarbage(fromSelector)) {
    return {
      raw: fromSelector,
      describe: () => 'A value captured during recording.'
    };
  }

  return null;
};

const buildDescription = (describe, label, event) => {
  const base = describe(label);
  if (typeof event.value === 'string' && event.value && event.value !== '[REDACTED]') {
    return `${base} Example from recording: "${event.value}".`;
  }
  return base;
};

const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_NAME_PATTERN = /date|dob|birthday|\bday\b|\bmonth\b|\byear\b/i;

// checkbox/radio events already carry a real boolean (content.js's
// getElementValue returns target.checked, not a string), so that check is
// free and exact — no guessing needed. Date and number are inferred from
// the captured value shape (and, for date, the field's descriptive name).
const inferType = (value, selector) => {
  if (typeof value === 'boolean') {
    return 'boolean';
  }

  const strValue = typeof value === 'string' ? value.trim() : '';

  if (DATE_VALUE_PATTERN.test(strValue) || (selector && DATE_NAME_PATTERN.test(selector))) {
    return 'date';
  }

  if (strValue !== '' && !Number.isNaN(Number(strValue))) {
    return 'number';
  }

  return 'text';
};

const parameterizeWorkflowRuleBased = (events) => {
  const condensed = condenseEvents(events);

  const parameters = [];
  const usedNames = new Set();
  let variableCount = 0;

  const steps = condensed.map((event) => {
    const isVariable = event.type === 'input' || event.type === 'change';
    if (!isVariable) {
      return { ...event };
    }

    variableCount += 1;

    const nameSource = pickNameSource(event);
    let name = nameSource ? toCamelCase(nameSource.raw, MAX_NAME_WORDS) : '';
    let label = nameSource ? toLabel(nameSource.raw, MAX_NAME_WORDS) : '';
    let description;

    if (!name) {
      // Nothing usable was found (or every candidate looked like a
      // generated identifier) — a clean generic fallback beats exposing a
      // raw DOM id/class in a parameter that may end up shown in a
      // marketplace listing.
      name = `field${variableCount}`;
      label = `Field ${variableCount}`;
      description = 'A value captured during recording (no descriptive label was found on the page).';
    } else {
      description = buildDescription(nameSource.describe, label, event);
    }

    let uniqueName = name;
    let suffix = 2;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${name}${suffix}`;
      suffix += 1;
    }
    usedNames.add(uniqueName);

    parameters.push({
      name: uniqueName,
      type: inferType(event.value, event.selector),
      label,
      description,
      defaultValue: event.value ?? null,
      eventIndex: event.index
    });

    return { ...event, value: `{{${uniqueName}}}` };
  });

  return { parameters, steps };
};

module.exports = { parameterizeWorkflowRuleBased };
