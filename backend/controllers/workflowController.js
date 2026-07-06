// Using the rule-based parameterizer for now to avoid requiring Anthropic API
// billing/setup at this stage. services/workflowParameterizer.js (LLM-based)
// is left in place, unused, in case we switch back later.
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { saveWorkflow, getWorkflow, listWorkflows } = require('../services/workflowStore');
const { runWorkflow } = require('../services/replayEngine');

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
      steps: result.steps
    });

    return res.json({ success: true, ...workflow });
  } catch (err) {
    console.error('[Backend] parameterize workflow failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to parameterize workflow.' });
  }
};

const list = (req, res) => {
  try {
    return res.json({ success: true, workflows: listWorkflows() });
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

    const parameterValues = req.body || {};
    const result = await runWorkflow({ steps: workflow.steps, parameterValues });
    return res.json({ success: true, ...result });
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
