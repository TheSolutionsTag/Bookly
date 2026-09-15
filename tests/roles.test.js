require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

async function login(role) {
  const { email, password } = await createUserAndAuthHeader(role);
  const res = await request(app).post('/auth/login').send({ email, password });
  return res.body.token;
}

describe('Role-based access control', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('rejects bad credentials with 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('STAFF cannot create a resource (403), ADMIN can (201)', async () => {
    const staffToken = await login('STAFF');
    const adminToken = await login('ADMIN');

    const staffAttempt = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Should Fail', timezone: 'UTC', slot_duration_minutes: 30 });
    expect(staffAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Should Succeed', timezone: 'UTC', slot_duration_minutes: 30 });
    expect(adminAttempt.status).toBe(201);
  });

  test('STAFF cannot manage users (403)', async () => {
    const staffToken = await login('STAFF');
    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'New Person', email: 'new-person@example.com', password: 'supersecret1', role: 'STAFF' });
    expect(res.status).toBe(403);
  });

  test('STAFF can list appointments (broad query) but anonymous cannot', async () => {
    const staffToken = await login('STAFF');

    const anonAttempt = await request(app).get('/appointments?status=CONFIRMED');
    expect(anonAttempt.status).toBe(401);

    const staffAttempt = await request(app)
      .get('/appointments?status=CONFIRMED')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffAttempt.status).toBe(200);
  });

  test('a request with no token is rejected on admin-only routes', async () => {
    const res = await request(app)
      .post('/resources')
      .send({ name: 'No Token', timezone: 'UTC', slot_duration_minutes: 30 });
    expect(res.status).toBe(401);
  });
});
