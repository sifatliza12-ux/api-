// Classifies a recorded value/label as a *dynamic* value — a date, a price,
// a time, a plain number, or free text tied to a search/autocomplete choice
// — as opposed to a fixed, permanent piece of UI copy (a menu label, a
// button caption). This is the missing step that let click targets like a
// calendar day ("Thursday, 30 July 2026") get baked into a literal selector:
// the recorder and parameterizer only ever asked "what identifies this
// element," never "does what identifies it change over time or per user."
//
// Used from three places that need the exact same judgment call:
//   - ruleBasedParameterizer.js, classifying freshly recorded click events
//     (with rich meta from content.js) into calendar_date/dynamic_click steps
//   - workflowUpgrader.js, retroactively upgrading legacy workflows that
//     predate this feature and only have a bare selector/value string
//   - replayEngine.js, parsing a resolved calendar_date value back into a
//     real Date to search the live page for
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];
const MONTH_PATTERN = MONTH_NAMES.map((m) => m.slice(0, 3)).join('|');

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE_PATTERN = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;
// "30 July 2026", "Thursday, 30 July 2026"
const LONG_DATE_PATTERN_1 = new RegExp(`\\b\\d{1,2}\\s+(${MONTH_PATTERN})[a-z]*\\s+\\d{4}\\b`, 'i');
// "July 30, 2026" / "Jul 30 2026"
const LONG_DATE_PATTERN_2 = new RegExp(`\\b(${MONTH_PATTERN})[a-z]*\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'i');
// "Thu 30 Jul" (no year — common in compact calendar summaries)
const SHORT_DATE_PATTERN = new RegExp(`\\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\s+\\d{1,2}\\s+(${MONTH_PATTERN})[a-z]*\\b`, 'i');

const DATE_PATTERNS = [ISO_DATE_PATTERN, SLASH_DATE_PATTERN, LONG_DATE_PATTERN_1, LONG_DATE_PATTERN_2, SHORT_DATE_PATTERN];

// "Thu 30 Jul — Wed 5 Aug", "30 Jul - 5 Aug", "07/30/2026 to 08/05/2026"
const RANGE_SEPARATOR_PATTERN = /\s(—|–|-|to)\s/;

const TIME_PATTERN = /\b\d{1,2}:\d{2}\s*(am|pm|AM|PM)?\b/;

const PRICE_PATTERN = /[$€£¥₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(USD|EUR|GBP|INR)\b/i;

const PURE_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

// A year is what actually makes a date resolvable to an absolute point in
// time — without one, "Fri 31 Jul" is indistinguishable from a calendar
// *toggle* button's compact preview text (real day-picker cells expose a
// full aria-label with year; a "reopen the date picker" summary button
// often renders the exact same short day/month text but ISN'T a selectable
// cell at all). SHORT_DATE_PATTERN alone is deliberately never enough —
// requiring a 4-digit year somewhere in the text is what keeps a
// date-summary toggle from being misread as a specific selectable date
// (new Date("Fri 31 Jul") silently resolves to the year 2001 in Node/V8,
// which is exactly the kind of wrong-but-not-obviously-wrong result this
// guards against).
const HAS_YEAR_PATTERN = /\b\d{4}\b/;

const isDateLike = (text) => HAS_YEAR_PATTERN.test(text) && DATE_PATTERNS.some((pattern) => pattern.test(text));

const isDateRangeLike = (text) => {
  if (!RANGE_SEPARATOR_PATTERN.test(text) || !HAS_YEAR_PATTERN.test(text)) return false;
  const parts = text.split(RANGE_SEPARATOR_PATTERN).filter((part) => part && !/^(—|–|-|to)$/.test(part));
  return parts.filter(isDateLike).length >= 2 || (parts.length >= 1 && parts.some(isDateLike) && SHORT_DATE_PATTERN.test(text));
};

const isTimeLike = (text) => TIME_PATTERN.test(text) && text.length <= 20;

const isPriceLike = (text) => PRICE_PATTERN.test(text);

const isPureNumberLike = (text) => PURE_NUMBER_PATTERN.test(text) && text.length <= 6;

// Best-effort text -> {day, month(0-based), year}. Deliberately loose: real
// calendars phrase the same date many different ways, and getting the parse
// wrong just means falling back to the next detection strategy, not a crash.
const parseDateParts = (text) => {
  if (!text) return null;
  const trimmed = String(text).trim();

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) };
  }

  const lower = trimmed.toLowerCase();

  const m1 = lower.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_PATTERN})[a-z]*\\s+(\\d{4})`));
  if (m1) {
    const monthIndex = MONTH_NAMES.findIndex((name) => name.startsWith(m1[2]));
    if (monthIndex >= 0) return { day: Number(m1[1]), month: monthIndex, year: Number(m1[3]) };
  }

  const m2 = lower.match(new RegExp(`(${MONTH_PATTERN})[a-z]*\\s+(\\d{1,2}),?\\s+(\\d{4})`));
  if (m2) {
    const monthIndex = MONTH_NAMES.findIndex((name) => name.startsWith(m2[1]));
    if (monthIndex >= 0) return { day: Number(m2[2]), month: monthIndex, year: Number(m2[3]) };
  }

  const slash = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    // Ambiguous day/month order (DD/MM vs MM/DD) — prefer DD/MM/YYYY when
    // both readings are plausible, but fall back to MM/DD/YYYY when the
    // DD/MM reading is impossible (e.g. "07/30/2026" can only be MM/DD,
    // since 30 is not a valid month). Anything neither reading can explain
    // (e.g. a value that isn't actually a date) returns null rather than a
    // silently wrong date.
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31) {
      return { day: a, month: b - 1, year };
    }
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      return { day: b, month: a - 1, year };
    }
    return null;
  }

  return null;
};

// A single clean date/price/time/number never runs this long — anything
// past this is almost always a compound summary control ("Thu 30 Jul — Wed
// 5 Aug · 2 adults · 1 room · Search") that happens to CONTAIN a date-like
// substring rather than BEING one. Misreading a "reopen the picker" toggle
// as "select this date" produces a calendar step with no coherent date to
// resolve, so this is a correctness guard, not just tidiness.
const MAX_CLASSIFIABLE_LENGTH = 40;

// Classifies a single piece of text. Returns null if nothing dynamic-looking
// was found — the caller should treat the value as ordinary fixed UI copy.
const classifyValueText = (rawText) => {
  const text = String(rawText || '').trim();
  if (!text || text.length > MAX_CLASSIFIABLE_LENGTH) return null;

  if (isDateRangeLike(text)) {
    return { type: 'date_range', normalized: text };
  }
  if (isDateLike(text)) {
    const parts = parseDateParts(text);
    return { type: 'date', normalized: parts ? `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` : text, parts };
  }
  if (isTimeLike(text)) {
    return { type: 'time', normalized: text };
  }
  if (isPriceLike(text)) {
    return { type: 'price', normalized: text };
  }
  if (isPureNumberLike(text)) {
    return { type: 'number', normalized: text };
  }
  return null;
};

module.exports = {
  classifyValueText,
  parseDateParts,
  isDateLike,
  isDateRangeLike
};
