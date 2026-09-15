// One-time bootstrap: creates the first ADMIN account so someone can log
// in and, from the Users screen, create every other account (staff or
// additional admins) from then on. Safe to re-run - it's a no-op if that
// email already exists.
const pool = require('./pool');
const config = require('../config');
const authService = require('../services/authService');
const logger = require('../logger');

async function seed() {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
    config.bootstrapAdminEmail.toLowerCase(),
  ]);

  if (rows.length > 0) {
    logger.info({ email: config.bootstrapAdminEmail }, 'Bootstrap admin already exists, skipping');
  } else {
    await authService.createUser({
      name: 'Admin',
      email: config.bootstrapAdminEmail,
      password: config.bootstrapAdminPassword,
      role: 'ADMIN',
    });
    logger.info({ email: config.bootstrapAdminEmail }, 'Bootstrap admin account created');
  }

  await pool.end();
}

seed().catch((err) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
