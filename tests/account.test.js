require('./env');

const request = require('supertest');
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { createUserAndAuthHeader } = require('./helpers');

const app = createApp();

describe('Self-service account management', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('a user can update their own name and email, and gets a fresh token back', async () => {
    const { email, password } = await createUserAndAuthHeader('STAFF');
    const login = await request(app).post('/auth/login').send({ email, password });
    const token = login.body.token;

    const newEmail = `updated-${Date.now()}@example.com`;
    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name', email: newEmail });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Updated Name');
    expect(res.body.user.email).toBe(newEmail.toLowerCase());
    expect(res.body.token).toBeDefined();

    // The new token reflects the updated email, and logging in with the
    // new email now works.
    const loginWithNewEmail = await request(app).post('/auth/login').send({ email: newEmail, password });
    expect(loginWithNewEmail.status).toBe(200);
  });

  test('cannot update to an email already used by another account', async () => {
    const userA = await createUserAndAuthHeader('STAFF');
    const userB = await createUserAndAuthHeader('STAFF');
    const loginB = await request(app).post('/auth/login').send(userB);
    const tokenB = loginB.body.token;

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: userA.email });
    expect(res.status).toBe(409);
  });

  test('changing password requires the correct current password, and the new password works afterward', async () => {
    const { email, password } = await createUserAndAuthHeader('ADMIN');
    const login = await request(app).post('/auth/login').send({ email, password });
    const token = login.body.token;

    const wrongCurrent = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'totally-wrong', new_password: 'brand-new-password1' });
    expect(wrongCurrent.status).toBe(401);

    const changed = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: password, new_password: 'brand-new-password1' });
    expect(changed.status).toBe(200);

    const oldPasswordLogin = await request(app).post('/auth/login').send({ email, password });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await request(app)
      .post('/auth/login')
      .send({ email, password: 'brand-new-password1' });
    expect(newPasswordLogin.status).toBe(200);
  });

  test('an unauthenticated request cannot update a profile or change a password', async () => {
    const noAuthProfile = await request(app).patch('/auth/me').send({ name: 'Nope' });
    expect(noAuthProfile.status).toBe(401);

    const noAuthPassword = await request(app)
      .post('/auth/change-password')
      .send({ current_password: 'x', new_password: 'y-new-password' });
    expect(noAuthPassword.status).toBe(401);
  });
});
