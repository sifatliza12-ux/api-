const express = require('express');
const {
  listMyPurchaseRequests,
  listCreatorPurchaseRequests,
  approvePurchaseRequest,
  rejectPurchaseRequest,
  requestVerification,
  resubmitPurchaseRequest
} = require('../controllers/purchaseRequestController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', requireAuth, listMyPurchaseRequests);
router.get('/for-me', requireAuth, listCreatorPurchaseRequests);
router.patch('/:id', requireAuth, resubmitPurchaseRequest);
router.post('/:id/approve', requireAuth, approvePurchaseRequest);
router.post('/:id/reject', requireAuth, rejectPurchaseRequest);
router.post('/:id/request-verification', requireAuth, requestVerification);

module.exports = router;
