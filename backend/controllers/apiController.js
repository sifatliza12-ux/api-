const sampleApis = [
  {
    id: 1,
    name: 'User Workflow API',
    method: 'POST',
    version: 'v1.0',
    status: 'Active'
  },
  {
    id: 2,
    name: 'Invoice Generator API',
    method: 'GET',
    version: 'v1.2',
    status: 'Draft'
  }
];

const listApis = (req, res) => {
  // TODO: Replace in-memory sample data with database-backed API storage.
  res.json(sampleApis);
};

module.exports = {
  listApis
};
