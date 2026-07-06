const express = require('express');
const { parameterize, list, run } = require('../controllers/workflowController');

const router = express.Router();

router.get('/', list);
router.post('/parameterize', parameterize);
router.post('/:workflowId/run', run);

module.exports = router;
