// Collapses a raw recorder event log into a shorter list better suited to
// LLM analysis and to direct replay: keystroke-level noise is dropped, and
// repeated `input` events on the same field collapse to their final value.
// Each condensed item keeps `originalIndex` so callers can map back into the
// exact, untouched event that was actually recorded.
//
// keyup is always noise. keydown is noise too EXCEPT for Enter — on a huge
// number of real sites (search boxes, login forms) Enter is how the user
// actually submits, with no separate click ever recorded. Dropping it
// unconditionally (as this used to) meant replay silently never left the
// pre-submit page: the click/dynamic_click step recorded right after it
// would then run against a page that never navigated, only ever matching
// whatever same-selector element happened to already exist there (e.g. a
// site's persistent, empty, zero-size placeholder) — surfacing downstream
// as a confusing "found, but not visible" on a totally unrelated step
// rather than the real problem, a missing Enter press.
const NOISE_EVENT_TYPES = new Set(['keyup']);
const isKeptKeydown = (event) => event.type === 'keydown' && event.value === 'Enter';

const condenseEvents = (events) => {
  console.log('[Backend][pipeline] step 2: event condenser received', { rawEventCount: (events || []).length });

  const condensed = [];
  const lastInputIndexBySelector = new Map();

  (events || []).forEach((event, originalIndex) => {
    if (NOISE_EVENT_TYPES.has(event.type)) {
      return;
    }
    if (event.type === 'keydown' && !isKeptKeydown(event)) {
      return;
    }

    if (event.type === 'input' && event.selector && lastInputIndexBySelector.has(event.selector)) {
      const existingIndex = lastInputIndexBySelector.get(event.selector);
      condensed[existingIndex] = {
        ...condensed[existingIndex],
        originalIndex,
        value: event.value,
        timestamp: event.timestamp
      };
      return;
    }

    const index = condensed.length;
    condensed.push({
      index,
      originalIndex,
      type: event.type,
      selector: event.selector || null,
      locators: Array.isArray(event.locators) ? event.locators : null,
      value: event.value ?? null,
      url: event.url || null,
      meta: event.meta || null,
      timestamp: event.timestamp || null
    });

    if (event.type === 'input' && event.selector) {
      lastInputIndexBySelector.set(event.selector, index);
    }
  });

  console.log('[Backend][pipeline] step 2: event condenser output', { condensedEventCount: condensed.length });
  return condensed;
};

module.exports = { condenseEvents };
