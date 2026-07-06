const express = require('express');
const { listApis } = require('../controllers/apiController');

const router = express.Router();

router.get('/', listApis);

module.exports = router;
