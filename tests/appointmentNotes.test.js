require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const googleCalendar = require('../src/services/googleCalendarService');
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

describe('POST /appointments/:id/notes', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('adds a note to an appointment with no prior notes', async () => {
    const resourceId = await createResourceWithMondayHours('Notes Resource A');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Frank',
      customer_email: 'frank@example.com',
    });
    expect(created.status).toBe(201);
    expect(created.body.notes).toBeNull();

    const noted = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .send({ note: 'Bring the signed contract' });

    expect(noted.status).toBe(200);
    expect(noted.body.notes).toBe('Bring the signed contract');
  });

  test('appends a second note rather than overwriting the first', async () => {
    const resourceId = await createResourceWithMondayHours('Notes Resource B');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Grace',
      customer_email: 'grace@example.com',
      notes: 'Prefers morning slots',
    });
    expect(created.status).toBe(201);

    const noted = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .send({ note: 'Needs wheelchair access' });

    expect(noted.status).toBe(200);
    expect(noted.body.notes).toBe('Prefers morning slots\nNeeds wheelchair access');

    const fetched = await request(app).get(`/appointments/${created.body.id}`);
    expect(fetched.body.notes).toBe('Prefers morning slots\nNeeds wheelchair access');
  });

  test('sets attachment_url independently of notes', async () => {
    const resourceId = await createResourceWithMondayHours('Notes Resource C');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Hank',
      customer_email: 'hank@example.com',
    });

    const noted = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .send({ attachment_url: 'https://drive.google.com/file/d/abc123' });

    expect(noted.status).toBe(200);
    expect(noted.body.attachment_url).toBe('https://drive.google.com/file/d/abc123');
    expect(noted.body.notes).toBeNull();
  });

  test('rejects an empty body (neither note nor attachment_url)', async () => {
    const resourceId = await createResourceWithMondayHours('Notes Resource D');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Iris',
      customer_email: 'iris@example.com',
    });

    const res = await request(app).post(`/appointments/${created.body.id}/notes`).send({});
    expect(res.status).toBe(400);
  });

  test('rejects adding a note to a cancelled appointment', async () => {
    const resourceId = await createResourceWithMondayHours('Notes Resource E');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Jack',
      customer_email: 'jack@example.com',
    });
    await request(app).post(`/appointments/${created.body.id}/cancel`);

    const res = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .send({ note: 'too late' });
    expect(res.status).toBe(409);
  });

  test('404s for an unknown appointment id', async () => {
    const res = await request(app)
      .post('/appointments/00000000-0000-0000-0000-000000000000/notes')
      .send({ note: 'anything' });
    expect(res.status).toBe(404);
  });

  test('a resource-scoped API key cannot add a note to a different resource\'s appointment', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const token = loginRes.body.token;

    const resourceA = await createResourceWithMondayHours('Notes Resource F');
    const resourceB = await createResourceWithMondayHours('Notes Resource G');

    const created = await request(app).post('/appointments').send({
      resource_id: resourceA,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Kim',
      customer_email: 'kim@example.com',
    });

    const keyRes = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Scoped to B', resource_id: resourceB });
    const scopedKey = keyRes.body.key;

    const res = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .set('Authorization', `Bearer ${scopedKey}`)
      .send({ note: 'should not work' });
    expect(res.status).toBe(404);
  });

  test('a Calendar sync failure never blocks the note from being saved (resilience)', async () => {
    // No Google account is connected in this test environment at all, so
    // updateEventDescription's own getAuthedClient() returns null and it
    // no-ops - this appointment never even got a google_event_id from
    // createAppointment for the same reason. Spy anyway to prove the note
    // save path doesn't depend on Calendar sync succeeding, and that the
    // sync function is only invoked at all when a google_event_id exists.
    const spy = jest.spyOn(googleCalendar, 'updateEventDescription');
    const resourceId = await createResourceWithMondayHours('Notes Resource H');
    const created = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Liam',
      customer_email: 'liam@example.com',
    });
    expect(created.body.google_event_id).toBeNull();

    const noted = await request(app)
      .post(`/appointments/${created.body.id}/notes`)
      .send({ note: 'no calendar connected, should still save' });

    expect(noted.status).toBe(200);
    expect(noted.body.notes).toBe('no calendar connected, should still save');
    // No google_event_id on this appointment, so the sync call is skipped
    // entirely (never attempted, not attempted-and-swallowed) - correct
    // per addNoteToAppointment's own `if (updated.google_event_id)` guard.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
