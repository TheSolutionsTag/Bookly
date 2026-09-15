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

describe('Zoom integration', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('STAFF is forbidden from every /integrations/zoom admin route', async () => {
    const staffToken = await loginAs('STAFF');

    const connectUrl = await request(app)
      .get('/integrations/zoom/connect-url')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(connectUrl.status).toBe(403);

    const status = await request(app).get('/integrations/zoom/status').set('Authorization', `Bearer ${staffToken}`);
    expect(status.status).toBe(403);

    const disconnect = await request(app)
      .post('/integrations/zoom/disconnect')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(disconnect.status).toBe(403);
  });

  test('STAFF cannot set a resource video provider, ADMIN can, independently of any calendar provider', async () => {
    const adminToken = await loginAs('ADMIN');
    const staffToken = await loginAs('STAFF');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Zoom Video Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    const staffAttempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ provider: 'zoom' });
    expect(staffAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'zoom' });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.video_provider).toBe('zoom');
    // No calendar provider was ever set on this resource - video provider is independent.
    expect(adminAttempt.body.calendar_provider).toBeNull();
  });

  test('a Zoom-enabled resource books successfully with no join URL when Zoom is not actually connected (resilience)', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Unconnected Zoom Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'zoom' });

    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

    const booking = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Katherine Johnson',
      customer_email: 'katherine@example.com',
    });
    expect(booking.status).toBe(201);
    expect(booking.body.zoom_join_url).toBeNull();
    expect(booking.body.zoom_meeting_id).toBeNull();

    // Cancel must also succeed cleanly even though there's no real meeting
    // to delete.
    const cancelled = await request(app).post(`/appointments/${booking.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
  });
});
