const db = require('../db');

// Generic notification feed shared by both creator and buyer events. No
// push/websocket transport exists — the bell UI (extension/shared/notifications.js)
// polls listForUser/unreadCount on an interval, matching every other
// "reload on demand" data flow already in this extension.
const rowToNotification = (row) => row && ({
  id: row.id,
  userId: row.user_id,
  type: row.type,
  title: row.title,
  body: row.body || '',
  link: row.link || '',
  read: Boolean(row.read),
  createdAt: row.created_at
});

const insertStmt = db.prepare(`
  INSERT INTO notifications (user_id, type, title, body, link, read, created_at)
  VALUES (@userId, @type, @title, @body, @link, 0, @createdAt)
`);
const listForUserStmt = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
const unreadCountStmt = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read = 0');
const markReadStmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?');
const markAllReadStmt = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?');

const create = ({ userId, type, title, body, link }) => {
  const result = insertStmt.run({
    userId: Number(userId),
    type: String(type),
    title: String(title),
    body: body || '',
    link: link || '',
    createdAt: new Date().toISOString()
  });
  return rowToNotification(db.prepare('SELECT * FROM notifications WHERE id = ?').get(result.lastInsertRowid));
};

const listForUser = (userId) => listForUserStmt.all(Number(userId)).map(rowToNotification);

const unreadCount = (userId) => unreadCountStmt.get(Number(userId)).count;

const markRead = (id, userId) => {
  markReadStmt.run(Number(id), Number(userId));
};

const markAllRead = (userId) => {
  markAllReadStmt.run(Number(userId));
};

module.exports = { create, listForUser, unreadCount, markRead, markAllRead };
