const express = require('express');
const { createSession, getSession, addMessage } = require('../controllers/aiCreatorController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// AI API Creator sessions are always owner-scoped — unlike a published
// workflow's /run endpoint, there is no anonymous/public use case here.
router.post('/sessions', requireAuth, createSession);
router.get('/sessions/:id', requireAuth, getSession);
router.post('/sessions/:id/messages', requireAuth, addMessage);

module.exports = router;
