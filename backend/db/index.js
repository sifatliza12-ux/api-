const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Single local SQLite file — replaces every Map()/array that used to hold
// this data in process memory. better-sqlite3 is synchronous by design, so
// every service function that used to run in-memory (no await) keeps that
// exact same synchronous call signature after this migration; only the
// bcrypt-dependent User functions are async, same as before.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'forgeflow.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    parameters TEXT NOT NULL,
    steps TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    price REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS my_apis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    method TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    generated_code TEXT,
    description TEXT,
    parameters TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS marketplace_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    my_api_id INTEGER REFERENCES my_apis(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    method TEXT,
    version TEXT,
    price REAL NOT NULL DEFAULT 0,
    publisher TEXT,
    free INTEGER NOT NULL DEFAULT 1,
    category TEXT DEFAULT 'all',
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS replay_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    triggered_by_user_id INTEGER REFERENCES users(id),
    is_test INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL,
    message TEXT,
    final_url TEXT,
    final_title TEXT,
    skipped_steps TEXT,
    created_at TEXT NOT NULL
  );

  -- One row per workflow: the canonical, positional field-name list an
  -- extraction run settles on. Read before naming fields on every run and
  -- written back (grown, never renamed) so the same workflow always returns
  -- the same JSON keys across separate replays.
  CREATE TABLE IF NOT EXISTS extraction_schemas (
    workflow_id INTEGER PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    field_names TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

// Schema evolution for databases created before this column existed —
// CREATE TABLE IF NOT EXISTS above only helps on a fresh database, it won't
// retroactively add a column to a table that already exists. ALTER TABLE
// ADD COLUMN is the safe, additive way to upgrade an existing one in place
// without losing any data already in it (unlike deleting the file, which is
// what earlier schema changes in this project required).
const addColumnIfMissing = (table, columnDefinition) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
  } catch (error) {
    if (!/duplicate column name/i.test(error.message)) {
      throw error;
    }
  }
};

addColumnIfMissing('replay_runs', 'step_log TEXT');
addColumnIfMissing('replay_runs', 'extraction_method TEXT');
addColumnIfMissing('workflows', 'extraction_hint TEXT');

module.exports = db;
