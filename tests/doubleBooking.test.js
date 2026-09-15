require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function createResourceWithMondayHours() {
  const { email, password } = await createUserAndAuthHeader('ADMIN');
  const loginRes = await request(app).post('/auth/login').send({ email, password });
  const token = loginRes.body.token;

  const resRes = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Concurrency Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
  const resourceId = resRes.body.id;

  await request(app)
    .post(`/resources/${resourceId}/availability-rules`)
    .set('Authorization', `Bearer ${token}`)
    .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

  return resourceId;
}

describe('Concurrent double-booking protection (DB exclusion constraint)', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('firing two simultaneous POST /appointments for the same slot: exactly one succeeds, the other gets 409', async () => {
    const resourceId = await createResourceWithMondayHours();
    const startTime = '2026-09-14T10:00:00.000Z'; // Monday, within working hours

    const bookingPayload = (name) => ({
      resource_id: resourceId,
      start_time: startTime,
      duration: 30,
      customer_name: name,
      customer_email: `${name.toLowerCase()}@example.com`,
    });

    // Fire both requests truly concurrently - no await between them.
    const [responseA, responseB] = await Promise.all([
      request(app).post('/appointments').send(bookingPayload('RaceA')),
      request(app).post('/appointments').send(bookingPayload('RaceB')),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const conflictResponse = responseA.status === 409 ? responseA : responseB;
    expect(conflictResponse.body.error.code).toBe('CONFLICT');

    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED'`,
      [resourceId]
    );
    expect(rows).toHaveLength(1);
  });
});
