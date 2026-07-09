const express = require('express');
const {
  listMarketplaceItems,
  publishMarketplace,
  updateMarketplaceItem,
  removeMarketplaceItem,
  purchaseMarketplaceItem,
  listMyPurchases
} = require('../controllers/marketplaceController');
const { optionalAuth, requireAuth } = require('../middleware/auth');

const router = express.Router();

// optionalAuth: browsing stays public/unauthenticated exactly as before,
// but a logged-in caller also gets ownership/purchase info per listing.
router.get('/', optionalAuth, listMarketplaceItems);
router.get('/purchases/mine', requireAuth, listMyPurchases);
router.post('/publish', publishMarketplace);
router.post('/:id/purchase', requireAuth, purchaseMarketplaceItem);
router.patch('/:id', requireAuth, updateMarketplaceItem);
router.delete('/:id', requireAuth, removeMarketplaceItem);

module.exports = router;
