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

const toCamelCase = (raw) => {
  const words = toWords(raw).map((word) => word.toLowerCase());
  if (words.length === 0) {
    return '';
  }
  return words[0] + words.slice(1).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
};

const toLabel = (raw) => {
  const words = toWords(raw);
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

    const baseNameRaw = deriveBaseNameFromSelector(event.selector);
    let name = baseNameRaw ? toCamelCase(baseNameRaw) : '';
    let label = baseNameRaw ? toLabel(baseNameRaw) : '';

    if (!name) {
      name = `field${variableCount}`;
      label = `Field ${variableCount}`;
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
      eventIndex: event.index
    });

    return { ...event, value: `{{${uniqueName}}}` };
  });

  return { parameters, steps };
};

module.exports = { parameterizeWorkflowRuleBased };
