const marketplaceStore = require('../services/marketplaceStore');

const listMarketplaceItems = (req, res) => {
  res.json(marketplaceStore.listAll());
};

const updateMarketplaceItem = (req, res) => {
  try {
    const payload = req.body || {};

    if (typeof payload.price !== 'undefined') {
      const newPrice = Number(payload.price);
      if (Number.isNaN(newPrice) || newPrice < 0) {
        return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
      }
    }

    const item = marketplaceStore.update(req.params.id, payload);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    return res.json({ success: true, item });
  } catch (err) {
    console.error('[Backend] updateMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const removeMarketplaceItem = (req, res) => {
  try {
    const removed = marketplaceStore.removeById(req.params.id);
    if (!removed) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Backend] removeMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// Kept for backward compatibility: the popup's publish button already calls
// this route immediately before POST /api/my-apis/:id/publish. That second
// call (myApisController.publishMyApi) is now the single authoritative place
// a listing actually gets created/updated/removed, since it has the real
// My APIs record and the authenticated user to attribute it to — this route
// no longer needs to (and, being unauthenticated, shouldn't) persist
// anything itself. It just keeps responding successfully so that existing
// call sequence doesn't break.
const publishMarketplace = (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.name || !payload.endpoint) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    return res.json({ success: true, message: 'API published successfully.' });
  } catch (err) {
    console.error('[Backend] publishMarketplace error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  listMarketplaceItems,
  publishMarketplace,
  updateMarketplaceItem,
  removeMarketplaceItem
};
