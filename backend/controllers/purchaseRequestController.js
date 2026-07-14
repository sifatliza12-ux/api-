const marketplaceStore = require('../services/marketplaceStore');
const marketplacePurchaseStore = require('../services/marketplacePurchaseStore');
const purchaseRequestStore = require('../services/purchaseRequestStore');
const walletTransactionStore = require('../services/walletTransactionStore');
const notificationStore = require('../services/notificationStore');
const { findById } = require('../models/User');

const PAYMENT_METHODS = ['bkash', 'nagad', 'rocket', 'bank_transfer'];
// ~3MB decoded image comes out to roughly this many base64 characters —
// generous for a payment-confirmation screenshot without letting the
// (already-raised) 50mb JSON body limit be the only guard.
const MAX_SCREENSHOT_LENGTH = 4 * 1024 * 1024;
// Screenshot must be a well-formed base64 image data URL — rejects anything
// else outright (a client that skips the frontend entirely could otherwise
// post arbitrary text into this field, which is later rendered as an <img
// src> in the creator/buyer UI; raster-only, no svg+xml, which can carry
// script).
const SCREENSHOT_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/i;

const isValidScreenshot = (screenshot) => SCREENSHOT_DATA_URL_RE.test(String(screenshot));

const withListingInfo = (request) => {
  const listing = marketplaceStore.getById(request.listingId);
  return {
    ...request,
    listingName: listing ? listing.name : 'Unknown API',
    listingPublisher: listing ? listing.publisher : 'Unknown',
  };
};

const withBuyerInfo = (request) => {
  const buyer = findById(request.buyerId);
  return { ...request, buyerName: buyer ? buyer.name : 'Unknown buyer' };
};

// Simulated purchase, manual-approval edition — this is the buyer-facing
// half of the same seam marketplaceController.purchaseMarketplaceItem already
// documents: a real payment gateway would replace "buyer fills this form"
// with "gateway redirect", but would still land here (or an equivalent
// webhook) to create the pending request a creator/gateway later resolves.
const createPurchaseRequest = (req, res) => {
  try {
    const listing = marketplaceStore.getById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    if (listing.ownerId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You already own this API.' });
    }
    if (marketplacePurchaseStore.hasPurchased(listing.id, req.user.id)) {
      return res.status(400).json({ success: false, message: 'You already own this API.' });
    }
    if (!listing.price || Number(listing.price) === 0) {
      return res.status(400).json({ success: false, message: 'Free APIs do not require a purchase request — use the instant purchase endpoint.' });
    }

    const { paymentMethod, transactionId, screenshot, buyerNote } = req.body || {};

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'Please choose a valid payment method.' });
    }
    if (!transactionId || !String(transactionId).trim()) {
      return res.status(400).json({ success: false, message: 'Transaction ID is required.' });
    }
    if (screenshot) {
      if (String(screenshot).length > MAX_SCREENSHOT_LENGTH) {
        return res.status(400).json({ success: false, message: 'Screenshot is too large. Please upload an image under 3MB.' });
      }
      if (!isValidScreenshot(screenshot)) {
        return res.status(400).json({ success: false, message: 'Screenshot must be a valid image.' });
      }
    }

    const existingActive = purchaseRequestStore.latestActiveForListingBuyer(listing.id, req.user.id);
    if (existingActive && (existingActive.status === 'pending' || existingActive.status === 'verification_required')) {
      return res.status(400).json({ success: false, message: 'You already have a purchase request in progress for this API.' });
    }

    const request = purchaseRequestStore.create({
      listingId: listing.id,
      buyerId: req.user.id,
      creatorId: listing.ownerId,
      price: listing.price,
      paymentMethod,
      transactionId: String(transactionId).trim(),
      screenshot: screenshot || null,
      buyerNote: buyerNote || ''
    });

    if (listing.ownerId) {
      notificationStore.create({
        userId: listing.ownerId,
        type: 'purchase_request_created',
        title: 'New purchase request',
        body: `${req.user.name} wants to buy "${listing.name}".`,
        link: 'purchase-requests/purchase-requests.html'
      });
    }

    return res.status(201).json({ success: true, message: 'Purchase request submitted. The creator will review it shortly.', request });
  } catch (err) {
    console.error('[Backend] createPurchaseRequest error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const listMyPurchaseRequests = (req, res) => {
  try {
    const requests = purchaseRequestStore.listForBuyer(req.user.id).map(withListingInfo);
    return res.json(requests);
  } catch (err) {
    console.error('[Backend] listMyPurchaseRequests error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const listCreatorPurchaseRequests = (req, res) => {
  try {
    const status = req.query.status && String(req.query.status);
    const requests = purchaseRequestStore.listForCreator(req.user.id, status).map(withListingInfo).map(withBuyerInfo);
    return res.json(requests);
  } catch (err) {
    console.error('[Backend] listCreatorPurchaseRequests error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// Ownership is re-checked against the listing itself (not just the
// denormalized creator_id column) — same defense-in-depth as
// marketplaceController.updateMarketplaceItem/removeMarketplaceItem.
const assertCreatorOwnsRequest = (request, req) => {
  if (!request) return { status: 404, message: 'Purchase request not found.' };
  const listing = marketplaceStore.getById(request.listingId);
  if (!listing || listing.ownerId !== req.user.id) {
    return { status: 403, message: 'Only this listing\'s creator can manage this request.' };
  }
  return null;
};

const approvePurchaseRequest = (req, res) => {
  try {
    const request = purchaseRequestStore.getById(req.params.id);
    const authError = assertCreatorOwnsRequest(request, req);
    if (authError) return res.status(authError.status).json({ success: false, message: authError.message });

    // approveIfNotApproved is the single atomic point deciding whether this
    // call actually performs the approval — a duplicated approve action
    // (double-click, retried request) sees `false` here and skips granting
    // access/crediting the wallet/notifying the buyer a second time.
    const didApprove = purchaseRequestStore.approveIfNotApproved(request.id);
    const updated = purchaseRequestStore.getById(request.id);

    if (!didApprove) {
      return res.json({ success: true, message: 'Already approved.', request: updated });
    }

    // This is the exact call the existing (unchanged) instant-purchase flow
    // already uses to grant access — approving a request now drives the same
    // "Run API" unlock that a free "Get for Free" click always has.
    marketplacePurchaseStore.purchase({ listingId: request.listingId, buyerId: request.buyerId, pricePaid: request.price });

    walletTransactionStore.create({
      purchaseRequestId: request.id,
      listingId: request.listingId,
      creatorId: req.user.id,
      buyerId: request.buyerId,
      amount: request.price
    });

    const listing = marketplaceStore.getById(request.listingId);
    notificationStore.create({
      userId: request.buyerId,
      type: 'purchase_approved',
      title: 'Purchase approved',
      body: `Your purchase of "${listing ? listing.name : 'this API'}" was approved. You can run it now.`,
      link: 'purchased-apis/purchased-apis.html'
    });

    return res.json({ success: true, message: 'Purchase approved.', request: updated });
  } catch (err) {
    console.error('[Backend] approvePurchaseRequest error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const rejectPurchaseRequest = (req, res) => {
  try {
    const request = purchaseRequestStore.getById(req.params.id);
    const authError = assertCreatorOwnsRequest(request, req);
    if (authError) return res.status(authError.status).json({ success: false, message: authError.message });

    const message = (req.body && req.body.message) || '';
    const updated = purchaseRequestStore.setStatus(request.id, 'rejected', { creatorMessage: message, resolvedAt: new Date().toISOString() });

    const listing = marketplaceStore.getById(request.listingId);
    notificationStore.create({
      userId: request.buyerId,
      type: 'purchase_rejected',
      title: 'Purchase rejected',
      body: message
        ? `Your purchase of "${listing ? listing.name : 'this API'}" was rejected: ${message}`
        : `Your purchase of "${listing ? listing.name : 'this API'}" was rejected.`,
      link: 'my-purchases/my-purchases.html'
    });

    return res.json({ success: true, message: 'Purchase request rejected.', request: updated });
  } catch (err) {
    console.error('[Backend] rejectPurchaseRequest error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const requestVerification = (req, res) => {
  try {
    const request = purchaseRequestStore.getById(req.params.id);
    const authError = assertCreatorOwnsRequest(request, req);
    if (authError) return res.status(authError.status).json({ success: false, message: authError.message });

    const message = (req.body && req.body.message) || '';
    if (!message.trim()) {
      return res.status(400).json({ success: false, message: 'Please explain what needs verifying.' });
    }

    const updated = purchaseRequestStore.setStatus(request.id, 'verification_required', { creatorMessage: message });

    const listing = marketplaceStore.getById(request.listingId);
    notificationStore.create({
      userId: request.buyerId,
      type: 'verification_required',
      title: 'Verification required',
      body: `The creator needs more info about your purchase of "${listing ? listing.name : 'this API'}": ${message}`,
      link: 'my-purchases/my-purchases.html'
    });

    return res.json({ success: true, message: 'Verification requested.', request: updated });
  } catch (err) {
    console.error('[Backend] requestVerification error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// Buyer resubmits after a "Verification Required" response — only valid
// from that status so a resolved (approved/rejected) or already-pending
// request can't be silently rewritten.
const resubmitPurchaseRequest = (req, res) => {
  try {
    const request = purchaseRequestStore.getById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Purchase request not found.' });
    }
    if (request.buyerId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only resubmit your own purchase requests.' });
    }
    if (request.status !== 'verification_required') {
      return res.status(400).json({ success: false, message: 'Only requests marked "Verification Required" can be resubmitted.' });
    }

    const { transactionId, screenshot, buyerNote } = req.body || {};
    if (!transactionId || !String(transactionId).trim()) {
      return res.status(400).json({ success: false, message: 'Transaction ID is required.' });
    }
    if (screenshot) {
      if (String(screenshot).length > MAX_SCREENSHOT_LENGTH) {
        return res.status(400).json({ success: false, message: 'Screenshot is too large. Please upload an image under 3MB.' });
      }
      if (!isValidScreenshot(screenshot)) {
        return res.status(400).json({ success: false, message: 'Screenshot must be a valid image.' });
      }
    }

    const updated = purchaseRequestStore.resubmit(request.id, {
      transactionId: String(transactionId).trim(),
      screenshot: typeof screenshot !== 'undefined' ? screenshot : request.screenshot,
      buyerNote: typeof buyerNote !== 'undefined' ? buyerNote : request.buyerNote
    });

    if (request.creatorId) {
      const listing = marketplaceStore.getById(request.listingId);
      notificationStore.create({
        userId: request.creatorId,
        type: 'purchase_request_resubmitted',
        title: 'Purchase request resubmitted',
        body: `${req.user.name} resubmitted their purchase request for "${listing ? listing.name : 'an API'}".`,
        link: 'purchase-requests/purchase-requests.html'
      });
    }

    return res.json({ success: true, message: 'Purchase request resubmitted.', request: updated });
  } catch (err) {
    console.error('[Backend] resubmitPurchaseRequest error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  createPurchaseRequest,
  listMyPurchaseRequests,
  listCreatorPurchaseRequests,
  approvePurchaseRequest,
  rejectPurchaseRequest,
  requestVerification,
  resubmitPurchaseRequest
};
