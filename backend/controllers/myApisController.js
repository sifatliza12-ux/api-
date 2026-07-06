const { setVisibility } = require('../services/workflowStore');

let nextId = 1;

// In-memory store for generated APIs
// TODO: Replace this with a persistent database (MongoDB, Postgres, etc.)
const myApisStore = [];

// A my-apis record created from a recorded workflow always has this
// endpoint shape (see workflowController.parameterize) — used to find the
// linked workflow so publish/unpublish can also flip its runtime visibility.
const WORKFLOW_RUN_ENDPOINT_PATTERN = /^\/api\/workflows\/(.+)\/run$/;

const listMyApis = (req, res) => {
  const own = myApisStore.filter((api) => api.ownerId === req.user.id);
  res.json(own);
};

const getMyApiById = (req, res) => {
  const id = Number(req.params.id);
  const item = myApisStore.find((a) => a.id === id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  if (item.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  res.json(item);
};

// Shared by the createMyApi route and by workflowController.parameterize, so
// a recorded workflow shows up in "My APIs" the same way a manually created
// one would, without going through HTTP.
const buildMyApiRecord = (payload = {}) => {
  const api = {
    id: nextId++,
    name: payload.name || 'Untitled API',
    version: payload.version || 'v1.0',
    method: payload.method || 'POST',
    endpoint: payload.endpoint || '/api/v1/unknown',
    generatedCode: payload.generatedCode || '',
    parameters: Array.isArray(payload.parameters) ? payload.parameters : [],
    published: !!payload.published,
    ownerId: payload.ownerId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  myApisStore.unshift(api);
  return api;
};

const createMyApi = (req, res) => {
  try {
    const api = buildMyApiRecord({ ...req.body, ownerId: req.user.id });
    return res.status(201).json(api);
  } catch (err) {
    console.error('[Backend] createMyApi error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const deleteMyApi = (req, res) => {
  const id = Number(req.params.id);
  const idx = myApisStore.findIndex((a) => a.id === id);
  if (idx === -1 || myApisStore[idx].ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  myApisStore.splice(idx, 1);
  return res.json({ success: true });
};

const publishMyApi = (req, res) => {
  const id = Number(req.params.id);
  const item = myApisStore.find((a) => a.id === id);
  if (!item || item.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  // Allow a body flag { published: true/false } to toggle publish state
  const body = req.body || {};
  item.published = typeof body.published === 'boolean' ? body.published : true;
  item.updatedAt = new Date().toISOString();

  // Mirror the publish state onto the linked workflow's visibility — that's
  // what workflowController.run actually checks to decide whether a
  // non-owner can call it. Without this, "publish" would only flip a label
  // in My APIs without ever making the API actually runnable by anyone else.
  const match = item.endpoint.match(WORKFLOW_RUN_ENDPOINT_PATTERN);
  if (match) {
    setVisibility(match[1], item.published ? 'public' : 'private');
  }

  return res.json({ success: true, message: item.published ? 'API published.' : 'API unpublished.' });
};

module.exports = {
  listMyApis,
  getMyApiById,
  createMyApi,
  deleteMyApi,
  publishMyApi,
  buildMyApiRecord,
  // Expose store for tests or future persistence migration
  __store: myApisStore
};
