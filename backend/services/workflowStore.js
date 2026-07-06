// In-memory store, same pattern as myApisController's store — no persistence
// layer exists yet in this backend, so a saved workflow only lives as long
// as the server process does.
//
// Schema includes marketplace-facing fields (ownerId, visibility, price,
// description) even though no selling/listing functionality exists yet —
// this is deliberate so the shape doesn't need a migration later. They're
// all inert placeholders for now: ownerId is always null (no auth built
// yet), visibility is always 'private', price is always 0.
let nextId = 1;
const workflows = new Map();

const saveWorkflow = (data) => {
  const workflowId = String(nextId++);
  const workflow = {
    workflowId,
    name: data.name || `Workflow ${workflowId}`,
    description: data.description || '',
    parameters: data.parameters || [],
    steps: data.steps || [],
    ownerId: data.ownerId ?? null,
    visibility: data.visibility || 'private',
    price: data.price ?? 0,
    createdAt: new Date().toISOString()
  };
  workflows.set(workflowId, workflow);
  return workflow;
};

const getWorkflow = (workflowId) => workflows.get(workflowId) || null;

const listWorkflows = () => Array.from(workflows.values());

module.exports = { saveWorkflow, getWorkflow, listWorkflows };
