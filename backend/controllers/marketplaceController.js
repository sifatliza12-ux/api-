const marketplaceStore = require('../services/marketplaceStore');
const marketplacePurchaseStore = require('../services/marketplacePurchaseStore');
const purchaseRequestStore = require('../services/purchaseRequestStore');
const myApisStore = require('../services/myApisStore');
const { getWorkflow } = require('../services/workflowStore');

// A marketplace_listings row never stores parameters itself — the live,
// authoritative schema for ANY workflow (booking a hotel, sending an email,
// posting to a feed, whatever) lives on its linked workflow, resolved
// generically via myApiId -> workflowId -> getWorkflow (which also lazily
// upgrades legacy step data — see workflowStore.js). This is what lets a
// buyer's Run form (extension/purchased-apis/purchased-apis.js,
// extension/marketplace/marketplace.js) stay in sync with whatever the
// creator's workflow currently defines, without this controller ever
// needing to know what a given API automates. Only called for listings the
// caller actually owns or has purchased — see the "shared after purchase"
// note in marketplace.js's pre-purchase details modal.
const withRunnableParameters = (item) => {
  const myApi = item.myApiId ? myApisStore.getById(item.myApiId) : null;
  const workflow = myApi?.workflowId ? getWorkflow(myApi.workflowId) : null;
  return { ...item, parameters: (workflow ? workflow.parameters : myApi?.parameters) || [] };
};

// optionalAuth (routes/marketplace.js) means req.user may or may not be set.
// purchaseCount is public on every listing (same idea as a storefront
// showing "12 people bought this" to anyone). isOwnedByMe/isPurchasedByMe
// are inherently per-user, so those only appear for a logged-in caller —
// an anonymous request still gets every field it got before this feature
// existed, plus the new public purchaseCount.
const listMarketplaceItems = (req, res) => {
  const items = marketplaceStore.listAll().map((item) => ({
    ...item,
    purchaseCount: marketplacePurchaseStore.countForListing(item.id)
  }));

  if (!req.user) {
    return res.json(items);
  }

  const purchasedIds = new Set(marketplacePurchaseStore.listPurchasedListingIds(req.user.id));
  const enriched = items.map((item) => {
    const isPurchasedByMe = purchasedIds.has(item.id);
    const isOwnedByMe = item.ownerId === req.user.id;
    // Only surfaced when access isn't already granted — an old resolved
    // request should never mask a fresh Buy button once someone owns the
    // listing (see purchaseRequestStore.latestActiveForListingBuyer, which
    // already excludes 'approved').
    const activeRequest = !isPurchasedByMe
      ? purchaseRequestStore.latestActiveForListingBuyer(item.id, req.user.id)
      : null;
    const base = {
      ...item,
      isOwnedByMe,
      isPurchasedByMe,
      myPurchaseRequestStatus: activeRequest ? activeRequest.status : null
    };
    // Parameters are only attached once access is actually granted — a
    // browsing (not-yet-purchased) listing must never leak the recorded
    // field values/labels behind its paywall.
    return (isOwnedByMe || isPurchasedByMe) ? withRunnableParameters(base) : base;
  });

  return res.json(enriched);
};

// Simulated purchase — no payment gateway yet, but this is the single point
// where a real one would plug in later (charge, then call
// marketplacePurchaseStore.purchase on success). Idempotent: buying
// something you already own just confirms it rather than erroring, and an
// owner can't "purchase" their own listing since they already have it.
const purchaseMarketplaceItem = (req, res) => {
  try {
    const item = marketplaceStore.getById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    if (item.ownerId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You already own this API.' });
    }

    marketplacePurchaseStore.purchase({ listingId: item.id, buyerId: req.user.id, pricePaid: item.price || 0 });

    return res.json({
      success: true,
      message: item.price > 0 ? 'Purchase complete.' : 'Added to your library.',
      item
    });
  } catch (err) {
    console.error('[Backend] purchaseMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// "My Purchased APIs" library — powers the dedicated Purchased APIs page,
// so each item also carries when it was bought (purchasedAt) alongside the
// listing's own fields (name, description, publisher/creator, etc.).
const listMyPurchases = (req, res) => {
  try {
    const purchases = marketplacePurchaseStore.listPurchasesWithDates(req.user.id);
    const items = purchases
      .map(({ listingId, purchasedAt }) => {
        const item = marketplaceStore.getById(listingId);
        return item ? withRunnableParameters({ ...item, purchasedAt }) : null;
      })
      .filter(Boolean);
    return res.json(items);
  } catch (err) {
    console.error('[Backend] listMyPurchases error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// Editing/removing a listing is a creator-only action — the frontend only
// shows these to the owner, but that's a UI courtesy, not access control,
// so it's enforced here too.
const updateMarketplaceItem = (req, res) => {
  try {
    const existing = marketplaceStore.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    if (existing.ownerId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only this listing\'s creator can edit it.' });
    }

    const payload = req.body || {};

    if (typeof payload.price !== 'undefined') {
      const newPrice = Number(payload.price);
      if (Number.isNaN(newPrice) || newPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Price must be a number greater than 0.' });
      }
    }

    if (typeof payload.name !== 'undefined' && !String(payload.name).trim()) {
      return res.status(400).json({ success: false, message: 'Name cannot be empty' });
    }

    const item = marketplaceStore.update(req.params.id, payload);

    // Keeps the underlying My APIs record's price in step with the listing
    // — upsertForMyApi (myApisController.publishMyApi) always re-reads price
    // from that record on every publish, so without this an unpublish then
    // republish would silently revert to whatever price the listing had
    // before this update.
    if (item && existing.myApiId && typeof payload.price !== 'undefined') {
      myApisStore.updatePrice(existing.myApiId, Number(payload.price));
    }

    return res.json({ success: true, item });
  } catch (err) {
    console.error('[Backend] updateMarketplaceItem error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const removeMarketplaceItem = (req, res) => {
  try {
    const existing = marketplaceStore.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    if (existing.ownerId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only this listing\'s creator can remove it.' });
    }

    // A listing's purchase_requests cascade-delete with it — removing one
    // while a buyer's payment is still awaiting a decision would silently
    // discard their pending (or "needs verification") request with no
    // explanation on either side. Block removal until those are resolved
    // (approved or rejected) instead.
    if (purchaseRequestStore.hasPendingForListing(req.params.id)) {
      return res.status(409).json({ success: false, message: 'This listing has purchase requests awaiting your decision. Approve or reject them before removing it.' });
    }

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
  removeMarketplaceItem,
  purchaseMarketplaceItem,
  listMyPurchases
};
