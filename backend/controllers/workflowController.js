// Using the rule-based parameterizer for now to avoid requiring Anthropic API
// billing/setup at this stage. services/workflowParameterizer.js (LLM-based)
// is left in place, unused, in case we switch back later.
const { parameterizeWorkflowRuleBased } = require('../services/ruleBasedParameterizer');
const { buildApiDescription } = require('../services/apiDescriptionBuilder');
const { saveWorkflow, getWorkflow, listWorkflows, setExtractionHint } = require('../services/workflowStore');
const { runWorkflow } = require('../services/replayEngine');
const { logRun, countForOwner } = require('../services/replayRunStore');
const { buildMyApiRecord } = require('./myApisController');

const parameterize = (req, res) => {
  try {
    const events = req.body?.events;
    console.log('[Backend][pipeline] POST /api/workflows/parameterize received', {
      userId: req.user?.id,
      eventCount: Array.isArray(events) ? events.length : 0
    });

    if (!Array.isArray(events) || events.length === 0) {
      console.warn('[Backend][pipeline] FAILED at request validation: no events in request body');
      return res.status(400).json({ success: false, message: 'Request body must include a non-empty "events" array.' });
    }

    const result = parameterizeWorkflowRuleBased(events);
    const description = req.body?.description || buildApiDescription(result);
    const workflow = saveWorkflow({
      name: req.body?.name,
      description,
      parameters: result.parameters,
      steps: result.steps,
      ownerId: req.user.id
    });
    console.log('[Backend][pipeline] step 5: API object generated', { workflowId: workflow.workflowId, name: workflow.name, ownerId: workflow.ownerId });

    // Mirror into the My APIs store so a recorded workflow shows up there
    // immediately — the two stores are otherwise unrelated.
    const myApiRecord = buildMyApiRecord({
      name: workflow.name,
      description: workflow.description,
      version: 'v1.0',
      method: 'POST',
      endpoint: `/api/workflows/${workflow.workflowId}/run`,
      parameters: workflow.parameters,
      price: workflow.price,
      ownerId: req.user.id,
      workflowId: workflow.workflowId
    });
    console.log('[Backend][pipeline] step 6: saved to My APIs store', { id: myApiRecord.id, ownerId: myApiRecord.ownerId, endpoint: myApiRecord.endpoint });

    return res.json({ success: true, ...workflow });
  } catch (err) {
    console.error('[Backend][pipeline] FAILED with an exception', err);
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

// Shared by run and test: executes the workflow with the given parameter
// values, logs the outcome to replay_runs (new — this is the "replay
// metadata" that never used to be persisted anywhere), and sends the
// response. The only difference between the two callers is which values get
// passed in and the isTest flag.
const executeAndRespond = async ({ res, workflow, parameterValues, isTest, triggeredByUserId }) => {
  try {
    const result = await runWorkflow({
      steps: workflow.steps,
      parameterValues,
      workflowId: workflow.workflowId,
      extractionHint: workflow.extractionHint
    });
    const skippedCount = result.skippedSteps?.length || 0;
    const message = skippedCount > 0
      ? `Workflow completed, but ${skippedCount} non-critical step${skippedCount === 1 ? '' : 's'} ${skippedCount === 1 ? 'was' : 'were'} skipped.`
      : 'Workflow completed successfully.';

    logRun({
      workflowId: workflow.workflowId,
      triggeredByUserId,
      isTest,
      success: true,
      message,
      finalUrl: result.finalUrl,
      finalTitle: result.finalTitle,
      skippedSteps: result.skippedSteps,
      stepLog: result.stepLog,
      extractionMethod: result.extractionMethod
    });

    // parameterValues is the already-resolved merge (supplied override ->
    // recorded default) that was actually substituted into the replay steps
    // — exactly what "parametersApplied" needs to reflect, not the raw
    // request body a caller sent.
    return res.json({ success: true, message, ...result, parametersApplied: parameterValues });
  } catch (err) {
    console.error('[Backend] workflow run failed', err);

    logRun({
      workflowId: workflow.workflowId,
      triggeredByUserId,
      isTest,
      success: false,
      message: err.message || 'Workflow run failed.',
      stepLog: err.stepLog
    });

    return res.status(500).json({
      success: false,
      message: err.message || 'Workflow run failed.',
      stepIndex: err.stepIndex,
      stepType: err.stepType
    });
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
    // marketplace model — that's what "visible to everyone" means once an API
    // is published. A still-private workflow can only be run by its owner;
    // req.user is only populated here if a valid token was sent (optionalAuth),
    // so an anonymous or wrong-user request is rejected.
    const isOwner = req.user && req.user.id === workflow.ownerId;
    if (workflow.visibility !== 'public' && !isOwner) {
      return res.status(401).json({ success: false, message: 'This API is private. Log in as its owner to run it.' });
    }

    // This is the endpoint a buyer calls: whatever they supply overrides the
    // recorded default, anything they omit still falls back to it.
    const suppliedValues = req.body || {};
    const parameterValues = {};
    (workflow.parameters || []).forEach((param) => {
      parameterValues[param.name] = Object.prototype.hasOwnProperty.call(suppliedValues, param.name)
        ? suppliedValues[param.name]
        : param.defaultValue;
    });

    return await executeAndRespond({ res, workflow, parameterValues, isTest: false, triggeredByUserId: req.user?.id ?? null });
  } catch (err) {
    // Without this, a synchronous throw in an async route handler (e.g. a
    // corrupted stored row) becomes an unhandled promise rejection — Express
    // never awaits/catches what a handler returns — which crashes the whole
    // Node process on modern Node versions instead of failing just this
    // request. See executeAndRespond's own try/catch for the same reasoning.
    console.error('[Backend] GET workflow for run failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to run workflow.' });
  }
};

// Owner-only: always replays with the workflow's own stored default values,
// ignoring anything in the request body, so it never depends on a buyer's
// input. Used while building/debugging, before an API is ever published —
// distinct from run, which is what a real caller (owner or buyer) uses.
const test = async (req, res) => {
  try {
    const { workflowId } = req.params;
    const workflow = getWorkflow(workflowId);

    if (!workflow || workflow.ownerId !== req.user.id) {
      return res.status(404).json({ success: false, message: `No saved workflow found for id "${workflowId}".` });
    }

    const parameterValues = {};
    (workflow.parameters || []).forEach((param) => {
      parameterValues[param.name] = param.defaultValue;
    });

    return await executeAndRespond({ res, workflow, parameterValues, isTest: true, triggeredByUserId: req.user.id });
  } catch (err) {
    console.error('[Backend] GET workflow for test failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to test workflow.' });
  }
};

// Owner-only, minimal write path for requirement 7: no dedicated UI for this
// yet, so a backend-only PATCH is what lets an owner tell the extraction
// pipeline "use this selector first" instead of relying purely on
// auto-detection. Passing selector: null clears a previously-set hint.
const updateExtractionHint = (req, res) => {
  try {
    const { workflowId } = req.params;
    const workflow = getWorkflow(workflowId);

    if (!workflow || workflow.ownerId !== req.user.id) {
      return res.status(404).json({ success: false, message: `No saved workflow found for id "${workflowId}".` });
    }

    const { selector } = req.body || {};
    if (selector !== null && typeof selector !== 'string') {
      return res.status(400).json({ success: false, message: 'Request body must include a "selector" string (or null to clear it).' });
    }

    const updated = setExtractionHint(workflowId, selector ? { selector } : null);
    return res.json({ success: true, workflow: updated });
  } catch (err) {
    console.error('[Backend] update extraction hint failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to update extraction hint.' });
  }
};

// Read-only aggregate for the Creator dashboard's "Total API Runs" stat —
// how many times *anyone* has actually run this creator's published
// workflows. Doesn't touch parameterize/run/test at all, just queries
// replay_runs (already written by executeAndRespond above).
const myRunStats = (req, res) => {
  try {
    return res.json({ success: true, totalRuns: countForOwner(req.user.id) });
  } catch (err) {
    console.error('[Backend] myRunStats failed', err);
    return res.status(500).json({ success: false, message: 'Failed to load run stats.' });
  }
};

module.exports = { parameterize, list, run, test, updateExtractionHint, myRunStats };
