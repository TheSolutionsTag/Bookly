const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

let counter = 0;

/**
 * Creates a real user row (hashed password) and returns an
 * Authorization header value for it, exercising the same auth path the
 * app uses at runtime rather than forging a token by hand.
 */
async function createUserAndAuthHeader(role = 'ADMIN') {
  counter += 1;
  const email = `test-${role.toLowerCase()}-${Date.now()}-${counter}@example.com`;
  const password = 'test-password-123';
  const passwordHash = await bcrypt.hash(password, 4); // low cost factor - tests only
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)`,
    ['Test User', email, passwordHash, role]
  );
  return { email, password };
}

module.exports = { createUserAndAuthHeader };
