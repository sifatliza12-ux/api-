const db = require('../db');

// Manual-approval purchase workflow for paid listings — the successor to an
// instant "charge and grant" for anything with a price. The row this store
// manages IS the state a real payment gateway's webhook would eventually
// drive instead of a creator's Approve click; nothing above this store
// (routes/controller) needs to change when that happens.
const rowToRequest = (row) => row && ({
  id: row.id,
  listingId: row.listing_id,
  buyerId: row.buyer_id,
  creatorId: row.creator_id,
  price: row.price,
  paymentMethod: row.payment_method,
  transactionId: row.transaction_id,
  screenshot: row.screenshot || null,
  buyerNote: row.buyer_note || '',
  creatorMessage: row.creator_message || '',
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at || null
});

const insertStmt = db.prepare(`
  INSERT INTO purchase_requests
    (listing_id, buyer_id, creator_id, price, payment_method, transaction_id, screenshot, buyer_note, status, created_at, updated_at)
  VALUES
    (@listingId, @buyerId, @creatorId, @price, @paymentMethod, @transactionId, @screenshot, @buyerNote, 'pending', @createdAt, @updatedAt)
`);
const getByIdStmt = db.prepare('SELECT * FROM purchase_requests WHERE id = ?');
const listForBuyerStmt = db.prepare('SELECT * FROM purchase_requests WHERE buyer_id = ? ORDER BY created_at DESC');
const listForCreatorStmt = db.prepare('SELECT * FROM purchase_requests WHERE creator_id = ? ORDER BY created_at DESC');
const listForCreatorByStatusStmt = db.prepare('SELECT * FROM purchase_requests WHERE creator_id = ? AND status = ? ORDER BY created_at DESC');
// Latest non-approved request per (listing, buyer) — powers the Marketplace
// card's button state (Pending Approval / Verification Required / Purchase
// Rejected) without needing a join on every browse request.
const latestActiveForListingBuyerStmt = db.prepare(`
  SELECT * FROM purchase_requests
  WHERE listing_id = ? AND buyer_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`);
const updateStatusStmt = db.prepare(`
  UPDATE purchase_requests
  SET status = @status, creator_message = @creatorMessage, updated_at = @updatedAt, resolved_at = @resolvedAt
  WHERE id = @id
`);
// Conditional on "not already approved" so this is the single point that
// decides whether an approve action actually happens — info.changes tells
// the caller whether THIS call performed the transition, so a duplicated
// approve (double-click, retried request) can't grant access/credit the
// wallet twice.
const approveIfNotApprovedStmt = db.prepare(`
  UPDATE purchase_requests
  SET status = 'approved', updated_at = @updatedAt, resolved_at = @resolvedAt
  WHERE id = @id AND status != 'approved'
`);
const resubmitStmt = db.prepare(`
  UPDATE purchase_requests
  SET transaction_id = @transactionId, screenshot = @screenshot, buyer_note = @buyerNote,
      status = 'pending', updated_at = @updatedAt
  WHERE id = @id
`);
// "Pending" for wallet-stat purposes covers both pending and
// verification_required — both are still awaiting a final creator decision.
const pendingCountForCreatorStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM purchase_requests
  WHERE creator_id = ? AND status IN ('pending', 'verification_required')
`);
const pendingRevenueForCreatorStmt = db.prepare(`
  SELECT COALESCE(SUM(price), 0) AS total FROM purchase_requests
  WHERE creator_id = ? AND status IN ('pending', 'verification_required')
`);
// Used to block removing a listing out from under a buyer whose payment is
// still awaiting a decision — marketplace_listings -> purchase_requests is
// ON DELETE CASCADE, so without this check a creator could silently delete
// a listing (and, with it, any buyer's still-open purchase request) with no
// warning to either side.
const hasPendingForListingStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM purchase_requests
  WHERE listing_id = ? AND status IN ('pending', 'verification_required')
`);

const create = ({ listingId, buyerId, creatorId, price, paymentMethod, transactionId, screenshot, buyerNote }) => {
  const now = new Date().toISOString();
  const result = insertStmt.run({
    listingId: Number(listingId),
    buyerId: Number(buyerId),
    creatorId: creatorId ? Number(creatorId) : null,
    price: Number(price) || 0,
    paymentMethod: String(paymentMethod),
    transactionId: String(transactionId),
    screenshot: screenshot || null,
    buyerNote: buyerNote || '',
    createdAt: now,
    updatedAt: now
  });
  return rowToRequest(getByIdStmt.get(result.lastInsertRowid));
};

const getById = (id) => rowToRequest(getByIdStmt.get(Number(id))) || null;

const listForBuyer = (buyerId) => listForBuyerStmt.all(Number(buyerId)).map(rowToRequest);

const listForCreator = (creatorId, status) => {
  const rows = status
    ? listForCreatorByStatusStmt.all(Number(creatorId), status)
    : listForCreatorStmt.all(Number(creatorId));
  return rows.map(rowToRequest);
};

const latestActiveForListingBuyer = (listingId, buyerId) => {
  const row = latestActiveForListingBuyerStmt.get(Number(listingId), Number(buyerId));
  if (!row) return null;
  // "Active" excludes approved (once approved, access is granted — the
  // Marketplace card switches to isPurchasedByMe/Run API instead) so a
  // long-since-approved old request never masks a fresh purchase later.
  if (row.status === 'approved') return null;
  return rowToRequest(row);
};

const setStatus = (id, status, { creatorMessage = '', resolvedAt = null } = {}) => {
  updateStatusStmt.run({
    id: Number(id),
    status,
    creatorMessage: creatorMessage || '',
    updatedAt: new Date().toISOString(),
    resolvedAt
  });
  return getById(id);
};

// Returns true only if this call actually flipped the status to 'approved'
// (false if it was already approved) — the controller uses that to decide
// whether to run the once-only side effects (grant access, credit wallet,
// notify buyer) at all.
const approveIfNotApproved = (id) => {
  const info = approveIfNotApprovedStmt.run({
    id: Number(id),
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString()
  });
  return info.changes > 0;
};

// Only meaningful from 'verification_required' — enforced by the controller,
// not here, so this store stays a plain data layer.
const resubmit = (id, { transactionId, screenshot, buyerNote }) => {
  const existing = getById(id);
  if (!existing) return null;
  resubmitStmt.run({
    id: Number(id),
    transactionId: String(transactionId || existing.transactionId),
    screenshot: typeof screenshot !== 'undefined' ? screenshot : existing.screenshot,
    buyerNote: typeof buyerNote !== 'undefined' ? buyerNote : existing.buyerNote,
    updatedAt: new Date().toISOString()
  });
  return getById(id);
};

const pendingCountForCreator = (creatorId) => pendingCountForCreatorStmt.get(Number(creatorId)).count;

const pendingRevenueForCreator = (creatorId) => pendingRevenueForCreatorStmt.get(Number(creatorId)).total;

const hasPendingForListing = (listingId) =>
  hasPendingForListingStmt.get(Number(listingId)).count > 0;

module.exports = {
  create,
  getById,
  listForBuyer,
  listForCreator,
  latestActiveForListingBuyer,
  setStatus,
  approveIfNotApproved,
  resubmit,
  pendingCountForCreator,
  pendingRevenueForCreator,
  hasPendingForListing
};
