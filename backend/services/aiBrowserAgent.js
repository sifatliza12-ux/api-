// AI API Creator's browser agent (V2 Phase 2) — the file replayEngine.js and
// pageSnapshotBuilder.js both already name as their intended caller. Drives
// a live Playwright page toward a confirmed intent by repeatedly asking the
// active AIProvider's decideNextAction "what's the single next action?",
// executing it, and recording it as a workflow step — until the model
// reports "done" (success), "stop" (model gave up), or maxSteps is reached.
//
// Deliberately NOT a rewrite of replayEngine.js: this reuses its four
// exported helpers (locatorFromCandidate, dismissCommonOverlays,
// waitForPageStability, getStructuralCandidates isn't needed here) instead
// of reimplementing element resolution, and produces steps in exactly the
// shape runWorkflow already consumes — the resulting workflow is replayed
// by the existing engine unchanged, not by any code in this file. The
// retry/recovery machinery inside runWorkflow (performWithRetry etc.) isn't
// reused because it isn't exported (see replayEngine.js's own comment on
// why) and isn't needed here anyway: a live agent re-observes the real page
// every single step via a fresh snapshot, so it doesn't need blind retries
// against a possibly-stale element the way replaying a recorded step does.
const { chromium } = require('playwright');
const { buildPageSnapshot } = require('./pageSnapshotBuilder');
const { detectPageBlock } = require('./antiBotDetector');
const { locatorFromCandidate, dismissCommonOverlays, waitForPageStability } = require('./replayEngine');
const { getProvider } = require('./aiProviders');

class BrowserAgentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BrowserAgentError';
    this.details = details;
  }
}

// Small enough that a runaway/looping model can't drive a single request
// forever, generous enough for a real multi-field form + submit + result
// page. Overridable per call for tests, not via env — this bounds a single
// live browser session's cost, not a deployment-wide setting.
const DEFAULT_MAX_STEPS = 20;
const ACTION_TIMEOUT_MS = 10000;

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

// Resolves a decideNextAction ref back to a live Playwright Locator by
// walking the SAME element's locators array pageSnapshotBuilder built for
// it (in priority order), same interop contract pageSnapshotBuilder.test.js
// already proves against replayEngine.locatorFromCandidate. Throws rather
// than guessing if every candidate fails to resolve to anything currently
// on the page — the page may have changed between the snapshot and now.
const resolveElementLocator = async (page, snapshot, ref) => {
  const element = (snapshot.elements || []).find((el) => el.ref === ref);
  if (!element) {
    throw new BrowserAgentError(`Ref "${ref}" is not present in the current snapshot.`);
  }

  for (const candidate of element.locators || []) {
    try {
      const locator = locatorFromCandidate(page, candidate).first();
      if (await locator.count() > 0) {
        return locator;
      }
    } catch (error) {
      // This candidate didn't resolve — fall through to the next one.
    }
  }
  throw new BrowserAgentError(`Could not resolve any locator for ref "${ref}" against the live page.`, { element });
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
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
      break;
    }
    case 'input':
    case 'change': {
      const locator = await resolveElementLocator(page, snapshot, action.ref);
      await locator.fill(action.value || '', { timeout: ACTION_TIMEOUT_MS });
      break;
    }
    case 'keydown': {
      const locator = await resolveElementLocator(page, snapshot, action.ref);
      await locator.press(action.value || 'Enter', { timeout: ACTION_TIMEOUT_MS });
      break;
    }
    default:
      throw new BrowserAgentError(`"${action.action}" is not an executable action.`);
  }

  await waitForPageStability(page, 3000);
  await dismissCommonOverlays(page).catch(() => null);
};

// Converts one executed action into a step in exactly the shape
// replayEngine.runWorkflow's `switch (step.type)` consumes (see that file's
// 'navigation'/'click'/'input'/'change'/'keydown' cases), so the workflow
// this produces is replayable by the existing engine completely unchanged.
// calendar_date is recorded as a plain 'click' on the same resolved element
// — replaying the literal day cell the agent found beats reinvoking
// runWorkflow's month-navigation search logic (performCalendarDateClick),
// which exists to relocate a date BLIND from a recorded selector; this step
// already carries the live element's own locators, so that search has
// nothing to add.
const actionToWorkflowStep = (action, snapshot) => {
  if (action.action === 'navigation') {
    return { type: 'navigation', value: action.value };
  }

  const element = (snapshot.elements || []).find((el) => el.ref === action.ref);
  const type = action.action === 'calendar_date' ? 'click' : action.action;
  return {
    type,
    value: action.value ?? null,
    locators: element?.locators || [],
    meta: { tag: element?.tag || null }
  };
};

// Runs the agent loop to completion (done/stop/blocked/maxSteps) and
// returns a result — never throws for an ordinary in-page failure (a
// blocked page, the model stopping, running out of steps); only throws
// BrowserAgentError for a genuine execution fault (bad ref, navigation
// error, unresolvable locator) since those mean the run can't be trusted to
// continue safely.
//
// `page`, when provided, is used as-is and its browser/context lifecycle is
// the CALLER's responsibility (matches buildPageSnapshot's own convention,
// and lets tests drive a single shared page via data: URLs). When omitted,
// this function launches and closes its own browser, matching runWorkflow's
// self-contained convention for real callers (i.e. the controller).
// `decideNextAction`, when provided, overrides the active AIProvider's
// implementation — used by tests to script a deterministic decision
// sequence without depending on a real model.
const runBrowserAgent = async ({ intent, maxSteps = DEFAULT_MAX_STEPS, page: injectedPage, decideNextAction: injectedDecideNextAction } = {}) => {
  if (!intent || typeof intent !== 'object') {
    throw new BrowserAgentError('runBrowserAgent requires a structured intent.');
  }

  const decide = injectedDecideNextAction || getProvider().decideNextAction;

  let browser = null;
  let page = injectedPage;

  try {
    if (!page) {
      browser = await chromium.launch({ headless: HEADLESS, args: HEADLESS ? CONTAINER_LAUNCH_ARGS : ['--start-maximized'] });
      const context = await browser.newContext({ viewport: HEADLESS ? { width: 1280, height: 720 } : null });
      page = await context.newPage();
    }

    const startUrl = intent.targetSite?.url;
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
      await waitForPageStability(page, 3000);
      await dismissCommonOverlays(page).catch(() => null);
    }

    const history = [];
    const steps = [];
    const finalInfo = async (extra) => ({
      steps,
      history,
      finalUrl: page.url(),
      finalTitle: await page.title().catch(() => ''),
      ...extra
    });

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const block = await detectPageBlock(page).catch(() => ({ blocked: false }));
      if (block.blocked) {
        return finalInfo({ success: false, stopped: true, stopReason: block.reason, message: block.message });
      }

      const snapshot = await buildPageSnapshot(page);
      const action = await decide(snapshot, intent, history);
      history.push(action);

      if (action.action === 'done') {
        return finalInfo({ success: true, stopped: false, stopReason: null, message: null });
      }
      if (action.action === 'stop') {
        return finalInfo({ success: false, stopped: true, stopReason: 'model_stop', message: action.reason || 'The AI agent stopped before completing the task.' });
      }

      await executeAction(page, snapshot, action);
      steps.push(actionToWorkflowStep(action, snapshot));
    }

    return finalInfo({ success: false, stopped: true, stopReason: 'max_steps_exceeded', message: `Stopped after ${maxSteps} steps without the task being marked done.` });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};

module.exports = { runBrowserAgent, BrowserAgentError, DEFAULT_MAX_STEPS };
