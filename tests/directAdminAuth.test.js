require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createApiKey } = require('../src/lib/apiKeys');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

// Part B item 6 — the admin-chat automation (ChatMate360) authenticates
// admin actions by forwarding the logged-in admin's own real Bookly JWT
// and letting BOOKLY be the one that decides whether it's actually an
// ADMIN. This is the test that Bookly's own ADMIN check — the ultimate
// authorization boundary, completely independent of anything ChatMate360
// does — actually holds on its own. Exercises the real HTTP API directly,
// no mocking, no going through ChatMate360 at all.
describe('Bookly admin-only endpoints — the real, independent authorization boundary (Part B item 6)', () => {
  afterAll(async () => {
    await pool.end();
  });

  async function createResource(token) {
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Direct Auth Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    return res.body.id;
  }

  test('a public/resource-scoped API key against an admin-only endpoint is rejected', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const resourceId = await createResource(loginRes.body.token);

    const { key: apiKey } = await createApiKey({ label: 'scoped-key-test', resourceId });

    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'Should Be Rejected', timezone: 'UTC', slot_duration_minutes: 30 });

    // An API key is not a JWT at all — Bookly's `authenticate` middleware
    // (jwt.verify) rejects it outright with 401, never reaching the
    // ADMIN-role check. Either way it's REJECTED, which is what matters:
    // a resource-scoped booking key must never be usable for admin writes.
    expect(res.status).toBe(401);
    const { rows } = await pool.query('SELECT id FROM resources WHERE name = $1', ['Should Be Rejected']);
    expect(rows).toHaveLength(0);
  });

  test('a STAFF session against an admin-only endpoint is rejected with 403', async () => {
    const { email, password } = await createUserAndAuthHeader('STAFF');
    const loginRes = await request(app).post('/auth/login').send({ email, password });

    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ name: 'Should Be Rejected Staff', timezone: 'UTC', slot_duration_minutes: 30 });

    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT id FROM resources WHERE name = $1', ['Should Be Rejected Staff']);
    expect(rows).toHaveLength(0);
  });

  test('no session/anonymous against an admin-only endpoint is rejected with 401', async () => {
    const res = await request(app)
      .post('/resources')
      .send({ name: 'Should Be Rejected Anon', timezone: 'UTC', slot_duration_minutes: 30 });

    expect(res.status).toBe(401);
    const { rows } = await pool.query('SELECT id FROM resources WHERE name = $1', ['Should Be Rejected Anon']);
    expect(rows).toHaveLength(0);
  });

  test('a real ADMIN session against the same endpoint succeeds', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });

    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ name: 'Should Succeed Admin', timezone: 'UTC', slot_duration_minutes: 30 });

    expect(res.status).toBe(201);
    const { rows } = await pool.query('SELECT id FROM resources WHERE name = $1', ['Should Succeed Admin']);
    expect(rows).toHaveLength(1);
  });
});
