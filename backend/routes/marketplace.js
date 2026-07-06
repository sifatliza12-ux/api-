const express = require('express');
const { listMarketplaceItems, publishMarketplace, updateMarketplaceItem, removeMarketplaceItem } = require('../controllers/marketplaceController');

const router = express.Router();

router.get('/', listMarketplaceItems);
router.post('/publish', publishMarketplace);
router.patch('/:id', updateMarketplaceItem);
router.delete('/:id', removeMarketplaceItem);

module.exports = router;
