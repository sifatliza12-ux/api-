const express = require('express');
const { getSubscription } = require('../controllers/subscriptionController');

const router = express.Router();

router.get('/', getSubscription);

module.exports = router;
