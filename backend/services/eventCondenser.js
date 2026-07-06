// Collapses a raw recorder event log into a shorter list better suited to
// LLM analysis and to direct replay: keystroke-level noise is dropped, and
// repeated `input` events on the same field collapse to their final value.
// Each condensed item keeps `originalIndex` so callers can map back into the
// exact, untouched event that was actually recorded.
const NOISE_EVENT_TYPES = new Set(['keydown', 'keyup']);

const condenseEvents = (events) => {
  const condensed = [];
  const lastInputIndexBySelector = new Map();

  (events || []).forEach((event, originalIndex) => {
    if (NOISE_EVENT_TYPES.has(event.type)) {
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
      value: event.value ?? null,
      url: event.url || null,
      meta: event.meta || null,
      timestamp: event.timestamp || null
    });

    if (event.type === 'input' && event.selector) {
      lastInputIndexBySelector.set(event.selector, index);
    }
  });

  return condensed;
};

module.exports = { condenseEvents };
