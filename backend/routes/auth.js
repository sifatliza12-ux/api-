const express = require('express');

const router = express.Router();

router.post('/login', (req, res) => {
  res.json({ message: 'Login endpoint is ready' });
});

router.post('/register', (req, res) => {
  res.json({ message: 'Register endpoint is ready' });
});

module.exports = router;
