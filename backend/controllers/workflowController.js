// Using the rule-based parameterizer for now to avoid requiring Anthropic API
// billing/setup at this stage. services/workflowParameterizer.js (LLM-based)
// is left in place, unused, in case we switch back later.
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { saveWorkflow, getWorkflow, listWorkflows } = require('../services/workflowStore');
const { runWorkflow } = require('../services/replayEngine');
const { buildMyApiRecord } = require('./myApisController');

const parameterize = (req, res) => {
  try {
    const events = req.body?.events;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: 'Request body must include a non-empty "events" array.' });
    }

    const result = parameterizeWorkflowRuleBased(events);
    const workflow = saveWorkflow({
      name: req.body?.name,
      description: req.body?.description,
      parameters: result.parameters,
      steps: result.steps,
      ownerId: req.user.id
    });

    // Mirror into the My APIs store so a recorded workflow shows up there
    // immediately — the two stores are otherwise unrelated.
    buildMyApiRecord({
      name: workflow.name,
      version: 'v1.0',
      method: 'POST',
      endpoint: `/api/workflows/${workflow.workflowId}/run`,
      parameters: workflow.parameters,
      ownerId: req.user.id
    });

    return res.json({ success: true, ...workflow });
  } catch (err) {
    console.error('[Backend] parameterize workflow failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to parameterize workflow.' });
  }
};

const list = (req, res) => {
  try {
    const own = listWorkflows().filter((workflow) => workflow.ownerId === req.user.id);
    return res.json({ success: true, workflows: own });
  } catch (err) {
    console.error('[Backend] list workflows failed', err);
    return res.status(500).json({ success: false, message: 'Failed to list workflows.' });
  }
};

const run = async (req, res) => {
  try {
    const { workflowId } = req.params;
    const workflow = getWorkflow(workflowId);

    if (!workflow) {
      return res.status(404).json({ success: false, message: `No saved workflow found for id "${workflowId}".` });
    }

    // Published (public) workflows are callable by anyone, per the
    // marketplace model — that's what "visible to everyone" means once an
    // API is published. A still-private workflow can only be run by its
    // owner; req.user is only populated here if a valid token was sent
    // (optionalAuth), so an anonymous or wrong-user request is rejected.
    const isOwner = req.user && req.user.id === workflow.ownerId;
    if (workflow.visibility !== 'public' && !isOwner) {
      return res.status(401).json({ success: false, message: 'This API is private. Log in as its owner to run it.' });
    }

    // The creator's own "Run API" click sends no body at all — every
    // parameter falls back to the value recorded when the workflow was made.
    // A marketplace buyer can instead supply some or all values; whatever
    // they provide overrides the default, anything they omit still falls
    // back the same way. Same merge, same endpoint, no separate code path
    // for "creator" vs "buyer" since there's no auth to tell them apart yet.
    const suppliedValues = req.body || {};
    const parameterValues = {};
    (workflow.parameters || []).forEach((param) => {
      parameterValues[param.name] = Object.prototype.hasOwnProperty.call(suppliedValues, param.name)
        ? suppliedValues[param.name]
        : param.defaultValue;
    });

    const result = await runWorkflow({ steps: workflow.steps, parameterValues });
    const skippedCount = result.skippedSteps?.length || 0;
    const message = skippedCount > 0
      ? `Workflow completed, but ${skippedCount} non-critical step${skippedCount === 1 ? '' : 's'} ${skippedCount === 1 ? 'was' : 'were'} skipped.`
      : 'Workflow completed successfully.';

    return res.json({ success: true, message, ...result });
  } catch (err) {
    console.error('[Backend] workflow run failed', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Workflow run failed.',
      stepIndex: err.stepIndex,
      stepType: err.stepType
    });
  }
};

module.exports = { parameterize, list, run };
