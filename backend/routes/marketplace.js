const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Marketplace routes are available' });
});

// POST /marketplace/publish
router.post('/publish', (req, res) => {
  // TODO: Implement authentication, validation, and persistence for real publishing.
  try {
    const payload = req.body || {};

    if (!payload.name || !payload.endpoint) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    return res.json({ success: true, message: 'API published successfully.' });
  } catch (err) {
    console.error('[API- backend] publish error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

module.exports = router;
