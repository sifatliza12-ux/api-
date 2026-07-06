const { condenseEvents } = require('./eventCondenser');
const { classifyValueText } = require('./dynamicValueDetector');

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

const dedupeName = (name, usedNames) => {
  let uniqueName = name;
  let suffix = 2;
  while (usedNames.has(uniqueName)) {
    uniqueName = `${name}${suffix}`;
    suffix += 1;
  }
  return uniqueName;
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

// A click/dblclick target is treated as a *dynamic* parameter rather than a
// permanent, hardcoded selector target when either:
//   - content.js flagged it as sitting inside a calendar-like container
//     (meta.inCalendarContext, or a data-date/datetime attribute on it or
//     an ancestor), or
//   - its visible text itself matches a date/date-range/time/price/number
//     pattern (dynamicValueDetector.classifyValueText) — this is the path
//     that also covers legacy events recorded before content.js captured
//     any of the richer meta, since it only needs the plain text.
// Calendar clicks get their own step type (calendar_date) because replaying
// them needs month-navigation + semantic date matching, not just a fresh
// text search — see replayEngine.js. Everything else dynamic (price/time/
// number/free-text selections such as an autocomplete suggestion) becomes
// dynamic_click, which just re-searches the live page for the current
// parameter's value instead of the literal text recorded months ago.
// Legacy steps (recorded before content.js captured aria-label separately)
// often still have it embedded in the old single `selector` string, e.g.
// `span[aria-label="Thursday, 30 July 2026"]` — the visible click text can
// be just the bare day number ("30"), which alone looks like a plain number,
// not a date. Pulling the label back out of the selector is what lets a
// legacy calendar-cell click still classify correctly even with no meta.
const extractAriaLabelFromSelector = (selector) => {
  if (!selector) return null;
  const match = String(selector).match(/aria-label="([^"]*)"/);
  return match ? match[1] : null;
};

const classifyDynamicClick = (event, context = {}) => {
  if (event.type !== 'click' && event.type !== 'dblclick') {
    return null;
  }

  const meta = event.meta || {};
  const text = typeof event.value === 'string' ? event.value.trim() : '';
  const textClassification = classifyValueText(text);

  const selectorLabel = extractAriaLabelFromSelector(event.selector);
  const selectorClassification = selectorLabel ? classifyValueText(selectorLabel) : null;
  const selectorLooksLikeDate = selectorClassification && selectorClassification.type === 'date';

  if (meta.inCalendarContext || meta.dateAttr || selectorLooksLikeDate
    || (textClassification && textClassification.type === 'date') || (textClassification && textClassification.type === 'date_range')) {
    const defaultValue = (selectorLooksLikeDate && selectorClassification.normalized)
      || (textClassification && textClassification.normalized)
      || meta.dateAttr
      || text;
    return {
      kind: 'calendar_date',
      paramType: 'date',
      defaultValue,
      description: `A calendar date selected during recording (originally "${selectorLooksLikeDate ? selectorLabel : text}"). Resolved semantically on replay — it will find the matching day even if the calendar has moved on to a different month.`
    };
  }

  if (textClassification) {
    const kindLabel = { price: 'price', time: 'time', number: 'numeric' }[textClassification.type] || 'text';
    return {
      kind: 'dynamic_click',
      paramType: textClassification.type === 'number' ? 'number' : 'text',
      defaultValue: text,
      description: `A ${kindLabel} option selected during recording (originally "${text}"). Replay re-searches the page for whatever value is supplied, instead of the exact original text.`
    };
  }

  // Autocomplete/suggestion selection — the "type Dhaka, later run with
  // London" case. This is deliberately NOT a new independent parameter:
  // an autocomplete option only exists *because of* whatever was just typed
  // into the field right before it, so it should track that field's live
  // value automatically, not need to be kept in sync as a second parameter.
  // meta.inListboxContext (role=listbox/option, or a suggestion/dropdown
  // class — see content.js's getClickContext) is the strong, live-recording
  // signal; context.relatedParamName is the adjacency fallback for legacy
  // workflows that predate that capture — "this click came immediately
  // after typing into a field" is, on essentially every real site, exactly
  // what selecting a search/destination/movie/stock-symbol suggestion looks
  // like, regardless of what that site's dropdown markup happens to be.
  if ((meta.inListboxContext || context.relatedParamName) && text) {
    if (context.relatedParamName) {
      return {
        kind: 'dynamic_click',
        linkedParam: context.relatedParamName,
        description: `A suggestion selected during recording (originally "${text}") for the value typed into "${context.relatedParamName}". Replay searches the live suggestion list for an option matching whatever value that parameter is given, instead of the exact original suggestion.`
      };
    }
    return {
      kind: 'dynamic_click',
      paramType: 'text',
      defaultValue: text,
      description: `A suggestion/option selected during recording (originally "${text}"). Replay re-searches the page for whatever value is supplied, instead of the exact original text.`
    };
  }

  return null;
};

const NAME_PREFIX_BY_KIND = {
  calendar_date: 'calendarDate',
  price: 'priceOption',
  time: 'timeOption',
  number: 'numberOption',
  text: 'selection'
};

// Shared by the live parameterizer (fresh recordings, called from
// parameterizeWorkflowRuleBased below) and workflowUpgrader.js (retroactively
// upgrading legacy workflows saved before this feature existed) — one place
// that turns a classified dynamic click into an actual parameter + rewritten
// step, so both paths can never drift apart on naming/typing rules.
const buildDynamicClickUpgrade = (event, dynamicCountByPrefix, usedNames, context = {}) => {
  const dynamicClick = classifyDynamicClick(event, context);
  if (!dynamicClick) {
    return null;
  }

  // Linked suggestion click — no new parameter. Reuses the related field's
  // own placeholder directly, so overriding just that one parameter (e.g.
  // "destination") is enough; there's no second "which suggestion to click"
  // parameter for a caller to separately keep in sync.
  if (dynamicClick.linkedParam) {
    const step = { ...event, type: dynamicClick.kind, value: `{{${dynamicClick.linkedParam}}}` };
    return { parameter: null, step };
  }

  const textClassification = classifyValueText(typeof event.value === 'string' ? event.value.trim() : '');
  const prefixKey = dynamicClick.kind === 'calendar_date' ? 'calendar_date' : ((textClassification && textClassification.type) || 'text');
  const prefix = NAME_PREFIX_BY_KIND[prefixKey] || 'selection';
  dynamicCountByPrefix[prefix] = (dynamicCountByPrefix[prefix] || 0) + 1;

  const name = `${prefix}${dynamicCountByPrefix[prefix]}`;
  const uniqueName = dedupeName(name, usedNames);

  const parameter = {
    name: uniqueName,
    type: dynamicClick.paramType,
    label: toLabel(name, MAX_NAME_WORDS) || name,
    description: dynamicClick.description,
    defaultValue: dynamicClick.defaultValue,
    eventIndex: event.index
  };

  const step = { ...event, type: dynamicClick.kind, value: `{{${uniqueName}}}` };
  return { parameter, step };
};

const parameterizeWorkflowRuleBased = (events) => {
  console.log('[Backend][pipeline] step 3: parameterizer received', { eventCount: (events || []).length });
  const condensed = condenseEvents(events);

  const parameters = [];
  const usedNames = new Set();
  let variableCount = 0;
  const dynamicCountByPrefix = {};

  // Tracks "the parameter a caller would naturally think to override" for
  // linking an immediately-following suggestion click — see
  // classifyDynamicClick's linkedParam branch. Kept anchored to the FIRST
  // parameter created for a given selector so a field's paired input+change
  // events (recorded as two separate parameters, e.g. "destination" and
  // "destination2") don't shift the link target to the second, less
  // obvious one. Cleared after any click (the "about to pick a suggestion"
  // window closes once anything is clicked) or navigation.
  let pendingInputParamName = null;
  let pendingInputSelector = null;

  const steps = condensed.map((event) => {
    if (event.type === 'input' || event.type === 'change') {
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

      const uniqueName = dedupeName(name, usedNames);
      usedNames.add(uniqueName);

      parameters.push({
        name: uniqueName,
        type: inferType(event.value, event.selector),
        label,
        description,
        defaultValue: event.value ?? null,
        eventIndex: event.index
      });

      if (event.selector !== pendingInputSelector) {
        pendingInputParamName = uniqueName;
        pendingInputSelector = event.selector;
      }

      return { ...event, value: `{{${uniqueName}}}` };
    }

    if (event.type === 'click' || event.type === 'dblclick') {
      const upgrade = buildDynamicClickUpgrade(event, dynamicCountByPrefix, usedNames, { relatedParamName: pendingInputParamName });
      pendingInputParamName = null;
      pendingInputSelector = null;

      if (upgrade) {
        if (upgrade.parameter) {
          usedNames.add(upgrade.parameter.name);
          parameters.push(upgrade.parameter);
        }
        return upgrade.step;
      }
      return { ...event };
    }

    // Any other event type (scroll, touch, navigation, new_page, ...)
    // closes the "about to pick a suggestion" window just as much as a
    // click does. A real suggestion selection happens in the SAME
    // interaction burst as the typing — nothing else recorded in between.
    // Without this, a click many steps later (after the user scrolled off
    // to browse something else entirely) could still inherit a stale link
    // to a field they typed into long before — exactly what happened with
    // a plain wikilink click 15 scrolls after a "light" checkbox, which
    // got wrongly tied to that checkbox's boolean value instead of being
    // left as an ordinary, unparameterized click.
    pendingInputParamName = null;
    pendingInputSelector = null;

    return { ...event };
  });

  console.log('[Backend][pipeline] step 4: workflow template created', { stepCount: steps.length, parameterCount: parameters.length });
  return { parameters, steps };
};

module.exports = { parameterizeWorkflowRuleBased, classifyDynamicClick, buildDynamicClickUpgrade };
