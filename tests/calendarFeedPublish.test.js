require('./env');

const request = require('supertest');
const ical = require('node-ical');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function loginAs(role) {
  const { email, password } = await createUserAndAuthHeader(role);
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

describe('Published calendar.ics feed', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('returns valid, parseable ICS containing exactly the resource real upcoming confirmed appointments, and rejects an invalid or missing token', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Published Feed Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resource = resourceRes.body;
    expect(resource.calendar_feed_token).toBeTruthy();

    await request(app)
      .post(`/resources/${resource.id}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

    const confirmed = await request(app).post('/appointments').send({
      resource_id: resource.id,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Private Customer Name',
      customer_email: 'private@example.com',
    });
    expect(confirmed.status).toBe(201);

    const cancelledOne = await request(app).post('/appointments').send({
      resource_id: resource.id,
      start_time: '2026-09-14T11:00:00.000Z',
      duration: 30,
      customer_name: 'Cancelled Customer',
      customer_email: 'cancelled@example.com',
    });
    await request(app).post(`/appointments/${cancelledOne.body.id}/cancel`);

    // No token at all.
    const noToken = await request(app).get(`/resources/${resource.id}/calendar.ics`);
    expect(noToken.status).toBe(403);

    // Wrong token.
    const badToken = await request(app).get(`/resources/${resource.id}/calendar.ics?token=not-the-real-token`);
    expect(badToken.status).toBe(403);

    // Correct token.
    const feedRes = await request(app).get(`/resources/${resource.id}/calendar.ics?token=${resource.calendar_feed_token}`);
    expect(feedRes.status).toBe(200);
    expect(feedRes.headers['content-type']).toMatch(/text\/calendar/);

    const parsed = ical.sync.parseICS(feedRes.text);
    const events = Object.values(parsed).filter((item) => item.type === 'VEVENT');
    expect(events).toHaveLength(1);
    expect(events[0].start.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    // Generic summary text only - never the customer's private name/email.
    expect(events[0].summary).not.toMatch(/Private Customer Name/);
  });

  test('regenerating the token invalidates the old one', async () => {
    const adminToken = await loginAs('ADMIN');
    const staffToken = await loginAs('STAFF');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Token Rotation Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resource = resourceRes.body;
    const oldToken = resource.calendar_feed_token;

    const staffAttempt = await request(app)
      .post(`/resources/${resource.id}/calendar-feed/regenerate-token`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffAttempt.status).toBe(403);

    const regenerate = await request(app)
      .post(`/resources/${resource.id}/calendar-feed/regenerate-token`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(regenerate.status).toBe(200);
    expect(regenerate.body.calendar_feed_token).not.toBe(oldToken);

    const withOldToken = await request(app).get(`/resources/${resource.id}/calendar.ics?token=${oldToken}`);
    expect(withOldToken.status).toBe(403);

    const withNewToken = await request(app).get(
      `/resources/${resource.id}/calendar.ics?token=${regenerate.body.calendar_feed_token}`
    );
    expect(withNewToken.status).toBe(200);
  });
});
