const bcrypt = require('bcrypt');
const db = require('../db');

// SQLite-backed now (was an in-memory Map) — better-sqlite3 is synchronous,
// so every function here keeps the exact same call signature callers already
// use (no new `await` needed anywhere). Only createUser/verifyPassword stay
// async, same as before, because bcrypt itself is async.
const SALT_ROUNDS = 10;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// DB rows are snake_case; the rest of the app expects the camelCase shape
// that used to come straight off the in-memory object.
const rowToUser = (row) => row && ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  name: row.name,
  createdAt: row.created_at
});

const insertStmt = db.prepare(
  'INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)'
);
const findByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

const createUser = async ({ email, password, name }) => {
  const normalizedEmail = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);
  const createdAt = new Date().toISOString();
  const displayName = name || normalizedEmail.split('@')[0];

  const result = insertStmt.run(normalizedEmail, passwordHash, displayName, createdAt);

  return {
    id: result.lastInsertRowid,
    email: normalizedEmail,
    passwordHash,
    name: displayName,
    createdAt
  };
};

const findByEmail = (email) => rowToUser(findByEmailStmt.get(normalizeEmail(email))) || null;

const findById = (id) => rowToUser(findByIdStmt.get(Number(id))) || null;

const verifyPassword = (user, password) => bcrypt.compare(String(password), user.passwordHash);

// Never send passwordHash to the client.
const toPublicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt
});

module.exports = { createUser, findByEmail, findById, verifyPassword, toPublicUser };
