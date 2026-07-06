const db = require('../../db');

// One canonical field-name list per workflow, keyed by workflow_id (see
// extraction_schemas table in db/index.js). This is what makes repeated
// /run calls against the same workflow return the same JSON keys even
// though each replay re-infers field names from scratch — see
// extraction/index.js's reconcileSchema for how a fresh inference gets
// merged against what's stored here.
const getStmt = db.prepare('SELECT field_names FROM extraction_schemas WHERE workflow_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO extraction_schemas (workflow_id, field_names, sample_count, updated_at)
  VALUES (@workflowId, @fieldNames, 1, @updatedAt)
  ON CONFLICT(workflow_id) DO UPDATE SET
    field_names = @fieldNames,
    sample_count = sample_count + 1,
    updated_at = @updatedAt
`);

const getSchema = (workflowId) => {
  if (!workflowId) return null;
  const row = getStmt.get(Number(workflowId));
  return row ? JSON.parse(row.field_names) : null;
};

const saveSchema = (workflowId, fieldNames) => {
  if (!workflowId) return;
  upsertStmt.run({
    workflowId: Number(workflowId),
    fieldNames: JSON.stringify(fieldNames),
    updatedAt: new Date().toISOString()
  });
};

module.exports = { getSchema, saveSchema };
