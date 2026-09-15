require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createApiKey, revokeApiKey } = require('../src/lib/apiKeys');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function adminToken() {
  const { email, password } = await createUserAndAuthHeader('ADMIN');
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

async function createResource(token, name) {
  const res = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, timezone: 'UTC', slot_duration_minutes: 30 });
  const resourceId = res.body.id;
  // Open every day of the week, all day - these tests care about
  // cross-tenant scoping, not availability-rule mechanics, so every
  // resource just needs to always be bookable.
  for (let day = 0; day <= 6; day += 1) {
    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${token}`)
      .send({ day_of_week: day, start_time: '00:00', end_time: '23:59' });
  }
  return resourceId;
}

describe('Scoped API keys - external-integration authentication (e.g. ChatMate360)', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('a request with no key at all is completely unaffected (backward-compatible public contract)', async () => {
    const token = await adminToken();
    const resourceId = await createResource(token, 'Unkeyed Resource');
    const res = await request(app)
      .post('/appointments')
      .send({
        resource_id: resourceId,
        start_time: '2026-09-15T10:00:00.000Z',
        duration: 30,
        customer_name: 'No Key Customer',
        customer_email: 'nokey@example.com',
      });
    expect(res.status).toBe(201);
  });

  test('an invalid/garbage API key is rejected outright, not silently treated as no key', async () => {
    const res = await request(app)
      .get('/appointments/00000000-0000-0000-0000-000000000000')
      .set('Authorization', 'Bearer bk_not_a_real_key');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test("a key scoped to Resource A cannot create, read, cancel, or reschedule any appointment for Resource B, even with B's real ids", async () => {
    const token = await adminToken();
    const resourceA = await createResource(token, 'Tenant A Resource');
    const resourceB = await createResource(token, 'Tenant B Resource');
    const { key: keyForA } = await createApiKey({ label: 'Chatbot A', resourceId: resourceA });

    // A real appointment that genuinely exists on Resource B.
    const bookB = await request(app).post('/appointments').send({
      resource_id: resourceB,
      start_time: '2026-09-16T10:00:00.000Z',
      duration: 30,
      customer_name: 'Tenant B Customer',
      customer_email: 'tenantb@example.com',
    });
    expect(bookB.status).toBe(201);
    const appointmentBId = bookB.body.id;

    // CREATE: keyForA tries to book directly onto Resource B.
    const createAttempt = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${keyForA}`)
      .send({
        resource_id: resourceB,
        start_time: '2026-09-16T11:00:00.000Z',
        duration: 30,
        customer_name: 'Cross Tenant Attempt',
        customer_email: 'attempt@example.com',
      });
    expect(createAttempt.status).toBe(404);

    // READ: keyForA tries to fetch B's real, known appointment id.
    const readAttempt = await request(app)
      .get(`/appointments/${appointmentBId}`)
      .set('Authorization', `Bearer ${keyForA}`);
    expect(readAttempt.status).toBe(404);

    // CANCEL: keyForA tries to cancel B's real, known appointment id.
    const cancelAttempt = await request(app)
      .post(`/appointments/${appointmentBId}/cancel`)
      .set('Authorization', `Bearer ${keyForA}`);
    expect(cancelAttempt.status).toBe(404);

    // RESCHEDULE: keyForA tries to reschedule B's real, known appointment id.
    const rescheduleAttempt = await request(app)
      .post(`/appointments/${appointmentBId}/reschedule`)
      .set('Authorization', `Bearer ${keyForA}`)
      .send({ start_time: '2026-09-16T13:00:00.000Z', duration: 30 });
    expect(rescheduleAttempt.status).toBe(404);

    // Confirm B's appointment was genuinely untouched by any of the above.
    const stillThere = await pool.query('SELECT status FROM appointments WHERE id = $1', [appointmentBId]);
    expect(stillThere.rows[0].status).toBe('CONFIRMED');

    // Sanity check: the SAME key legitimately operating on its OWN
    // resource (A) still works normally.
    const legitimateBooking = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${keyForA}`)
      .send({
        resource_id: resourceA,
        start_time: '2026-09-16T10:00:00.000Z',
        duration: 30,
        customer_name: 'Legit A Customer',
        customer_email: 'legita@example.com',
      });
    expect(legitimateBooking.status).toBe(201);
  });

  test('a revoked key is rejected on every operation type, not just the one it was first tested against', async () => {
    const token = await adminToken();
    const resourceId = await createResource(token, 'Revocation Test Resource');
    const { id: keyId, key: rawKey } = await createApiKey({ label: 'Revocation Test', resourceId });

    const booking = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({
        resource_id: resourceId,
        start_time: '2026-09-17T10:00:00.000Z',
        duration: 30,
        customer_name: 'Pre-revoke Customer',
        customer_email: 'prerevoke@example.com',
      });
    expect(booking.status).toBe(201);
    const appointmentId = booking.body.id;

    const wasRevoked = await revokeApiKey(keyId);
    expect(wasRevoked).toBe(true);

    const createAfterRevoke = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({
        resource_id: resourceId,
        start_time: '2026-09-17T11:00:00.000Z',
        duration: 30,
        customer_name: 'Post-revoke Customer',
        customer_email: 'postrevoke@example.com',
      });
    expect(createAfterRevoke.status).toBe(401);

    const readAfterRevoke = await request(app)
      .get(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${rawKey}`);
    expect(readAfterRevoke.status).toBe(401);

    const cancelAfterRevoke = await request(app)
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${rawKey}`);
    expect(cancelAfterRevoke.status).toBe(401);

    const rescheduleAfterRevoke = await request(app)
      .post(`/appointments/${appointmentId}/reschedule`)
      .set('Authorization', `Bearer ${rawKey}`)
      .send({ start_time: '2026-09-17T13:00:00.000Z', duration: 30 });
    expect(rescheduleAfterRevoke.status).toBe(401);

    const listAfterRevoke = await request(app)
      .get('/appointments')
      .query({ email: 'prerevoke@example.com' })
      .set('Authorization', `Bearer ${rawKey}`);
    expect(listAfterRevoke.status).toBe(401);
  });

  test('the raw key is never returned again after creation - the list endpoint exposes only the prefix', async () => {
    const token = await adminToken();
    const resourceId = await createResource(token, 'Leakage Check Resource');
    const created = await createApiKey({ label: 'Leakage Check', resourceId });

    const listRes = await request(app).get('/api-keys').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const row = listRes.body.find((k) => k.id === created.id);
    expect(row).toBeTruthy();
    expect(row.key_prefix).toBe(created.key_prefix);
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.key_hash).toBeUndefined();
  });
});
