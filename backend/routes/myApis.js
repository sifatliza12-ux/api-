const express = require('express');
const { listMyApis, getMyApiById, createMyApi, deleteMyApi } = require('../controllers/myApisController');

const router = express.Router();

router.get('/my-apis', listMyApis);
router.get('/my-apis/:id', getMyApiById);
router.post('/my-apis', createMyApi);
router.delete('/my-apis/:id', deleteMyApi);
router.post('/my-apis/:id/publish', (req, res) => {
	// Delegate to controller - keep route simple
	return require('../controllers/myApisController').publishMyApi(req, res);
});

module.exports = router;
