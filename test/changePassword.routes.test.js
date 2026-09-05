'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { verifyPassword } = require('../src/auth/passwords');
const { ChangePasswordError } = require('../src/auth/changePassword');

const REGISTER_PAYLOAD = {
  email: 'rafael@example.com',
  password: 'super-secret-1',
  first_name: 'Rafael',
  last_name: 'Vilaça',
};

function setCookies(response) {
  return [].concat(response.headers['set-cookie'] ?? []);
}

async function registerAndLogin(app, email) {
  const registerPayload = email
    ? { ...REGISTER_PAYLOAD, email }
    : REGISTER_PAYLOAD;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerPayload });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: registerPayload.email, password: registerPayload.password },
  });
  assert.equal(login.statusCode, 200);
  const cookiePair = setCookies(login)[0].split(';')[0];
  return { login, cookiePair };
}

async function scenario() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const { cookiePair } = await registerAndLogin(app);
  return { db, app, cookiePair };
}

test('PUT /api/auth/password updates the password when the current password is correct', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('fresh-secret-2', stored.password_hash), true);
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), false);

  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com', password: 'super-secret-1' },
  });
  assert.equal(oldLogin.statusCode, 401);

  const newLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com', password: 'fresh-secret-2' },
  });
  assert.equal(newLogin.statusCode, 200);

  await app.close();
  db.close();
});

test('PUT /api/auth/password returns 401 for an incorrect current password', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'totally-wrong',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: 'Incorrect current password.',
    errors: ['incorrectCurrentPassword'],
  });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password returns 400 for mismatched new passwords', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'different-3',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Invalid password change request.',
    errors: ['passwordsMismatch'],
  });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password returns 400 when the new password is too short', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'short7',
      confirmNewPassword: 'short7',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Invalid password change request.',
    errors: ['passwordMinLength'],
  });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password returns every independent validation failure at once', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'short7',
      confirmNewPassword: 'different-3',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Invalid password change request.',
    errors: ['passwordMinLength', 'passwordsMismatch'],
  });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password returns every validation problem grouped together', async () => {
  const { db, app, cookiePair } = await scenario();

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Invalid password change request.',
    errors: ['currentRequired', 'newRequired', 'confirmRequired'],
  });

  await app.close();
  db.close();
});

test('PUT /api/auth/password requires authentication', async () => {
  const { db, app } = await scenario();

  const anonymous = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.json(), { error: 'Authentication required.' });

  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  assert.equal(await verifyPassword('super-secret-1', stored.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password changes only the authenticated users record', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const { cookiePair } = await registerAndLogin(app);
  await registerAndLogin(app, 'other@example.com');

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(response.statusCode, 200);

  const first = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rafael@example.com');
  const second = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('other@example.com');
  assert.equal(await verifyPassword('fresh-secret-2', first.password_hash), true);
  assert.equal(await verifyPassword('super-secret-1', second.password_hash), true);

  await app.close();
  db.close();
});

test('PUT /api/auth/password surfaces unexpected failures as HTTP 500', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    changeUserPassword: async () => {
      throw new Error('hash service down');
    },
  });
  const { cookiePair } = await registerAndLogin(app);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(response.statusCode, 500);

  await app.close();
  db.close();
});

test('PUT /api/auth/password omits the errors array when none were reported', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    changeUserPassword: async () => {
      throw new ChangePasswordError(400, 'Invalid request.');
    },
  });
  const { cookiePair } = await registerAndLogin(app);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie: cookiePair },
    payload: {
      currentPassword: 'super-secret-1',
      newPassword: 'fresh-secret-2',
      confirmNewPassword: 'fresh-secret-2',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Invalid request.' });

  await app.close();
  db.close();
});