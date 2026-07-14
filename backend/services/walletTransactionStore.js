const db = require('../db');

// Append-only ledger — one row per approved purchase request, written once
// by purchaseRequestController.approvePurchaseRequest and never edited or
// deleted afterward. Wallet stat totals are real SUM()/COUNT() queries over
// this table (and over pending purchase_requests for pending-revenue), not
// client-side estimates — the only thing still "placeholder" about them is
// that no real currency has moved through a payment gateway yet.
const insertStmt = db.prepare(`
  INSERT INTO wallet_transactions (purchase_request_id, listing_id, creator_id, buyer_id, amount, created_at)
  VALUES (@purchaseRequestId, @listingId, @creatorId, @buyerId, @amount, @createdAt)
`);

const totalRevenueStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE creator_id = ?');
const completedSalesStmt = db.prepare('SELECT COUNT(*) AS count FROM wallet_transactions WHERE creator_id = ?');
const mostPurchasedStmt = db.prepare(`
  SELECT listing_id, COUNT(*) AS count
  FROM wallet_transactions
  WHERE creator_id = ?
  GROUP BY listing_id
  ORDER BY count DESC
  LIMIT 1
`);
const distinctApisSoldStmt = db.prepare('SELECT COUNT(DISTINCT listing_id) AS count FROM wallet_transactions WHERE creator_id = ?');
const listRecentForCreatorStmt = db.prepare('SELECT * FROM wallet_transactions WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?');

const create = ({ purchaseRequestId, listingId, creatorId, buyerId, amount }) => {
  const result = insertStmt.run({
    purchaseRequestId: Number(purchaseRequestId),
    listingId: Number(listingId),
    creatorId: Number(creatorId),
    buyerId: Number(buyerId),
    amount: Number(amount) || 0,
    createdAt: new Date().toISOString()
  });
  return db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(result.lastInsertRowid);
};

const totalRevenueForCreator = (creatorId) => totalRevenueStmt.get(Number(creatorId)).total;

const completedSalesForCreator = (creatorId) => completedSalesStmt.get(Number(creatorId)).count;

const mostPurchasedListingIdForCreator = (creatorId) => {
  const row = mostPurchasedStmt.get(Number(creatorId));
  return row ? row.listing_id : null;
};

const distinctApisSoldForCreator = (creatorId) => distinctApisSoldStmt.get(Number(creatorId)).count;

const listRecentForCreator = (creatorId, limit = 20) => listRecentForCreatorStmt.all(Number(creatorId), limit);

module.exports = {
  create,
  totalRevenueForCreator,
  completedSalesForCreator,
  mostPurchasedListingIdForCreator,
  distinctApisSoldForCreator,
  listRecentForCreator
};
