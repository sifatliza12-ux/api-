const db = require('../db');

// SQLite-backed now (was a hardcoded sampleMarketplaceItems array). The
// original 3 demo items are seeded once on first run so the Marketplace
// isn't empty for anyone testing today — they have no my_api_id/owner_id
// (nobody "owns" them, matching their original nature as static samples).
// A real published API's listing is upserted/removed by
// myApisController.publishMyApi, keyed on my_api_id, whenever a user
// publishes or unpublishes — that's the single authoritative sync point,
// not this module and not the /marketplace/publish route (kept only for
// backward compatibility with the existing frontend call sequence).
const rowToListing = (row) => row && ({
  id: row.id,
  myApiId: row.my_api_id,
  ownerId: row.owner_id,
  name: row.name,
  description: row.description || '',
  method: row.method,
  version: row.version,
  price: row.price,
  publisher: row.publisher,
  free: Boolean(row.free),
  category: row.category || 'all',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const SEED_ITEMS = [
  {
    name: 'Invoice Automation API',
    description: 'Automatically generate invoices from completed workflows.',
    method: 'POST',
    version: 'v1.0',
    price: 5,
    publisher: 'Forge Studio',
    free: 0,
    category: 'productivity',
    ageMs: 1000 * 60 * 60 * 24 * 3
  },
  {
    name: 'Order Processing API',
    description: 'Automate order fulfillment across multiple platforms.',
    method: 'POST',
    version: 'v1.2',
    price: 12,
    publisher: 'Automation Labs',
    free: 0,
    category: 'automation',
    ageMs: 1000 * 60 * 60 * 24 * 7
  },
  {
    name: 'Social Posting API',
    description: 'Publish content across multiple social platforms.',
    method: 'POST',
    version: 'v1.0',
    price: 0,
    publisher: 'FlowTech',
    free: 1,
    category: 'social',
    ageMs: 1000 * 60 * 60 * 5
  }
];

const countStmt = db.prepare('SELECT COUNT(*) AS count FROM marketplace_listings');
const seedInsertStmt = db.prepare(`
  INSERT INTO marketplace_listings (name, description, method, version, price, publisher, free, category, created_at)
  VALUES (@name, @description, @method, @version, @price, @publisher, @free, @category, @createdAt)
`);

const seedIfEmpty = () => {
  if (countStmt.get().count > 0) {
    return;
  }
  const insertMany = db.transaction((items) => {
    items.forEach((item) => {
      seedInsertStmt.run({
        ...item,
        createdAt: new Date(Date.now() - item.ageMs).toISOString()
      });
    });
  });
  insertMany(SEED_ITEMS);
};

seedIfEmpty();

const listAllStmt = db.prepare('SELECT * FROM marketplace_listings ORDER BY created_at DESC');
const getByIdStmt = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?');
const getByMyApiIdStmt = db.prepare('SELECT * FROM marketplace_listings WHERE my_api_id = ?');
const insertStmt = db.prepare(`
  INSERT INTO marketplace_listings (my_api_id, owner_id, name, description, method, version, price, publisher, free, category, created_at, updated_at)
  VALUES (@myApiId, @ownerId, @name, @description, @method, @version, @price, @publisher, @free, @category, @createdAt, @updatedAt)
`);
const updateStmt = db.prepare(`
  UPDATE marketplace_listings
  SET name = @name, description = @description, method = @method, version = @version,
      price = @price, publisher = @publisher, free = @free, updated_at = @updatedAt
  WHERE id = @id
`);
const patchStmt = db.prepare('UPDATE marketplace_listings SET price = COALESCE(?, price), category = COALESCE(?, category), updated_at = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM marketplace_listings WHERE id = ?');
const deleteByMyApiIdStmt = db.prepare('DELETE FROM marketplace_listings WHERE my_api_id = ?');

const listAll = () => listAllStmt.all().map(rowToListing);

const getById = (id) => rowToListing(getByIdStmt.get(Number(id))) || null;

// Publishing an already-published API just updates its existing listing
// (name/price/etc. may have changed) instead of creating a duplicate.
const upsertForMyApi = ({ myApiId, ownerId, name, description, method, version, price, publisher }) => {
  const existing = getByMyApiIdStmt.get(Number(myApiId));
  const now = new Date().toISOString();
  const free = !price || Number(price) === 0;

  if (existing) {
    updateStmt.run({ id: existing.id, name, description, method, version, price, publisher, free: free ? 1 : 0, updatedAt: now });
    return getById(existing.id);
  }

  const result = insertStmt.run({
    myApiId: Number(myApiId),
    ownerId: ownerId ?? null,
    name, description, method, version, price, publisher,
    free: free ? 1 : 0,
    category: 'all',
    createdAt: now,
    updatedAt: now
  });
  return getById(result.lastInsertRowid);
};

const removeByMyApiId = (myApiId) => {
  deleteByMyApiIdStmt.run(Number(myApiId));
};

const update = (id, patch) => {
  const info = patchStmt.run(
    typeof patch.price !== 'undefined' ? Number(patch.price) : null,
    typeof patch.category !== 'undefined' ? String(patch.category) : null,
    new Date().toISOString(),
    Number(id)
  );
  if (info.changes === 0) {
    return null;
  }
  return getById(id);
};

const removeById = (id) => {
  const info = deleteStmt.run(Number(id));
  return info.changes > 0;
};

module.exports = { listAll, getById, upsertForMyApi, removeByMyApiId, update, removeById };
