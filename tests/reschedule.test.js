require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function createResourceWithMondayHours(name) {
  const { email, password } = await createUserAndAuthHeader('ADMIN');
  const loginRes = await request(app).post('/auth/login').send({ email, password });
  const token = loginRes.body.token;

  const resRes = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, timezone: 'UTC', slot_duration_minutes: 30 });
  const resourceId = resRes.body.id;

  await request(app)
    .post(`/resources/${resourceId}/availability-rules`)
    .set('Authorization', `Bearer ${token}`)
    .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

  return resourceId;
}

describe('POST /appointments/:id/reschedule', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('moves the appointment to the new time without ever double-booking', async () => {
    const resourceId = await createResourceWithMondayHours('Reschedule Resource A');

    const original = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Carol',
      customer_email: 'carol@example.com',
    });
    expect(original.status).toBe(201);

    const rescheduled = await request(app)
      .post(`/appointments/${original.body.id}/reschedule`)
      .send({ start_time: '2026-09-14T11:00:00.000Z', duration: 30 });

    expect(rescheduled.status).toBe(201);
    expect(rescheduled.body.start_time).toBe('2026-09-14T11:00:00.000Z');
    expect(rescheduled.body.status).toBe('CONFIRMED');
    expect(rescheduled.body.id).not.toBe(original.body.id);

    const oldFetch = await request(app).get(`/appointments/${original.body.id}`);
    expect(oldFetch.body.status).toBe('CANCELLED');
    expect(oldFetch.body.cancelled_at).not.toBeNull();

    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED'`,
      [resourceId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rescheduled.body.id);
  });

  test('refuses to reschedule into a slot already taken by another appointment', async () => {
    const resourceId = await createResourceWithMondayHours('Reschedule Resource B');

    const appointmentToMove = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Dave',
      customer_email: 'dave@example.com',
    });
    const blockingAppointment = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T13:00:00.000Z',
      duration: 30,
      customer_name: 'Erin',
      customer_email: 'erin@example.com',
    });
    expect(appointmentToMove.status).toBe(201);
    expect(blockingAppointment.status).toBe(201);

    const rescheduled = await request(app)
      .post(`/appointments/${appointmentToMove.body.id}/reschedule`)
      .send({ start_time: '2026-09-14T13:00:00.000Z', duration: 30 });

    expect(rescheduled.status).toBe(409);

    // The original appointment must still be CONFIRMED at its original time -
    // the failed reschedule must not have left it cancelled.
    const original = await request(app).get(`/appointments/${appointmentToMove.body.id}`);
    expect(original.body.status).toBe('CONFIRMED');
    expect(original.body.start_time).toBe('2026-09-14T10:00:00.000Z');

    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED'`,
      [resourceId]
    );
    expect(rows).toHaveLength(2);
  });
});
