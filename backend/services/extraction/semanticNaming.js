// Turns the positional field arrays domExtractor.js produces into named
// objects. Naming priority mirrors requirement 3 of the extraction spec:
// explicit semantic attributes first (aria-label/data-*/placeholder, carried
// through as field.hint), then pattern-based inference (currency/rating/
// review-count look-alikes), then a stable positional fallback so nothing
// ever comes back unnamed.
const CURRENCY_PATTERN = /^[$€£¥₹]\s?[\d,.]+|\b\d[\d,.]*\s?(USD|EUR|GBP|INR)\b/i;
const REVIEW_COUNT_PATTERN = /\breviews?\b/i;
const RATING_PATTERN = /^\d(\.\d)?\s*\/\s*\d+(\.\d)?$|^\d(\.\d)?\s*stars?$/i;
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const slugify = (text) => {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || null;
};

const nameForField = (field, positionIndex, usedNames) => {
  let base = (field.hint && slugify(field.hint))
    || (field.attr === 'href' && 'url')
    || (field.attr === 'src' && 'image')
    || (CURRENCY_PATTERN.test(field.text) && 'price')
    || (REVIEW_COUNT_PATTERN.test(field.text) && 'reviews_count')
    || (RATING_PATTERN.test(field.text) && 'rating')
    || (HEADING_TAGS.has(field.tag) && 'title')
    || `field_${positionIndex + 1}`;

  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
};

// One name per slot, inferred from the first item that actually has a value
// in that slot (items can vary slightly in field count).
const inferFieldNames = (items) => {
  if (!items.length) return [];
  const maxLen = items.reduce((max, item) => Math.max(max, item.length), 0);
  const usedNames = new Set();
  const names = [];

  for (let pos = 0; pos < maxLen; pos += 1) {
    const sample = items.find((item) => item[pos])?.[pos];
    names.push(sample ? nameForField(sample, pos, usedNames) : `field_${pos + 1}`);
  }

  return names;
};

const namesToObjects = (items, fieldNames) => items.map((item) => {
  const obj = {};
  fieldNames.forEach((name, pos) => {
    const field = item[pos];
    obj[name] = field ? (field.attrValue ?? field.text ?? null) : null;
  });
  return obj;
});

module.exports = { inferFieldNames, namesToObjects };
