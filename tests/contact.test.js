require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

describe('POST /contact', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('anyone can submit a message, and it is rejected with 400 when invalid', async () => {
    const good = await request(app)
      .post('/contact')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'How does the API handle timezones?' });
    expect(good.status).toBe(201);
    expect(good.body.id).toBeDefined();

    const bad = await request(app).post('/contact').send({ name: '', email: 'not-an-email', message: '' });
    expect(bad.status).toBe(400);
  });

  test('only ADMIN can list or mark messages read', async () => {
    const { email, password } = await createUserAndAuthHeader('STAFF');
    const loginRes = await request(app).post('/auth/login').send({ email, password });
    const staffToken = loginRes.body.token;

    const anonList = await request(app).get('/contact');
    expect(anonList.status).toBe(401);

    const staffList = await request(app).get('/contact').set('Authorization', `Bearer ${staffToken}`);
    expect(staffList.status).toBe(403);

    const adminCreds = await createUserAndAuthHeader('ADMIN');
    const adminLogin = await request(app).post('/auth/login').send(adminCreds);
    const adminToken = adminLogin.body.token;

    const submitted = await request(app)
      .post('/contact')
      .send({ name: 'Bob', email: 'bob@example.com', message: 'Pricing question' });

    const adminList = await request(app).get('/contact').set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(Array.isArray(adminList.body)).toBe(true);

    const markRead = await request(app)
      .post(`/contact/${submitted.body.id}/read`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(markRead.status).toBe(200);
    expect(markRead.body.read_at).not.toBeNull();
  });
});
