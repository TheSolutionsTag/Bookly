const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://postgres:postgres@localhost:5455/postgres';
const TEST_DB_NAME = 'helebooker_test';
const TEST_URL = process.env.TEST_DATABASE_URL || `postgres://postgres:postgres@localhost:5455/${TEST_DB_NAME}`;

module.exports = async function globalSetup() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  }
  await admin.end();

  const testClient = new Client({ connectionString: TEST_URL });
  await testClient.connect();
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  await testClient.query(schema);
  // Start every test run from a clean slate.
  await testClient.query(
    'TRUNCATE appointments, availability_exceptions, availability_rules, resources, users CASCADE'
  );
  await testClient.end();
};
