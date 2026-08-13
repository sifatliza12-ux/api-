const db = require('../db');

// SQLite-backed store for the AI API Creator's chat sessions (V2). Mirrors
// the workflowStore.js / myApisStore.js pattern: thin functions wrapping
// prepared statements, camelCase in/out, no concept of "the current
// request" (that's the controller's job, once one exists).
const STATUSES = Object.freeze([
  'created',
  'parsing',
  'awaiting_confirmation',
  'generating',
  'testing',
  'completed',
  'failed',
  'cancelled'
]);

const rowToSession = (row) => row && ({
  id: row.id,
  ownerId: row.owner_id,
  status: row.status,
  nlCommand: row.nl_command,
  chatMessages: JSON.parse(row.chat_messages),
  generatedWorkflowId: row.generated_workflow_id === null ? null : String(row.generated_workflow_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const insertStmt = db.prepare(`
  INSERT INTO ai_creation_sessions (owner_id, status, nl_command, chat_messages, generated_workflow_id, created_at, updated_at)
  VALUES (@ownerId, @status, @nlCommand, @chatMessages, @generatedWorkflowId, @createdAt, @updatedAt)
`);
const getByIdStmt = db.prepare('SELECT * FROM ai_creation_sessions WHERE id = ?');
const listByOwnerStmt = db.prepare('SELECT * FROM ai_creation_sessions WHERE owner_id = ? ORDER BY created_at DESC');
const setStatusStmt = db.prepare('UPDATE ai_creation_sessions SET status = ?, updated_at = ? WHERE id = ?');
const setChatMessagesStmt = db.prepare('UPDATE ai_creation_sessions SET chat_messages = ?, updated_at = ? WHERE id = ?');
const setGeneratedWorkflowStmt = db.prepare('UPDATE ai_creation_sessions SET generated_workflow_id = ?, updated_at = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM ai_creation_sessions WHERE id = ?');

const create = ({ ownerId, nlCommand, chatMessages = [] }) => {
  const now = new Date().toISOString();
  const result = insertStmt.run({
    ownerId,
    status: 'created',
    nlCommand,
    chatMessages: JSON.stringify(chatMessages),
    generatedWorkflowId: null,
    createdAt: now,
    updatedAt: now
  });

  return rowToSession(getByIdStmt.get(result.lastInsertRowid));
};

const getById = (id) => rowToSession(getByIdStmt.get(Number(id))) || null;

const listByOwner = (ownerId) => listByOwnerStmt.all(ownerId).map(rowToSession);

const setStatus = (id, status) => {
  if (!STATUSES.includes(status)) {
    throw new Error(`Unknown AI creation session status: ${status}`);
  }
  const info = setStatusStmt.run(status, new Date().toISOString(), Number(id));
  if (info.changes === 0) {
    return null;
  }
  return getById(id);
};

// Read-modify-write, same trade-off replayRunStore/notificationStore make
// elsewhere in this codebase: better-sqlite3 is synchronous, so there's no
// concurrent-write race within a single Node process to guard against here.
const appendMessage = (id, message) => {
  const session = getById(id);
  if (!session) {
    return null;
  }
  const chatMessages = [...session.chatMessages, message];
  setChatMessagesStmt.run(JSON.stringify(chatMessages), new Date().toISOString(), Number(id));
  return getById(id);
};

const setGeneratedWorkflow = (id, workflowId) => {
  const info = setGeneratedWorkflowStmt.run(workflowId ? Number(workflowId) : null, new Date().toISOString(), Number(id));
  if (info.changes === 0) {
    return null;
  }
  return getById(id);
};

const deleteById = (id) => {
  const info = deleteStmt.run(Number(id));
  return info.changes > 0;
};

module.exports = {
  STATUSES,
  create,
  getById,
  listByOwner,
  setStatus,
  appendMessage,
  setGeneratedWorkflow,
  deleteById
};
