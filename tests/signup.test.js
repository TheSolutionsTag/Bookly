require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

describe('POST /auth/signup', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('creates a STAFF account that starts inactive and cannot log in until an admin approves it', async () => {
    const email = `new-signup-${Date.now()}@example.com`;
    const signup = await request(app)
      .post('/auth/signup')
      .send({ name: 'New Person', email, password: 'supersecret1' });
    expect(signup.status).toBe(201);
    expect(signup.body.user.role).toBe('STAFF');
    expect(signup.body.user.is_active).toBe(false);

    const loginBeforeApproval = await request(app).post('/auth/login').send({ email, password: 'supersecret1' });
    expect(loginBeforeApproval.status).toBe(401);

    const { email: adminEmail, password: adminPassword } = await createUserAndAuthHeader('ADMIN');
    const adminLogin = await request(app).post('/auth/login').send({ email: adminEmail, password: adminPassword });
    const adminToken = adminLogin.body.token;

    const usersList = await request(app).get('/users').set('Authorization', `Bearer ${adminToken}`);
    const created = usersList.body.find((u) => u.email === email.toLowerCase());
    expect(created.is_active).toBe(false);

    const reactivate = await request(app)
      .post(`/users/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.is_active).toBe(true);

    const loginAfterApproval = await request(app).post('/auth/login').send({ email, password: 'supersecret1' });
    expect(loginAfterApproval.status).toBe(200);
    expect(loginAfterApproval.body.user.role).toBe('STAFF');
  });

  test('rejects signup with an email that already exists', async () => {
    const email = `dup-signup-${Date.now()}@example.com`;
    const first = await request(app).post('/auth/signup').send({ name: 'A', email, password: 'supersecret1' });
    expect(first.status).toBe(201);

    const second = await request(app).post('/auth/signup').send({ name: 'B', email, password: 'anotherpass1' });
    expect(second.status).toBe(409);
  });
});
