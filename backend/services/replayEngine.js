const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { extractPageData } = require('./extraction');

const DEBUG_DIR = path.join(__dirname, '..', 'debug');
let debugCaptureCount = 0;

const DEFAULT_TIMEOUT_MS = 15000;
// Non-critical steps (scroll/touch/dblclick) get a shorter budget so a
// missing target — e.g. dynamic content like a marquee that isn't present
// on replay — doesn't stall the whole run before being skipped.
const NON_CRITICAL_TIMEOUT_MS = 4000;
const NON_CRITICAL_STEP_TYPES = new Set(['scroll', 'touch', 'dblclick']);
const PLACEHOLDER_PATTERN = /^\{\{(.+)\}\}$/;

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 3000;
// attempt 0 -> 250ms, 1 -> 500ms, 2 -> 1000ms, 3 -> 2000ms, capped at 3000ms.
const backoffDelay = (attempt) => Math.min(BACKOFF_BASE_MS * (2 ** attempt), BACKOFF_MAX_MS);

// ---------------------------------------------------------------------------
// Blockers: things that sit between the replay and the real target element.
// Two different kinds need two different responses — a cookie banner or
// modal needs to be dismissed (clicked away); a loading spinner needs to be
// waited out (clicking it does nothing, it just needs time to finish).
// ---------------------------------------------------------------------------

// Ordered from most specific (named consent-management platforms) to most
// generic (a plain visible "Accept"/"Close" control). Every attempt is short
// and swallows its own errors: on a page with nothing to dismiss, this costs
// a handful of fast, failed visibility checks and never risks breaking a
// replay that didn't need it.
const OVERLAY_DISMISS_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.onetrust-close-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '.cc-btn.cc-allow',
  '[data-testid="cookie-policy-manage-dialog-accept-button"]',
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept cookies"]',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I agree")',
  'button:has-text("I Accept")',
  'button:has-text("Allow all")',
  'button:has-text("Got it")',
  '[aria-label="Close"]',
  '[aria-label="close"]',
  // Substring + case-insensitive match, not an exact one — real sites phrase
  // their close control's accessible name as a full sentence rather than
  // the bare word "Close" (booking.com's own sign-in nudge modal, found via
  // the blocker diagnostics below, uses aria-label="Dismiss sign in
  // information."). "Dismiss" is specifically a safe generic verb to widen
  // on: it always means "close this without acting on it," never "confirm."
  '[aria-label*="Dismiss" i]',
  '[data-dismiss="modal"]',
  '.modal-close',
  'button.close'
];

const dismissCommonOverlays = async (page) => {
  for (const selector of OVERLAY_DISMISS_SELECTORS) {
    try {
      const control = page.locator(selector).first();
      if (await control.isVisible({ timeout: 250 })) {
        await control.click({ timeout: 1000 });
        // One dismissal per call — clearing the first thing in the way is
        // what a human does before re-assessing, not clearing everything at
        // once, and avoids stacking unrelated clicks on the page.
        return selector;
      }
    } catch (error) {
      // Not present, not visible, or vanished before the click landed —
      // any of these just mean "nothing to dismiss here," keep scanning.
    }
  }
  return null;
};

// Loading spinners/skeletons aren't clicked away — they resolve on their own.
// This just waits (briefly) for anything matching these common patterns to
// stop being visible, so the replay doesn't try to interact with content
// that's still being lazily rendered underneath.
const LOADING_INDICATOR_SELECTORS = [
  '[aria-busy="true"]',
  '.loading-spinner', '.loading-overlay', '.spinner', '.skeleton', '.skeleton-loader',
  '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]'
];

const waitForLoadingIndicatorsToClear = async (page, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let anyVisible = false;
    for (const selector of LOADING_INDICATOR_SELECTORS) {
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 100 })) {
          anyVisible = true;
          break;
        }
      } catch (error) {
        // Not present — fine, keep checking the rest.
      }
    }
    if (!anyVisible) {
      return true;
    }
    await page.waitForTimeout(150);
  }
  return false;
};

// Waits for the page to genuinely settle after a navigation or an action
// that might trigger one, the way a human would pause and look before doing
// anything else — rather than acting the instant the DOM first exists.
// networkidle is best-effort only: many modern sites (analytics beacons,
// websockets, polling widgets) never truly go idle, so this must never block
// the replay — it only helps on the (common) case of a genuinely finished
// page, and silently gives up otherwise.
const waitForPageStability = async (page, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
};

// ---------------------------------------------------------------------------
// Multi-strategy locator resolution. A recorded step carries an ORDERED list
// of candidate ways to re-find its element (see content.js's
// getLocatorCandidates) — semantic/accessible attributes first, structural
// ones last. Falling back through this list, instead of trusting one fixed
// selector, is what actually fixes "works on some pages, fails on others":
// that pattern is a symptom of the one recorded selector being unstable on
// some pages, not the pages themselves being unsupportable.
// ---------------------------------------------------------------------------

const locatorFromCandidate = (page, candidate) => {
  switch (candidate.strategy) {
    case 'role':
      return page.getByRole(candidate.role, candidate.name ? { name: candidate.name, exact: false } : undefined);
    case 'text':
      return candidate.tag
        ? page.locator(candidate.tag).filter({ hasText: candidate.value })
        : page.getByText(candidate.value, { exact: false });
    case 'label':
      return page.getByLabel(candidate.value, { exact: false });
    case 'xpath':
      // content.js's getXPath() already returns a bare "//..." or "/..."
      // expression; Playwright needs the explicit xpath= engine prefix to
      // parse it as one rather than trying to read it as CSS.
      return page.locator(`xpath=${candidate.value}`);
    case 'css':
    default:
      return page.locator(candidate.value);
  }
};

// Legacy workflows recorded before this change only have step.selector (a
// single CSS string) — that still works, it just becomes a one-candidate
// list instead of a multi-strategy one. New workflows carry step.locators
// with the legacy selector appended as a final fallback, so a stale/removed
// semantic attribute never makes a step less resilient than it used to be.
//
// dynamic_click steps search for whatever the CURRENT parameter value is —
// not the literal text that happened to be on the page months ago. This is
// what makes "click the search result/suggestion/price bucket matching
// {{value}}" actually parameter-aware instead of frozen to the recording.
//
// When a live value is available it is deliberately the ONLY candidate,
// not just the first one tried alongside the old recorded selector/text.
// Both get walked in the SAME actionability sweep (findActionableCandidate
// below), so if the old structural selector happens to already match
// *something* on the page (a generic "first item in this dropdown" class
// does, regardless of its content) while the freshly-typed value's
// suggestion is still one network round-trip away from rendering, the old
// candidate would win the race and click the wrong option — exactly the
// "recorded Dhaka, still selects Dhaka after asking for London" failure
// mode. waitForActionableElement's own retry/backoff loop already re-walks
// this same fresh search every round, so there's nothing to gain — and a
// wrong-element risk to lose — by giving the stale candidates a chance to
// win early. They're only used when there's truly no live value to look for.
const getCandidateList = (step, parameterValues) => {
  if (step.type === 'dynamic_click' && step.value) {
    try {
      const currentValue = substitutePlaceholders(step.value, parameterValues || {});
      if (currentValue !== null && typeof currentValue !== 'undefined' && String(currentValue).trim()) {
        return [{ strategy: 'text', value: String(currentValue).trim() }];
      }
    } catch (error) {
      // Missing parameter value — fall through to whatever was recorded.
    }
  }

  const candidates = [];
  if (Array.isArray(step.locators)) {
    candidates.push(...step.locators);
  }
  if (step.selector) {
    candidates.push({ strategy: 'css', value: step.selector });
  }
  return candidates;
};

// Identifies whatever element is actually sitting at the target's own
// center point — this is the direct answer to "what is covering it," as
// opposed to just knowing that *something* is (see inspectElement's
// `covered` boolean, which uses the same elementFromPoint approach but
// collapses the result to true/false instead of keeping its identity).
const describeElementAtPoint = async (locator) => {
  try {
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return null;
      return {
        tag: top.tagName,
        id: top.id || null,
        classes: (top.className && typeof top.className === 'string') ? top.className : null,
        ariaLabel: top.getAttribute('aria-label') || null,
        text: (top.textContent || '').trim().slice(0, 120),
        isTargetItself: top === el || el.contains(top) || top.contains(el)
      };
    });
  } catch (error) {
    return null;
  }
};

// Diagnostic capture for click interception (requirement: "I need to see
// what the blocker actually is"). Fires only on an actual interception event
// — a Playwright click-time error, or a terminal "covered" timeout — never
// on every poll of the retry loop, so this stays cheap enough not to slow
// down a healthy replay. Screenshots land in backend/debug/ (gitignored).
const captureBlockerDiagnostics = async ({ page, locator, stepIndex, stepType, reason, playwrightError }) => {
  const diagnostics = {
    stepIndex,
    stepType,
    reason: reason || null,
    playwrightError: playwrightError || null,
    timestamp: new Date().toISOString(),
    blockerAtPoint: null,
    screenshotPath: null
  };

  diagnostics.blockerAtPoint = locator ? await describeElementAtPoint(locator) : null;

  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    debugCaptureCount += 1;
    const filename = `blocker-step${stepIndex}-${Date.now()}-${debugCaptureCount}.png`;
    const screenshotPath = path.join(DEBUG_DIR, filename);
    await page.screenshot({ path: screenshotPath });
    diagnostics.screenshotPath = screenshotPath;
  } catch (error) {
    diagnostics.screenshotError = error.message;
  }

  console.warn('[Backend][replay][blocker]', JSON.stringify(diagnostics));
  return diagnostics;
};

// Explicit, individually-loggable actionability checks rather than trusting
// a single bundled "click succeeded or didn't." elementFromPoint is what
// actually answers "is something else covering this element" (an overlay
// physically on top of it at its own coordinates) — Playwright's built-in
// actionability wait checks this internally but doesn't expose it, which is
// exactly the visibility this needs for diagnosing which sites fail and why.
const inspectElement = async (locator) => {
  const result = { exists: false, visible: false, enabled: false, covered: null };

  try {
    result.exists = (await locator.count()) > 0;
  } catch (error) {
    return result;
  }
  if (!result.exists) {
    return result;
  }

  try {
    result.visible = await locator.isVisible();
  } catch (error) {
    return result;
  }
  if (!result.visible) {
    return result;
  }

  try {
    result.enabled = await locator.isEnabled();
  } catch (error) {
    result.enabled = true; // Not every element has a meaningful disabled state.
  }

  try {
    result.covered = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(cx, cy);
      if (!topElement) {
        return false;
      }
      return !(topElement === el || el.contains(topElement) || topElement.contains(el));
    });
  } catch (error) {
    result.covered = false;
  }

  return result;
};

// Walks the candidate list once, returning the first one that's fully
// actionable (exists, visible, enabled, not covered). Reports the specific
// blocking reason from whichever candidate got furthest, for logging.
const findActionableCandidate = async (page, candidates) => {
  let bestReason = 'no candidate matched anything on the page';
  // Tracks the furthest-progressed candidate even on failure (specifically
  // the "covered" case) so a terminal timeout can still run blocker
  // diagnostics against a real element instead of having nothing to inspect.
  let bestBlockedLocator = null;

  for (const candidate of candidates) {
    let locator;
    try {
      locator = locatorFromCandidate(page, candidate).first();
    } catch (error) {
      continue;
    }

    const check = await inspectElement(locator);
    if (check.exists && check.visible && check.enabled && !check.covered) {
      return { locator, candidate, check };
    }

    if (check.exists && check.visible && check.covered) {
      bestReason = 'element found and visible, but another element covers it';
      bestBlockedLocator = locator;
    } else if (check.exists && check.visible && !check.enabled) {
      bestReason = 'element found and visible, but disabled';
    } else if (check.exists && !check.visible) {
      bestReason = 'element found, but not visible';
    } else if (check.exists) {
      bestReason = 'element matched but actionability could not be confirmed';
    }
  }

  return { locator: null, candidate: null, check: null, reason: bestReason, bestBlockedLocator };
};

// The structured-retry-with-backoff loop requirement (5): rather than one
// long wait on one selector, this repeatedly (a) waits for loading
// indicators to clear, (b) re-walks the ENTIRE candidate list fresh — so if
// the DOM changed which candidate now matches, the next round adapts — and
// (c) backs off exponentially between rounds instead of a fixed poll
// interval, clearing obvious blockers each time it doesn't find a fully
// actionable element.
const waitForActionableElement = async (page, step, { timeoutMs, log, parameterValues }) => {
  const candidates = getCandidateList(step, parameterValues);
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastReason = 'no candidate locators were recorded for this step';
  let lastBlockedLocator = null;

  while (Date.now() < deadline) {
    await waitForLoadingIndicatorsToClear(page, Math.min(1500, Math.max(0, deadline - Date.now())));

    const found = await findActionableCandidate(page, candidates);
    if (found.locator) {
      log.retries = attempt;
      log.strategyUsed = found.candidate.strategy;
      log.strategyValue = found.candidate.value || `${found.candidate.role || ''}:${found.candidate.name || ''}`;
      return found.locator;
    }

    lastReason = found.reason;
    if (found.bestBlockedLocator) {
      lastBlockedLocator = found.bestBlockedLocator;
    }

    const dismissed = await dismissCommonOverlays(page);
    if (dismissed) {
      log.blockersDismissed = (log.blockersDismissed || []).concat(dismissed);
      continue; // Something was actually in the way — re-check immediately, no need to burn a backoff delay.
    }

    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(backoffDelay(attempt), Math.max(0, remaining)));
  }

  log.retries = attempt;
  log.failureReason = lastReason;

  // Terminal timeout with a real "covered" candidate on hand — capture what
  // is actually blocking it before giving up, rather than just reporting
  // "something covers it" with no further detail.
  if (lastBlockedLocator) {
    const diagnostics = await captureBlockerDiagnostics({
      page,
      locator: lastBlockedLocator,
      stepIndex: step.index,
      stepType: step.type,
      reason: lastReason
    });
    log.blockerDiagnostics = (log.blockerDiagnostics || []).concat(diagnostics);
  }

  throw new Error(`No actionable element found for step (tried ${candidates.length} locator candidate(s)): ${lastReason}`);
};

// ---------------------------------------------------------------------------
// Step actions. Each resolves its element through the fallback chain above,
// then performs the action with one more layer of retry for the case where
// the element passed every check but was replaced (React/Vue-style
// re-render) in the instant between the check and the click — re-resolving
// from scratch (not reusing the same locator/handle) on every attempt.
// ---------------------------------------------------------------------------

const TRANSIENT_ACTION_ERROR_PATTERN = /intercepts pointer events|not attached to the dom|element is not attached|detached/i;

const performWithRetry = async (page, step, log, timeoutMs, actionFn, parameterValues) => {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    const locator = await waitForActionableElement(page, step, { timeoutMs: Math.max(0, deadline - Date.now()), log, parameterValues });

    try {
      await actionFn(locator);
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      const isTransient = TRANSIENT_ACTION_ERROR_PATTERN.test(error?.message || '');

      if (isTransient) {
        // This is Playwright's own click-interception error (its message
        // usually names the intercepting element directly) — capture it
        // verbatim alongside our own elementFromPoint read and a screenshot,
        // every time it happens, not just on the final failure.
        const diagnostics = await captureBlockerDiagnostics({
          page,
          locator,
          stepIndex: step.index,
          stepType: step.type,
          reason: 'playwright action was intercepted/blocked',
          playwrightError: error.message
        });
        log.blockerDiagnostics = (log.blockerDiagnostics || []).concat(diagnostics);
      }

      if (remaining <= 0 || !isTransient) {
        throw error;
      }
      attempt += 1;
      log.retries = (log.retries || 0) + 1;
      await dismissCommonOverlays(page);
      await page.waitForTimeout(Math.min(backoffDelay(attempt), remaining));
    }
  }
};

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

const scrollElement = async (page, selector, x, y, timeoutMs) => {
  await page.waitForSelector(selector, { state: 'attached', timeout: timeoutMs });
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

const fillField = async (locator, value) => {
  if (typeof value === 'boolean') {
    await locator.setChecked(value);
    return;
  }

  try {
    await locator.fill(value === null || typeof value === 'undefined' ? '' : String(value));
  } catch (fillError) {
    // Not a fillable <input>/<textarea>/[contenteditable] (e.g. a <select>) —
    // fall back to option selection.
    await locator.selectOption(String(value));
  }
};

// ---------------------------------------------------------------------------
// Calendar dates. A recorded calendar_date step's value is never treated as
// "search for this literal selector" — it's resolved semantically: parse
// the parameter into a real calendar date, then search the LIVE page for a
// day cell that matches that date by structure/attributes, not by whatever
// exact string the widget happened to render on the day it was recorded.
// If the visible month doesn't contain that date yet, this drives the
// calendar's own "next month" control forward and re-checks — a bounded
// number of times — so the same step keeps working long after the
// recording date has passed and the widget has moved on.
// ---------------------------------------------------------------------------

const MONTH_NAMES_EN = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// Accepts whatever a calendar_date parameter's value actually is: the
// classifier's own ISO normalization ("2026-07-30"), a plain Date-parseable
// string, or (if a caller supplies their own value through the API) a bare
// "YYYY-MM-DD". Returns null rather than throwing on anything unparseable —
// the caller turns that into a clear step-level error instead of a crash.
const parseTargetDate = (rawValue) => {
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return rawValue;
  }
  const text = String(rawValue || '').trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const parsed = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const CALENDAR_MARKER_ATTR = 'data-ff-cal-target';

// Runs entirely inside the page (page.evaluate) — searches for a day cell
// whose own data-date/datetime attribute OR parsed aria-label matches the
// target date, across several common calendar-widget conventions at once
// rather than betting on exactly one. A match gets a temporary marker
// attribute stamped on it so the caller can build a real Playwright locator
// from it afterwards (evaluate can't return a Locator, only data).
const findCalendarCellInPage = ({ day, month, year, marker, monthNames }) => {
  document.querySelectorAll(`[${marker}]`).forEach((el) => el.removeAttribute(marker));

  const parseDateFromLabel = (label) => {
    if (!label) return null;
    const lower = label.toLowerCase();

    const m1 = lower.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    if (m1) {
      const idx = monthNames.findIndex((name) => name.startsWith(m1[2].slice(0, 3)));
      if (idx >= 0) return { day: Number(m1[1]), month: idx, year: Number(m1[3]) };
    }

    const m2 = lower.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m2) {
      const idx = monthNames.findIndex((name) => name.startsWith(m2[1].slice(0, 3)));
      if (idx >= 0) return { day: Number(m2[2]), month: idx, year: Number(m2[3]) };
    }

    return null;
  };

  const candidates = document.querySelectorAll(
    '[data-date], [data-day], [datetime], [role="gridcell"], [role="button"][aria-label], td[aria-label], span[aria-label], div[aria-label], button[aria-label]'
  );

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const dataDate = el.getAttribute('data-date') || el.getAttribute('datetime');
    if (dataDate) {
      const parsed = new Date(dataDate);
      if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day) {
        el.setAttribute(marker, '1');
        return true;
      }
    }

    const ariaLabel = el.getAttribute('aria-label');
    const parsedLabel = parseDateFromLabel(ariaLabel);
    if (parsedLabel && parsedLabel.day === day && parsedLabel.month === month && parsedLabel.year === year) {
      el.setAttribute(marker, '1');
      return true;
    }
  }

  return false;
};

const findCalendarCellForDate = async (page, targetDate) => {
  const found = await page.evaluate(findCalendarCellInPage, {
    day: targetDate.getDate(),
    month: targetDate.getMonth(),
    year: targetDate.getFullYear(),
    marker: CALENDAR_MARKER_ATTR,
    monthNames: MONTH_NAMES_EN
  });
  return found ? page.locator(`[${CALENDAR_MARKER_ATTR}]`).first() : null;
};

const NEXT_MONTH_SELECTORS = [
  '[aria-label*="next month" i]',
  'button[aria-label*="Next" i]',
  '[data-testid*="next" i][data-testid*="month" i]',
  '.react-datepicker__navigation--next',
  '.next-month',
  '.datepicker-next'
];

const clickNextMonthControl = async (page) => {
  for (const selector of NEXT_MONTH_SELECTORS) {
    try {
      const control = page.locator(selector).first();
      if (await control.isVisible({ timeout: 200 })) {
        await control.click({ timeout: 1000 });
        return true;
      }
    } catch (error) {
      // Not present/visible — try the next selector.
    }
  }
  return false;
};

const MAX_MONTH_ADVANCES = 14;

// Same idea as captureBlockerDiagnostics, for the other way a calendar step
// can fail: not because something is covering the target, but because no
// day cell matching the target date (and no month-navigation control) could
// be found at all — usually because the calendar widget never actually
// opened, or its markup doesn't match any of findCalendarCellInPage's
// detection strategies. Screenshots + a DOM summary of whatever *does* look
// calendar-shaped on the page turns "no cell found" into an actionable next
// step instead of a dead end.
const captureCalendarDiagnostics = async ({ page, stepIndex, targetDate, monthAdvances }) => {
  const diagnostics = {
    stepIndex,
    targetDate: targetDate.toDateString(),
    monthAdvances,
    timestamp: new Date().toISOString(),
    domSummary: null,
    screenshotPath: null
  };

  try {
    diagnostics.domSummary = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const calendarRoots = Array.from(document.querySelectorAll(
        '[role="grid"], [class*="calendar" i], [data-testid*="calendar" i], [data-testid*="datepicker" i]'
      )).filter(visible).slice(0, 5).map((el) => ({
        tag: el.tagName, testId: el.getAttribute('data-testid'), role: el.getAttribute('role')
      }));
      const dateAriaLabels = Array.from(document.querySelectorAll('[aria-label]'))
        .filter((el) => /\d{4}/.test(el.getAttribute('aria-label') || '') && visible(el))
        .slice(0, 5)
        .map((el) => el.getAttribute('aria-label'));
      return { calendarRootCount: calendarRoots.length, calendarRoots, dateAriaLabelSamples: dateAriaLabels };
    });
  } catch (error) {
    diagnostics.domSummaryError = error.message;
  }

  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    debugCaptureCount += 1;
    const screenshotPath = path.join(DEBUG_DIR, `calendar-step${stepIndex}-${Date.now()}-${debugCaptureCount}.png`);
    await page.screenshot({ path: screenshotPath });
    diagnostics.screenshotPath = screenshotPath;
  } catch (error) {
    diagnostics.screenshotError = error.message;
  }

  console.warn('[Backend][replay][calendar]', JSON.stringify(diagnostics));
  return diagnostics;
};

const performCalendarDateClick = async (page, step, parameterValues, log, timeoutMs) => {
  const rawValue = substitutePlaceholders(step.value, parameterValues);
  const targetDate = parseTargetDate(rawValue);
  if (!targetDate) {
    throw new Error(`Could not parse a calendar date from value "${rawValue}"`);
  }

  const deadline = Date.now() + timeoutMs;
  let monthAdvances = 0;

  while (Date.now() < deadline) {
    const dismissed = await dismissCommonOverlays(page);
    if (dismissed) {
      log.blockersDismissed = (log.blockersDismissed || []).concat(dismissed);
    }

    const cell = await findCalendarCellForDate(page, targetDate);
    if (cell) {
      log.strategyUsed = 'calendar-semantic';
      log.retries = monthAdvances;
      await cell.click();
      return;
    }

    if (monthAdvances >= MAX_MONTH_ADVANCES) {
      break;
    }

    const advanced = await clickNextMonthControl(page);
    monthAdvances += 1;
    log.retries = monthAdvances;
    if (!advanced) {
      // No next-month control found at all — waiting longer won't help,
      // but a couple of quick retries covers a slow-rendering calendar.
      await page.waitForTimeout(Math.min(backoffDelay(monthAdvances), Math.max(0, deadline - Date.now())));
      continue;
    }
    await waitForPageStability(page, 1000);
  }

  log.failureReason = `No calendar cell found for ${targetDate.toDateString()} after advancing ${monthAdvances} month(s)`;
  const diagnostics = await captureCalendarDiagnostics({ page, stepIndex: step.index, targetDate, monthAdvances });
  log.calendarDiagnostics = diagnostics;
  throw new Error(log.failureReason);
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

const runWorkflow = async ({ steps, parameterValues, workflowId, extractionHint }) => {
  const runStartedAt = Date.now();
  const values = parameterValues || {};
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ hasTouch: true });
  const tracker = createPageTracker(await context.newPage());

  const skippedSteps = [];
  const stepLog = [];

  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const startedAt = Date.now();
      const log = {
        index: i,
        type: step.type,
        url: null,
        strategyUsed: null,
        retries: 0,
        blockersDismissed: [],
        failureReason: null,
        result: 'success'
      };

      try {
        if (step.type !== 'navigation' && step.type !== 'new_page') {
          tracker.resolveForStep(step);
        }

        const page = tracker.current;
        log.url = page.url();
        const timeoutMs = NON_CRITICAL_STEP_TYPES.has(step.type) ? NON_CRITICAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

        switch (step.type) {
          case 'navigation': {
            const url = substitutePlaceholders(step.value, values);
            if (url) {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
              await waitForPageStability(page, DEFAULT_TIMEOUT_MS);
              // Cookie/consent banners overwhelmingly appear right after a
              // fresh navigation — this is the one moment it's worth
              // proactively checking, rather than only reacting to a click
              // that later fails because one is in the way.
              const dismissed = await dismissCommonOverlays(page);
              if (dismissed) {
                log.blockersDismissed.push(dismissed);
              }
              tracker.remember(page);
              log.url = page.url();
            }
            break;
          }

          case 'click':
          case 'dynamic_click': {
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.click(), values);
            await waitForPageStability(page, 3000);
            break;
          }

          case 'dblclick': {
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.dblclick(), values);
            await waitForPageStability(page, 3000);
            break;
          }

          case 'input':
          case 'change': {
            const value = substitutePlaceholders(step.value, values);
            await performWithRetry(page, step, log, timeoutMs, (locator) => fillField(locator, value), values);
            break;
          }

          case 'calendar_date': {
            await performCalendarDateClick(page, step, values, log, timeoutMs);
            await waitForPageStability(page, 3000);
            break;
          }

          case 'scroll': {
            const { x, y } = parseScrollValue(step.value);
            const target = step.meta?.target;
            if (!target || target === 'window') {
              await scrollWindow(page, x, y);
            } else {
              await scrollElement(page, target, x, y, NON_CRITICAL_TIMEOUT_MS);
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
              await waitForPageStability(newPage, DEFAULT_TIMEOUT_MS);
              const dismissed = await dismissCommonOverlays(newPage);
              if (dismissed) {
                log.blockersDismissed.push(dismissed);
              }
            }
            tracker.remember(newPage);
            log.url = newPage.url();
            break;
          }

          default:
            // Unknown/unsupported step type — skip rather than fail the whole replay.
            log.result = 'skipped';
            log.failureReason = `Unrecognized step type "${step.type}"`;
            break;
        }
      } catch (stepError) {
        log.failureReason = log.failureReason || stepError.message;

        if (NON_CRITICAL_STEP_TYPES.has(step.type)) {
          log.result = 'skipped';
          console.warn(`[Backend] Skipping non-critical step ${i} (${step.type}): ${stepError.message}`);
          skippedSteps.push({ index: i, type: step.type, reason: stepError.message });
        } else {
          log.result = 'failed';
          log.durationMs = Date.now() - startedAt;
          stepLog.push(log);
          console.error('[Backend][replay]', JSON.stringify(log));
          throw Object.assign(new Error(`Step ${i} (${step.type}) failed: ${stepError.message}`), {
            stepIndex: i,
            stepType: step.type,
            stepLog
          });
        }
      }

      log.durationMs = Date.now() - startedAt;
      stepLog.push(log);
      console.log('[Backend][replay]', JSON.stringify(log));
    }

    const finalPage = tracker.current;
    const finalUrl = finalPage.url();
    const finalTitle = await finalPage.title();

    // Extraction runs on the live final page, before the browser closes in
    // `finally` below. extractPageData never throws (it catches internally),
    // but it's wrapped again here as defense in depth — a bug in extraction
    // must never turn a successful replay into a failed one.
    let extraction;
    try {
      extraction = await extractPageData({ page: finalPage, workflowId, extractionHint });
    } catch (error) {
      console.warn('[Backend][replay] extraction threw unexpectedly, ignoring:', error.message);
      extraction = { data: [], confidence: 0, method: 'error', truncated: false, totalFound: 0 };
    }

    const stepsExecuted = stepLog.filter((entry) => entry.result === 'success').length;

    return {
      finalUrl,
      finalTitle,
      skippedSteps,
      stepLog,
      data: extraction.data,
      source: finalUrl,
      confidence: extraction.confidence,
      execution: {
        durationMs: Date.now() - runStartedAt,
        stepsExecuted,
        stepsSkipped: skippedSteps.length,
        truncated: extraction.truncated,
        totalFound: extraction.totalFound
      },
      extractionMethod: extraction.method
    };
  } finally {
    await context.close();
    await browser.close();
  }
};

module.exports = { runWorkflow };
