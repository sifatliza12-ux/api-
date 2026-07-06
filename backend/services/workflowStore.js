// In-memory store, same pattern as myApisController's store — no persistence
// layer exists yet in this backend, so a saved workflow only lives as long
// as the server process does.
//
// ownerId is set from the authenticated creator (see workflowController.js);
// visibility starts 'private' and only flips to 'public' when the linked My
// APIs record is published (see myApisController.publishMyApi), which is
// also what workflowController.run checks before allowing a non-owner to
// execute it. price stays an inert placeholder — no payment/purchase flow
// exists yet.
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

const setVisibility = (workflowId, visibility) => {
  const workflow = workflows.get(workflowId);
  if (!workflow) {
    return null;
  }
  workflow.visibility = visibility;
  return workflow;
};

module.exports = { saveWorkflow, getWorkflow, listWorkflows, setVisibility };
