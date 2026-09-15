const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const config = require('../config');
const logger = require('../logger');
const { ApiError } = require('../middleware/errors');

const SALT_ROUNDS = 10;

function toPublicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, is_active: row.is_active };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email, name: user.name }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

async function login(email, password) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user || !user.is_active) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logger.warn({ email }, 'Login rejected: bad password');
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  logger.info({ user_id: user.id, role: user.role }, 'User logged in');
  return { token: issueToken(user), user: toPublicUser(user) };
}

async function createUser({ name, email, password, role, isActive = true }) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    throw new ApiError(409, 'CONFLICT', 'A user with that email already exists');
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, email.toLowerCase(), passwordHash, role, isActive]
  );
  logger.info({ user_id: rows[0].id, role, is_active: isActive }, 'User account created');
  return toPublicUser(rows[0]);
}

/**
 * Public self-signup. Unlike createUser (ADMIN-only, can set any role and
 * is active immediately), signups always land as STAFF and inactive - an
 * Admin has to approve (reactivate) the account from the Users screen
 * before it can log in. Keeps self-registration available without letting
 * anyone grant themselves access or a role.
 */
async function signup({ name, email, password }) {
  return createUser({ name, email, password, role: 'STAFF', isActive: false });
}

/**
 * Self-service profile update (name and/or email). Any logged-in user can
 * change their own name/email - this never touches role or is_active,
 * which stay ADMIN-controlled via the Users screen.
 */
async function updateProfile(id, { name, email }) {
  if (email) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [
      email.toLowerCase(),
      id,
    ]);
    if (existing.rows.length > 0) {
      throw new ApiError(409, 'CONFLICT', 'A user with that email already exists');
    }
  }
  const { rows } = await pool.query(
    `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email) WHERE id = $1 RETURNING *`,
    [id, name || null, email ? email.toLowerCase() : null]
  );
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  logger.info({ user_id: id }, 'User profile updated');
  return toPublicUser(rows[0]);
}

/**
 * Self-service password change. Requires the current password so a
 * hijacked but still-logged-in session token can't be used to lock the
 * real owner out by silently changing their password.
 */
async function changePassword(id, { currentPassword, newPassword }) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  const user = rows[0];

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
  logger.info({ user_id: id }, 'User password changed');
}

async function setUserActive(id, isActive) {
  const { rows } = await pool.query('UPDATE users SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive]);
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  logger.info({ user_id: id, is_active: isActive }, 'User account status changed');
  return toPublicUser(rows[0]);
}

async function listUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  return rows.map(toPublicUser);
}

module.exports = {
  login,
  createUser,
  signup,
  updateProfile,
  changePassword,
  setUserActive,
  listUsers,
  toPublicUser,
  issueToken,
};
