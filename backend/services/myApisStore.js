const db = require('../db');

// SQLite-backed now (was a plain array manipulated directly inside
// myApisController.js). This module owns the storage; the controller stays
// a thin HTTP layer on top, matching the pattern workflowStore.js already
// established elsewhere in this backend. Ownership checks (is this the
// requester's own record?) are deliberately left to the controller, same as
// workflowController.js does for workflows — this module has no concept of
// "the current request."
const rowToMyApi = (row) => row && ({
  id: row.id,
  ownerId: row.owner_id,
  workflowId: row.workflow_id === null ? null : String(row.workflow_id),
  name: row.name,
  version: row.version,
  method: row.method,
  endpoint: row.endpoint,
  generatedCode: row.generated_code || '',
  description: row.description || '',
  parameters: JSON.parse(row.parameters),
  price: row.price,
  published: Boolean(row.published),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const insertStmt = db.prepare(`
  INSERT INTO my_apis (owner_id, workflow_id, name, version, method, endpoint, generated_code, description, parameters, price, published, created_at, updated_at)
  VALUES (@ownerId, @workflowId, @name, @version, @method, @endpoint, @generatedCode, @description, @parameters, @price, @published, @createdAt, @updatedAt)
`);
const getByIdStmt = db.prepare('SELECT * FROM my_apis WHERE id = ?');
const listByOwnerStmt = db.prepare('SELECT * FROM my_apis WHERE owner_id = ? ORDER BY created_at DESC');
const countByOwnerStmt = db.prepare('SELECT COUNT(*) AS count FROM my_apis WHERE owner_id = ?');
const deleteByIdStmt = db.prepare('DELETE FROM my_apis WHERE id = ?');
const setPublishedStmt = db.prepare('UPDATE my_apis SET published = ?, updated_at = ? WHERE id = ?');

const create = (payload = {}) => {
  const now = new Date().toISOString();
  const result = insertStmt.run({
    ownerId: payload.ownerId ?? null,
    workflowId: payload.workflowId ? Number(payload.workflowId) : null,
    name: payload.name || 'Untitled API',
    version: payload.version || 'v1.0',
    method: payload.method || 'POST',
    endpoint: payload.endpoint || '/api/v1/unknown',
    generatedCode: payload.generatedCode || '',
    description: payload.description || '',
    parameters: JSON.stringify(Array.isArray(payload.parameters) ? payload.parameters : []),
    price: payload.price ?? 0,
    published: payload.published ? 1 : 0,
    createdAt: now,
    updatedAt: now
  });

  return rowToMyApi(getByIdStmt.get(result.lastInsertRowid));
};

const getById = (id) => rowToMyApi(getByIdStmt.get(Number(id))) || null;

const listByOwner = (ownerId) => listByOwnerStmt.all(ownerId).map(rowToMyApi);

const countByOwner = (ownerId) => countByOwnerStmt.get(ownerId).count;

const deleteById = (id) => {
  const info = deleteByIdStmt.run(Number(id));
  return info.changes > 0;
};

const setPublished = (id, published) => {
  const info = setPublishedStmt.run(published ? 1 : 0, new Date().toISOString(), Number(id));
  if (info.changes === 0) {
    return null;
  }
  return getById(id);
};

module.exports = { create, getById, listByOwner, countByOwner, deleteById, setPublished };
