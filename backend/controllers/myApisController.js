let nextId = 1;

// In-memory store for generated APIs
// TODO: Replace this with a persistent database (MongoDB, Postgres, etc.)
const myApisStore = [];

const listMyApis = (req, res) => {
  res.json(myApisStore);
};

const getMyApiById = (req, res) => {
  const id = Number(req.params.id);
  const item = myApisStore.find((a) => a.id === id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  res.json(item);
};

const createMyApi = (req, res) => {
  try {
    const payload = req.body || {};
    const api = {
      id: nextId++,
      name: payload.name || 'Untitled API',
      version: payload.version || 'v1.0',
      method: payload.method || 'POST',
      endpoint: payload.endpoint || '/api/v1/unknown',
      generatedCode: payload.generatedCode || '',
      published: !!payload.published,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    myApisStore.unshift(api);

    // Return created resource
    return res.status(201).json(api);
  } catch (err) {
    console.error('[Backend] createMyApi error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const deleteMyApi = (req, res) => {
  const id = Number(req.params.id);
  const idx = myApisStore.findIndex((a) => a.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  myApisStore.splice(idx, 1);
  return res.json({ success: true });
};

const publishMyApi = (req, res) => {
  const id = Number(req.params.id);
  const item = myApisStore.find((a) => a.id === id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'API not found' });
  }
  // In a real implementation, this would interact with marketplace/payment systems
  // Allow a body flag { published: true/false } to toggle publish state
  const body = req.body || {};
  if (typeof body.published === 'boolean') {
    item.published = body.published;
  } else {
    item.published = true;
  }
  item.updatedAt = new Date().toISOString();

  return res.json({ success: true, message: item.published ? 'API published.' : 'API unpublished.' });
};

module.exports = {
  listMyApis,
  getMyApiById,
  createMyApi,
  deleteMyApi,
  publishMyApi,
  // Expose store for tests or future persistence migration
  __store: myApisStore
};
