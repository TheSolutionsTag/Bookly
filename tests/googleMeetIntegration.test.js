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

describe('Google Meet link generation (via Google Calendar sync)', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('cannot enable Google Meet on a resource that is not synced to Google Calendar - rejected at the settings-save step', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'No Calendar Sync Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    // Never synced to any calendar provider.
    const attempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google_meet' });
    expect(attempt.status).toBe(400);

    // And it must not have silently been saved.
    const check = await request(app).get('/resources');
    const found = check.body.find((r) => r.id === resourceId);
    expect(found.video_provider).toBeNull();
  });

  test('cannot enable Google Meet when the resource is synced to Microsoft instead of Google', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Microsoft Synced Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'microsoft', calendar_id: 'someone@outlook.com' });

    const attempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google_meet' });
    expect(attempt.status).toBe(400);
  });

  test('enabling Google Meet succeeds once the resource is synced to Google Calendar', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Google Synced Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google', calendar_id: 'primary' });

    const attempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google_meet' });
    expect(attempt.status).toBe(200);
    expect(attempt.body.video_provider).toBe('google_meet');
  });

  test('a Google-Meet-enabled, Google-synced resource still books successfully with no Meet URL when Google is not actually connected (resilience)', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Unconnected Google Meet Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google', calendar_id: 'primary' });

    await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google_meet' });

    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

    const booking = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Grace Hopper',
      customer_email: 'grace-meet@example.com',
    });
    expect(booking.status).toBe(201);
    expect(booking.body.google_meet_url).toBeNull();
    // Google Calendar sync itself wasn't connected either, so no event id.
    expect(booking.body.google_event_id).toBeNull();

    const cancelled = await request(app).post(`/appointments/${booking.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
  });

  test('STAFF is forbidden from setting a resource video provider (including google_meet)', async () => {
    const adminToken = await loginAs('ADMIN');
    const staffToken = await loginAs('STAFF');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Staff Forbidden Meet Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .patch(`/resources/${resourceId}/calendar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ provider: 'google', calendar_id: 'primary' });

    const attempt = await request(app)
      .patch(`/resources/${resourceId}/video-provider`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ provider: 'google_meet' });
    expect(attempt.status).toBe(403);
  });
});
