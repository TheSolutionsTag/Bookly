require('./env');

const http = require('http');
const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const icsFeedService = require('../src/services/icsFeedService');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function loginAs(role) {
  const { email, password } = await createUserAndAuthHeader(role);
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

// A tiny real HTTP server standing in for Calendly/Acuity/etc - this
// proves the feature actually fetches and parses a real ICS response over
// the network, without depending on any external service being reachable
// or stable during test runs.
function startIcsServer(icsBody) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(icsBody);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const VALID_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-1@example.com
DTSTAMP:20260910T000000Z
DTSTART:20260914T130000Z
DTEND:20260914T133000Z
SUMMARY:Existing external booking
END:VEVENT
END:VCALENDAR
`;

describe('Generic ICS feed subscription', () => {
  let icsServer;
  let icsServerUrl;

  beforeAll(async () => {
    icsServer = await startIcsServer(VALID_ICS);
    icsServerUrl = `http://127.0.0.1:${icsServer.address().port}/feed.ics`;
  });

  afterAll(async () => {
    await new Promise((resolve) => icsServer.close(resolve));
    await pool.end();
  });

  test('STAFF is forbidden from adding or removing feeds, ADMIN can', async () => {
    const adminToken = await loginAs('ADMIN');
    const staffToken = await loginAs('STAFF');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ICS Feed Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    const staffAttempt = await request(app)
      .post(`/resources/${resourceId}/external-feeds`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ics_url: icsServerUrl, label: 'My Calendly' });
    expect(staffAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .post(`/resources/${resourceId}/external-feeds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ics_url: icsServerUrl, label: 'My Calendly' });
    expect(adminAttempt.status).toBe(201);
    expect(adminAttempt.body.last_fetch_status).toBe('ok');

    const staffDelete = await request(app)
      .delete(`/resources/${resourceId}/external-feeds/${adminAttempt.body.id}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffDelete.status).toBe(403);
  });

  test('a valid feed is validated and synced on creation, and its events correctly block matching available-slots times', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ICS Blocking Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

    // Before subscribing, 13:00-13:30 UTC on 2026-09-14 (a Monday) is open.
    const before = await request(app).get(`/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`);
    expect(before.body.available_slots).toContain('2026-09-14T13:00:00.000Z');

    const feedRes = await request(app)
      .post(`/resources/${resourceId}/external-feeds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ics_url: icsServerUrl, label: 'My Calendly' });
    expect(feedRes.status).toBe(201);

    // The feed's VEVENT occupies exactly 13:00-13:30 UTC - that slot must
    // now be excluded, and a booking attempt against it must be rejected.
    const after = await request(app).get(`/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`);
    expect(after.body.available_slots).not.toContain('2026-09-14T13:00:00.000Z');
    expect(after.body.available_slots).toContain('2026-09-14T13:30:00.000Z');

    const bookingAttempt = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T13:00:00.000Z',
      duration: 30,
      customer_name: 'Should Fail',
      customer_email: 'fail@example.com',
    });
    expect(bookingAttempt.status).toBe(409);
  });

  test('an unreachable feed URL is rejected with a clear 400 at creation time, and never saved', async () => {
    const adminToken = await loginAs('ADMIN');

    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Bad Feed Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    const res = await request(app)
      .post(`/resources/${resourceId}/external-feeds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ics_url: 'http://127.0.0.1:1/definitely-not-listening.ics', label: 'Broken feed' });
    expect(res.status).toBe(400);

    const feeds = await request(app).get(`/resources/${resourceId}/external-feeds`);
    expect(feeds.body).toHaveLength(0);
  });

  test('a feed that starts working then goes bad keeps its stale cache and marks status error, without blocking bookings', async () => {
    // A second tiny server we can shut down mid-test to simulate an outage.
    const flakyServer = await startIcsServer(VALID_ICS);
    const flakyUrl = `http://127.0.0.1:${flakyServer.address().port}/feed.ics`;

    const adminToken = await loginAs('ADMIN');
    const resourceRes = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Flaky Feed Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
    const resourceId = resourceRes.body.id;

    const feedRes = await request(app)
      .post(`/resources/${resourceId}/external-feeds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ics_url: flakyUrl, label: 'Flaky feed' });
    expect(feedRes.body.last_fetch_status).toBe('ok');

    await new Promise((resolve) => flakyServer.close(resolve));

    // A manual re-sync now fails (server is down), but must not throw and
    // must not wipe the previously-cached busy block.
    const { rows: feedRows } = await pool.query('SELECT * FROM external_calendar_feeds WHERE id = $1', [
      feedRes.body.id,
    ]);
    await icsFeedService.syncFeed(feedRows[0]);

    const { rows: updatedFeed } = await pool.query('SELECT * FROM external_calendar_feeds WHERE id = $1', [
      feedRes.body.id,
    ]);
    expect(updatedFeed[0].last_fetch_status).toBe('error');

    const { rows: cachedBlocks } = await pool.query(
      'SELECT * FROM external_feed_busy_blocks WHERE feed_id = $1',
      [feedRes.body.id]
    );
    expect(cachedBlocks.length).toBeGreaterThan(0);

    // And a normal booking on an unrelated time still works fine.
    await request(app)
      .post(`/resources/${resourceId}/availability-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });
    const booking = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Still Works',
      customer_email: 'works@example.com',
    });
    expect(booking.status).toBe(201);
  });
});
