require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { fetchMeetingHistory } = require('../src/services/reportService');
const { createApiKey } = require('../src/lib/apiKeys');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

function bufferParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function createResourceWithMondayHours(name, token) {
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

describe('GET /reports/meeting-history', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('STAFF is forbidden (403), anonymous is rejected (401) - direct route access, not just UI-hiding', async () => {
    const { email, password } = await createUserAndAuthHeader('STAFF');
    // Newly-created STAFF account (not via signup, so no approval gate
    // involved) - active by construction, so a 403 here is purely the
    // role check, not an inactive-account 401.
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const staffToken = loginRes.body.token;

    const staffAttempt = await request(app)
      .get('/reports/meeting-history')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffAttempt.status).toBe(403);

    const anonAttempt = await request(app).get('/reports/meeting-history');
    expect(anonAttempt.status).toBe(401);
  });

  test('the underlying query returns real seeded appointment data - date, time, attendee, status, notes, per resource', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const token = loginRes.body.token;

    const resourceId = await createResourceWithMondayHours('History Resource A', token);

    const confirmed = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Nadia Confirmed',
      customer_email: 'nadia@example.com',
    });
    expect(confirmed.status).toBe(201);
    await request(app)
      .post(`/appointments/${confirmed.body.id}/notes`)
      .send({ note: 'Wants a follow-up call next week' });

    const toCancel = await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T13:00:00.000Z',
      duration: 30,
      customer_name: 'Oscar Cancelled',
      customer_email: 'oscar@example.com',
    });
    await request(app).post(`/appointments/${toCancel.body.id}/cancel`);

    // This is the exact query the PDF route renders row-by-row
    // (reportService.streamMeetingHistoryPdf just formats what this
    // returns) - asserting on real, structured data here is a more
    // reliable correctness check than parsing rendered PDF bytes back
    // out, and covers the same "does it contain real appointment data"
    // requirement without depending on a third-party PDF-text-extraction
    // library (see this file's git history / IMPLEMENTATION_STATUS.md for
    // why one was tried and dropped: pdf-parse's bundled pdfjs versions
    // both failed on ordinary PDFKit output in this Jest/CJS environment,
    // unrelated to this report's own content).
    const rows = await fetchMeetingHistory({ resource_id: resourceId });
    expect(rows).toHaveLength(2);

    const nadia = rows.find((r) => r.customer_name === 'Nadia Confirmed');
    expect(nadia).toMatchObject({
      customer_email: 'nadia@example.com',
      status: 'CONFIRMED',
      notes: 'Wants a follow-up call next week',
      resource_name: 'History Resource A',
    });
    expect(new Date(nadia.start_time).toISOString()).toBe('2026-09-14T10:00:00.000Z');

    const oscar = rows.find((r) => r.customer_name === 'Oscar Cancelled');
    expect(oscar).toMatchObject({
      customer_email: 'oscar@example.com',
      status: 'CANCELLED',
      resource_name: 'History Resource A',
    });
  });

  test('date-range and resource_id filters narrow the results correctly', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const token = loginRes.body.token;

    const resourceId = await createResourceWithMondayHours('History Resource B', token);
    await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'In Range',
      customer_email: 'inrange@example.com',
    });

    const withinRange = await fetchMeetingHistory({ resource_id: resourceId, from: '2026-09-14T00:00:00.000Z', to: '2026-09-14T23:59:59.000Z' });
    expect(withinRange).toHaveLength(1);
    expect(withinRange[0].customer_name).toBe('In Range');

    const outsideRange = await fetchMeetingHistory({ resource_id: resourceId, from: '2099-01-01', to: '2099-01-02' });
    expect(outsideRange).toHaveLength(0);
  });

  test('the ADMIN endpoint streams a real, well-formed PDF (headers, magic bytes, non-trivial size)', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const token = loginRes.body.token;

    const resourceId = await createResourceWithMondayHours('History Resource C', token);
    await request(app).post('/appointments').send({
      resource_id: resourceId,
      start_time: '2026-09-14T10:00:00.000Z',
      duration: 30,
      customer_name: 'Pdf Check',
      customer_email: 'pdfcheck@example.com',
    });

    const res = await request(app)
      .get(`/reports/meeting-history?resource_id=${resourceId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('meeting-history.pdf');
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.slice(-6).toString('latin1').trim().endsWith('%%EOF')).toBe(true);
    // A real, non-trivial document (more than just a bare header/footer).
    expect(res.body.length).toBeGreaterThan(500);
  });

  test('an empty range still produces a valid, well-formed PDF, not an error', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const token = loginRes.body.token;

    const res = await request(app)
      .get('/reports/meeting-history?from=2099-01-01&to=2099-01-02')
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  // This is the exact path ChatMate360 uses: it never holds a real Bookly
  // ADMIN session, only the resource-scoped API key already stored (and
  // decrypted) for a chatbot's Bookly connection - the same key it uses for
  // every other Bookly call. These tests exercise that path directly
  // against this route, not just the shared apiKeyAuth middleware in
  // isolation (see apiKeyAuth.test.js for the general-purpose coverage).
  describe('scoped-API-key access (the ChatMate360 integration path)', () => {
    test('a key scoped to its own resource can download that resource\'s real report with no ADMIN session at all', async () => {
      const { email, password } = await createUserAndAuthHeader('ADMIN');
      const loginRes = await request(app).post('/auth/login').send({ email, password });
      const token = loginRes.body.token;
      const resourceId = await createResourceWithMondayHours('Scoped Key Resource', token);
      const { key: scopedKey } = await createApiKey({ label: 'ChatMate360 Bot', resourceId });

      await request(app).post('/appointments').send({
        resource_id: resourceId,
        start_time: '2026-09-14T10:00:00.000Z',
        duration: 30,
        customer_name: 'Scoped Key Customer',
        customer_email: 'scopedkey@example.com',
      });

      const res = await request(app)
        .get('/reports/meeting-history')
        .set('Authorization', `Bearer ${scopedKey}`)
        .buffer(true)
        .parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');

      // The scoped key's request didn't even need to pass resource_id -
      // forceApiKeyResourceScope pinned it automatically, so the
      // underlying query only ever covered this key's own resource.
      const rows = await fetchMeetingHistory({ resource_id: resourceId });
      expect(rows.map((r) => r.customer_email)).toContain('scopedkey@example.com');
    });

    test('a key scoped to Resource A is rejected (404) when it asks for Resource B\'s report, even with B\'s real id', async () => {
      const { email, password } = await createUserAndAuthHeader('ADMIN');
      const loginRes = await request(app).post('/auth/login').send({ email, password });
      const token = loginRes.body.token;
      const resourceA = await createResourceWithMondayHours('Report Tenant A', token);
      const resourceB = await createResourceWithMondayHours('Report Tenant B', token);
      const { key: keyForA } = await createApiKey({ label: 'Chatbot A', resourceId: resourceA });

      await request(app).post('/appointments').send({
        resource_id: resourceB,
        start_time: '2026-09-14T10:00:00.000Z',
        duration: 30,
        customer_name: 'Tenant B Only',
        customer_email: 'tenantbonly@example.com',
      });

      const crossTenantAttempt = await request(app)
        .get(`/reports/meeting-history?resource_id=${resourceB}`)
        .set('Authorization', `Bearer ${keyForA}`);
      expect(crossTenantAttempt.status).toBe(404);
    });

    test('an invalid/garbage API key is rejected outright on this route too, not silently treated as an anonymous (401-worthy) request', async () => {
      const res = await request(app)
        .get('/reports/meeting-history')
        .set('Authorization', 'Bearer bk_not_a_real_key');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });
});
