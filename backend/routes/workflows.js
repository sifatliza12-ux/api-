const express = require('express');
const { parameterize, list, run, test, updateExtractionHint, myRunStats } = require('../controllers/workflowController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, list);
// Static path, registered before the /:workflowId routes below so it can
// never be shadowed by them (Express only matches /:workflowId/run when the
// second segment is literally "run", so there's no actual collision either
// way — this ordering is just for readability).
router.get('/stats/mine', requireAuth, myRunStats);
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
