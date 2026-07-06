const sampleMarketplaceItems = [
  {
    id: 1,
    name: 'Invoice Automation API',
    description: 'Automatically generate invoices from completed workflows.',
    method: 'POST',
    version: 'v1.0',
    price: 5,
    publisher: 'Forge Studio',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    free: false,
    category: 'productivity'
  },
  {
    id: 2,
    name: 'Order Processing API',
    description: 'Automate order fulfillment across multiple platforms.',
    method: 'POST',
    version: 'v1.2',
    price: 12,
    publisher: 'Automation Labs',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    free: false,
    category: 'automation'
  },
  {
    id: 3,
    name: 'Social Posting API',
    description: 'Publish content across multiple social platforms.',
    method: 'POST',
    version: 'v1.0',
    price: 0,
    publisher: 'FlowTech',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    free: true,
    category: 'social'
  }
];

const listMarketplaceItems = (req, res) => {
  // TODO: Replace with marketplace catalog and transaction logic later.
  res.json(sampleMarketplaceItems);
};

const updateMarketplaceItem = (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = sampleMarketplaceItems.find(i => i.id === id);
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

    const payload = req.body || {};
    if (typeof payload.price !== 'undefined') {
      const newPrice = Number(payload.price);
      if (Number.isNaN(newPrice) || newPrice < 0) {
        return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
      }
      item.price = newPrice;
      item.free = newPrice === 0;
    }

    if (typeof payload.category !== 'undefined') {
      item.category = String(payload.category || 'all');
    }

    item.updatedAt = new Date().toISOString();
    return res.json({ success: true, item });
  } catch (err) {
    console.error('[Backend] updateMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const removeMarketplaceItem = (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = sampleMarketplaceItems.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Item not found' });
    // Remove listing from marketplace catalog. TODO: Persist deletion in DB.
    sampleMarketplaceItems.splice(idx, 1);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Backend] removeMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const publishMarketplace = (req, res) => {
  // TODO: Add authentication, validation, persistence, and payment handling here.
  try {
    const payload = req.body || {};

    // Basic validation for expected fields (non-blocking for demo)
    if (!payload.name || !payload.endpoint) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    // In a real implementation, persist the marketplace listing and handle transactions.
    return res.json({ success: true, message: 'API published successfully.' });
  } catch (err) {
    console.error('[Backend] publishMarketplace error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  listMarketplaceItems,
  publishMarketplace
  ,updateMarketplaceItem
  ,removeMarketplaceItem
};
