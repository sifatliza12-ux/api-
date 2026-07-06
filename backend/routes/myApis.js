const express = require('express');
const { listMyApis, getMyApiById, createMyApi, deleteMyApi, publishMyApi } = require('../controllers/myApisController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/my-apis', requireAuth, listMyApis);
router.get('/my-apis/:id', requireAuth, getMyApiById);
router.post('/my-apis', requireAuth, createMyApi);
router.delete('/my-apis/:id', requireAuth, deleteMyApi);
router.post('/my-apis/:id/publish', requireAuth, publishMyApi);

module.exports = router;
