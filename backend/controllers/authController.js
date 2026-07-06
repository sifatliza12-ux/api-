const jwt = require('jsonwebtoken');
const { createUser, findByEmail, verifyPassword, toPublicUser } = require('../models/User');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const TOKEN_EXPIRY = '7d';

const signToken = (user) => jwt.sign(
  { sub: user.id, email: user.email },
  process.env.JWT_SECRET,
  { expiresIn: TOKEN_EXPIRY }
);

const register = async (req, res) => {
  try {
    const { email, password, name } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    if (!EMAIL_PATTERN.test(String(email))) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    if (findByEmail(email)) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const user = await createUser({ email, password, name });
    const token = signToken(user);

    return res.status(201).json({ success: true, token, user: toPublicUser(user) });
  } catch (err) {
    console.error('[Backend] register failed', err);
    return res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = findByEmail(email);
    // Same message whether the email doesn't exist or the password is wrong
    // — don't reveal which half of the guess was correct.
    if (!user || !(await verifyPassword(user, password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = signToken(user);
    return res.json({ success: true, token, user: toPublicUser(user) });
  } catch (err) {
    console.error('[Backend] login failed', err);
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// req.user is populated by the requireAuth middleware.
const me = (req, res) => {
  return res.json({ success: true, user: toPublicUser(req.user) });
};

const logout = (req, res) => {
  // Stateless JWTs can't be revoked server-side without a blacklist, which is
  // out of scope for phase 1 — logout is actually enforced by the client
  // discarding its stored token. This endpoint (still auth-protected, so it
  // only succeeds for a currently-valid session) exists as the single place
  // a token blacklist would slot into later.
  return res.json({ success: true, message: 'Logged out.' });
};

module.exports = { register, login, me, logout };
