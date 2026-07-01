const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Marketplace routes are available' });
});

module.exports = router;
