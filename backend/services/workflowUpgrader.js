// Retroactively upgrades a workflow recorded before dynamic-value detection
// existed — same idea as the ALTER TABLE / addColumnIfMissing pattern in
// db/index.js, just applied to the *content* of a workflow's steps instead
// of the database schema. Reuses buildDynamicClickUpgrade — the exact same
// classification + naming logic the live recorder pipeline uses — so a
// years-old recording and a workflow recorded five minutes ago get
// classified identically; nothing here duplicates that judgment call.
//
// Two independent upgrades happen per step, in order:
//   1. Synthesize a text-based fallback locator when one is missing
//      (requirement 8 — every step gets *some* fallback beyond a single
//      raw selector, even one recorded before content.js captured any).
//   2. Classify click/dblclick steps for dynamic values and, if matched,
//      rewrite them into calendar_date/dynamic_click steps + add a
//      parameter (requirements 1-3, 7) — using the ORIGINAL literal text,
//      captured in step 1 before this step replaces it with a placeholder.
const { buildDynamicClickUpgrade, extractPlaceholderName, linkUrlToPendingValue, linkAllUrlsToParameters, dedupeFieldParameters } = require('./ruleBasedParameterizer');

const PLACEHOLDER_PATTERN = /^\{\{.+\}\}$/;
const PLACEHOLDER_CAPTURE_PATTERN = /^\{\{(.+)\}\}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const escapeForCssAttr = (value) => String(value).replace(/["\\]/g, '\\$&');

const synthesizeLegacyLocators = (step) => {
  if (Array.isArray(step.locators) && step.locators.length) {
    return null; // Already has real candidates — nothing to synthesize.
  }

  const candidates = [];

  if (step.type === 'input' || step.type === 'change') {
    const fieldContext = step.meta?.fieldContext || {};
    if (fieldContext.label) candidates.push({ strategy: 'label', value: fieldContext.label });
    if (fieldContext.ariaLabel) candidates.push({ strategy: 'css', value: `[aria-label="${escapeForCssAttr(fieldContext.ariaLabel)}"]` });
    if (fieldContext.placeholder) candidates.push({ strategy: 'css', value: `[placeholder="${escapeForCssAttr(fieldContext.placeholder)}"]` });
    if (fieldContext.name) candidates.push({ strategy: 'css', value: `[name="${escapeForCssAttr(fieldContext.name)}"]` });
  } else if (step.type === 'click' || step.type === 'dblclick') {
    const text = typeof step.value === 'string' ? step.value.trim() : '';
    if (text && text.length <= 80 && !PLACEHOLDER_PATTERN.test(text)) {
      candidates.push({ strategy: 'text', value: text, tag: step.meta?.tag });
    }
  }

  return candidates.length ? candidates : null;
};

// Existing parameter names seed both the "don't collide" set and each
// dynamic-value kind's running counter, so upgrading a workflow that's
// already partially upgraded (or was hand-edited) continues numbering
// sensibly instead of restarting at 1 and colliding.
const seedNamingState = (parameters) => {
  const usedNames = new Set();
  const dynamicCountByPrefix = {};

  (parameters || []).forEach((param) => {
    usedNames.add(param.name);
    const match = param.name.match(/^([a-zA-Z]+?)(\d+)$/);
    if (match) {
      const prefix = match[1];
      const num = Number(match[2]);
      dynamicCountByPrefix[prefix] = Math.max(dynamicCountByPrefix[prefix] || 0, num);
    }
  });

  return { usedNames, dynamicCountByPrefix };
};

// Returns { steps, parameters } if anything was upgraded, or null if the
// workflow was already fully up to date — callers should skip writing back
// to storage in the null case.
const upgradeLegacyWorkflow = ({ steps, parameters }) => {
  const { usedNames, dynamicCountByPrefix } = seedNamingState(parameters);
  const nextParameters = [...(parameters || [])];
  let changed = false;

  // Same adjacency tracking as the live parameterizer (see
  // ruleBasedParameterizer.js's pendingInputParamName) — a legacy step's
  // input/change value is already a placeholder ("{{destination}}") from
  // whenever it was ORIGINALLY parameterized, so the name is extracted from
  // that rather than re-derived, but the "was this click typed right
  // before it" adjacency judgment is identical.
  let pendingInputParamName = null;
  let pendingInputSelector = null;
  let pendingInputValue = null;

  // A legacy input/change step's value is already a placeholder
  // ("{{destination}}"), not the raw typed text — this looks the original
  // text back up from the parameter's stored defaultValue, so the
  // looksLikePlausibleSuggestion text-overlap check has something real to
  // compare a candidate suggestion click against.
  const defaultValueByParamName = new Map((parameters || []).map((p) => [p.name, p.defaultValue]));

  const nextSteps = (steps || []).map((step) => {
    // Already semantic (recorded fresh, or upgraded on a previous load) —
    // never re-classify. Re-running classification on an already-upgraded
    // step could relabel it, which breaks the "stable schema across runs"
    // guarantee the rest of the system relies on. It still originated from
    // a click though, so the pending adjacency slot must be cleared here
    // too — otherwise, on every load *after* the first upgrade, this early
    // return skips the reset that a freshly-classified click would have
    // done, and a stale link from an earlier field leaks into the next
    // unrelated click.
    if (step.type === 'calendar_date' || step.type === 'dynamic_click') {
      // Already semantic, but still carries the same "this is what the live
      // parameter produced" signal a fresh dynamic_click does — a click many
      // steps back may have already been upgraded on a prior pass, and a
      // navigation/new_page step further down still needs to see it.
      const resolvedParamName = extractPlaceholderName(step.value);
      pendingInputParamName = resolvedParamName;
      pendingInputSelector = null;
      pendingInputValue = resolvedParamName ? (defaultValueByParamName.get(resolvedParamName) ?? null) : null;

      // Repairs a defaultValue data-quality bug from an earlier version of
      // classifyDynamicClick: a bare visible day number ("31") could win
      // over the calendar widget's own machine-readable date (meta.dateAttr,
      // "2026-07-31") when this step was first classified. That's not just
      // cosmetic — it's an invalid value for a date input to show a buyer,
      // and unparseable by parseTargetDate at replay time whenever no
      // override is supplied (new Date("31") is Invalid Date). This never
      // re-classifies the step itself (still skipped, per the guard above),
      // just corrects the parameter's stored default when a real ISO date
      // is available and the current one isn't already one.
      if (step.type === 'calendar_date' && resolvedParamName && step.meta?.dateAttr && ISO_DATE_PATTERN.test(step.meta.dateAttr)) {
        const paramIndex = nextParameters.findIndex((p) => p.name === resolvedParamName);
        if (paramIndex !== -1 && !ISO_DATE_PATTERN.test(String(nextParameters[paramIndex].defaultValue)) && nextParameters[paramIndex].defaultValue !== step.meta.dateAttr) {
          nextParameters[paramIndex] = { ...nextParameters[paramIndex], defaultValue: step.meta.dateAttr };
          changed = true;
        }
      }

      return step;
    }

    let workingStep = step;
    const synthesizedLocators = synthesizeLegacyLocators(step);
    if (synthesizedLocators) {
      workingStep = { ...step, locators: synthesizedLocators };
      changed = true;
    }

    if (workingStep.type === 'input' || workingStep.type === 'change') {
      const match = typeof workingStep.value === 'string' ? workingStep.value.match(PLACEHOLDER_CAPTURE_PATTERN) : null;
      if (match && workingStep.selector !== pendingInputSelector) {
        pendingInputParamName = match[1];
        pendingInputSelector = workingStep.selector;
        pendingInputValue = defaultValueByParamName.get(match[1]) ?? null;
      }
      return workingStep;
    }

    if (workingStep.type === 'navigation' || workingStep.type === 'new_page') {
      // Same gap as the live parameterizer closes (see the matching branch
      // in ruleBasedParameterizer.js): a value typed/clicked right before a
      // navigation often survives verbatim into the URL it lands on (a
      // search engine's "?q=", a site's own "?search="), but a navigation
      // triggered by Enter/native form submit has no click event of its own
      // to link from — so a legacy recording froze that URL as a literal
      // forever. Link it retroactively here, exactly like a fresh recording
      // would today.
      const urlField = workingStep.type === 'navigation' ? 'value' : 'url';
      const rawUrl = workingStep[urlField];
      const linkedUrl = pendingInputParamName
        ? linkUrlToPendingValue(rawUrl, pendingInputParamName, pendingInputValue)
        : null;

      pendingInputParamName = null;
      pendingInputSelector = null;
      pendingInputValue = null;

      if (linkedUrl) {
        changed = true;
        return { ...workingStep, [urlField]: linkedUrl };
      }
      return workingStep;
    }

    if (workingStep.type === 'keydown') {
      // Enter submitting the field just typed into carries the same
      // live-value signal a click does — see the matching branch in
      // ruleBasedParameterizer.js. Preserved only when it fired on the
      // field currently pending.
      if (workingStep.selector !== pendingInputSelector) {
        pendingInputParamName = null;
        pendingInputValue = null;
      }
      pendingInputSelector = null;
      return workingStep;
    }

    if (workingStep.type !== 'click' && workingStep.type !== 'dblclick') {
      // Any other step type (scroll, touch, ...) closes the adjacency
      // window just like a click would — see the matching comment in
      // ruleBasedParameterizer.js. Without this, a click many steps later
      // (after scrolling off to browse something unrelated) could inherit a
      // stale link to a field typed into long before it.
      pendingInputParamName = null;
      pendingInputSelector = null;
      pendingInputValue = null;
      return workingStep;
    }

    const upgrade = buildDynamicClickUpgrade(workingStep, dynamicCountByPrefix, usedNames, { relatedParamName: pendingInputParamName, relatedParamValue: pendingInputValue });

    const resolvedParamName = upgrade ? extractPlaceholderName(upgrade.step.value) : null;
    pendingInputParamName = resolvedParamName;
    pendingInputSelector = null;
    pendingInputValue = resolvedParamName && typeof workingStep.value === 'string' ? workingStep.value.trim() : null;

    if (!upgrade) {
      return workingStep;
    }

    if (upgrade.parameter) {
      usedNames.add(upgrade.parameter.name);
      nextParameters.push(upgrade.parameter);
    }
    changed = true;
    return upgrade.step;
  });

  // Retroactive pass for the SAME field-value duplication ruleBasedParameterizer.js
  // now prevents at recording time: an already-saved workflow may still carry
  // two parameters for one real field (a browser's 'input' and its native
  // 'change', each independently parameterized before this fold existed).
  // eventIndex positions are unaffected by everything above (each step maps
  // 1:1, in place, into nextSteps), so they're still valid against nextSteps.
  const deduped = dedupeFieldParameters(nextParameters, nextSteps);
  if (deduped.parameters.length !== nextParameters.length) {
    changed = true;
  }

  // Same non-adjacency URL sweep the live parameterizer now runs (see
  // ruleBasedParameterizer.js) — this is what lets an ALREADY-stored
  // workflow (recorded before this pass existed, or whose per-step adjacency
  // window closed before reaching its navigation, e.g. two calendar-date
  // picks followed by a few unrelated clicks/scrolls before "Search") get
  // its checkin/checkout-shaped URLs linked retroactively, the next time
  // getWorkflow() loads it — no re-recording required.
  const urlLinked = linkAllUrlsToParameters(deduped.steps, deduped.parameters);
  if (urlLinked.changed) {
    changed = true;
  }

  if (!changed) {
    return null;
  }

  return { steps: urlLinked.steps, parameters: deduped.parameters };
};

module.exports = { upgradeLegacyWorkflow };
