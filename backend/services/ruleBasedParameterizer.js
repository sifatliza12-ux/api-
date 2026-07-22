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
// Every term is word-bounded, including "date"/"dob" — an unbounded match
// would fire on any selector/name that merely CONTAINS those letters
// ("candidateName", "updateField", "validateEmail", "mandatoryField"),
// wrongly classifying an ordinary text field as a date. That misclassification
// isn't cosmetic: the UI renders a native date-picker input for it (see
// buildParamFieldHtml in my-apis.js), which silently discards any non-date
// value it's seeded with — making the field appear to accept no edits at all.
const DATE_NAME_PATTERN = /\bdate\b|\bdob\b|\bbirthday\b|\bday\b|\bmonth\b|\byear\b/i;

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

// Element types that can never behave like a clickable suggestion, no
// matter how "adjacent" they are to the input that preceded them: a native
// <select> renders its own OS-level picker (there's nothing in the page's
// accessibility tree to text-search for), and body/html are never
// themselves the click target in any real recording.
const NEVER_SUGGESTION_TAGS = new Set(['select', 'option', 'body', 'html']);
// Roles that mean "this is a structural/navigation control," not an item
// from a dynamically generated list.
const NON_SUGGESTION_ROLES = new Set(['navigation', 'menubar', 'tablist', 'tab']);
const SUGGESTION_ROLES = new Set(['option', 'listitem', 'menuitem']);

const normalizeForOverlap = (value) => String(value || '').toLowerCase().trim();

// A real suggestion's text either contains, or is contained by, whatever
// was actually typed ("Female" clicked after typing "Female"; "London
// Heathrow Airport" clicked after typing "London"). An unrelated control
// that merely happens to be the next click ("5 adults · 3 children · 4
// rooms" after typing a destination) shares no text with it at all.
const textOverlapsTypedValue = (clickText, typedValue) => {
  const click = normalizeForOverlap(clickText);
  const typed = normalizeForOverlap(typedValue);
  if (!click || !typed) return false;
  return click.includes(typed) || typed.includes(click);
};

// Requirement: only link a parameter to a click when the clicked element
// is PLAUSIBLY a dynamic suggestion/option generated from that input —
// not just "the next thing that got clicked." Generic across any site:
// every signal here is a structural/accessibility property (tag, role,
// listbox-container membership) or a text-overlap comparison, never a
// site-specific selector or class name.
const looksLikePlausibleSuggestion = (event, relatedParamValue) => {
  const meta = event.meta || {};
  const tag = String(meta.tag || '').toLowerCase();

  if (NEVER_SUGGESTION_TAGS.has(tag)) {
    return false;
  }
  if (meta.inCalendarContext) {
    return false; // Calendar controls are handled by the calendar_date path, never linked here.
  }
  if (meta.role && NON_SUGGESTION_ROLES.has(meta.role)) {
    return false;
  }

  // Strong, structural signals: sits inside a real listbox/autocomplete
  // container, or the element's own role says "this is a list option."
  if (meta.inListboxContext) {
    return true;
  }
  if (meta.role && SUGGESTION_ROLES.has(meta.role)) {
    return true;
  }

  // No structural signal available (a legacy recording, or content.js
  // couldn't detect a container this time) — fall back to comparing what
  // was clicked against what was actually typed. This is what separates a
  // real suggestion from an unrelated button/link that happened to be the
  // next click.
  const text = typeof event.value === 'string' ? event.value.trim() : '';
  return textOverlapsTypedValue(text, relatedParamValue);
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
    // meta.dateAttr (a calendar widget's own machine-readable data-date/
    // datetime attribute, e.g. "2026-07-31") is the most authoritative
    // signal available and must win first. The visible click text alone is
    // often just a bare day number ("31") — classifyValueText correctly
    // reads that as type:'number' (isPureNumberLike), NOT type:'date' (which
    // requires a 4-digit year, see dynamicValueDetector.js's HAS_YEAR_PATTERN
    // guard). Previously textClassification.normalized was tried before
    // meta.dateAttr regardless of its type, so a bare-day-number click inside
    // a real calendar silently got a defaultValue of "31" instead of
    // "2026-07-31" — an unparseable value for calendar_date replay
    // (parseTargetDate("31") is Invalid Date), and useless for matching
    // against a URL's checkin/checkout query params later.
    const defaultValue = meta.dateAttr
      || (selectorLooksLikeDate && selectorClassification.normalized)
      || (textClassification && (textClassification.type === 'date' || textClassification.type === 'date_range') && textClassification.normalized)
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
  // Linking to that existing parameter is checked FIRST and takes priority
  // — a suggestion click is still a suggestion click whether or not
  // content.js also flagged it as sitting in a listbox container. Merely
  // being the next click after typing is NOT enough on its own, though —
  // that alone matched an unrelated occupancy-summary button and a native
  // <select> in real recordings — so linking additionally requires
  // looksLikePlausibleSuggestion to confirm the clicked element could
  // actually behave like a live suggestion.
  if (context.relatedParamName && text && looksLikePlausibleSuggestion(event, context.relatedParamValue)) {
    return {
      kind: 'dynamic_click',
      linkedParam: context.relatedParamName,
      description: `A suggestion selected during recording (originally "${text}") for the value typed into "${context.relatedParamName}". Replay searches the live suggestion list for an option matching whatever value that parameter is given, instead of the exact original suggestion.`
    };
  }

  // No adjacent input to link to, but the click still clearly sits inside
  // a live suggestion/listbox container — still worth capturing as its own
  // parameter rather than leaving it a frozen literal selector.
  if (meta.inListboxContext && text) {
    return {
      kind: 'dynamic_click',
      paramType: 'text',
      defaultValue: text,
      description: `A suggestion/option selected during recording (originally "${text}"). Replay re-searches the page for whatever value is supplied, instead of the exact original text.`
    };
  }

  return null;
};

const FULL_PLACEHOLDER_PATTERN = /^\{\{(.+)\}\}$/;

// A resolved step's value is either a brand-new placeholder or a link to an
// existing one, but either way it's always exactly "{{paramName}}" (see
// buildDynamicClickUpgrade/the input branch below) — this pulls that name
// back out so a later step can be told "this is the same live value".
const extractPlaceholderName = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(FULL_PLACEHOLDER_PATTERN);
  return match ? match[1] : null;
};

const escapeForRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A typed/clicked value doesn't just vanish once the browser acts on it —
// on a great many sites (virtually every search engine, and any GET-based
// search/filter form) it reappears verbatim, percent-encoded, inside the URL
// the workflow lands on next ("?q=cats", "?search=cats", "/search/cats").
// These are the literal forms that survival can take, in the order they're
// tried (longest/most-specific first once sorted by the caller).
const urlEncodingVariants = (rawValue) => {
  const value = String(rawValue);
  const percentEncoded = encodeURIComponent(value);
  const plusEncoded = percentEncoded.replace(/%20/g, '+');
  return Array.from(new Set([value, percentEncoded, plusEncoded])).filter((v) => v && v.length >= 2);
};

// Finds wherever the value just typed into a field (or just clicked as a
// dynamic suggestion) survived into a URL a subsequent navigation/new_page
// step landed on, and rewrites just that occurrence to the SAME parameter's
// placeholder — so "navigate to https://site.com/search?q=cats" becomes
// "...?q={{destination}}" and tracks whatever value that parameter is given
// at replay time, instead of staying frozen at "cats" forever. Deliberately
// only ever touches the path/query/hash portion of the URL, never the
// origin, so a value that happens to overlap part of the domain itself
// (rare, but possible for very short/common words) can never corrupt it.
// Generic by construction: no site, query-key name, or URL shape is
// hardcoded — only "does this literal value, in some encoding, appear in
// the URL that came right after it was produced."
const linkUrlToPendingValue = (rawUrl, paramName, pendingValue) => {
  if (!rawUrl || !paramName || typeof pendingValue !== 'string') return null;
  const trimmedValue = pendingValue.trim();
  if (!trimmedValue) return null;

  let origin = '';
  let tail = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    origin = parsed.origin;
    tail = rawUrl.slice(origin.length);
  } catch (error) {
    // Relative or otherwise unparseable as an absolute URL — operate on the
    // whole string; there's no origin to protect.
  }

  const variants = urlEncodingVariants(trimmedValue).sort((a, b) => b.length - a.length);
  let rewrittenTail = tail;
  let matched = false;

  for (const variant of variants) {
    const regex = new RegExp(escapeForRegex(variant), 'g');
    if (regex.test(rewrittenTail)) {
      rewrittenTail = rewrittenTail.replace(regex, `{{${paramName}}}`);
      matched = true;
    }
  }

  return matched ? `${origin}${rewrittenTail}` : null;
};

// A second, GENERIC url-linking pass — deliberately not adjacency-based.
// linkUrlToPendingValue above only ever checks the single parameter that was
// "pending" immediately before one specific step, so its window closes the
// moment anything else (a scroll, an unrelated click) happens in between —
// exactly what happens when a workflow picks two calendar dates and then
// scrolls/clicks a few more times before the navigation that actually reads
// them fires. This pass instead takes every parameter the workflow ended up
// with and checks it against every navigation/new_page URL in the WHOLE
// workflow, independent of step order or distance. Matching is purely
// value-based — never a site, host, or query-parameter name — so it applies
// identically to a booking.com checkin/checkout pair, a totally different
// site's date range, or any other text/number/date parameter whose recorded
// value happens to reappear in a URL query string.
const MIN_GENERIC_URL_MATCH_LENGTH = 3;
// Matching "true"/"false" against arbitrary URL text is far too likely to
// hit an unrelated flag that happens to share that literal value — boolean
// parameters are excluded from this generic sweep for that reason (the
// adjacency-based pass above never linked them for the same reason).
const URL_MATCH_EXCLUDED_TYPES = new Set(['boolean']);

// One or more literal strings a given parameter's value might appear as in a
// URL. For most types this is just its own defaultValue. Date parameters
// also try the originating calendar_date step's own meta.dateAttr — the
// widget's own machine-readable ISO date — independent of whatever ended up
// in defaultValue, so a workflow saved before the dateAttr-first fix above
// (defaultValue "31" instead of "2026-07-31") still gets linked correctly
// without needing to be re-recorded.
const buildUrlSearchCandidates = (parameters, steps) => {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (paramName, rawValue) => {
    if (rawValue === null || typeof rawValue === 'undefined') return;
    const value = String(rawValue).trim();
    if (value.length < MIN_GENERIC_URL_MATCH_LENGTH) return;
    const key = `${paramName}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ paramName, value });
  };

  (parameters || []).forEach((param) => {
    if (URL_MATCH_EXCLUDED_TYPES.has(param.type)) return;

    addCandidate(param.name, param.defaultValue);

    if (param.type === 'date') {
      const originStep = steps[param.eventIndex];
      const dateAttr = originStep?.meta?.dateAttr;
      if (dateAttr) addCandidate(param.name, dateAttr);
    }
  });

  // Longest value first: a more specific/longer match is tried (and
  // consumed) before a shorter one that might otherwise be a substring of it
  // or of an unrelated part of the URL.
  return candidates.sort((a, b) => b.value.length - a.value.length);
};

const linkAllUrlsToParameters = (steps, parameters) => {
  const candidates = buildUrlSearchCandidates(parameters, steps);
  if (!candidates.length) {
    return { steps, changed: false };
  }

  let changed = false;

  const rewriteUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;

    let origin = '';
    let tail = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      origin = parsed.origin;
      tail = rawUrl.slice(origin.length);
    } catch (error) {
      // Relative/unparseable as an absolute URL — operate on the whole
      // string, same fallback linkUrlToPendingValue already relies on.
    }

    let rewrittenTail = tail;
    let matchedAny = false;

    for (const { paramName, value } of candidates) {
      const variants = urlEncodingVariants(value).sort((a, b) => b.length - a.length);
      for (const variant of variants) {
        const regex = new RegExp(escapeForRegex(variant), 'g');
        if (regex.test(rewrittenTail)) {
          rewrittenTail = rewrittenTail.replace(regex, `{{${paramName}}}`);
          matchedAny = true;
        }
      }
    }

    if (!matchedAny) return rawUrl;
    changed = true;
    return `${origin}${rewrittenTail}`;
  };

  const nextSteps = steps.map((step) => {
    if (step.type === 'navigation') {
      const rewritten = rewriteUrl(step.value);
      return rewritten === step.value ? step : { ...step, value: rewritten };
    }
    if (step.type === 'new_page') {
      const rewritten = rewriteUrl(step.url);
      return rewritten === step.url ? step : { ...step, url: rewritten };
    }
    return step;
  });

  return { steps: nextSteps, changed };
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

// Step types whose parameter came from a real DOM form-field event
// (input/change) — the only family where the SAME element can legitimately
// fire more than one recorded event that each independently became its own
// parameter (a browser's own 'input', firing per keystroke and already
// collapsed to its final value upstream, followed by its native 'change' on
// blur/Enter — virtually universal behavior for text fields on any site,
// framework, or workflow). Deliberately excludes click-family step types:
// two clicks sharing a generic, reusable selector (e.g. two different
// autocomplete pickers on the same page both rendering suggestions under an
// identical CSS class) are very often genuinely DIFFERENT logical inputs,
// so merging those by selector alone would wrongly conflate them.
const FIELD_VALUE_STEP_TYPES = new Set(['input', 'change']);

// Multiple recorded events on the exact same form field each get their OWN
// parameter from the per-event pass above, purely because that pass only
// ever looks at one event at a time — it has no way to know a later event
// targets a field it's already parameterized. Both steps are still real,
// distinct replay actions (a native 'change' can trigger site behavior an
// 'input' alone doesn't — populating suggestions, running validation — so
// neither can simply be dropped), but a caller should only ever see and
// edit ONE parameter for what is, from their point of view, a single field
// they'd type a single value into. Left undetected, this doesn't just
// clutter the parameter list: editing the FIRST (visible, "obvious")
// duplicate has no effect on final replay, because the LATER step — bound
// to its own, still-recorded value — fills the field again right after and
// silently overwrites the edit.
//
// This finds every group of field-value parameters that share the exact
// same originating selector, keeps the first (canonical) one, and repoints
// EVERY step in the whole workflow — not just the ones that produced the
// duplicate, since a dynamic_click/navigation step elsewhere may already be
// linked to it — at that one placeholder. Purely structural (selector
// equality on step type, nothing else): no site, field name, or label is
// ever inspected.
const dedupeFieldParameters = (parameters, steps) => {
  const canonicalNameBySelector = new Map();
  const renameMap = new Map();

  const keptParameters = parameters.filter((param) => {
    const originStep = steps[param.eventIndex];
    if (!originStep || !FIELD_VALUE_STEP_TYPES.has(originStep.type) || !originStep.selector) {
      return true;
    }

    const existingCanonical = canonicalNameBySelector.get(originStep.selector);
    if (!existingCanonical) {
      canonicalNameBySelector.set(originStep.selector, param.name);
      return true;
    }

    renameMap.set(param.name, existingCanonical);
    return false;
  });

  if (renameMap.size === 0) {
    return { parameters, steps };
  }

  const renamePlaceholders = (value) => {
    if (typeof value !== 'string' || !value.includes('{{')) {
      return value;
    }
    let result = value;
    renameMap.forEach((canonicalName, duplicateName) => {
      result = result.split(`{{${duplicateName}}}`).join(`{{${canonicalName}}}`);
    });
    return result;
  };

  const nextSteps = steps.map((step) => ({
    ...step,
    value: renamePlaceholders(step.value),
    url: renamePlaceholders(step.url)
  }));

  return { parameters: keptParameters, steps: nextSteps };
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
  let pendingInputValue = null;

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
        pendingInputValue = typeof event.value === 'string' ? event.value : null;
      }

      return { ...event, value: `{{${uniqueName}}}` };
    }

    if (event.type === 'click' || event.type === 'dblclick') {
      const upgrade = buildDynamicClickUpgrade(event, dynamicCountByPrefix, usedNames, { relatedParamName: pendingInputParamName, relatedParamValue: pendingInputValue });

      // A resolved dynamic click (a suggestion, a price/time/number option)
      // carries the same "this text is what the live parameter produced"
      // signal an input does — if that click's own recorded text survives
      // into a URL the workflow lands on next (e.g. a link opened in a new
      // tab), that URL should keep tracking the live value too. A plain,
      // unparameterized click (a nav link, a "Search" button) carries no
      // such signal, so it still closes the window exactly as before.
      const resolvedParamName = upgrade ? extractPlaceholderName(upgrade.step.value) : null;
      pendingInputParamName = resolvedParamName;
      pendingInputSelector = null;
      pendingInputValue = resolvedParamName && typeof event.value === 'string' ? event.value.trim() : null;

      if (upgrade) {
        if (upgrade.parameter) {
          usedNames.add(upgrade.parameter.name);
          parameters.push(upgrade.parameter);
        }
        return upgrade.step;
      }
      return { ...event };
    }

    if (event.type === 'navigation' || event.type === 'new_page') {
      // The URL a step lands on right after a live typed/clicked value was
      // produced is exactly the case content.js can't see coming: pressing
      // Enter in a search box (or a form's native submit) navigates the
      // browser directly, with no separate click event at all — so unlike a
      // suggestion click, this URL was NEVER given a chance to become a
      // parameter. Left alone it stays a frozen literal forever, and replay
      // will re-force it verbatim regardless of what the caller supplies.
      // Linking it here closes that gap the same way suggestion clicks are
      // already linked, just one step further down the chain.
      const urlField = event.type === 'navigation' ? 'value' : 'url';
      const rawUrl = event[urlField];
      const linkedUrl = pendingInputParamName
        ? linkUrlToPendingValue(rawUrl, pendingInputParamName, pendingInputValue)
        : null;

      pendingInputParamName = null;
      pendingInputSelector = null;
      pendingInputValue = null;

      return linkedUrl ? { ...event, [urlField]: linkedUrl } : { ...event };
    }

    if (event.type === 'keydown') {
      // The only keydown event.condenseEvents keeps is Enter, and it
      // overwhelmingly means "submit the field I just typed into" — the
      // same "this is what the live value produced" signal a click
      // carries, so a navigation right after it should still get to link
      // its URL to the live parameter (see the navigation branch above).
      // Only preserved when it fired on the SAME field currently pending
      // (an Enter pressed somewhere else entirely isn't that signal).
      if (event.selector !== pendingInputSelector) {
        pendingInputParamName = null;
        pendingInputValue = null;
      }
      pendingInputSelector = null;
      return { ...event };
    }

    // Any other event type (scroll, touch, ...) closes the "about to pick a
    // suggestion" window just as much as a click does. A real suggestion
    // selection happens in the SAME interaction burst as the typing —
    // nothing else recorded in between. Without this, a click many steps
    // later (after the user scrolled off to browse something else entirely)
    // could still inherit a stale link to a field they typed into long
    // before — exactly what happened with a plain wikilink click 15 scrolls
    // after a "light" checkbox, which got wrongly tied to that checkbox's
    // boolean value instead of being left as an ordinary, unparameterized
    // click.
    pendingInputParamName = null;
    pendingInputSelector = null;
    pendingInputValue = null;

    return { ...event };
  });

  const deduped = dedupeFieldParameters(parameters, steps);

  // Final, non-adjacency sweep — catches any parameter value that survived
  // into a navigation/new_page URL further downstream than the per-event
  // adjacency tracking above could reach (see linkAllUrlsToParameters).
  const urlLinked = linkAllUrlsToParameters(deduped.steps, deduped.parameters);

  console.log('[Backend][pipeline] step 4: workflow template created', {
    stepCount: urlLinked.steps.length,
    parameterCount: deduped.parameters.length
  });
  return { parameters: deduped.parameters, steps: urlLinked.steps };
};

module.exports = {
  parameterizeWorkflowRuleBased,
  classifyDynamicClick,
  buildDynamicClickUpgrade,
  looksLikePlausibleSuggestion,
  extractPlaceholderName,
  linkUrlToPendingValue,
  linkAllUrlsToParameters,
  dedupeFieldParameters
};
