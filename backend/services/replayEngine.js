const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { extractPageData } = require('./extraction');

const DEBUG_DIR = path.join(__dirname, '..', 'debug');
let debugCaptureCount = 0;

const DEFAULT_TIMEOUT_MS = 15000;
// Non-critical steps get a shorter budget so a missing target — e.g.
// decorative dynamic content like a marquee that scroll/touch targeted
// during recording but isn't present on replay — doesn't stall the whole
// run before being skipped. Deliberately NOT click-family steps: a
// dblclick is exactly as likely as a single click to be a load-bearing
// interaction (expanding an accordion, revealing a confirm button that a
// LATER step depends on) — silently skipping it after a short timeout,
// while the same element would have appeared comfortably within the
// standard critical-step budget, doesn't make that dblclick's own effect
// optional; it just relocates the eventual failure to a later, unrelated
// step and hides the real cause. Only truly cosmetic/best-effort actions
// belong in this set.
const NON_CRITICAL_TIMEOUT_MS = 4000;
const NON_CRITICAL_STEP_TYPES = new Set(['scroll', 'touch']);
const PLACEHOLDER_PATTERN = /^\{\{(.+)\}\}$/;

// Month-by-month navigation is legitimately slower than a single click: a
// target several months out on a widget that only advances one month per
// click, waits for a lazy-loaded fetch each time, and settles the page
// between clicks can easily need 30+ seconds of real wall-clock time. The
// previous shared DEFAULT_TIMEOUT_MS (15s, sized for an ordinary click) is
// what actually caused a legitimate 8-month advance to be reported as a
// failure — not a broken calendar, just an insufficient clock.
const CALENDAR_TIMEOUT_MS = 45000;

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 3000;
// attempt 0 -> 250ms, 1 -> 500ms, 2 -> 1000ms, 3 -> 2000ms, capped at 3000ms.
const backoffDelay = (attempt) => Math.min(BACKOFF_BASE_MS * (2 ** attempt), BACKOFF_MAX_MS);

// Polling cadence/cap for waitForElementToStopMoving — generic replacement
// for "wait for CSS transition/animation to finish." Rather than inspecting
// computed transition/animation properties (fragile across frameworks and
// animation libraries), this polls the element's own bounding box a few
// times a short interval apart and returns as soon as it stops changing —
// catching a fade/slide-in still in flight even though the element already
// passes the visible/enabled/not-covered checks, while never waiting any
// longer than an already-settled element needs (near-zero extra cost).
const ANIMATION_SETTLE_POLL_MS = 80;
const ANIMATION_SETTLE_MAX_CHECKS = 6;

// Bounds the "nudge the page to trigger lazy-loaded content" recovery in
// waitForActionableElement — a handful of scroll-and-wait cycles is enough to
// mount most infinite-scroll/lazy-rendered targets without turning a
// genuinely-missing element into a much longer stall.
const MAX_LAZY_SCROLL_ATTEMPTS = 3;

// Bounds how many times waitForActionableElement will try clearing a
// confirmed-covered element itself before handing it back anyway. Without
// this, a permanently undismissable overlay (nothing in the known-selector
// list, no findable close control, unaffected by Escape) would loop here
// until the whole step times out — the JS-click fallback in performWithRetry
// (step 8) would never even get a chance to run, since it only ever sees
// what this function returns. Handing the covered locator back after a few
// failed attempts lets Playwright's OWN native click-actionability wait take
// one more real shot (which resolves plenty of transient/animating cases on
// its own), and only then escalates to the JS-click fallback if that fails too.
const MAX_COVERED_RECOVERY_ATTEMPTS = 3;

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
  'button.close',
  // Broader, still-generic patterns — none of these name a specific site.
  // Ordered from most-specific/least-risky (a real dialog's own close
  // control) to loosest (any visible glyph/word meaning "not now"), since
  // dismissCommonOverlays stops at the first visible match.
  '[role="dialog"] button[aria-label*="close" i]',
  '[role="dialog"] [aria-label*="close" i]',
  '[aria-modal="true"] button[aria-label*="close" i]',
  '[aria-modal="true"] [aria-label*="close" i]',
  'button[aria-label*="close" i]',
  '[class*="modal" i] button[aria-label*="close" i]',
  '[class*="popup" i] button[aria-label*="close" i]',
  '[class*="overlay" i] button[aria-label*="close" i]',
  '[class*="newsletter" i] button[aria-label*="close" i]',
  'button:has-text("No thanks")',
  'button:has-text("Not now")',
  'button:has-text("Maybe later")',
  'button:has-text("Skip")',
  'button:has-text("×")',
  'button:has-text("✕")'
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

const OVERLAY_CLOSE_MARKER_ATTR = 'data-ff-overlay-close-target';
// Patterns built as strings and compiled INSIDE the page.evaluate call below
// (never passed as a RegExp argument — Playwright's argument serialization
// doesn't reliably round-trip RegExp objects, plain strings always do).
const OVERLAY_CLOSE_EXACT_SOURCE = '^(close|dismiss|no thanks|not now|maybe later|skip|got it|accept all|accept|allow|agree|reject|decline|later|x|×|✕)$';
const OVERLAY_CLOSE_SUBSTRING_SOURCE = 'close|dismiss|no thanks|not now|maybe later|got it|accept';

// Runs entirely inside the page — given the coordinates of whatever click
// target is currently covered, finds the element actually sitting on top of
// it (same elementFromPoint approach as inspectElement/describeElementAtPoint)
// and searches near THAT element for a close/dismiss control. Generic across
// any site: a cookie banner, a newsletter popup, a login-prompt modal, a
// sticky header, or any other fixed-position element blocking the click —
// nothing here names a specific site or widget. Two search tiers, in order:
//   1. The covering element itself, or a few ancestors above it, directly
//      looks like a close control (a real <button>/<a>/[role=button] whose
//      accessible name matches close/dismiss/skip/etc).
//   2. Failing that, walk up from the covering element to the nearest
//      "panel-like" ancestor (role=dialog, aria-modal=true, or a sizeable
//      fixed/sticky-positioned box) and search ITS descendants for a close
//      control — this is what catches a modal whose visible "X" sits in a
//      header far from the exact point that happened to be covered.
// A match gets a temporary marker attribute so the caller can build a real
// Playwright locator from it afterwards (evaluate can't return a Locator).
const findCoveringCloseControlInPage = ({ cx, cy, marker, exactSource, substringSource }) => {
  document.querySelectorAll(`[${marker}]`).forEach((el) => el.removeAttribute(marker));

  const top = document.elementFromPoint(cx, cy);
  if (!top) return false;

  const exactPattern = new RegExp(exactSource, 'i');
  const substringPattern = new RegExp(substringSource, 'i');

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const accessibleName = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);

  const looksLikeCloseControl = (el) => {
    if (!isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    const isControl = tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button';
    if (!isControl) return false;
    const name = accessibleName(el);
    if (!name) return false;
    return exactPattern.test(name) || substringPattern.test(name);
  };

  let node = top;
  for (let depth = 0; node && depth < 5; depth += 1) {
    if (looksLikeCloseControl(node)) {
      node.setAttribute(marker, '1');
      return true;
    }
    node = node.parentElement;
  }

  const isPanelLike = (el) => {
    if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') return true;
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      const rect = el.getBoundingClientRect();
      return rect.width > 100 && rect.height > 60;
    }
    return false;
  };

  let panel = top;
  for (let depth = 0; panel && depth < 8; depth += 1) {
    if (isPanelLike(panel)) break;
    panel = panel.parentElement;
  }
  if (!panel) return false;

  const candidates = panel.querySelectorAll('button, a, [role="button"]');
  for (const el of candidates) {
    if (looksLikeCloseControl(el)) {
      el.setAttribute(marker, '1');
      return true;
    }
  }

  return false;
};

const findCoveringCloseControl = async (page, blockedLocator) => {
  try {
    // Playwright's own default for boundingBox()'s timeout is 0 — literally
    // "no timeout" — not "resolves instantly." If the page/renderer is ever
    // slow to respond (real, observed live against Wikipedia under system
    // load: an ordinary CDP round-trip that's normally sub-second stalling
    // for well over a minute), this call has no safety net at all and can
    // hang far longer than the handful of milliseconds this best-effort
    // recovery helper is supposed to cost — silently blowing through the
    // step's own timeoutMs budget from a code path the caller (and the
    // overall retry deadline) can't see or bound.
    const box = await blockedLocator.boundingBox({ timeout: 2000 });
    if (!box) return null;
    const found = await page.evaluate(findCoveringCloseControlInPage, {
      cx: box.x + box.width / 2,
      cy: box.y + box.height / 2,
      marker: OVERLAY_CLOSE_MARKER_ATTR,
      exactSource: OVERLAY_CLOSE_EXACT_SOURCE,
      substringSource: OVERLAY_CLOSE_SUBSTRING_SOURCE
    });
    return found ? page.locator(`[${OVERLAY_CLOSE_MARKER_ATTR}]`).first() : null;
  } catch (error) {
    return null;
  }
};

// Single recovery entry point used everywhere a click/action turns out to be
// blocked: tries the known-selector list first (cheap, handles the common
// named cases immediately), then — only once a REAL blocking element is
// confirmed (blockedLocator is non-null) — the targeted covering-element
// search above, then Escape as a last resort. Escape is deliberately gated
// on blockedLocator being present: with nothing confirmed to be in the way
// (the target simply doesn't exist/render yet), there's no justification for
// it, and it could just as easily close something useful still in progress
// (an autocomplete dropdown the very next step needs) as a genuine
// obstruction. Returns a short descriptor for logging, or null if nothing
// was attempted / nothing helped.
const tryRecoverFromBlocker = async (page, blockedLocator) => {
  const commonDismissed = await dismissCommonOverlays(page);
  if (commonDismissed) {
    return `dismissed:${commonDismissed}`;
  }

  if (!blockedLocator) {
    return null;
  }

  const closeControl = await findCoveringCloseControl(page, blockedLocator);
  if (closeControl) {
    try {
      await closeControl.click({ timeout: 1000 });
      return 'dismissed:covering-element-close-control';
    } catch (error) {
      // Marked element vanished/became unclickable between detection and
      // click — fall through to the Escape-key attempt below.
    }
  }

  try {
    await page.keyboard.press('Escape');
    return 'attempted:escape-key';
  } catch (error) {
    return null;
  }
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
// Human-readable "what this step targets" for the per-step diagnostic log —
// generic across every step type (a real selector, a locator candidate, or
// for navigation-shaped steps that have no DOM target at all, the URL/
// template itself), never anything site-specific.
const describeStepTarget = (step) => {
  if (step.selector) {
    return step.selector;
  }
  if (Array.isArray(step.locators) && step.locators.length) {
    const first = step.locators[0];
    return first.value || `${first.strategy}${first.role ? ':' + first.role : ''}${first.name ? ':' + first.name : ''}`;
  }
  if (step.type === 'navigation') {
    return step.value || null;
  }
  if (step.type === 'new_page') {
    return step.url || null;
  }
  return null;
};

// Best-effort visual snapshot of the page right after a step finished —
// part of the per-step diagnostic log (requirement: "screenshot after the
// step"). Never allowed to affect replay outcome: a screenshot failure (page
// already navigating/closing, no display, disk issue) is swallowed exactly
// like the existing blocker/calendar diagnostics captures elsewhere in this
// file, and simply leaves screenshotPath null.
const captureStepScreenshot = async (page, stepIndex) => {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    debugCaptureCount += 1;
    const screenshotPath = path.join(DEBUG_DIR, `step${stepIndex}-${Date.now()}-${debugCaptureCount}.jpg`);
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, timeout: 3000 });
    return screenshotPath;
  } catch (error) {
    return null;
  }
};

// Drops trailing classes from a multi-class CSS selector, most-specific
// first — e.g. "div.foo.bar.baz" -> "div.foo.bar" -> tried again next round
// -> "div.foo". Returns null when there's nothing left to relax (a bare
// tag, an id selector, an attribute selector, or already a single class).
// Generic string manipulation only — no site knowledge.
const relaxCssSelector = (selector) => {
  const match = String(selector || '').match(/^([a-zA-Z][a-zA-Z0-9]*)((?:\.[a-zA-Z0-9_-]+)+)$/);
  if (!match) return null;
  const classes = match[2].split('.').filter(Boolean);
  if (classes.length <= 1) return null;
  return `${match[1]}.${classes.slice(0, classes.length - 1).join('.')}`;
};

// A plausible ARIA role guessed from the recorded tag name — used only as
// a last-resort candidate when nothing else about a step is left to try.
const TAG_TO_ROLE = {
  button: 'button', a: 'link', input: 'textbox', textarea: 'textbox',
  select: 'combobox', option: 'option', img: 'img',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', li: 'listitem'
};

const firstFewWords = (text, n) => text.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

// Last-resort, semantic-relocation candidates (requirement 4: "always
// relocate elements using text/role/aria/label/placeholder/nearby context
// instead of recorded indexes"). Only ever reached once every recorded
// locator/selector for this step has already failed to produce anything
// actionable — derives LOOSER ways to relocate the SAME recorded element
// from its own metadata (a shorter version of its CSS selector, a
// shortened text search using just the first few words of its recorded
// visible text, a role inferred from its recorded tag), never any new,
// site-specific knowledge. Placeholder values ("{{name}}", for input/
// change/dynamic_click/calendar_date steps) are deliberately never used as
// search text — that string was never actually visible on any page.
const buildRelaxedCandidates = (step) => {
  const relaxed = [];

  const relaxedSelector = step.selector ? relaxCssSelector(step.selector) : null;
  if (relaxedSelector) {
    relaxed.push({ strategy: 'css', value: relaxedSelector });
  }

  // Text/role relaxed candidates only make sense when step.value IS the
  // target element's own visible text (true for click/dblclick, where it
  // was captured from the clicked element itself). A keydown step's value
  // is the KEY that was pressed ("Enter"), never text on the page — using
  // it as a text search would risk matching some unrelated element that
  // merely contains the word "Enter" (e.g. an "Enter your email" label).
  const valueIsElementText = step.type === 'click' || step.type === 'dblclick';
  const isPlaceholder = typeof step.value === 'string' && PLACEHOLDER_PATTERN.test(step.value);
  const recordedText = (valueIsElementText && !isPlaceholder && typeof step.value === 'string') ? step.value.trim() : '';

  if (recordedText && recordedText.length <= 200) {
    const shortText = firstFewWords(recordedText, 4);
    if (shortText && shortText.length >= 2) {
      relaxed.push({ strategy: 'text', value: shortText });

      const inferredRole = TAG_TO_ROLE[String(step.meta?.tag || '').toLowerCase()];
      if (inferredRole) {
        relaxed.push({ strategy: 'role', role: inferredRole, name: shortText });
      }
    }
  }

  return relaxed;
};

const getCandidateList = (step, parameterValues) => {
  if (step.type === 'dynamic_click' && step.value) {
    try {
      const currentValue = substitutePlaceholders(step.value, parameterValues || {});
      if (currentValue !== null && typeof currentValue !== 'undefined' && String(currentValue).trim()) {
        // Deliberately the ONLY candidate when a live value is available —
        // a stale structural/text fallback must never get a chance to win
        // a race against a suggestion that's still one network round-trip
        // away from rendering (see the historical "recorded Dhaka, still
        // selects Dhaka after asking for London" failure this guards
        // against). waitForActionableElement's own retry loop already
        // re-runs this same fresh search every round.
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
  candidates.push(...buildRelaxedCandidates(step));
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
    }, undefined, { timeout: 2000 });
  } catch (error) {
    return null;
  }
};

// Richer than describeElementAtPoint — describes the MATCHED element
// itself (not whatever covers it), for diagnosing exactly why it wasn't
// actionable: its live bounding box, whether that box actually falls inside
// the current viewport, its computed display/visibility/opacity (the real
// CSS reason isVisible() said false — "display:none" and "off-screen but
// technically rendered" look identical from isVisible() alone), and a
// truncated outerHTML snippet so a failure can be diagnosed without needing
// to reproduce it locally.
const describeElementRichly = async (locator) => {
  try {
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        id: el.id || null,
        classes: (el.className && typeof el.className === 'string') ? el.className : null,
        ariaLabel: el.getAttribute('aria-label') || null,
        text: (el.textContent || '').trim().slice(0, 120),
        boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
        computedDisplay: style.display,
        computedVisibility: style.visibility,
        computedOpacity: style.opacity,
        outerHtmlSnippet: (el.outerHTML || '').slice(0, 400)
      };
    }, undefined, { timeout: 2000 });
  } catch (error) {
    return null;
  }
};

// Human-readable "what selector/strategy was actually tried" for logging —
// generic across every locator strategy findBestMatchForCandidate can walk.
const describeCandidate = (candidate) => {
  if (!candidate) return null;
  if (candidate.strategy === 'role') return `role:${candidate.role}${candidate.name ? `[name="${candidate.name}"]` : ''}`;
  return `${candidate.strategy}:${candidate.value || ''}`;
};

// Diagnostic capture for a failed/blocked interaction (requirement: "I need
// to see what the blocker actually is" / selector used, match counts,
// viewport position, computed visibility, screenshot, HTML snippet). Fires
// on any terminal actionability failure — not just interception — so a
// "not visible" or "not found" failure gets exactly the same diagnostic
// depth as a "covered" one. Never on every poll of the retry loop, so this
// stays cheap enough not to slow down a healthy replay. Screenshots land in
// backend/debug/ (gitignored).
const captureBlockerDiagnostics = async ({ page, locator, stepIndex, stepType, reason, playwrightError, selectorUsed, matchCount, visibleCount }) => {
  const diagnostics = {
    stepIndex,
    stepType,
    reason: reason || null,
    selectorUsed: selectorUsed || null,
    matchCount: typeof matchCount === 'number' ? matchCount : null,
    visibleCount: typeof visibleCount === 'number' ? visibleCount : null,
    playwrightError: playwrightError || null,
    timestamp: new Date().toISOString(),
    pageUrl: null,
    pageTitle: null,
    viewport: null,
    blockerAtPoint: null,
    matchedElement: null,
    screenshotPath: null
  };

  try { diagnostics.pageUrl = page.url(); } catch (error) { /* page may already be closed */ }
  try { diagnostics.pageTitle = await page.title(); } catch (error) { /* best-effort only */ }
  try { diagnostics.viewport = page.viewportSize(); } catch (error) { /* best-effort only */ }

  diagnostics.blockerAtPoint = locator ? await describeElementAtPoint(locator) : null;
  diagnostics.matchedElement = locator ? await describeElementRichly(locator) : null;

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

// Polls an element's own bounding box until it stops moving/resizing (or
// the check budget runs out), then returns. Generic across any animation
// library or CSS transition — no site or framework knowledge, just "is the
// geometry still changing." Never blocks longer than
// ANIMATION_SETTLE_MAX_CHECKS * ANIMATION_SETTLE_POLL_MS (480ms by
// default) PLUS this bounded per-check timeout, and returns immediately
// once two consecutive reads agree. The explicit timeout matters here for
// the same reason as findCoveringCloseControl's: boundingBox() defaults to
// Playwright's "0 = no timeout," so a single slow-to-respond check would
// otherwise have no bound at all, silently turning this "cheap insurance"
// helper (see its call site's own comment) into an unbounded stall that
// eats the calling step's entire time budget.
const waitForElementToStopMoving = async (locator) => {
  let previousBox = null;
  for (let i = 0; i < ANIMATION_SETTLE_MAX_CHECKS; i += 1) {
    const box = await locator.boundingBox({ timeout: 1000 }).catch(() => null);
    if (!box) {
      // Can't measure (detached, not yet rendered) — don't block the step
      // over this; the caller's own actionability checks already cover
      // that case separately.
      return;
    }
    if (
      previousBox
      && Math.abs(box.x - previousBox.x) < 0.5
      && Math.abs(box.y - previousBox.y) < 0.5
      && Math.abs(box.width - previousBox.width) < 0.5
      && Math.abs(box.height - previousBox.height) < 0.5
    ) {
      return; // Settled.
    }
    previousBox = box;
    await locator.page().waitForTimeout(ANIMATION_SETTLE_POLL_MS);
  }
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

  // Playwright's own isVisible() only checks display/visibility/opacity and
  // a non-zero box — it does NOT catch a common accessibility pattern that
  // stays technically visible-per-CSS while being genuinely unreachable: a
  // "skip to main content" link, screen-reader-only text, etc. positioned
  // at a fixed, scroll-independent offscreen offset (classically
  // top:-9999px), specifically so sighted users never see it. Converting
  // to DOCUMENT coordinates (adding the current scroll offset) is what
  // makes this precise: if the element's true position is negative, no
  // scroll position can ever reach it (scrollX/scrollY can't go below 0) —
  // as opposed to an element that's merely below/right of the CURRENT
  // scroll position (a large but positive document coordinate), which is
  // completely ordinary and reachable via scrollIntoViewIfNeeded. Without
  // this, such an element — often the very first match for a generic
  // bare-tag selector like "span" on any real site — would win a
  // multi-match scan ahead of the actual intended target purely by
  // document order, exactly as happened in production (a "Skip to main
  // content" link beating the real target).
  // Every Playwright call in this function is given an explicit, short
  // timeout. Their shared default — confirmed against playwright-core's own
  // type definitions — is "0 = no timeout," NOT "resolves immediately";
  // isEnabled() and locator.evaluate() in particular perform their own
  // actionability-style wait (at minimum, for the element to be attached)
  // before running. Reproduced live against Wikipedia under real system
  // load: a single one of these calls, deep inside findBestMatchForCandidate's
  // per-candidate scan, stalled for 60+ seconds — with no explicit timeout
  // there was nothing bounding it, so the stall silently blew through the
  // step's own retry-loop deadline instead of surfacing as one more
  // ordinary transient failure the backoff loop could react to. inspectElement
  // runs on every match of every locator candidate, every round of
  // waitForActionableElement's retry loop — exactly the hot path where an
  // unbounded call does the most damage.
  try {
    const unreachableOffscreen = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const docTop = rect.top + window.scrollY;
      const docLeft = rect.left + window.scrollX;
      return docTop < -1 || docLeft < -1;
    }, undefined, { timeout: 1500 });
    if (unreachableOffscreen) {
      result.visible = false;
      return result;
    }
  } catch (error) {
    // Can't determine — don't block on this alone, fall through to the
    // remaining checks as before.
  }

  try {
    result.enabled = await locator.isEnabled({ timeout: 1500 });
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
    }, undefined, { timeout: 1500 });
  } catch (error) {
    result.covered = false;
  }

  return result;
};

// Bounds how many same-selector matches findBestMatchForCandidate will walk
// — real pages rarely have more than a handful of genuine duplicates, and
// this keeps a pathological "matches 500 elements" selector cheap to check.
const MAX_MATCHES_PER_CANDIDATE = 12;

// A recorded selector/aria-label/role+name can legitimately match MORE THAN
// ONE element on a real page — a hidden mobile-only duplicate sitting next
// to the visible desktop one, a screen-reader-only instance alongside the
// real one, a stale template node a framework left in the DOM. Binding to
// whichever happens to be first in document order (Playwright's own
// default, and what this codebase used to do unconditionally via
// `.first()`) means a hidden duplicate that merely happens to come first
// silently blocks the entire step — this is what "element found, but not
// visible" meant in production on more than one site, even though a
// genuinely visible, clickable match existed a few elements later. This
// walks every match of ONE candidate (bounded above), preferring the first
// fully actionable one over raw document order, and falls back through
// covered -> disabled -> merely-exists-but-hidden so there's always a real
// element to report on for diagnostics even when nothing was usable.
const findBestMatchForCandidate = async (page, candidate) => {
  let baseLocator;
  try {
    baseLocator = locatorFromCandidate(page, candidate);
  } catch (error) {
    return { locator: null, matchCount: 0, visibleCount: 0, reason: 'selector could not be evaluated' };
  }

  let matchCount;
  try {
    matchCount = await baseLocator.count();
  } catch (error) {
    return { locator: null, matchCount: 0, visibleCount: 0, reason: 'selector could not be evaluated' };
  }

  if (matchCount === 0) {
    return { locator: null, matchCount: 0, visibleCount: 0, reason: 'no candidate matched anything on the page' };
  }

  const scanLimit = Math.min(matchCount, MAX_MATCHES_PER_CANDIDATE);
  let visibleCount = 0;
  let bestCovered = null;
  let bestDisabled = null;
  let bestHidden = null;
  let anyExisted = false;

  for (let i = 0; i < scanLimit; i += 1) {
    const locator = baseLocator.nth(i);
    const check = await inspectElement(locator);
    if (!check.exists) continue;
    anyExisted = true;

    if (!check.visible) {
      if (!bestHidden) bestHidden = { locator, check };
      continue;
    }
    visibleCount += 1;

    if (check.enabled && !check.covered) {
      // Ideal match — stop scanning further matches of THIS candidate.
      return { locator, check, matchCount, visibleCount, reason: null };
    }
    if (check.covered && !bestCovered) bestCovered = { locator, check };
    if (!check.enabled && !bestDisabled) bestDisabled = { locator, check };
  }

  if (bestCovered) {
    return { locator: bestCovered.locator, check: bestCovered.check, matchCount, visibleCount, reason: 'element found and visible, but another element covers it', covered: true };
  }
  if (bestDisabled) {
    return { locator: bestDisabled.locator, check: bestDisabled.check, matchCount, visibleCount, reason: 'element found and visible, but disabled' };
  }
  if (bestHidden) {
    // Kept (not null) specifically so a terminal failure can still run rich
    // diagnostics — computed display/visibility, bounding box, HTML
    // snippet — against a REAL matched element instead of having nothing
    // to inspect.
    return { locator: bestHidden.locator, check: bestHidden.check, matchCount, visibleCount, reason: 'element found, but not visible', hidden: true };
  }
  if (anyExisted) {
    return { locator: null, matchCount, visibleCount, reason: 'element matched but actionability could not be confirmed' };
  }
  return { locator: null, matchCount, visibleCount, reason: 'no candidate matched anything on the page' };
};

// Walks the candidate list once, returning the first one that's fully
// actionable (exists, visible, enabled, not covered) — searching every
// MATCH of each candidate (see findBestMatchForCandidate), not just
// document order's first. Reports the specific blocking reason and the
// richest diagnostic info seen across every candidate tried, for logging.
const findActionableCandidate = async (page, candidates) => {
  let bestReason = 'no candidate matched anything on the page';
  // Tracks the furthest-progressed candidate even on failure (specifically
  // the "covered" case) so a terminal timeout can still run blocker
  // diagnostics against a real element instead of having nothing to inspect.
  let bestBlockedLocator = null;
  // Independent of bestBlockedLocator — the single richest failure info
  // seen across every candidate, covered or not, for the terminal
  // diagnostics capture (match/visible counts, selector, a hidden-but-real
  // element to describe).
  let bestDiagnostics = null;

  for (const candidate of candidates) {
    const result = await findBestMatchForCandidate(page, candidate);

    if (result.locator && !result.reason) {
      return { locator: result.locator, candidate, check: result.check, matchCount: result.matchCount, visibleCount: result.visibleCount };
    }

    if (!bestDiagnostics || (result.matchCount || 0) > (bestDiagnostics.matchCount || 0)) {
      bestDiagnostics = { candidate, ...result };
    }

    if (result.covered) {
      bestReason = result.reason;
      bestBlockedLocator = result.locator;
    } else if (!bestBlockedLocator) {
      bestReason = result.reason || bestReason;
    }
  }

  return { locator: null, candidate: null, check: null, reason: bestReason, bestBlockedLocator, diagnostics: bestDiagnostics };
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
  let lastDiagnostics = null;
  let lazyScrollAttempts = 0;
  let coveredAttempts = 0;

  while (Date.now() < deadline) {
    await waitForLoadingIndicatorsToClear(page, Math.min(1500, Math.max(0, deadline - Date.now())));

    const found = await findActionableCandidate(page, candidates);
    if (found.locator) {
      log.retries = attempt;
      log.elementFound = true;
      log.strategyUsed = found.candidate.strategy;
      log.strategyValue = found.candidate.value || `${found.candidate.role || ''}:${found.candidate.name || ''}`;
      log.matchCount = found.matchCount;
      log.visibleCount = found.visibleCount;
      return found.locator;
    }

    lastReason = found.reason;
    if (found.diagnostics) {
      lastDiagnostics = found.diagnostics;
    }
    if (found.bestBlockedLocator) {
      lastBlockedLocator = found.bestBlockedLocator;
      coveredAttempts += 1;

      // A handful of recovery attempts against the SAME covered element is
      // enough to know whether anything here is actually going to clear it.
      // Handing it back now — rather than looping until the whole step
      // times out — is what lets performWithRetry's real click attempt (and
      // its JS-click last resort) ever run at all for a genuinely
      // undismissable overlay.
      if (coveredAttempts > MAX_COVERED_RECOVERY_ATTEMPTS) {
        log.retries = attempt;
        log.elementFound = true;
        log.strategyUsed = 'covered-handoff';
        return found.bestBlockedLocator;
      }
    }

    const recovery = await tryRecoverFromBlocker(page, found.bestBlockedLocator);
    if (recovery) {
      log.blockersDismissed = (log.blockersDismissed || []).concat(recovery);
      // A short, bounded pause even on a "something happened" result — a
      // recovery attempt that didn't actually change anything (e.g. Escape
      // against a modal that ignores it) would otherwise spin this loop as
      // fast as the event loop allows; the very next check reveals whether
      // it helped, so there's nothing gained by not pausing here too.
      await page.waitForTimeout(Math.min(300, Math.max(0, deadline - Date.now())));
      continue;
    }

    // Nothing covered, nothing to dismiss, and the target still doesn't
    // exist at all — on sites with infinite-scroll or lazy-rendered lists,
    // that's very often because it simply hasn't mounted yet. A couple of
    // scroll nudges (generic across any site — no selector/site knowledge
    // needed) gives lazy content a chance to render before this gives up.
    if (!found.bestBlockedLocator && lazyScrollAttempts < MAX_LAZY_SCROLL_ATTEMPTS) {
      lazyScrollAttempts += 1;
      await page.mouse.wheel(0, 800).catch(() => {});
      await waitForLoadingIndicatorsToClear(page, 800);
      continue;
    }

    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(backoffDelay(attempt), Math.max(0, remaining)));
  }

  log.retries = attempt;
  log.elementFound = false;
  log.failureReason = lastReason;
  log.matchCount = lastDiagnostics ? lastDiagnostics.matchCount : 0;
  log.visibleCount = lastDiagnostics ? lastDiagnostics.visibleCount : 0;

  // Terminal failure — capture full diagnostics (selector used, match/
  // visible counts, viewport position, computed visibility, a screenshot,
  // and an HTML snippet of whatever element WAS found, even if it wasn't
  // actionable) regardless of WHICH reason it failed for. Previously this
  // only fired for the "covered" case, so a "not visible" or "not found"
  // failure — the exact shape reported in production — left no screenshot
  // or element detail behind at all to diagnose it from.
  const diagnosticLocator = lastBlockedLocator || (lastDiagnostics && lastDiagnostics.locator) || null;
  const diagnostics = await captureBlockerDiagnostics({
    page,
    locator: diagnosticLocator,
    stepIndex: step.index,
    stepType: step.type,
    reason: lastReason,
    selectorUsed: lastDiagnostics ? describeCandidate(lastDiagnostics.candidate) : null,
    matchCount: lastDiagnostics ? lastDiagnostics.matchCount : 0,
    visibleCount: lastDiagnostics ? lastDiagnostics.visibleCount : 0
  });
  log.blockerDiagnostics = (log.blockerDiagnostics || []).concat(diagnostics);

  throw new Error(`No actionable element found for step (tried ${candidates.length} locator candidate(s)): ${lastReason}`);
};

// ---------------------------------------------------------------------------
// Step actions. Each resolves its element through the fallback chain above,
// then performs the action with one more layer of retry for the case where
// the element passed every check but was replaced (React/Vue-style
// re-render) in the instant between the check and the click — re-resolving
// from scratch (not reusing the same locator/handle) on every attempt.
// ---------------------------------------------------------------------------

// Matches Playwright's own error text for anything worth retrying rather
// than failing the step outright. Originally scoped to interception-only
// errors ("intercepts pointer events", detached-element races); broadened
// to also cover Playwright's own native actionability-wait timeout
// ("Timeout Nms exceeded" — the exact error a locator.click({timeout})
// throws when its internal wait for visible/enabled/stable/in-viewport
// never resolves) and its constituent reasons ("outside of the viewport",
// "not stable"). Without this, a click that failed Playwright's OWN
// actionability wait — a real production failure mode, not a hypothetical
// one — skipped this entire retry/recovery/JS-click-fallback pipeline
// and failed on the very first attempt, identically to how "element
// found and visible, but another element covers it" used to before the
// interception recovery work.
const TRANSIENT_ACTION_ERROR_PATTERN = /intercepts pointer events|not attached to the dom|element is not attached|detached|timeout \d+ms exceeded|outside of the viewport|not stable/i;

// options.allowJsClickFallback gates the last-resort recovery in step 8 of
// the replay-robustness requirement: only click-family actions (click,
// dblclick, dynamic_click, calendar_date) ever pass true — a text-fill action
// has no equivalent "force it anyway" that means anything, so input/change
// never fall back to it (see the fillField call site below).
//
// options.abortIfNavigatedAway is dynamic_click-specific (see that case in
// runWorkflow's switch). A dynamic_click's whole premise is "select a value
// from a list dynamically rendered on THIS page" — a list that, by
// definition, cannot exist on a page already navigated away from. Checked
// on EVERY iteration of this loop (not just once before the first attempt)
// because the failure this guards against is a genuine RACE, not a
// before-the-fact state: confirmed live against Wikipedia, a native
// Enter-triggered form submit can complete WHILE Playwright is mid-attempt
// on the suggestion click (the click itself "succeeds" in the sense of
// dispatching, then Playwright's post-click wait for a scheduled
// navigation times out against a DIFFERENT, already-in-flight one) — so the
// page can still be on the ORIGINAL page at the top of this function and
// only diverge one or more retries later. Without this check, the retry
// loop searches the NEW (destination) page's text for the same value,
// which is not just pointless but actively wrong: the identical search
// text very often reappears as the destination page's own content (e.g.
// an article titled exactly what was searched for), so it can click the
// wrong element entirely and hang waiting for a navigation that will never
// come — this is exactly what turned one recording into "succeeds on some
// replays, fails on others" purely from timing.
const performWithRetry = async (page, step, log, timeoutMs, actionFn, parameterValues, options = {}) => {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  const urlBeforeStep = options.abortIfNavigatedAway ? page.url() : null;

  for (;;) {
    if (urlBeforeStep && page.url() !== urlBeforeStep) {
      log.strategyUsed = 'navigation-already-occurred';
      log.actionExecuted = true;
      return;
    }

    const locator = await waitForActionableElement(page, step, { timeoutMs: Math.max(0, deadline - Date.now()), log, parameterValues });

    // Explicit scroll-into-view + wait for any in-flight animation/
    // transition to settle before every action — Playwright's own click()
    // already scrolls implicitly, but a custom scroll container, a sticky
    // header that re-covers the target right as it scrolls into place, or a
    // fade/slide-in still animating even after the element passes every
    // other actionability check can all still race an implicit scroll.
    // Doing it explicitly, with an adaptive settle wait (not a blind fixed
    // one), is cheap insurance and never fails the step (best-effort only).
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await waitForElementToStopMoving(locator);

    // Cheap, side-effect-free pre-flight check for click-family actions —
    // Playwright's trial mode runs its full actionability + hit-testing
    // logic without actually dispatching the click, catching nuances (exact
    // hit-testing edge cases, pointer-events:none) this file's own manual
    // inspectElement checks don't replicate. Purely diagnostic (never
    // blocks the real attempt below); its failure reason feeds straight
    // into the log so a terminal failure can say WHY a recovery attempt
    // was expected to fail, not just that it did (requirement 6).
    if (options.allowJsClickFallback) {
      try {
        await locator.click({ trial: true, timeout: 800 });
        log.trialClickReason = null;
      } catch (trialError) {
        log.trialClickReason = trialError.message;
      }
    }

    try {
      await actionFn(locator);
      log.actionExecuted = true;
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

      const attemptsExhausted = remaining <= 0;

      // Last-resort chain, only reached after every normal retry already
      // failed on a genuine interception/timeout. Playwright's own
      // actionability model correctly refuses to click something it can
      // see is visually covered or unstable — exactly right for a real
      // user — but a persistent, undismissable overlay (rare, but real on
      // some sites) would otherwise fail the whole workflow over a purely
      // cosmetic obstruction. Two tiers, most- to least-faithful:
      //   1. force:true — still a REAL, trusted browser mouse event (so a
      //      site checking event.isTrusted still sees a genuine click),
      //      just with the actionability/hit-testing wait skipped, since
      //      that's already been retried extensively above.
      //   2. a native DOM el.click() via JS — bypasses every actionability
      //      check entirely, least faithful (not guaranteed to read as a
      //      trusted event on every site), but still better than failing
      //      the whole workflow over a purely cosmetic obstruction.
      // Both gated tightly: only for click-family actions (never a text
      // fill), and only once every other recovery attempt has run out —
      // never used in place of a real attempt.
      if (isTransient && attemptsExhausted && options.allowJsClickFallback) {
        try {
          await locator.click({ force: true, timeout: 1000 });
          log.actionExecuted = true;
          log.forceClickFallbackUsed = true;
          return;
        } catch (forceClickError) {
          log.forceClickFailureReason = forceClickError.message;
        }

        try {
          await locator.evaluate((el) => el.click(), undefined, { timeout: 2000 });
          log.actionExecuted = true;
          log.jsClickFallbackUsed = true;
          return;
        } catch (jsClickError) {
          // Neither fallback helped — nothing left to try, fall through to
          // the original Playwright error below.
          log.jsClickFailureReason = jsClickError.message;
        }
      }

      if (attemptsExhausted || !isTransient) {
        throw error;
      }

      attempt += 1;
      log.retries = (log.retries || 0) + 1;
      const recovery = await tryRecoverFromBlocker(page, locator);
      if (recovery) {
        log.blockersDismissed = (log.blockersDismissed || []).concat(recovery);
      }
      await page.waitForTimeout(Math.min(backoffDelay(attempt), remaining));
    }
  }
};

// Every parameterized input/click/calendar step's value is set to exactly
// "{{paramName}}" (see ruleBasedParameterizer.js) so a full-string match is
// all that's needed for those step types — there's no embedded-placeholder-
// in-a-larger-string case to handle here. Navigation/new_page URLs are the
// one exception (see resolveUrlTemplate below), because a param there is
// only ever ONE piece of a larger URL, never the step's whole value.
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

const EMBEDDED_PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;

// Resolves a navigation/new_page URL that may carry a placeholder EMBEDDED
// inside it (e.g. "https://site.com/search?q={{destination}}" — see
// linkUrlToPendingValue in ruleBasedParameterizer.js, which is what rewrites
// a recorded literal URL into this template in the first place). Each
// occurrence is percent-encoded on the way in, since it's being spliced into
// a URL's path/query rather than assigned wholesale to a field value. This
// is what makes a runtime parameter change actually reach a step whose
// original navigation was triggered by a native form submit / Enter
// keypress rather than a click — there is no separate "click" event for the
// replay engine to trust the live outcome of in that case, so the URL itself
// has to already be data-driven.
const resolveUrlTemplate = (urlTemplate, parameterValues) => {
  if (typeof urlTemplate !== 'string' || !urlTemplate) {
    return urlTemplate;
  }

  // Whole-value placeholder ("{{name}}" and nothing else) — behaves exactly
  // like substitutePlaceholders, preserving whatever type the parameter
  // actually holds rather than forcing it through string coercion.
  if (PLACEHOLDER_PATTERN.test(urlTemplate)) {
    return substitutePlaceholders(urlTemplate, parameterValues);
  }

  if (!urlTemplate.includes('{{')) {
    return urlTemplate;
  }

  return urlTemplate.replace(EMBEDDED_PLACEHOLDER_PATTERN, (whole, rawName) => {
    const paramName = rawName.trim();
    if (!Object.prototype.hasOwnProperty.call(parameterValues, paramName)) {
      throw new Error(`Missing value for parameter "${paramName}"`);
    }
    return encodeURIComponent(String(parameterValues[paramName]));
  });
};

// A literal value's common survival forms in a URL — same idea as
// ruleBasedParameterizer.js's urlEncodingVariants, kept as its own small
// local copy here rather than cross-importing (this module owns replay,
// not parameterization).
const urlValueVariants = (rawValue) => {
  const value = String(rawValue);
  const percentEncoded = encodeURIComponent(value);
  const plusEncoded = percentEncoded.replace(/%20/g, '+');
  return Array.from(new Set([value, percentEncoded, plusEncoded])).filter((v) => v && v.length >= 1);
};

// The literal values a navigation URL TEMPLATE embeds, resolved to this
// run's ACTUAL parameter values — what requirement 8 means by "regenerate
// the URL from current parameter values": not reconstructing and
// string-comparing a full URL (fragile against param reordering, the site
// adding its own params, or encoding differences), just the set of values
// that should appear SOMEWHERE in the live URL if the site reached the
// same destination on its own.
const extractTemplatedValues = (urlTemplate, parameterValues) => {
  if (typeof urlTemplate !== 'string') return [];
  const values = [];
  for (const match of urlTemplate.matchAll(EMBEDDED_PLACEHOLDER_PATTERN)) {
    const paramName = match[1].trim();
    if (Object.prototype.hasOwnProperty.call(parameterValues, paramName)) {
      const value = parameterValues[paramName];
      if (value !== null && typeof value !== 'undefined' && String(value).trim()) {
        values.push(String(value).trim());
      }
    }
  }
  return values;
};

// Is the LIVE page already effectively at this navigation step's
// destination — reached via whatever actually happened (a click's own
// navigation, a native form submit, client-side routing several steps
// back) — so forcing a page.goto() with the recorded/templated URL would
// be redundant at best and actively WRONG at worst (dragging the browser
// back to a stale literal, discarding a live, parameter-correct page the
// site already produced on its own). This is the core of requirement 8:
// "never depend on replaying a recorded URL if the same page can be
// reached by replaying the recorded actions." Same origin + pathname, plus
// every templated value for THIS run present somewhere in the live URL —
// tracking/session/analytics query-string noise, canonicalized paths'
// exact casing, and param ordering are deliberately never compared, since
// none of those change what page a human would say they're looking at.
const isAlreadyAtNavigationTarget = (currentUrl, urlTemplate, parameterValues) => {
  let current;
  let recorded;
  try {
    current = new URL(currentUrl);
    recorded = new URL(resolveUrlTemplate(urlTemplate, parameterValues));
  } catch (error) {
    return false;
  }

  if (current.origin !== recorded.origin || current.pathname !== recorded.pathname) {
    return false;
  }

  const templatedValues = extractTemplatedValues(urlTemplate, parameterValues);
  if (templatedValues.length === 0) {
    // A fully static URL (no runtime parameters embedded in it at all) —
    // same origin+pathname is already the strongest signal available;
    // query-string differences here are tracking/session noise either way.
    return true;
  }

  return templatedValues.every((value) => {
    const variants = urlValueVariants(value);
    return variants.some((variant) => current.href.includes(variant));
  });
};

// page.goto() throwing does NOT necessarily mean navigation didn't happen.
// ERR_ABORTED in particular is extremely common on real, dynamic sites: the
// initial navigation gets interrupted by a client-side redirect, a second
// competing navigation the destination page itself triggers, or the
// browser simply cancelling the original request once a replacement
// document starts loading. The correct response is what a human watching
// the screen would conclude — look at where the browser actually ended up,
// not trust the promise's rejection blindly. Also retries across a few
// different waitUntil conditions before giving up entirely: a site that
// never truly goes networkidle (websockets, polling widgets, ad beacons)
// would otherwise spuriously fail on that condition alone even though the
// page loaded completely fine under 'load' or 'domcontentloaded'.
const NAVIGATION_ABORT_ERROR_PATTERN = /ERR_ABORTED|ERR_FAILED|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION_CLOSED|Navigation timeout|net::ERR_/i;
const NAVIGATION_WAIT_STRATEGIES = ['domcontentloaded', 'load', 'networkidle'];

const gotoWithRecovery = async (page, url, { timeoutMs, log } = {}) => {
  const urlBeforeAttempt = page.url();
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
  const perAttemptTimeout = Math.max(3000, Math.floor(budget / NAVIGATION_WAIT_STRATEGIES.length));

  let lastError = null;

  for (const waitUntil of NAVIGATION_WAIT_STRATEGIES) {
    try {
      await page.goto(url, { waitUntil, timeout: perAttemptTimeout });
      if (log) log.navigationStrategyUsed = waitUntil;
      return { navigated: true, finalUrl: page.url() };
    } catch (error) {
      lastError = error;

      // Whether or not goto() itself threw, the browser may already have
      // landed somewhere real — check the LIVE url before deciding this
      // attempt failed, rather than trusting the rejected promise alone.
      const currentUrl = page.url();
      if (currentUrl !== urlBeforeAttempt) {
        if (log) {
          log.navigationStrategyUsed = `${waitUntil}-recovered-after-error`;
          log.navigationRecoveryReason = error.message;
        }
        return { navigated: true, finalUrl: currentUrl };
      }

      const isAbortLike = NAVIGATION_ABORT_ERROR_PATTERN.test(error?.message || '');
      if (!isAbortLike) {
        // A genuine failure (DNS, connection refused, malformed URL) — no
        // waitUntil variant will fix this; retrying three times wastes the
        // step's whole time budget for no benefit.
        throw error;
      }
      // Abort-class error AND the page genuinely never moved — try the
      // next, more lenient waitUntil condition.
    }
  }

  // Every waitUntil strategy failed AND the page never actually moved —
  // the one case that's a genuine navigation failure, not just an artifact
  // of how the wait condition happened to be phrased.
  throw lastError || new Error(`Navigation to "${url}" did not complete`);
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
  }, [x, y], { timeout: 2000 });
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

// Playwright's own discriminator for ".fill() called on something that
// isn't a fillable <input>/<textarea>/[contenteditable]" (e.g. a real
// <select>) — verified against playwright-core's actual thrown text. This
// is deliberately narrow: confirmed live against Wikipedia's real search
// box, .fill() can also fail for perfectly ordinary TRANSIENT reasons (the
// element re-rendering, briefly covered, not yet stable) that say nothing
// about the element's type. Treating every fill() failure as "must be a
// select" — as this used to — sent those transient failures into
// selectOption() instead, which then hung for its own full default action
// timeout against a real <input> (selectOption's actionability wait for
// "is this a <select>" never resolves), discarding the real error and
// roughly quintupling the time a single step spent failing before
// performWithRetry's own retry/backoff loop ever got to react.
const NOT_FILLABLE_ERROR_PATTERN = /Element is not an <input>/;

// Explicit, bounded timeouts on every action here (matching the click-family
// convention elsewhere in this file) rather than Playwright's 30s default —
// by the time fillField runs, waitForActionableElement has already confirmed
// the element is visible/enabled, so a genuinely actionable element resolves
// near-instantly; a short timeout here is what caps a single stuck/
// misclassified attempt instead of letting it silently eat the whole step's
// time budget in one try.
const fillField = async (locator, value) => {
  if (typeof value === 'boolean') {
    await locator.setChecked(value, { timeout: 3000 });
    return;
  }

  const text = value === null || typeof value === 'undefined' ? '' : String(value);

  try {
    await locator.fill(text, { timeout: 3000 });
  } catch (fillError) {
    if (!NOT_FILLABLE_ERROR_PATTERN.test(fillError?.message || '')) {
      throw fillError;
    }
    // Confirmed not a fillable element (e.g. a <select>) — fall back to
    // option selection.
    await locator.selectOption(text, { timeout: 3000 });
  }
};

// ---------------------------------------------------------------------------
// Calendar dates. A recorded calendar_date step's value is never treated as
// "search for this literal selector" — it's resolved semantically: parse
// the parameter into a real calendar date, then search the LIVE page for a
// day cell that matches that date by structure/attributes, not by whatever
// exact string the widget happened to render on the day it was recorded.
//
// Navigation is MONTH-AWARE, not a blind "click next N times": every
// iteration first detects which month(s) the widget is actually showing
// right now (supporting a two-month-at-once display, common on travel
// sites' check-in/check-out pickers), compares that against the target
// month, and only searches for/clicks the day cell once the right month is
// confirmed on screen. This is what makes the same logic work identically
// whether the widget is one month behind the target or eleven — and, just
// as importantly, what lets it detect a click that silently failed to
// change anything (a disabled nav button, an animation that swallowed the
// click) instead of drifting through a stuck loop for the whole time budget.
// Nothing here is specific to any one site or calendar framework — every
// check is a structural/accessibility signal (role, aria-label, aria-live,
// aria-expanded, aria-disabled) or a generic "Month YYYY" text pattern.
// ---------------------------------------------------------------------------

const MONTH_NAMES_EN = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// Runs entirely inside the page — finds every calendar-like "currently
// displayed month" caption on the page right now. Generic across single-
// and dual-month calendar widgets: returns one entry per distinct month
// header found (requirement: handle calendars that display two months
// simultaneously), rather than betting on exactly one. Search order:
//   1. Inside anything structurally calendar-shaped (role=grid/application,
//      or a class/data-testid/aria-label containing "calendar"/"datepicker"),
//      look for its own heading/caption element.
//   2. If nothing matched at all, fall back to any short, visible "Month
//      YYYY" text anywhere on the page — some frameworks render the month
//      caption as a page-level sibling rather than inside the grid itself.
const MONTH_NAME_PATTERN_SOURCE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const CALENDAR_ROOT_QUERY = '[role="grid"], [role="application"], [class*="calendar" i], [data-testid*="calendar" i], [data-testid*="datepicker" i], [aria-label*="calendar" i]';
const MONTH_HEADING_QUERY = '[role="heading"], caption, h1, h2, h3, h4, [aria-live], [class*="caption" i], [class*="month" i], [class*="header" i]';

const findDisplayedMonthsInPage = ({ monthNamesSource, monthNames, rootQuery, headingQuery }) => {
  const monthPattern = new RegExp(`\\b(${monthNamesSource})\\.?\\s+(\\d{4})\\b`, 'i');

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const parseMonthYear = (text) => {
    const match = text.match(monthPattern);
    if (!match) return null;
    const idx = monthNames.findIndex((name) => name.startsWith(match[1].toLowerCase().slice(0, 3)));
    return idx >= 0 ? { month: idx, year: Number(match[2]) } : null;
  };

  const results = [];
  const seen = new Set();
  const addIfNew = (parsed) => {
    const key = `${parsed.year}-${parsed.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(parsed);
    }
  };

  document.querySelectorAll(rootQuery).forEach((root) => {
    if (!isVisible(root)) return;
    for (const el of root.querySelectorAll(headingQuery)) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue; // A real month caption is short — a paragraph merely containing a date isn't one.
      const parsed = parseMonthYear(text);
      if (parsed) {
        addIfNew(parsed);
        break; // Only the first matching heading per root — avoid double-counting nested headings.
      }
    }
  });

  if (results.length === 0) {
    for (const el of document.querySelectorAll(headingQuery)) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      const parsed = parseMonthYear(text);
      if (parsed) addIfNew(parsed);
      if (results.length >= 2) break;
    }
  }

  return results;
};

const getDisplayedMonths = async (page) => {
  try {
    return await page.evaluate(findDisplayedMonthsInPage, {
      monthNamesSource: MONTH_NAME_PATTERN_SOURCE,
      monthNames: MONTH_NAMES_EN,
      rootQuery: CALENDAR_ROOT_QUERY,
      headingQuery: MONTH_HEADING_QUERY
    });
  } catch (error) {
    return [];
  }
};

const monthKey = ({ month, year }) => year * 12 + month;

const isTargetMonthDisplayed = (displayedMonths, targetKey) => displayedMonths.some((m) => monthKey(m) === targetKey);

// Signed month distance from whichever currently-displayed month is closest
// to the target — positive means "navigate forward," negative means
// "navigate backward." This is what makes a dual-month display navigate
// correctly: the SECOND pane can already be past the target even while the
// first pane isn't there yet, so using the closest of the two (not just the
// first) avoids overshooting or oscillating.
const closestMonthDistance = (displayedMonths, targetKey) => {
  if (!displayedMonths.length) return null;
  let best = null;
  for (const m of displayedMonths) {
    const diff = targetKey - monthKey(m);
    if (best === null || Math.abs(diff) < Math.abs(best)) best = diff;
  }
  return best;
};

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
// rather than betting on exactly one. Returns a status rather than a bare
// boolean so the caller can tell "not on the page at all" apart from "found,
// but the widget marks it disabled/unavailable" (requirement: handle
// disabled dates) — the second case is a fundamentally different failure
// that no amount of further month-navigation will ever fix. A genuine match
// gets a temporary marker attribute stamped on it so the caller can build a
// real Playwright locator from it afterwards (evaluate can't return a
// Locator, only data); an enabled cell always wins over a disabled one with
// the same date, in case a widget momentarily renders both during a
// transition.
const findCalendarCellInPage = ({ day, month, year, marker, monthNames }) => {
  document.querySelectorAll(`[${marker}]`).forEach((el) => el.removeAttribute(marker));

  // Nested (not a module-level function) deliberately — everything this
  // page.evaluate callback touches has to be self-contained, since it runs
  // serialized in the browser with no access to outer Node.js closures.
  const isDisabledCalendarCell = (el) => {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
    return /\bdisabled\b|\bunavailable\b|\bblocked\b|\bnot-?allowed\b/.test(cls);
  };

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

  let sawDisabledMatch = false;

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    let isMatch = false;
    const dataDate = el.getAttribute('data-date') || el.getAttribute('datetime');
    if (dataDate) {
      const parsed = new Date(dataDate);
      if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day) {
        isMatch = true;
      }
    }
    if (!isMatch) {
      const parsedLabel = parseDateFromLabel(el.getAttribute('aria-label'));
      if (parsedLabel && parsedLabel.day === day && parsedLabel.month === month && parsedLabel.year === year) {
        isMatch = true;
      }
    }

    if (!isMatch) continue;

    if (isDisabledCalendarCell(el)) {
      sawDisabledMatch = true;
      continue; // Keep scanning — an enabled duplicate elsewhere should still win.
    }

    el.setAttribute(marker, '1');
    return 'found';
  }

  return sawDisabledMatch ? 'disabled' : 'not_found';
};

const findCalendarCellForDate = async (page, targetDate) => {
  const status = await page.evaluate(findCalendarCellInPage, {
    day: targetDate.getDate(),
    month: targetDate.getMonth(),
    year: targetDate.getFullYear(),
    marker: CALENDAR_MARKER_ATTR,
    monthNames: MONTH_NAMES_EN
  });
  return { status, locator: status === 'found' ? page.locator(`[${CALENDAR_MARKER_ATTR}]`).first() : null };
};

// Semantic-first, most-specific-to-least-specific: an accessible name that
// explicitly says "next/previous month" is essentially unambiguous; a bare
// "next"/"prev" aria-label is looser but still an accessibility signal, not
// a guess; the handful of framework class names at the end are a last
// resort for widgets with no accessible name at all. Nothing here names a
// specific site.
const NEXT_MONTH_SELECTORS = [
  'button[aria-label*="next month" i]',
  '[aria-label*="next month" i]',
  '[role="button"][aria-label*="next" i]',
  'button[aria-label*="next" i]',
  '[data-testid*="next" i][data-testid*="month" i]',
  '.react-datepicker__navigation--next',
  '.next-month',
  '.datepicker-next'
];

const PREV_MONTH_SELECTORS = [
  'button[aria-label*="previous month" i]',
  '[aria-label*="previous month" i]',
  '[role="button"][aria-label*="prev" i]',
  'button[aria-label*="prev" i]',
  '[data-testid*="prev" i][data-testid*="month" i]',
  '.react-datepicker__navigation--previous',
  '.prev-month',
  '.datepicker-prev'
];

const clickMonthNavControl = async (page, direction) => {
  const selectors = direction === 'next' ? NEXT_MONTH_SELECTORS : PREV_MONTH_SELECTORS;
  for (const selector of selectors) {
    try {
      const control = page.locator(selector).first();
      if (!(await control.isVisible({ timeout: 200 }))) continue;
      const disabled = await control.isDisabled({ timeout: 200 }).catch(() => false);
      if (disabled) continue;
      await control.click({ timeout: 1000 });
      return true;
    } catch (error) {
      // Not present/visible/enabled — try the next selector.
    }
  }
  return false;
};

// Some calendar widgets fully unmount (not just visually hide) after
// certain interactions, losing the grid AND its nav controls entirely
// (requirement: handle calendars that require reopening after navigation).
// Best-effort and generic: looks for a currently-visible, closed control
// (aria-expanded="false", a common convention for any disclosure widget —
// combobox, popover trigger, date field) whose accessible name suggests a
// date field, and clicks it to reopen. No site or widget-library knowledge.
const CALENDAR_TRIGGER_NAME_PATTERN = /date|check.?in|check.?out|calendar|arrival|departure|when\b/i;
const CALENDAR_REOPEN_TRIGGER_SELECTORS = [
  '[aria-haspopup="dialog"][aria-expanded="false"]',
  '[aria-haspopup="grid"][aria-expanded="false"]',
  '[role="combobox"][aria-expanded="false"]',
  'input[aria-expanded="false"]',
  'button[aria-expanded="false"]'
];

const tryReopenCalendar = async (page) => {
  for (const selector of CALENDAR_REOPEN_TRIGGER_SELECTORS) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < Math.min(count, 8); i += 1) {
        const el = locator.nth(i);
        if (!(await el.isVisible({ timeout: 150 }).catch(() => false))) continue;
        const name = await el.evaluate((node) => node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.textContent || '', undefined, { timeout: 1000 }).catch(() => '');
        if (CALENDAR_TRIGGER_NAME_PATTERN.test(name)) {
          await el.click({ timeout: 1000 }).catch(() => {});
          return true;
        }
      }
    } catch (error) {
      // Selector unsupported in this engine build, or nothing matched —
      // try the next candidate.
    }
  }
  return false;
};

// Poll-based, not a fixed sleep: waits for the DISPLAYED month to actually
// change rather than assuming a click's effect landed within some guessed
// delay. This is what makes navigation reliable against calendars that
// lazy-load future months over the network — a slow widget gets exactly as
// long as it needs (up to the cap below), and a fast one doesn't wait any
// longer than necessary.
const WAIT_FOR_MONTH_CHANGE_MS = 4000;

const waitForMonthChange = async (page, previousMonths, timeoutMs = WAIT_FOR_MONTH_CHANGE_MS) => {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = new Set(previousMonths.map(monthKey));
  while (Date.now() < deadline) {
    const current = await getDisplayedMonths(page);
    if (current.length > 0 && current.some((m) => !previousKeys.has(monthKey(m)))) {
      return current;
    }
    await page.waitForTimeout(150);
  }
  return getDisplayedMonths(page);
};

// Outer safety ceiling only — in normal operation the time-based deadline
// below (see CALENDAR_TIMEOUT_MS in runWorkflow) governs how long this can
// run; this just guarantees termination even if the clock and this counter
// somehow disagree.
const MAX_MONTH_ADVANCES = 36;
// Consecutive month-navigation clicks that don't actually change the
// displayed month before giving up — catches a nav control that LOOKS
// clickable (visible, not aria-disabled) but is a no-op at the widget's own
// lazy-loaded range boundary, rather than burning the rest of the time
// budget on a stuck loop.
const MAX_STALL_RETRIES = 3;

// Same idea as captureBlockerDiagnostics, for the other way a calendar step
// can fail: not because something is covering the target, but because no
// day cell matching the target date (and no month-navigation control) could
// be found at all — usually because the calendar widget never actually
// opened, or its markup doesn't match any of findCalendarCellInPage's
// detection strategies. Screenshots + a DOM summary of whatever *does* look
// calendar-shaped on the page turns "no cell found" into an actionable next
// step instead of a dead end.
const captureCalendarDiagnostics = async ({ page, stepIndex, targetDate, monthAdvances, monthLog }) => {
  const diagnostics = {
    stepIndex,
    targetDate: targetDate.toDateString(),
    monthAdvances,
    monthLog: monthLog || [],
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
  const targetKey = monthKey({ month: targetDate.getMonth(), year: targetDate.getFullYear() });

  const deadline = Date.now() + timeoutMs;
  const monthLog = [];
  let monthAdvances = 0;
  let stallCount = 0;
  let reopenAttempted = false;

  const clickResolvedCell = async (found) => {
    await found.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await waitForElementToStopMoving(found.locator);

    try {
      await found.locator.click();
    } catch (clickError) {
      // Same last-resort chain as every other click-family step (see
      // performWithRetry) — only for a genuine interception, and only after
      // the normal click already failed once. Requirement 11 (retry when
      // the calendar re-renders): re-resolve the cell fresh rather than
      // reusing the possibly-stale locator, in case the click itself
      // triggered a re-render.
      if (!TRANSIENT_ACTION_ERROR_PATTERN.test(clickError?.message || '')) {
        throw clickError;
      }
      const recovery = await tryRecoverFromBlocker(page, found.locator);
      if (recovery) {
        log.blockersDismissed = (log.blockersDismissed || []).concat(recovery);
      }
      const refound = await findCalendarCellForDate(page, targetDate);
      const retryLocator = refound.status === 'found' ? refound.locator : found.locator;
      try {
        await retryLocator.click({ timeout: 1000 });
      } catch (retryError) {
        await retryLocator.evaluate((el) => el.click(), undefined, { timeout: 2000 });
        log.jsClickFallbackUsed = true;
      }
    }

    log.actionExecuted = true;
  };

  while (Date.now() < deadline) {
    // Proactive, selector-based only (never the Escape-key fallback) — a
    // blind Escape here would risk closing the calendar widget itself
    // before its cell is ever clicked. The stronger recovery (including
    // Escape) is reserved for the reactive path inside clickResolvedCell,
    // once a real click on an actual cell has already confirmed something
    // else is on top of it.
    const dismissed = await dismissCommonOverlays(page);
    if (dismissed) {
      log.blockersDismissed = (log.blockersDismissed || []).concat(dismissed);
    }

    // Requirements 1, 2, 13: detect the currently displayed month(s) before
    // doing anything else, and log every iteration.
    let displayedMonths = await getDisplayedMonths(page);
    monthLog.push({
      iteration: monthAdvances,
      displayed: displayedMonths.map((m) => `${MONTH_NAMES_EN[m.month]} ${m.year}`),
      timestamp: new Date().toISOString()
    });
    console.log('[Backend][replay][calendar] month check', JSON.stringify(monthLog[monthLog.length - 1]));

    // Requirement 8: some widgets fully unmount the calendar after certain
    // interactions — try reopening it once (best-effort) before concluding
    // it's genuinely gone from the page.
    if (displayedMonths.length === 0 && !reopenAttempted) {
      reopenAttempted = true;
      if (await tryReopenCalendar(page)) {
        await waitForPageStability(page, 1500);
        displayedMonths = await getDisplayedMonths(page);
      }
    }

    // Requirement 9 (verify the target day exists before attempting the
    // click): only search for the actual cell once the target's month is
    // confirmed visible — or when month-detection itself found nothing at
    // all (some widgets have no parseable caption), falling back to the
    // page-wide search so that case never regresses versus a direct look.
    if (displayedMonths.length === 0 || isTargetMonthDisplayed(displayedMonths, targetKey)) {
      const found = await findCalendarCellForDate(page, targetDate);

      if (found.status === 'found') {
        log.strategyUsed = 'calendar-semantic';
        log.retries = monthAdvances;
        log.elementFound = true;
        log.calendarMonthLog = monthLog;
        await clickResolvedCell(found);
        return;
      }

      if (found.status === 'disabled') {
        // Requirement 7: the target date exists but the widget marks it
        // unavailable (already booked/blocked/in the past per the site's
        // own rules) — a fundamentally different failure than "not found,"
        // and no amount of further month-navigation will ever fix it, so
        // fail fast with a distinct, clear reason instead of burning the
        // rest of the time budget.
        log.elementFound = false;
        log.calendarMonthLog = monthLog;
        log.failureReason = `Target date ${targetDate.toDateString()} was found but is disabled/unavailable on this calendar`;
        const diagnostics = await captureCalendarDiagnostics({ page, stepIndex: step.index, targetDate, monthAdvances, monthLog });
        log.calendarDiagnostics = diagnostics;
        throw new Error(log.failureReason);
      }
    }

    if (monthAdvances >= MAX_MONTH_ADVANCES) {
      break;
    }

    // Requirements 3, 5, 6: navigate intelligently instead of blindly
    // advancing. The signed distance from whichever currently-displayed
    // month is CLOSEST to the target decides direction — correct for a
    // dual-month display, since its second pane can already be past the
    // target even while the first pane isn't there yet.
    const distance = closestMonthDistance(displayedMonths, targetKey);
    const direction = distance === null || distance >= 0 ? 'next' : 'previous';
    const beforeClickMonths = displayedMonths;

    const advanced = await clickMonthNavControl(page, direction);
    monthAdvances += 1;
    log.retries = monthAdvances;

    if (!advanced) {
      // No nav control found/visible/enabled at all — could be a slow
      // render, or a widget that lazy-mounts its own control. A few quick
      // retries covers that without paying the full backoff ladder cost
      // every single time.
      await page.waitForTimeout(Math.min(backoffDelay(Math.min(monthAdvances, 4)), Math.max(0, deadline - Date.now())));
      continue;
    }

    // Requirement 6: lazy-loading calendars don't necessarily finish
    // rendering the new month the instant the click resolves — poll for the
    // displayed month(s) to actually change rather than a fixed sleep.
    const afterClickMonths = await waitForMonthChange(page, beforeClickMonths, Math.min(WAIT_FOR_MONTH_CHANGE_MS, Math.max(500, deadline - Date.now())));

    // Drift/stall detection: if the displayed month didn't actually change,
    // the click may have silently failed (a disabled-but-not-aria-disabled
    // nav button, an animation that swallowed the click, the widget's own
    // lazy-loaded range boundary) — give it a few more tries before giving
    // up on this direction entirely, rather than looping for the whole
    // remaining time budget on a stuck widget.
    const beforeKey = beforeClickMonths.length ? monthKey(beforeClickMonths[0]) : null;
    const afterKey = afterClickMonths.length ? monthKey(afterClickMonths[0]) : null;
    if (beforeKey !== null && afterKey === beforeKey) {
      stallCount += 1;
      if (stallCount > MAX_STALL_RETRIES) {
        break;
      }
    } else {
      stallCount = 0;
    }

    await waitForPageStability(page, 1000);
  }

  log.elementFound = false;
  log.calendarMonthLog = monthLog;
  log.failureReason = `No calendar cell found for ${targetDate.toDateString()} after advancing ${monthAdvances} month(s)`;
  const diagnostics = await captureCalendarDiagnostics({ page, stepIndex: step.index, targetDate, monthAdvances, monthLog });
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

// Visible by default in local development: the whole point of "Run API"
// from the user's perspective is watching the recorded workflow actually
// happen in a real browser window, not trusting a backend log that says it
// happened. Production (NODE_ENV=production) has no display to show that
// window on — Railway and every other server/container host — so it
// defaults to headless there instead. FORGEFLOW_HEADLESS always wins when
// explicitly set (either direction, in any environment), so this remains a
// deployment-mode switch, not a per-site setting.
const NODE_ENV = process.env.NODE_ENV || 'development';
const HEADLESS = process.env.FORGEFLOW_HEADLESS !== undefined
  ? process.env.FORGEFLOW_HEADLESS === 'true'
  : NODE_ENV === 'production';

// Chromium's sandbox needs kernel privileges that containerized hosts like
// Railway don't grant, and /dev/shm is typically too small there too — the
// standard launch args for running headless Chromium in a container.
// Headed mode is local-only (see above), where none of this applies.
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

const runWorkflow = async ({ steps, parameterValues, workflowId, extractionHint }) => {
  const runStartedAt = Date.now();
  const values = parameterValues || {};
  const browser = await chromium.launch({ headless: HEADLESS, args: HEADLESS ? CONTAINER_LAUNCH_ARGS : ['--start-maximized'] });
  // null viewport lets the page fill the actual (maximized) window instead
  // of being letterboxed to Playwright's fixed default size — only
  // meaningful in headed mode; headless has no real window to fill.
  const context = await browser.newContext({ hasTouch: true, viewport: HEADLESS ? { width: 1280, height: 720 } : null });
  const tracker = createPageTracker(await context.newPage());

  const skippedSteps = [];
  const stepLog = [];

  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const startedAt = Date.now();
      // Full diagnostic schema for every step, per requirement: step number
      // (index), step type, selector/target, whether an element was found,
      // whether the action actually executed, the URL before and after, and
      // a best-effort screenshot. `elementFound`/`actionExecuted` start out
      // null/false and are only ever set true by the code path that actually
      // did that work — a step that never reaches waitForActionableElement
      // (navigation, scroll-window, touch) correctly stays `elementFound:
      // null` (not applicable) rather than a misleading true/false.
      const log = {
        index: i,
        type: step.type,
        selector: describeStepTarget(step),
        urlBefore: null,
        url: null,
        elementFound: null,
        actionExecuted: false,
        strategyUsed: null,
        retries: 0,
        blockersDismissed: [],
        failureReason: null,
        screenshotPath: null,
        result: 'success'
      };

      try {
        if (step.type !== 'navigation' && step.type !== 'new_page') {
          tracker.resolveForStep(step);
        }

        const page = tracker.current;
        log.urlBefore = page.url();
        log.url = log.urlBefore;
        const timeoutMs = step.type === 'calendar_date'
          ? CALENDAR_TIMEOUT_MS
          : (NON_CRITICAL_STEP_TYPES.has(step.type) ? NON_CRITICAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

        switch (step.type) {
          case 'navigation': {
            // A navigation step is very often not an independent command at
            // all — content.js records "the page finished loading" as its
            // own event, so clicking a real link/suggestion/Search button,
            // or a native form submit, produces its own navigation, and
            // this step's literal recorded URL is just whatever that
            // happened to point to *during recording*. Forcing that frozen
            // URL here would silently discard whatever the site's own,
            // already-correct navigation just did — dragging the browser
            // back to a stale search from months ago instead of trusting
            // the live result of today's actual parameter values. This is
            // requirement 8 in full: prefer the live outcome of replaying
            // the recorded ACTIONS over forcing a recorded URL, whenever
            // the two already agree — checked generically via
            // isAlreadyAtNavigationTarget (same origin+pathname, every
            // templated value for this run present in the live URL;
            // tracking/session/analytics query noise is never compared),
            // not by asking "was the previous step specifically a click" —
            // a scroll, a second click, or anything else in between the
            // real trigger and this step must not defeat that check.
            await waitForPageStability(page, Math.min(3000, DEFAULT_TIMEOUT_MS));
            const dismissedBeforeCheck = await dismissCommonOverlays(page);
            if (dismissedBeforeCheck) {
              log.blockersDismissed.push(dismissedBeforeCheck);
            }

            if (isAlreadyAtNavigationTarget(page.url(), step.value, values)) {
              log.strategyUsed = 'navigation-already-occurred';
              log.actionExecuted = true;
              tracker.remember(page);
              log.url = page.url();
              break;
            }

            const url = resolveUrlTemplate(step.value, values);
            if (url) {
              await gotoWithRecovery(page, url, { timeoutMs: DEFAULT_TIMEOUT_MS, log });
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
              log.actionExecuted = true;
            }
            break;
          }

          case 'click': {
            // An explicit, bounded timeout (rather than Playwright's own
            // ~30s default) matters specifically for a covered element
            // handed back by waitForActionableElement's recovery-exhausted
            // path (see MAX_COVERED_RECOVERY_ATTEMPTS) — it gives
            // Playwright's own native actionability wait one real, bounded
            // shot before performWithRetry's JS-click fallback takes over,
            // instead of a single attempt silently eating most of the
            // step's whole time budget.
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.click({ timeout: 3000 }), values, { allowJsClickFallback: true });
            await waitForPageStability(page, 3000);
            break;
          }

          case 'dynamic_click': {
            // A dynamic_click exists to select a value from a list that's
            // DYNAMICALLY RENDERED ON THE CURRENT PAGE (a search-suggestion
            // dropdown, an autocomplete option) — by definition, that list
            // cannot exist on a page already navigated away from. See
            // performWithRetry's abortIfNavigatedAway handling for why this
            // is checked on every retry iteration, not just once up front —
            // confirmed against live Wikipedia to be a real, timing-
            // dependent race, not a hypothetical one (see that option's
            // doc comment for the full reasoning).
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.click({ timeout: 3000 }), values, { allowJsClickFallback: true, abortIfNavigatedAway: true });
            await waitForPageStability(page, 3000);
            break;
          }

          case 'dblclick': {
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.dblclick({ timeout: 3000 }), values, { allowJsClickFallback: true });
            await waitForPageStability(page, 3000);
            break;
          }

          case 'input':
          case 'change': {
            const value = substitutePlaceholders(step.value, values);
            await performWithRetry(page, step, log, timeoutMs, (locator) => fillField(locator, value), values, { allowJsClickFallback: false });
            break;
          }

          case 'keydown': {
            // The only keydown that survives eventCondenser's filtering is
            // Enter — on many real sites (search boxes, login forms) that's
            // how the user actually submitted, with no separate click and,
            // for a client-side/SPA route change, often no captured
            // navigation step either. Replaying the literal keypress (not
            // guessing a URL) is what makes that submission happen again;
            // skipping it silently strands every later step on the
            // pre-submit page. waitForPageStability mirrors the click case
            // since Enter just as commonly triggers a navigation.
            await performWithRetry(page, step, log, timeoutMs, (locator) => locator.press('Enter', { timeout: 3000 }), values, { allowJsClickFallback: false });
            await waitForPageStability(page, 3000);
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
              log.elementFound = null; // n/a — scrolling the window has no element to find.
            } else {
              await scrollElement(page, target, x, y, NON_CRITICAL_TIMEOUT_MS);
              log.elementFound = true; // scrollElement's own waitForSelector already threw if missing.
            }
            log.actionExecuted = true;
            break;
          }

          case 'touch': {
            await simulateTouch(page, step.value, step.meta);
            log.actionExecuted = true;
            break;
          }

          case 'new_page': {
            const newPage = await context.newPage();
            tracker.current = newPage;
            const newPageUrl = resolveUrlTemplate(step.url, values);
            if (newPageUrl) {
              // Same multi-waitUntil recovery as the main navigation case —
              // a new tab is exactly as likely to hit ERR_ABORTED from a
              // client-side redirect as the primary page. Best-effort only
              // (a failed new-tab load has never been treated as fatal
              // here), but recovering it properly beats silently giving up
              // on the first waitUntil condition.
              await gotoWithRecovery(newPage, newPageUrl, { timeoutMs: DEFAULT_TIMEOUT_MS, log }).catch(() => {});
              await waitForPageStability(newPage, DEFAULT_TIMEOUT_MS);
              const dismissed = await dismissCommonOverlays(newPage);
              if (dismissed) {
                log.blockersDismissed.push(dismissed);
              }
            }
            tracker.remember(newPage);
            log.url = newPage.url();
            log.actionExecuted = true;
            break;
          }

          default:
            // Unknown/unsupported step type — skip rather than fail the whole replay.
            log.result = 'skipped';
            log.failureReason = `Unrecognized step type "${step.type}"`;
            break;
        }

        // Success path: capture the definitive post-step URL (overwrites the
        // pre-action value every case above already set as a fallback) and a
        // best-effort screenshot, against whatever page is current NOW — a
        // step can itself have switched tracker.current (navigation/new_page).
        log.url = tracker.current.url();
        log.screenshotPath = await captureStepScreenshot(tracker.current, i);
      } catch (stepError) {
        log.failureReason = log.failureReason || stepError.message;
        // Best-effort even on failure — this is exactly the moment a
        // screenshot/URL reading matters most for diagnosing WHY a step
        // didn't complete. tracker.current still points at a live page even
        // when the step's own action failed.
        try { log.url = tracker.current.url(); } catch (readError) { /* page may be closed/gone */ }
        log.screenshotPath = await captureStepScreenshot(tracker.current, i);

        if (NON_CRITICAL_STEP_TYPES.has(step.type)) {
          log.result = 'skipped';
          console.warn(`[Backend] Skipping non-critical step ${i} (${step.type}): ${stepError.message}`);
          skippedSteps.push({ index: i, type: step.type, reason: stepError.message });
        } else {
          log.result = 'failed';
          log.durationMs = Date.now() - startedAt;
          stepLog.push(log);
          console.error('[Backend][replay] STEP FAILED — replay stops here.', JSON.stringify(log));
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

    // Deliberately NOT closing browser/context here. The whole point of
    // "Run API" is that the user can watch it happen and then look at the
    // result — snapping the window shut the instant replay finishes would
    // defeat that. It stays open until the user closes it themselves (or
    // the backend process exits); only a FAILED run cleans up automatically
    // (see the catch block below), so failed attempts don't silently pile
    // up windows the user never asked to inspect.
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
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
};

// Exported so the run/test controller can validate an edited calendar_date
// parameter BEFORE launching a browser, using the exact same parser replay
// itself will use — a value that fails here would fail identically deep
// inside performCalendarDateClick, just after wastefully opening a browser.
module.exports = { runWorkflow, parseTargetDate };
