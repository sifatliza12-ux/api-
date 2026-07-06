const db = require('../db');
const { upgradeLegacyWorkflow } = require('./workflowUpgrader');

// SQLite-backed now (was an in-memory Map). ownerId is set from the
// authenticated creator (see workflowController.js); visibility starts
// 'private' and only flips to 'public' when the linked My APIs record is
// published (see myApisController.publishMyApi), which is also what
// workflowController.run checks before allowing a non-owner to execute it.
//
// The row's real primary key is an autoincrementing integer (`id`), never
// reused even after a delete — but every existing caller in this codebase
// treats workflowId as an opaque string (it always was `String(nextId++)`
// before this migration), so that's preserved exactly at this module's
// boundary: everything in and out of this file uses the string form.
const rowToWorkflow = (row) => row && ({
  workflowId: String(row.id),
  name: row.name,
  description: row.description || '',
  parameters: JSON.parse(row.parameters),
  steps: JSON.parse(row.steps),
  ownerId: row.owner_id,
  visibility: row.visibility,
  price: row.price,
  // Optional {selector: "..."} config — a CSS selector for the repeating
  // result container, checked first by the extraction pipeline before it
  // falls back to auto-detection. Null on every workflow until an owner
  // explicitly sets one via PATCH /:workflowId/extraction-hint.
  extractionHint: row.extraction_hint ? JSON.parse(row.extraction_hint) : null,
  createdAt: row.created_at
});

const insertStmt = db.prepare(`
  INSERT INTO workflows (owner_id, name, description, parameters, steps, visibility, price, extraction_hint, created_at)
  VALUES (@ownerId, @name, @description, @parameters, @steps, @visibility, @price, @extractionHint, @createdAt)
`);
const getStmt = db.prepare('SELECT * FROM workflows WHERE id = ?');
const listStmt = db.prepare('SELECT * FROM workflows');
const setVisibilityStmt = db.prepare('UPDATE workflows SET visibility = ? WHERE id = ?');
const setExtractionHintStmt = db.prepare('UPDATE workflows SET extraction_hint = ? WHERE id = ?');
const upgradeStepsStmt = db.prepare('UPDATE workflows SET steps = ?, parameters = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM workflows WHERE id = ?');

const saveWorkflow = (data) => {
  const result = insertStmt.run({
    ownerId: data.ownerId ?? null,
    name: data.name || 'Untitled Workflow',
    description: data.description || '',
    parameters: JSON.stringify(data.parameters || []),
    steps: JSON.stringify(data.steps || []),
    visibility: data.visibility || 'private',
    price: data.price ?? 0,
    extractionHint: data.extractionHint ? JSON.stringify(data.extractionHint) : null,
    createdAt: new Date().toISOString()
  });

  return rowToWorkflow(getStmt.get(result.lastInsertRowid));
};

// Lazily upgrades a workflow recorded before dynamic-value detection existed
// (hardcoded calendar dates/prices/etc. baked into literal selectors — see
// workflowUpgrader.js) the first time it's loaded after this feature shipped,
// persisting the upgrade so it only ever runs once per workflow rather than
// re-classifying on every single run/test call. Requirement: "existing
// workflows should be upgraded where reasonably possible instead of
// requiring users to re-record everything."
const getWorkflow = (workflowId) => {
  const workflow = rowToWorkflow(getStmt.get(Number(workflowId)));
  if (!workflow) {
    return null;
  }

  const upgraded = upgradeLegacyWorkflow({ steps: workflow.steps, parameters: workflow.parameters });
  if (!upgraded) {
    return workflow;
  }

  upgradeStepsStmt.run(JSON.stringify(upgraded.steps), JSON.stringify(upgraded.parameters), Number(workflowId));
  return { ...workflow, steps: upgraded.steps, parameters: upgraded.parameters };
};

const listWorkflows = () => listStmt.all().map(rowToWorkflow);

const setVisibility = (workflowId, visibility) => {
  const info = setVisibilityStmt.run(visibility, Number(workflowId));
  if (info.changes === 0) {
    return null;
  }
  return getWorkflow(workflowId);
};

const setExtractionHint = (workflowId, hint) => {
  const info = setExtractionHintStmt.run(hint ? JSON.stringify(hint) : null, Number(workflowId));
  if (info.changes === 0) {
    return null;
  }
  return getWorkflow(workflowId);
};

const deleteWorkflow = (workflowId) => {
  const info = deleteStmt.run(Number(workflowId));
  return info.changes > 0;
};

module.exports = { saveWorkflow, getWorkflow, listWorkflows, setVisibility, setExtractionHint, deleteWorkflow };
