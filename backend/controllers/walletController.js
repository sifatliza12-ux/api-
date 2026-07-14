const marketplaceStore = require('../services/marketplaceStore');
const purchaseRequestStore = require('../services/purchaseRequestStore');
const walletTransactionStore = require('../services/walletTransactionStore');
const { findById } = require('../models/User');

// Dashboard-style overview for the Creator Wallet page. totalRevenue and
// pendingRevenue are flagged `placeholder: true` in the response — the
// numbers themselves are real SUM()s over this creator's own data, but no
// real currency has moved through a payment gateway yet, so the frontend
// tags them with the same `stat-placeholder-tag` badge the Dashboard's
// "Estimated Revenue" card already uses. Every other figure here is a plain
// real count/aggregate, same footing as the Marketplace's purchaseCount.
const getWalletOverview = (req, res) => {
  try {
    const creatorId = req.user.id;

    const totalRevenue = walletTransactionStore.totalRevenueForCreator(creatorId);
    const pendingRevenue = purchaseRequestStore.pendingRevenueForCreator(creatorId);
    const completedSales = walletTransactionStore.completedSalesForCreator(creatorId);
    const pendingPurchaseRequests = purchaseRequestStore.pendingCountForCreator(creatorId);
    const totalApisSold = walletTransactionStore.distinctApisSoldForCreator(creatorId);
    const averageSellingPrice = completedSales > 0 ? totalRevenue / completedSales : 0;

    const mostPurchasedListingId = walletTransactionStore.mostPurchasedListingIdForCreator(creatorId);
    const mostPurchasedListing = mostPurchasedListingId ? marketplaceStore.getById(mostPurchasedListingId) : null;

    return res.json({
      totalRevenue,
      totalRevenuePlaceholder: true,
      pendingRevenue,
      pendingRevenuePlaceholder: true,
      completedSales,
      pendingPurchaseRequests,
      totalApisSold,
      averageSellingPrice,
      mostPurchasedApiName: mostPurchasedListing ? mostPurchasedListing.name : '—'
    });
  } catch (err) {
    console.error('[Backend] getWalletOverview error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// Recent Transactions table — a view over purchase_requests (every status:
// Pending, Approved, Rejected, Verification Required), not just completed
// money movements, matching the Wallet UI's status-badge requirement.
const getRecentTransactions = (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const requests = purchaseRequestStore.listForCreator(req.user.id).slice(0, limit);

    const transactions = requests.map((request) => {
      const listing = marketplaceStore.getById(request.listingId);
      const buyer = findById(request.buyerId);
      return {
        id: request.id,
        buyerName: buyer ? buyer.name : 'Unknown buyer',
        listingName: listing ? listing.name : 'Unknown API',
        amount: request.price,
        status: request.status,
        date: request.createdAt
      };
    });

    return res.json(transactions);
  } catch (err) {
    console.error('[Backend] getRecentTransactions error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = { getWalletOverview, getRecentTransactions };
