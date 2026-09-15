const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const logger = require('../logger');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('Database schema applied successfully');
  await pool.end();
}

migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
