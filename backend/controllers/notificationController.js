const notificationStore = require('../services/notificationStore');

const listNotifications = (req, res) => {
  try {
    const notifications = notificationStore.listForUser(req.user.id);
    const unreadCount = notificationStore.unreadCount(req.user.id);
    return res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('[Backend] listNotifications error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const markNotificationRead = (req, res) => {
  try {
    notificationStore.markRead(req.params.id, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Backend] markNotificationRead error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

const markAllNotificationsRead = (req, res) => {
  try {
    notificationStore.markAllRead(req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Backend] markAllNotificationsRead error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = { listNotifications, markNotificationRead, markAllNotificationsRead };
