const getSubscription = (req, res) => {
  // TODO: Connect subscription plan data to persistent user accounts later.
  res.json({
    plan: 'Free Trial',
    remainingTrials: 5,
    upgradeAvailable: true
  });
};

module.exports = {
  getSubscription
};
