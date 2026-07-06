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
const { buildDynamicClickUpgrade } = require('./ruleBasedParameterizer');

const PLACEHOLDER_PATTERN = /^\{\{.+\}\}$/;

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

  const nextSteps = (steps || []).map((step) => {
    // Already semantic (recorded fresh, or upgraded on a previous load) —
    // never re-classify. Re-running classification on an already-upgraded
    // step could relabel it, which breaks the "stable schema across runs"
    // guarantee the rest of the system relies on.
    if (step.type === 'calendar_date' || step.type === 'dynamic_click') {
      return step;
    }

    let workingStep = step;
    const synthesizedLocators = synthesizeLegacyLocators(step);
    if (synthesizedLocators) {
      workingStep = { ...step, locators: synthesizedLocators };
      changed = true;
    }

    if (workingStep.type !== 'click' && workingStep.type !== 'dblclick') {
      return workingStep;
    }

    const upgrade = buildDynamicClickUpgrade(workingStep, dynamicCountByPrefix, usedNames);
    if (!upgrade) {
      return workingStep;
    }

    usedNames.add(upgrade.parameter.name);
    nextParameters.push(upgrade.parameter);
    changed = true;
    return upgrade.step;
  });

  if (!changed) {
    return null;
  }

  return { steps: nextSteps, parameters: nextParameters };
};

module.exports = { upgradeLegacyWorkflow };
