const myApisStore = require('../services/myApisStore');
const marketplaceStore = require('../services/marketplaceStore');
const { setVisibility, deleteWorkflow, getWorkflow } = require('../services/workflowStore');

// my_apis.parameters is a snapshot taken once, at parameterize time — it
// never gets rewritten afterward. workflow.parameters, meanwhile, CAN change
// after that: getWorkflow() lazily (and now more often, since it also folds
// duplicate field parameters together — see workflowUpgrader.js) upgrades a
// stored workflow's parameter set on every single load. Without this, the
// "My APIs" UI could keep showing an outdated parameter list — missing a
// parameter that now exists, or still offering to edit one that was folded
// into another and no longer exists — even though /run has already moved
// on to the current set. Overlaying the live parameters here is what keeps
// "what the UI lets you edit" and "what the backend will actually use"
// from drifting apart; every other My APIs field still comes from its own
// stored record untouched.
const withLiveParameters = (item) => {
  if (!item || !item.workflowId) {
    return item;
  }
  const workflow = getWorkflow(item.workflowId);
  if (!workflow) {
    return item;
  }
  return { ...item, parameters: workflow.parameters };
};

const listMyApis = (req, res) => {
  const own = myApisStore.listByOwner(req.user.id).map(withLiveParameters);
  console.log('[Backend][pipeline] step 7: GET /api/my-apis', {
    userId: req.user?.id,
    ownedByThisUser: own.length
  });
  res.json(own);
};

const getMyApiById = (req, res) => {
  const item = myApisStore.getById(req.params.id);
  if (!item || item.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  res.json(withLiveParameters(item));
};

// Shared by the createMyApi route and by workflowController.parameterize, so
// a recorded workflow shows up in "My APIs" the same way a manually created
// one would, without going through HTTP.
const buildMyApiRecord = (payload = {}) => myApisStore.create(payload);

const createMyApi = (req, res) => {
  try {
    const api = buildMyApiRecord({ ...req.body, ownerId: req.user.id });
    return res.status(201).json(api);
  } catch (err) {
    console.error('[Backend] createMyApi error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Deleting an API is a real delete now, not just "hide it from the list":
// the My APIs record, its underlying workflow (so its /run endpoint stops
// working), and any marketplace listing for it are all removed together.
const deleteMyApi = (req, res) => {
  const item = myApisStore.getById(req.params.id);
  if (!item || item.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }

  // Foreign keys point child -> parent (marketplace_listings -> my_apis ->
  // workflows), so deletes must go in that same order or SQLite's FK
  // enforcement rejects deleting a row something else still references.
  marketplaceStore.removeByMyApiId(item.id);
  myApisStore.deleteById(item.id);
  if (item.workflowId) {
    deleteWorkflow(item.workflowId);
  }

  return res.json({ success: true });
};

const publishMyApi = (req, res) => {
  const item = myApisStore.getById(req.params.id);
  if (!item || item.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }

  // Allow a body flag { published: true/false } to toggle publish state
  const body = req.body || {};
  const published = typeof body.published === 'boolean' ? body.published : true;

  // A price is only meaningful (and required) when actually publishing —
  // unpublishing never touches it. The ForgeFlow pricing modal
  // (extension/shared/pricingModal.js) already enforces "> 0" client-side
  // before this request is ever sent; this is the server-side backstop so
  // the requirement holds regardless of caller.
  let price = item.price;
  if (published) {
    if (typeof body.price === 'undefined') {
      return res.status(400).json({ success: false, message: 'A price is required to publish this API.' });
    }
    const parsedPrice = Number(body.price);
    if (Number.isNaN(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Price must be a number greater than 0.' });
    }
    price = parsedPrice;
    myApisStore.updatePrice(item.id, price);
  }

  const updated = myApisStore.setPublished(item.id, published);

  // Mirror the publish state onto the linked workflow's visibility — that's
  // what workflowController.run actually checks to decide whether a
  // non-owner can call it. Without this, "publish" would only flip a label
  // in My APIs without ever making the API actually runnable by anyone else.
  if (item.workflowId) {
    setVisibility(item.workflowId, published ? 'public' : 'private');
  }

  // Single authoritative sync point for the Marketplace listing, so it
  // persists and stays visible after a restart regardless of whether the
  // caller also happens to hit the separate (legacy) /marketplace/publish
  // route — see marketplaceController.js.
  if (published) {
    // An optional note from the pricing modal becomes the listing's
    // description; leaving it blank keeps the API's existing description
    // instead of blanking it out.
    const description = typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : item.description;

    marketplaceStore.upsertForMyApi({
      myApiId: item.id,
      ownerId: item.ownerId,
      name: item.name,
      description,
      method: item.method,
      version: item.version,
      endpoint: item.endpoint,
      price,
      publisher: req.user.name || req.user.email
    });
  } else {
    marketplaceStore.removeByMyApiId(item.id);
  }

  return res.json({ success: true, message: updated.published ? 'API published.' : 'API unpublished.' });
};

module.exports = {
  listMyApis,
  getMyApiById,
  createMyApi,
  deleteMyApi,
  publishMyApi,
  buildMyApiRecord
};
