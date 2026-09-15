require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function loginAs(role) {
  const { email, password } = await createUserAndAuthHeader(role);
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

describe('Google Calendar integration', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('STAFF is forbidden from every /integrations/google admin route', async () => {
    const staffToken = await loginAs('STAFF');

    const connectUrl = await request(app)
      .get('/integrations/google/connect-url')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(connectUrl.status).toBe(403);

    const status = await request(app).get('/integrations/google/status').set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(403);

    const disconnect = await request(app)
      .post('/integrations/google/disconnect')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(disconnect.status).toBe(403);
  });

  test('ADMIN sees "not configured" status when no Google credentials are set', async () => {
    const adminToken = await loginAs('ADMIN');
    const res = await request(app).get('/integrations/google/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    // configured reflects whatever GOOGLE_CLIENT_ID/etc happen to be set in the test env.
    expect(typeof res.body.configured).toBe('boolean');
  });

  test('STAFF cannot link a resource to a calendar, ADMIN can', async () => {
    const adminToken = await loginAs('ADMIN');
    const staffToken = await loginAs('STAFF');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Calendar Link Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    const staffAttempt = await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ provider: 'google', calendar_id: 'someone@example.com' });
    expect(staffAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google', calendar_id: 'someone@example.com' });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.calendar_provider).toBe('google');
    expect(adminAttempt.body.google_calendar_id).toBe('someone@example.com');
  });

  test('booking, cancelling, and rescheduling still work when a resource is linked to a calendar but no Google account is actually connected', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Unconnected Calendar Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google', calendar_id: 'nobody-is-actually-connected@example.com' });

    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

    // Availability lookup must not crash even though the linked calendar
    // has no real Google connection behind it.
    const slots = await request(app).get(`/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`);
    expect(slots.status).toBe(200);
    expect(Array.isArray(slots.body.available_slots)).toBe(true);

    const booking = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Grace Hopper',
      customer_email: 'grace@example.com',
    });
    expect(booking.status).toBe(201);
    expect(booking.body.google_event_id).toBeNull();

    const rescheduled = await request(app)
      .post(`/appointments/${booking.body.id}/reschedule`)
      .send({ start_time: '2026-09-14T11:00:00.000Z', duration: 30 });
    expect(rescheduled.status).toBe(201);

    const cancelled = await request(app).post(`/appointments/${rescheduled.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});
