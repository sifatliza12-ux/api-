const myApisStore = require('../services/myApisStore');
const replayRunStore = require('../services/replayRunStore');

// ForgeFlow has one real plan today — Free. Marketplace APIs are priced
// individually by workflow complexity (see marketplaceStore.js), not by a
// subscription tier, so "the plan" only gates how much of the *builder*
// (generating + running your own APIs) a free account gets before an
// upgrade is needed.
const FREE_PLAN_LIMITS = {
  apiGenerations: 2,
  apiRuns: 2
};

// req.user is populated by requireAuth (routes/subscription.js) — usage is
// derived by counting this user's existing rows in tables that are already
// written by the (untouched) generation and run pipelines, so this is a
// read-only view over real data, not a new tracked counter.
const getSubscription = (req, res) => {
  const apiGenerationsUsed = myApisStore.countByOwner(req.user.id);
  const apiRunsUsed = replayRunStore.countByUser(req.user.id);

  res.json({
    plan: 'free',
    planLabel: 'Free Plan',
    limits: FREE_PLAN_LIMITS,
    usage: {
      apiGenerations: apiGenerationsUsed,
      apiRuns: apiRunsUsed
    },
    remaining: {
      apiGenerations: Math.max(0, FREE_PLAN_LIMITS.apiGenerations - apiGenerationsUsed),
      apiRuns: Math.max(0, FREE_PLAN_LIMITS.apiRuns - apiRunsUsed)
    },
    upgradeAvailable: true
  });
};

module.exports = {
  getSubscription
};
