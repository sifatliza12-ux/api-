const express = require('express');
const { parameterize, list, run, test, updateExtractionHint } = require('../controllers/workflowController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, list);
router.post('/parameterize', requireAuth, parameterize);
// Not requireAuth: a published (public) workflow must stay callable by
// anonymous/other users. optionalAuth identifies the caller when possible so
// the controller can still enforce ownership on private workflows.
router.post('/:workflowId/run', optionalAuth, run);
// Owner-only, always uses stored defaults — see workflowController.test.
router.post('/:workflowId/test', requireAuth, test);
// Owner-only: sets/clears the CSS selector the extraction pipeline checks
// first before falling back to DOM auto-detection.
router.patch('/:workflowId/extraction-hint', requireAuth, updateExtractionHint);

module.exports = router;
