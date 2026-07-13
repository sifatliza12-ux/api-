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
// Real (non-test) runs of every workflow this user owns, regardless of who
// triggered each run — a creator's "Total API Runs" stat, i.e. how many
// times buyers (or the creator themselves) have actually executed their
// published APIs. Distinct from countByUser, which counts runs *this user
// triggered* on any workflow.
const countForOwnerStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM replay_runs r
  JOIN workflows w ON w.id = r.workflow_id
  WHERE w.owner_id = ? AND r.is_test = 0
`);
// Same population as countForOwner (real, non-test runs of this owner's
// workflows) but the individual rows instead of just a count — powers the
// Creator Analytics "Recent Activity" feed's "API run" entries. Read-only;
// does not touch parameterize/run/test.
const listRecentForOwnerStmt = db.prepare(`
  SELECT r.created_at AS createdAt, r.success AS success, w.id AS workflowId, w.name AS workflowName
  FROM replay_runs r
  JOIN workflows w ON w.id = r.workflow_id
  WHERE w.owner_id = ? AND r.is_test = 0
  ORDER BY r.created_at DESC
  LIMIT ?
`);

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

const countForOwner = (ownerId) => countForOwnerStmt.get(ownerId).count;

const listRecentForOwner = (ownerId, limit = 8) => listRecentForOwnerStmt
  .all(ownerId, limit)
  .map((row) => ({
    workflowId: String(row.workflowId),
    workflowName: row.workflowName,
    createdAt: row.createdAt,
    success: Boolean(row.success)
  }));

module.exports = { logRun, countByUser, countForOwner, listRecentForOwner };
