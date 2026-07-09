const db = require('../db');

// "Replay metadata" — there was no persistent record of this before this
// migration; every run's result was only ever returned to the caller, never
// logged. isTest distinguishes an owner's Test API call (always uses stored
// defaults, never counts as a public execution) from a real Run API call.
// stepLog is the structured per-step diagnostic trail from replayEngine.js
// (locator strategy used, retry count, blockers cleared, failure reason) —
// exactly what's needed to tell "this site's selectors are drifting" apart
// from "this site is genuinely unsupported."
const insertStmt = db.prepare(`
  INSERT INTO replay_runs (workflow_id, triggered_by_user_id, is_test, success, message, final_url, final_title, skipped_steps, step_log, extraction_method, created_at)
  VALUES (@workflowId, @triggeredByUserId, @isTest, @success, @message, @finalUrl, @finalTitle, @skippedSteps, @stepLog, @extractionMethod, @createdAt)
`);
const countByUserStmt = db.prepare('SELECT COUNT(*) AS count FROM replay_runs WHERE triggered_by_user_id = ?');

const logRun = ({ workflowId, triggeredByUserId, isTest, success, message, finalUrl, finalTitle, skippedSteps, stepLog, extractionMethod }) => {
  insertStmt.run({
    workflowId: Number(workflowId),
    triggeredByUserId: triggeredByUserId ?? null,
    isTest: isTest ? 1 : 0,
    success: success ? 1 : 0,
    message: message || null,
    finalUrl: finalUrl || null,
    finalTitle: finalTitle || null,
    skippedSteps: JSON.stringify(skippedSteps || []),
    stepLog: JSON.stringify(stepLog || []),
    // Which extraction strategy produced the run's `data` (hint/dom/llm/none)
    // — kept alongside the run record so confidence-score debugging doesn't
    // require reproducing the run just to see which stage of the pipeline
    // fired. Null on runs from before this feature existed.
    extractionMethod: extractionMethod || null,
    createdAt: new Date().toISOString()
  });
};

// Counts every run this user has triggered (test runs on their own APIs and
// real Run API calls alike) — the simplest honest "usage" number available
// today, since no separate per-purchase run-tracking exists yet.
const countByUser = (userId) => countByUserStmt.get(userId).count;

module.exports = { logRun, countByUser };
