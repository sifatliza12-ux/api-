const express = require('express');
const {
  listMarketplaceItems,
  publishMarketplace,
  updateMarketplaceItem,
  removeMarketplaceItem,
  purchaseMarketplaceItem,
  listMyPurchases
} = require('../controllers/marketplaceController');
const { createPurchaseRequest } = require('../controllers/purchaseRequestController');
const { optionalAuth, requireAuth } = require('../middleware/auth');

const router = express.Router();

// optionalAuth: browsing stays public/unauthenticated exactly as before,
// but a logged-in caller also gets ownership/purchase info per listing.
router.get('/', optionalAuth, listMarketplaceItems);
router.get('/purchases/mine', requireAuth, listMyPurchases);
router.post('/publish', publishMarketplace);
// Free items: unchanged instant "charge and grant" (see purchaseMarketplaceItem).
router.post('/:id/purchase', requireAuth, purchaseMarketplaceItem);
// Paid items: manual-approval workflow — creates a pending purchase_requests
// row instead of granting access immediately (see routes/purchaseRequests.js
// for the approve/reject/verify actions a creator takes on it).
router.post('/:id/purchase-request', requireAuth, createPurchaseRequest);
router.patch('/:id', requireAuth, updateMarketplaceItem);
router.delete('/:id', requireAuth, removeMarketplaceItem);

module.exports = router;
