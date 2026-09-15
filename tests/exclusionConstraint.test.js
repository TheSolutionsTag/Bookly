require('./env');

// This test bypasses the application layer entirely and drives two raw,
// concurrently-open Postgres transactions directly, to prove the guarantee
// lives in the database itself (EXCLUDE USING gist on appointments) - not
// just in the app's pre-insert availability check, whose timing can't be
// controlled from the HTTP layer.
const { Pool } = require('pg');
const config = require('../src/config');

const pool = new Pool({ connectionString: config.databaseUrl });

async function insertResource(client) {
  const { rows } = await client.query(
    `INSERT INTO resources (name, timezone, slot_duration_minutes) VALUES ('Exclusion Test', 'UTC', 30) RETURNING id`
  );
  return rows[0].id;
}

describe('appointments EXCLUDE USING gist constraint', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('a transaction that inserts an overlapping CONFIRMED range blocks, then fails with 23P01 once the first commits', async () => {
    const setupClient = await pool.connect();
    const resourceId = await insertResource(setupClient);
    setupClient.release();

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const insertSql = `
        INSERT INTO appointments (resource_id, customer_name, customer_email, start_time, end_time)
        VALUES ($1, $2, $3, '2026-09-14T10:00:00Z', '2026-09-14T10:30:00Z')
      `;

      // A inserts first and holds the transaction open (does not commit yet).
      await clientA.query(insertSql, [resourceId, 'Client A', 'a@example.com']);

      // B attempts the exact same overlapping range while A is still open.
      // Postgres will make B's INSERT block on A's uncommitted row rather
      // than immediately erroring - this is the real concurrency case.
      const bInsertPromise = clientB.query(insertSql, [resourceId, 'Client B', 'b@example.com']);

      // Give B's query a moment to actually reach the server and start
      // waiting on A's row before we let A proceed.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await clientA.query('COMMIT');

      // Now that A has committed, B's blocked INSERT re-validates against
      // the exclusion constraint and must fail.
      await expect(bInsertPromise).rejects.toMatchObject({ code: '23P01' });

      await clientB.query('ROLLBACK');

      const { rows } = await pool.query(
        `SELECT * FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED'`,
        [resourceId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].customer_email).toBe('a@example.com');
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
