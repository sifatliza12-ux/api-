const jwt = require('jsonwebtoken');
const { findById } = require('../models/User');

// Protects a route: requires "Authorization: Bearer <token>", verifies it
// against JWT_SECRET, and attaches the corresponding user as req.user.
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = findById(payload.sub);

    if (!user) {
      return res.status(401).json({ success: false, message: 'User no longer exists.' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

// Identifies the caller if a valid token is present, but never rejects the
// request when it's absent/invalid — for routes like running a workflow,
// where a published (public) workflow must stay callable by anyone, but a
// private one still needs to know who's asking so ownership can be checked
// inside the route handler itself.
const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next();
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = findById(payload.sub);
    if (user) {
      req.user = user;
    }
  } catch (err) {
    // Invalid/expired token on an optional-auth route just means "treat as
    // anonymous" — the route decides whether that's allowed.
  }

  return next();
};

module.exports = { requireAuth, optionalAuth };
