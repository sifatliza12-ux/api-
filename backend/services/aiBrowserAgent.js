// AI API Creator's browser agent (V2 Phase 2) — the file replayEngine.js and
// pageSnapshotBuilder.js both already name as their intended caller. Drives
// a live Playwright page toward a confirmed intent by repeatedly asking the
// active AIProvider's decideNextAction "what's the single next action?",
// executing it, and recording it — until the model reports "done" (success),
// "stop" (model gave up), or maxSteps is reached.
//
// Deliberately NOT a rewrite of replayEngine.js: this reuses its exported
// helpers (locatorFromCandidate, dismissCommonOverlays, waitForPageStability)
// instead of reimplementing element resolution. The retry/recovery machinery
// inside runWorkflow (performWithRetry etc.) isn't reused because it isn't
// exported (see replayEngine.js's own comment on why) and isn't needed here
// anyway: a live agent re-observes the real page every single step via a
// fresh snapshot, so it doesn't need blind retries against a possibly-stale
// element the way replaying a recorded step does.
//
// V2 Phase 4: `steps` in this module's return value are RAW RECORDED EVENTS
// (the same {type, value, selector, locators, meta, url, ...} shape
// extension/content/content.js's manual recorder produces), NOT already
// replay-ready — the caller (aiCreatorController.generateWorkflow) is
// expected to run them through the EXISTING
// ruleBasedParameterizer.parameterizeWorkflowRuleBased(events), exactly like
// workflowController.parameterize already does for a human recording, so an
// AI-generated workflow gets real {{placeholder}} substitution through the
// same, single, unmodified parameterization/replay pipeline — not a second
// one. This file deliberately does not know what a "parameter" is; it only
// knows how to describe what it did on the live page in the recorder's
// vocabulary.
const { chromium } = require('playwright');
const { buildPageSnapshot } = require('./pageSnapshotBuilder');
const { detectPageBlock } = require('./antiBotDetector');
const { locatorFromCandidate, dismissCommonOverlays, waitForPageStability } = require('./replayEngine');
const { getProvider } = require('./aiProviders');
const siteDiscovery = require('./siteDiscovery');
const { extractPageData } = require('./extraction');

class BrowserAgentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BrowserAgentError';
    this.details = details;
  }
}

// A RECOVERABLE execution fault — the decided action was structurally valid
// (a real ref from the current snapshot, a supported action type) but could
// not actually be carried out against the live page (nothing currently
// visible/enabled/stable/unobscured matches it, or the actual click/fill/
// press call still failed despite that). The main loop treats ONLY this
// subclass as recoverable — reported back into `history` so the next
// decision can try something else — everything else (an invented ref, an
// unsupported action type, a navigation failure) stays fatal, unchanged.
class ActionExecutionError extends BrowserAgentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ActionExecutionError';
  }
}

// Small enough that a runaway/looping model can't drive a single request
// forever, generous enough for a real multi-field form + submit + result
// page. Overridable per call for tests, not via env — this bounds a single
// live browser session's cost, not a deployment-wide setting.
const DEFAULT_MAX_STEPS = 20;
const ACTION_TIMEOUT_MS = 10000;
// Once resolveElementLocator has already confirmed a candidate is visible,
// enabled, stable, and unobscured, the actual click/fill/press should
// resolve almost immediately — this stays far below ACTION_TIMEOUT_MS so a
// genuine residual failure (e.g. a last-instant DOM change) is reported
// back to the agent loop in seconds, not after a full 10s hang on an
// action that was never going to succeed.
const INTERACTION_TIMEOUT_MS = 3000;
// How many live DOM matches of a single locator candidate to probe before
// moving on to the next locator strategy — bounds cost when a selector
// (e.g. a data-testid reused across a duplicated desktop/mobile layout)
// matches many elements, only one of which is the real, currently visible
// target.
const MAX_CANDIDATE_MATCHES_TO_CHECK = 8;
// Cheap two-sample bounding-box comparison — not Playwright's full internal
// stability protocol, just enough to reject an element that's visibly
// still animating/moving (e.g. a toast sliding in) at decision time.
const STABILITY_CHECK_DELAY_MS = 60;

// Same HEADLESS/launch-args logic as replayEngine.js's runWorkflow (not
// exported from there — see that file's export-list comment on why the
// retry/launch internals stay private). Duplicated here rather than
// refactored out from under runWorkflow, per "do not rewrite the existing
// replay engine."
const NODE_ENV = process.env.NODE_ENV || 'development';
const HEADLESS = process.env.FORGEFLOW_HEADLESS !== undefined
  ? process.env.FORGEFLOW_HEADLESS === 'true'
  : NODE_ENV === 'production';
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

// Best-effort "is anything else painted on top of this element's center
// point" check via elementFromPoint — the same generic technique used
// elsewhere for overlay detection, applied here per-candidate rather than
// page-wide. Never throws and never blocks resolution on its own failure
// (a detached element, a point outside the layout viewport, etc. all just
// count as "not obscured" — this is a refinement on top of the visible/
// enabled checks, not a replacement for them).
const isCandidateObscured = async (locator) => {
  try {
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl) return false;
      return !(topEl === el || el.contains(topEl) || topEl.contains(el));
    });
  } catch (error) {
    return false;
  }
};

// Cheap two-sample bounding-box comparison — rejects an element that's
// still visibly moving (e.g. mid-animation) right now, without waiting for
// Playwright's own full actionability protocol to do it implicitly inside
// the eventual click/fill/press call.
const isCandidateStable = async (locator) => {
  try {
    const box1 = await locator.boundingBox();
    if (!box1) return false;
    await new Promise((resolve) => setTimeout(resolve, STABILITY_CHECK_DELAY_MS));
    const box2 = await locator.boundingBox();
    if (!box2) return false;
    return box1.x === box2.x && box1.y === box2.y && box1.width === box2.width && box1.height === box2.height;
  } catch (error) {
    return false;
  }
};

// A single locator candidate (e.g. `[data-testid="auth-toggle"]`) can
// resolve to MULTIPLE live DOM elements — a data-testid/class/structural
// selector describes a class of elements, not the one specific node
// pageSnapshotBuilder actually inspected. This is common and completely
// generic (not site-specific): a duplicated desktop/mobile nav, an A/B
// variant, a hidden template clone, etc. all legitimately share attributes
// with the real, currently-visible target. `.first()` alone picks whatever
// happens to be first in DOM order, which is NOT guaranteed to be the
// visible one — that mismatch is what caused the reported
// "locator.click: Timeout 10000ms exceeded" / "element is not visible"
// failure. This walks every live match (bounded by
// MAX_CANDIDATE_MATCHES_TO_CHECK) and returns the first one that is
// actually visible, enabled, stable, and unobscured — never just the first
// DOM-order match.
const findInteractableMatch = async (page, candidate) => {
  const base = locatorFromCandidate(page, candidate);
  let count;
  try {
    count = await base.count();
  } catch (error) {
    return null;
  }

  const checkCount = Math.min(count, MAX_CANDIDATE_MATCHES_TO_CHECK);
  for (let i = 0; i < checkCount; i += 1) {
    const nth = base.nth(i);
    try {
      const [visible, enabled] = await Promise.all([nth.isVisible(), nth.isEnabled()]);
      if (!visible || !enabled) continue;
      if (!(await isCandidateStable(nth))) continue;
      if (await isCandidateObscured(nth)) continue;
      return nth;
    } catch (error) {
      // This specific match errored out (e.g. detached mid-check) — try
      // the next one rather than giving up on the whole candidate.
    }
  }
  return null;
};

// Resolves a decideNextAction ref back to a live, INTERACTABLE Playwright
// Locator by walking the SAME element's locators array pageSnapshotBuilder
// built for it (in priority order), same interop contract
// pageSnapshotBuilder.test.js already proves against
// replayEngine.locatorFromCandidate — but, unlike a bare "does anything
// match" check, each candidate is scanned for an actually visible/enabled/
// stable/unobscured live match (see findInteractableMatch) before being
// accepted. If a candidate's matches are all hidden/disabled/obscured, the
// NEXT locator strategy for the same element is tried, rather than handing
// back a known-bad element and letting Playwright's own action timeout
// discover that the slow way.
//
// Throws plain BrowserAgentError (fatal — the ref itself is invalid, not
// just currently unreachable) when the ref isn't in the snapshot at all;
// throws ActionExecutionError (recoverable — see the main loop) when the
// ref is real but nothing about it is currently interactable.
const resolveElementLocator = async (page, snapshot, ref) => {
  const element = (snapshot.elements || []).find((el) => el.ref === ref);
  if (!element) {
    throw new BrowserAgentError(`Ref "${ref}" is not present in the current snapshot.`);
  }

  for (const candidate of element.locators || []) {
    const match = await findInteractableMatch(page, candidate);
    if (match) {
      return match;
    }
  }
  throw new ActionExecutionError(`Ref "${ref}" resolved to a snapshot element, but no candidate locator currently matches a visible, enabled, stable, unobscured element on the live page.`, { element });
};

// Executes exactly one validated action (from ollamaResponseUtils
// .validateProposedAction, or any provider's equivalent) against the page.
// Only ever called with actions outside {done, stop} — those are terminal
// and handled by the loop itself, never reach here.
const executeAction = async (page, snapshot, action) => {
  switch (action.action) {
    case 'navigation':
      await page.goto(action.value, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
      break;
    case 'click':
    case 'calendar_date': {
      const locator = await resolveElementLocator(page, snapshot, action.ref);
      try {
        await locator.click({ timeout: INTERACTION_TIMEOUT_MS });
      } catch (error) {
        // Already pre-verified visible/enabled/stable/unobscured — this is
        // a genuine residual failure (e.g. a last-instant DOM change), not
        // the "blindly retry a known-hidden element" failure mode this fix
        // targets. Still reported back to the agent loop rather than
        // crashing the whole run.
        throw new ActionExecutionError(`Could not click the target element for ref "${action.ref}": ${error.message}`, { ref: action.ref });
      }
      break;
    }
    case 'input':
    case 'change': {
      const locator = await resolveElementLocator(page, snapshot, action.ref);
      try {
        await locator.fill(action.value || '', { timeout: INTERACTION_TIMEOUT_MS });
      } catch (error) {
        throw new ActionExecutionError(`Could not fill the target element for ref "${action.ref}": ${error.message}`, { ref: action.ref });
      }
      break;
    }
    case 'keydown': {
      const locator = await resolveElementLocator(page, snapshot, action.ref);
      try {
        await locator.press(action.value || 'Enter', { timeout: INTERACTION_TIMEOUT_MS });
      } catch (error) {
        throw new ActionExecutionError(`Could not send the key to the target element for ref "${action.ref}": ${error.message}`, { ref: action.ref });
      }
      break;
    }
    default:
      throw new BrowserAgentError(`"${action.action}" is not an executable action.`);
  }

  await waitForPageStability(page, 3000);
  await dismissCommonOverlays(page).catch(() => null);
};

// Picks the single CSS-string `selector` ruleBasedParameterizer.js reads
// (deriveBaseNameFromSelector, inferType's date check, dedupeFieldParameters's
// duplicate-grouping key all key off this exact field, distinct from the
// `locators` array) — pageSnapshotBuilder.js guarantees every element has at
// least one strategy:'css' locator (testid/id/name/placeholder, or a
// structural fallback), so this is never left null for a resolved element.
const deriveSelector = (locators) => (locators || []).find((loc) => loc.strategy === 'css')?.value || null;

// Builds the event.meta.fieldContext object ruleBasedParameterizer.js's
// pickNameSource() reads (in priority order: label, ariaLabel, placeholder,
// name, nearbyText) to name a parameter well. The live snapshot doesn't
// carry a DOM `name` ATTRIBUTE or "nearby text" the way a real recording's
// content.js capture does (see pageSnapshotBuilder.js), so those two stay
// null — pickNameSource simply falls through to the next candidate, same as
// it already does for a real recording missing one of these. `ariaLabel`
// uses the snapshot's `name` (its accessible-name amalgam: aria-label ||
// aria-labelledby || label text || visible text || value) as the closest
// available proxy — an imperfect but reasonable stand-in, not a fabrication
// of data that isn't there.
const buildFieldContext = (element) => ({
  label: element?.label || null,
  ariaLabel: element?.name || null,
  placeholder: element?.placeholder || null,
  name: null,
  nearbyText: null
});

// Converts one executed action into a RAW RECORDED EVENT — the same shape
// extension/content/content.js's manual recorder produces and
// ruleBasedParameterizer.parameterizeWorkflowRuleBased(events) expects as
// input (see that module's pickNameSource/condenseEvents) — NOT an
// already-parameterized replay-ready step. The caller runs the full
// sequence through that existing function to get real {{placeholder}}
// steps + a matching parameters array, exactly like a human recording.
//
// calendar_date is recorded as a plain 'click' event, matching how a HUMAN
// calendar interaction is recorded too: content.js never emits a
// 'calendar_date' event itself — parameterizeWorkflowRuleBased's own
// classifyDynamicClick/buildDynamicClickUpgrade is what upgrades a
// plain click into a calendar_date STEP, based on the page structure around
// it. Feeding a plain click here lets that existing, unmodified
// classification logic decide, identically to a human recording.
//
// A click's `value` is the clicked element's own visible/accessible text
// (matching content.js's convention — see replayEngine.js's
// buildRelaxedCandidates comment on valueIsElementText), not null: both
// classifyDynamicClick's heuristics and replay's own relaxed-candidate
// fallback search depend on it being real text, not a placeholder.
const actionToRecordedEvent = (action, snapshot) => {
  const url = snapshot?.url || null;
  const pageTitle = snapshot?.title || null;
  const timestamp = new Date().toISOString();

  if (action.action === 'navigation') {
    return { type: 'navigation', value: action.value, url: action.value, selector: null, locators: null, meta: null, pageTitle, timestamp };
  }

  const element = (snapshot.elements || []).find((el) => el.ref === action.ref);
  const locators = element?.locators || null;
  const selector = deriveSelector(locators);

  if (action.action === 'input' || action.action === 'change') {
    return {
      type: action.action,
      value: action.value ?? '',
      selector,
      locators,
      meta: { fieldContext: buildFieldContext(element) },
      url,
      pageTitle,
      timestamp
    };
  }

  if (action.action === 'keydown') {
    return { type: 'keydown', value: action.value || 'Enter', selector, locators, meta: null, url, pageTitle, timestamp };
  }

  // click, calendar_date
  return { type: 'click', value: element?.name || null, selector, locators, meta: null, url, pageTitle, timestamp };
};

// Honest, user-facing messages for the two discovery outcomes that stop a
// run before the loop begins. Both invite the user to reply with the exact
// site/URL — which the existing follow-up path (aiCreatorController.addMessage
// -> re-parse) turns into a user-supplied, authoritative URL that bypasses
// discovery entirely on the next attempt. No candidate is ever silently
// chosen; the candidates are surfaced so the user can decide.
const summarizeCandidates = (candidates) => (candidates || [])
  .slice(0, 3)
  .map((c) => c.host || c.url)
  .filter(Boolean)
  .join(', ');

const buildAmbiguityMessage = (targetName, outcome) => {
  const named = targetName ? `"${targetName}"` : 'the requested target';
  const list = summarizeCandidates(outcome && outcome.candidates);
  return list
    ? `ForgeFlow couldn't confidently tell which website you meant for ${named}. Closest matches: ${list}. Reply with the exact website name or its URL to continue.`
    : `ForgeFlow couldn't confidently identify a website for ${named}. Reply with the exact website name or its URL to continue.`;
};

const buildUnreachableMessage = (targetName, outcome) => {
  const named = targetName ? `"${targetName}"` : 'the requested target';
  const why = outcome && outcome.reason ? ` (${outcome.reason})` : '';
  return `ForgeFlow couldn't reach a website for ${named}${why}. Reply with the exact website name or its URL to continue.`;
};

// Runs the agent loop to completion (done/stop/blocked/maxSteps) and
// returns a result — never throws for an ordinary in-page failure (a
// blocked page, the model stopping, running out of steps), NOR for a
// single action that turned out not to be currently interactable (see
// ActionExecutionError above — that's reported back into history and the
// loop continues). Only throws for a structural fault that means the run
// can't be trusted to continue safely at all: an invalid/invented ref, an
// unsupported action type, a navigation failure, or the model call itself
// failing.
//
// `page`, when provided, is used as-is and its browser/context lifecycle is
// the CALLER's responsibility (matches buildPageSnapshot's own convention,
// and lets tests drive a single shared page via data: URLs). When omitted,
// this function launches and closes its own browser, matching runWorkflow's
// self-contained convention for real callers (i.e. the controller).
// `decideNextAction`, when provided, overrides the active AIProvider's
// implementation — used by tests to script a deterministic decision
// sequence without depending on a real model. `discoverTargetSite`,
// likewise, overrides siteDiscovery.discoverTargetSite so tests exercise the
// resolve-start-URL branches against deterministic fixtures with no network.
const runBrowserAgent = async ({ intent, maxSteps = DEFAULT_MAX_STEPS, page: injectedPage, decideNextAction: injectedDecideNextAction, discoverTargetSite: injectedDiscover } = {}) => {
  if (!intent || typeof intent !== 'object') {
    throw new BrowserAgentError('runBrowserAgent requires a structured intent.');
  }

  const decide = injectedDecideNextAction || getProvider().decideNextAction;
  const discover = injectedDiscover || siteDiscovery.discoverTargetSite;

  let browser = null;
  let page = injectedPage;

  try {
    if (!page) {
      browser = await chromium.launch({ headless: HEADLESS, args: HEADLESS ? CONTAINER_LAUNCH_ARGS : ['--start-maximized'] });
      const context = await browser.newContext({ viewport: HEADLESS ? { width: 1280, height: 720 } : null });
      page = await context.newPage();
    }

    const history = [];
    // Raw recorded events (see actionToRecordedEvent) — meant to be fed
    // through ruleBasedParameterizer.parameterizeWorkflowRuleBased by the
    // caller, not replayed directly.
    const steps = [];

    const finalInfo = async (extra) => ({
      steps,
      history,
      finalUrl: page.url(),
      finalTitle: await page.title().catch(() => ''),
      ...extra
    });

    // Resolve a trustworthy starting URL for the target site, then record the
    // navigation to it as the first event — exactly like a human recording
    // always starts with one (see content.js). Without a recorded start,
    // replay would begin from about:blank and every subsequent step would
    // fail to find anything.
    //
    // Trust ladder (see nlIntentParser.classifyUrlSource + siteDiscovery.js):
    //   * urlSource 'user' — or a legacy intent that carries a url but no
    //     source at all — is a URL the user effectively typed: authoritative,
    //     navigated to directly (the pre-existing direct-URL behavior,
    //     unchanged).
    //   * urlSource 'model' — a URL only the model guessed — is NEVER trusted
    //     blindly: it is handed to discovery as a seed that must verify first.
    //   * no url but a target NAME — discovery searches for the name, ranks
    //     candidates, and verifies the winner on the live page before
    //     committing. Ambiguous/unreachable outcomes stop the run cleanly with
    //     an honest reason rather than guessing.
    //   * neither a url nor a name — nothing to resolve; the seed navigation
    //     is skipped and the decision loop simply works from the current page
    //     (also unchanged legacy behavior, and what the tests rely on).
    const site = intent.targetSite || {};
    const targetName = (site.name || '').trim();
    const trustedUrl = (site.url && site.urlSource !== 'model') ? site.url : null;
    const seedUrl = (site.url && site.urlSource === 'model') ? site.url : null;

    let startUrl = trustedUrl;
    if (!startUrl && (targetName || seedUrl)) {
      const outcome = await discover({ page, targetName, task: intent.task, seedUrl });
      if (outcome.status === 'discovered') {
        startUrl = outcome.url;
      } else if (outcome.status === 'ambiguous') {
        return finalInfo({ success: false, stopped: true, stopReason: 'target_ambiguous', message: buildAmbiguityMessage(targetName, outcome), candidates: outcome.candidates || [] });
      } else if (outcome.status === 'disabled') {
        // Discovery switched off by configuration — fall back to the legacy
        // behavior of letting the loop start from wherever the page already is.
      } else {
        // unreachable / no_query
        return finalInfo({ success: false, stopped: true, stopReason: 'target_unreachable', message: buildUnreachableMessage(targetName, outcome), candidates: outcome.candidates || [] });
      }
    }

    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
      await waitForPageStability(page, 3000);
      await dismissCommonOverlays(page).catch(() => null);
      steps.push({ type: 'navigation', value: startUrl, url: startUrl, selector: null, locators: null, meta: null, pageTitle: await page.title().catch(() => null), timestamp: new Date().toISOString() });
    }

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const block = await detectPageBlock(page).catch(() => ({ blocked: false }));
      if (block.blocked) {
        return finalInfo({ success: false, stopped: true, stopReason: block.reason, message: block.message });
      }

      const snapshot = await buildPageSnapshot(page);
      const action = await decide(snapshot, intent, history);
      history.push(action);

      if (action.action === 'done') {
        // The task just completed, so THIS page is the results page the user
        // actually asked for — extract structured records from it now, while
        // the live page is still open, using the EXISTING, shared extraction
        // pipeline (the same extractPageData that Run/replay already use — not
        // a second implementation). This is what turns "the agent finished
        // navigating" into "here are the real results". workflowId is null
        // (no workflow row exists yet at generation time, so there is no
        // stored schema to reconcile against); extractionHint is whatever the
        // intent carried, if anything. Never throws and never fails the run:
        // an empty/failed extraction still returns a successful agent result
        // with empty data, honestly.
        const extraction = await extractPageData({
          page,
          workflowId: null,
          extractionHint: intent.extractionHint || null
        }).catch((error) => {
          console.warn('[Backend][aiBrowserAgent] extraction on done failed, returning empty:', error.message);
          return { data: [], confidence: 0, method: 'error', truncated: false, totalFound: 0 };
        });
        return finalInfo({ success: true, stopped: false, stopReason: null, message: null, extraction });
      }
      if (action.action === 'stop') {
        return finalInfo({ success: false, stopped: true, stopReason: 'model_stop', message: action.reason || 'The AI agent stopped before completing the task.' });
      }

      try {
        await executeAction(page, snapshot, action);
        steps.push(actionToRecordedEvent(action, snapshot));
      } catch (error) {
        if (error instanceof ActionExecutionError) {
          // Recoverable: the decided action was valid (a real ref, a
          // supported type) but couldn't actually be carried out right now
          // — reported back into history (annotating the same entry
          // history.push(action) already added above) so the NEXT
          // decideNextAction call sees exactly what failed and why, and can
          // choose a different element/action instead. Nothing is recorded
          // to `steps` since nothing actually happened on the page. Anything
          // else (an invalid ref, an unsupported action type, a navigation
          // failure) is a structural fault, not a "this element wasn't
          // interactable" fault, and still propagates fatally, unchanged.
          history[history.length - 1] = { ...action, outcome: 'failed', error: error.message };
          continue;
        }
        throw error;
      }
    }

    return finalInfo({ success: false, stopped: true, stopReason: 'max_steps_exceeded', message: `Stopped after ${maxSteps} steps without the task being marked done.` });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};

module.exports = { runBrowserAgent, BrowserAgentError, ActionExecutionError, DEFAULT_MAX_STEPS };
