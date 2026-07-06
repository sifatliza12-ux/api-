const { chromium } = require('playwright');

const DEFAULT_TIMEOUT_MS = 15000;
const PLACEHOLDER_PATTERN = /^\{\{(.+)\}\}$/;

// Every parameterized step's value is set to exactly "{{paramName}}" (see
// ruleBasedParameterizer.js) so a full-string match is all that's needed —
// there's no embedded-placeholder-in-a-larger-string case to handle.
const substitutePlaceholders = (value, parameterValues) => {
  if (typeof value !== 'string') {
    return value;
  }

  const match = value.match(PLACEHOLDER_PATTERN);
  if (!match) {
    return value;
  }

  const paramName = match[1];
  if (!Object.prototype.hasOwnProperty.call(parameterValues, paramName)) {
    throw new Error(`Missing value for parameter "${paramName}"`);
  }

  return parameterValues[paramName];
};

const parseScrollValue = (value) => {
  const [xRaw, yRaw] = String(value || '0,0').split(',');
  return { x: Number(xRaw) || 0, y: Number(yRaw) || 0 };
};

const scrollWindow = async (page, x, y) => {
  await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y]);
};

const scrollElement = async (page, selector, x, y) => {
  await page.waitForSelector(selector, { state: 'attached', timeout: DEFAULT_TIMEOUT_MS });
  await page.locator(selector).evaluate((el, [sx, sy]) => {
    el.scrollLeft = sx;
    el.scrollTop = sy;
  }, [x, y]);
};

// Playwright's touchscreen API only exposes a single-point tap, no native
// swipe primitive. A swipe is replayed as a tap at the recorded gesture's
// start point followed by a tap at its end point — a reasonable
// approximation of the gesture, not a literal smooth drag.
const simulateTouch = async (page, gestureType, meta) => {
  const endX = meta?.x ?? 0;
  const endY = meta?.y ?? 0;
  const startX = endX - (meta?.dx || 0);
  const startY = endY - (meta?.dy || 0);

  await page.touchscreen.tap(startX, startY);
  if (gestureType === 'swipe') {
    await page.waitForTimeout(50);
    await page.touchscreen.tap(endX, endY);
  }
};

const fillField = async (page, selector, value) => {
  if (typeof value === 'boolean') {
    await page.setChecked(selector, value);
    return;
  }

  try {
    await page.fill(selector, value === null || typeof value === 'undefined' ? '' : String(value));
  } catch (fillError) {
    // Not a fillable <input>/<textarea>/[contenteditable] (e.g. a <select>) —
    // fall back to option selection.
    await page.selectOption(selector, String(value));
  }
};

// Our recorder doesn't tag events with an explicit tab ID, but every event
// does carry the URL of the page it happened on. We use that as a best-effort
// signal for which already-open page a step belongs to: if a step's recorded
// URL matches a different open page's origin than the one we're currently
// on, switch to it. This handles "user opened a new tab, did stuff, then
// switched back" without needing real tab tracking.
const createPageTracker = (initialPage) => {
  let currentPage = initialPage;
  const pagesByOrigin = new Map();

  const remember = (page) => {
    try {
      const origin = new URL(page.url()).origin;
      pagesByOrigin.set(origin, page);
    } catch (error) {
      // about:blank or invalid URL — nothing to key by yet.
    }
  };

  const resolveForStep = (step) => {
    if (!step.url) {
      return;
    }
    try {
      const stepOrigin = new URL(step.url).origin;
      const matched = pagesByOrigin.get(stepOrigin);
      if (matched && matched !== currentPage) {
        currentPage = matched;
      }
    } catch (error) {
      // step.url isn't a valid absolute URL — keep the current page.
    }
  };

  return {
    get current() { return currentPage; },
    set current(page) { currentPage = page; },
    remember,
    resolveForStep
  };
};

const runWorkflow = async ({ steps, parameterValues }) => {
  const values = parameterValues || {};
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ hasTouch: true });
  const tracker = createPageTracker(await context.newPage());

  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];

      try {
        if (step.type !== 'navigation' && step.type !== 'new_page') {
          tracker.resolveForStep(step);
        }

        const page = tracker.current;

        switch (step.type) {
          case 'navigation': {
            const url = substitutePlaceholders(step.value, values);
            if (url) {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
              await page.waitForLoadState('load', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
              tracker.remember(page);
            }
            break;
          }

          case 'click': {
            await page.waitForSelector(step.selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
            await page.click(step.selector);
            break;
          }

          case 'dblclick': {
            await page.waitForSelector(step.selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
            await page.dblclick(step.selector);
            break;
          }

          case 'input':
          case 'change': {
            const value = substitutePlaceholders(step.value, values);
            await page.waitForSelector(step.selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
            await fillField(page, step.selector, value);
            break;
          }

          case 'scroll': {
            const { x, y } = parseScrollValue(step.value);
            const target = step.meta?.target;
            if (!target || target === 'window') {
              await scrollWindow(page, x, y);
            } else {
              await scrollElement(page, target, x, y);
            }
            break;
          }

          case 'touch': {
            await simulateTouch(page, step.value, step.meta);
            break;
          }

          case 'new_page': {
            const newPage = await context.newPage();
            tracker.current = newPage;
            if (step.url) {
              await newPage.goto(step.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
            }
            tracker.remember(newPage);
            break;
          }

          default:
            // Unknown/unsupported step type — skip rather than fail the whole replay.
            break;
        }
      } catch (stepError) {
        throw Object.assign(new Error(`Step ${i} (${step.type}) failed: ${stepError.message}`), {
          stepIndex: i,
          stepType: step.type
        });
      }
    }

    const finalPage = tracker.current;
    const finalUrl = finalPage.url();
    const finalTitle = await finalPage.title();

    return { finalUrl, finalTitle };
  } finally {
    await context.close();
    await browser.close();
  }
};

module.exports = { runWorkflow };
