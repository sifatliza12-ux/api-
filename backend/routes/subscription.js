const express = require('express');
const { getSubscription } = require('../controllers/subscriptionController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, getSubscription);

module.exports = router;
