const express = require('express');
const { parameterize, list, run } = require('../controllers/workflowController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, list);
router.post('/parameterize', requireAuth, parameterize);
// Not requireAuth: a published (public) workflow must stay callable by
// anonymous/other users. optionalAuth identifies the caller when possible so
// the controller can still enforce ownership on private workflows.
router.post('/:workflowId/run', optionalAuth, run);

module.exports = router;
