const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Single local SQLite file — replaces every Map()/array that used to hold
// this data in process memory. better-sqlite3 is synchronous by design, so
// every service function that used to run in-memory (no await) keeps that
// exact same synchronous call signature after this migration; only the
// bcrypt-dependent User functions are async, same as before.
//
// DATABASE_DIR is optional and only matters in production: a platform like
// Railway wipes the local filesystem on every deploy/restart unless the
// database lives on a mounted persistent Volume, so DATABASE_DIR should be
// set to that Volume's mount path there. Left unset, this falls back to the
// same relative backend/data path it has always used — local development is
// unaffected.
const DATA_DIR = process.env.DATABASE_DIR
  ? path.resolve(process.env.DATABASE_DIR)
  : path.join(__dirname, '..', 'data');
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

  -- Purchase records are what turn a listing from "Purchase" into "Run API"
  -- for a given buyer. price_paid is captured at purchase time (not read
  -- live off the listing later) so a creator changing their price afterward
  -- can't rewrite what a past buyer already paid. Simulated for now (no real
  -- payment gateway yet) but the shape is exactly what a real purchase would
  -- need to record.
  CREATE TABLE IF NOT EXISTS marketplace_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    price_paid REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(listing_id, buyer_id)
  );

  -- Manual-approval purchase workflow for paid listings. Free items never
  -- create a row here — they still go through the original, unchanged
  -- marketplace_purchases instant-insert path. price is a snapshot (same
  -- reasoning as marketplace_purchases.price_paid). status is the single
  -- state machine driving both the buyer's My Purchases page and the
  -- creator's Purchase Requests page: pending -> approved|rejected, or
  -- pending -> verification_required -> pending (resubmit) -> ... This is
  -- the exact seam a real payment gateway would plug into later (a webhook
  -- calling the same approve function a creator's click calls today).
  CREATE TABLE IF NOT EXISTS purchase_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    creator_id INTEGER REFERENCES users(id),
    price REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    screenshot TEXT,
    buyer_note TEXT,
    creator_message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  );

  -- Append-only ledger row, written exactly once per approved purchase
  -- request (see purchaseRequestController.approvePurchaseRequest). This is
  -- what Wallet revenue/stat totals sum over — never edited or deleted
  -- after creation, so it stays a trustworthy record even if a listing's
  -- price or a request's other fields change later.
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_request_id INTEGER REFERENCES purchase_requests(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id),
    creator_id INTEGER NOT NULL REFERENCES users(id),
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    amount REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Generic notification feed for both creator and buyer events (new
  -- purchase request, approved, rejected, verification required/resubmitted).
  -- link is an extension-relative page path the bell dropdown can navigate
  -- to when a notification is clicked.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
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
// Lets a purchased/owned marketplace listing actually be run (Run API) —
// previously listings only carried enough to display a card, not enough to
// call the underlying workflow.
addColumnIfMissing('marketplace_listings', 'endpoint TEXT');

// At most one ledger row per approved purchase request — belt-and-braces
// against ever double-crediting a creator's wallet if an approve action is
// ever triggered twice for the same request (double-click, retried request,
// etc.). CREATE UNIQUE INDEX IF NOT EXISTS is safe to (re)run on a database
// that already has rows, unlike a UNIQUE column constraint added via ALTER
// TABLE, which SQLite doesn't support.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_purchase_request_id ON wallet_transactions(purchase_request_id)');

module.exports = db;
