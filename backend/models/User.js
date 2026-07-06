const bcrypt = require('bcrypt');

// In-memory store — same pattern as workflowStore.js and myApisController.js
// elsewhere in this backend; no database is wired up yet, so accounts only
// live as long as the server process does.
const SALT_ROUNDS = 10;

let nextId = 1;
const usersByEmail = new Map();

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const createUser = async ({ email, password, name }) => {
  const normalizedEmail = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);

  const user = {
    id: nextId++,
    email: normalizedEmail,
    passwordHash,
    name: name || normalizedEmail.split('@')[0],
    createdAt: new Date().toISOString()
  };

  usersByEmail.set(normalizedEmail, user);
  return user;
};

const findByEmail = (email) => usersByEmail.get(normalizeEmail(email)) || null;

const findById = (id) => {
  for (const user of usersByEmail.values()) {
    if (user.id === Number(id)) {
      return user;
    }
  }
  return null;
};

const verifyPassword = (user, password) => bcrypt.compare(String(password), user.passwordHash);

// Never send passwordHash to the client.
const toPublicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt
});

module.exports = { createUser, findByEmail, findById, verifyPassword, toPublicUser };
