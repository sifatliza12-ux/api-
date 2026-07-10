const db = require('../db');

// Purchasing is simulated (no payment gateway yet), but the record shape and
// the Purchase -> Owned -> Run state it drives are exactly what a real
// purchase would need — swapping in real payment processing later only
// changes what happens before `purchase()` is called, not this table or the
// ownership checks built on top of it.
const insertStmt = db.prepare(`
  INSERT INTO marketplace_purchases (listing_id, buyer_id, price_paid, created_at)
  VALUES (@listingId, @buyerId, @pricePaid, @createdAt)
  ON CONFLICT(listing_id, buyer_id) DO NOTHING
`);
const getStmt = db.prepare('SELECT * FROM marketplace_purchases WHERE listing_id = ? AND buyer_id = ?');
const listByBuyerStmt = db.prepare('SELECT listing_id FROM marketplace_purchases WHERE buyer_id = ? ORDER BY created_at DESC');
const listByBuyerWithDateStmt = db.prepare('SELECT listing_id, created_at FROM marketplace_purchases WHERE buyer_id = ? ORDER BY created_at DESC');
const countForListingStmt = db.prepare('SELECT COUNT(*) AS count FROM marketplace_purchases WHERE listing_id = ?');

const hasPurchased = (listingId, buyerId) => !!getStmt.get(Number(listingId), Number(buyerId));

// Idempotent — purchasing something you already own just confirms the
// existing purchase rather than erroring, so a retried/double click never
// fails.
const purchase = ({ listingId, buyerId, pricePaid }) => {
  insertStmt.run({
    listingId: Number(listingId),
    buyerId: Number(buyerId),
    pricePaid: Number(pricePaid) || 0,
    createdAt: new Date().toISOString()
  });
  return getStmt.get(Number(listingId), Number(buyerId));
};

const listPurchasedListingIds = (buyerId) => listByBuyerStmt.all(Number(buyerId)).map((row) => row.listing_id);

// Same purchases as listPurchasedListingIds, but paired with when each one
// happened — the Purchased APIs page needs a real "Purchase Date" per item,
// not just the set of owned listing ids.
const listPurchasesWithDates = (buyerId) => listByBuyerWithDateStmt
  .all(Number(buyerId))
  .map((row) => ({ listingId: row.listing_id, purchasedAt: row.created_at }));

const countForListing = (listingId) => countForListingStmt.get(Number(listingId)).count;

module.exports = { hasPurchased, purchase, listPurchasedListingIds, listPurchasesWithDates, countForListing };
