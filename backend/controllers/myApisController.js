const myApisStore = require('../services/myApisStore');
const marketplaceStore = require('../services/marketplaceStore');
const { setVisibility, deleteWorkflow } = require('../services/workflowStore');

const listMyApis = (req, res) => {
  const own = myApisStore.listByOwner(req.user.id);
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
  res.json(item);
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
    marketplaceStore.upsertForMyApi({
      myApiId: item.id,
      ownerId: item.ownerId,
      name: item.name,
      description: item.description,
      method: item.method,
      version: item.version,
      price: item.price,
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
