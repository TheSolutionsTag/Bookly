require('./env');

const crypto = require('crypto');
const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();
const SIGNING_KEY = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

function signPayload(bodyString, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${bodyString}`;
  const signature = crypto.createHmac('sha256', SIGNING_KEY).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function loginAsAdmin() {
  const { email, password } = await createUserAndAuthHeader('ADMIN');
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

async function createResourceWithMondayHours(token) {
  const resourceRes = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Calendly Webhook Test Resource', timezone: 'UTC', slot_duration_minutes: 30 });
  await request(app)
    .post(`/resources/${resourceRes.body.id}/availability-rules`)
    .set('Authorization', `Bearer ${token}`)
    .send({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });
  return resourceRes.body.id;
}

describe('Calendly webhook receiver', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('rejects a request with a tampered payload (signature computed over different bytes)', async () => {
    const adminToken = await loginAsAdmin();
    const resourceId = await createResourceWithMondayHours(adminToken);

    const realBody = {
      event: 'invitee.created',
      payload: {
        scheduled_event: {
          uri: 'https://api.calendly.com/scheduled_events/tampered-test',
          start_time: '2026-09-14T14:00:00.000000Z',
          end_time: '2026-09-14T14:30:00.000000Z',
        },
      },
    };
    // Sign a DIFFERENT body than what actually gets sent - simulates a
    // tampered/forged request.
    const signatureForDifferentBody = signPayload(JSON.stringify({ event: 'not.the.real.body' }));

    const res = await request(app)
      .post(`/webhooks/calendly/${resourceId}`)
      .set('Calendly-Webhook-Signature', signatureForDifferentBody)
      .send(realBody);

    expect(res.status).toBe(401);
  });

  test('rejects a request with no signature header at all', async () => {
    const adminToken = await loginAsAdmin();
    const resourceId = await createResourceWithMondayHours(adminToken);

    const res = await request(app)
      .post(`/webhooks/calendly/${resourceId}`)
      .send({ event: 'invitee.created', payload: { scheduled_event: {} } });
    expect(res.status).toBe(401);
  });

  test('a validly-signed invitee.created event blocks the corresponding slot, and invitee.canceled unblocks it', async () => {
    const adminToken = await loginAsAdmin();
    const resourceId = await createResourceWithMondayHours(adminToken);

    const eventUri = `https://api.calendly.com/scheduled_events/${resourceId}-test`;
    const payload = {
      event: 'invitee.created',
      payload: {
        scheduled_event: {
          uri: eventUri,
          start_time: '2026-09-14T14:00:00.000000Z',
          end_time: '2026-09-14T14:30:00.000000Z',
        },
      },
    };
    const bodyString = JSON.stringify(payload);
    const signature = signPayload(bodyString);

    const before = await request(app).get(`/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`);
    expect(before.body.available_slots).toContain('2026-09-14T14:00:00.000Z');

    const webhookRes = await request(app)
      .post(`/webhooks/calendly/${resourceId}`)
      .set('Calendly-Webhook-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyString);
    expect(webhookRes.status).toBe(200);

    const after = await request(app).get(`/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`);
    expect(after.body.available_slots).not.toContain('2026-09-14T14:00:00.000Z');

    // Now cancel it via the webhook and confirm the slot re-opens.
    const cancelPayload = { event: 'invitee.canceled', payload: { scheduled_event: { uri: eventUri } } };
    const cancelBodyString = JSON.stringify(cancelPayload);
    const cancelSignature = signPayload(cancelBodyString);

    const cancelWebhookRes = await request(app)
      .post(`/webhooks/calendly/${resourceId}`)
      .set('Calendly-Webhook-Signature', cancelSignature)
      .set('Content-Type', 'application/json')
      .send(cancelBodyString);
    expect(cancelWebhookRes.status).toBe(200);

    const afterCancel = await request(app).get(
      `/resources/${resourceId}/available-slots?date=2026-09-14&duration=30`
    );
    expect(afterCancel.body.available_slots).toContain('2026-09-14T14:00:00.000Z');
  });
});
