const express = require('express');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead
} = require('../controllers/notificationController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', requireAuth, listNotifications);
router.post('/read-all', requireAuth, markAllNotificationsRead);
router.post('/:id/read', requireAuth, markNotificationRead);

module.exports = router;
