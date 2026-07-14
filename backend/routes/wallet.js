const express = require('express');
const { getWalletOverview, getRecentTransactions } = require('../controllers/walletController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/overview', requireAuth, getWalletOverview);
router.get('/transactions', requireAuth, getRecentTransactions);

module.exports = router;
