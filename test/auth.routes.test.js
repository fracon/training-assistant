'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'Rafael@Example.com',
  password: 'super-secret-1',
  first_name: 'Rafael',
  last_name: 'Vilaça',
};

function setCookies(response) {
  return [].concat(response.headers['set-cookie'] ?? []);
}

async function registerAndLogin(app, payload = REGISTER_PAYLOAD) {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: payload.email, password: payload.password },
  });
  assert.equal(login.statusCode, 200);
  const cookiePair = setCookies(login)[0].split(';')[0];
  return { login, cookiePair };
}

test('login issues an http-only session cookie backed by a database row', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const { login } = await registerAndLogin(app);

  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json(), {
    user: {
      id: 1,
      email: 'rafael@example.com',
      first_name: 'Rafael',
      last_name: 'Vilaça',
    },
  });
  assert.ok(!login.body.includes('password_hash'));
  assert.ok(!login.body.includes('token'));

  const [cookie] = setCookies(login);
  assert.match(cookie, /^ta_session=[0-9a-f]{64}/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Secure/i);

  const sessions = db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
  assert.equal(sessions.total, 1);

  await app.close();
  db.close();
});

test('login omits the Secure flag when explicitly configured for plain HTTP', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const { login } = await registerAndLogin(app);

  const [cookie] = setCookies(login);
  assert.doesNotMatch(cookie, /Secure/i);
  assert.match(cookie, /HttpOnly/i);

  await app.close();
  db.close();
});

test('login rejects missing credentials with 400', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const empty = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.json(), { error: 'Email and password are required.' });

  const noPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com' },
  });
  assert.equal(noPassword.statusCode, 400);

  await app.close();
  db.close();
});

test('login never reveals whether the email exists', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: REGISTER_PAYLOAD });

  const unknownEmail = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'ghost@example.com', password: 'whatever-1' },
  });
  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com', password: 'totally-wrong' },
  });

  assert.equal(unknownEmail.statusCode, 401);
  assert.equal(wrongPassword.statusCode, 401);
  assert.deepEqual(unknownEmail.json(), wrongPassword.json());
  assert.deepEqual(wrongPassword.json(), { error: 'Invalid email or password.' });

  const sessions = db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
  assert.equal(sessions.total, 0);

  await app.close();
  db.close();
});

test('unexpected login failures surface as HTTP 500', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  await db.close();

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'rafael@example.com', password: 'super-secret-1' },
  });
  assert.equal(response.statusCode, 500);

  await app.close();
});

async function requireAuthScenario() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);
  return { db, app, cookiePair };
}

test('/api/me serves the authenticated profile from the session cookie', async () => {
  const { db, app, cookiePair } = await requireAuthScenario();

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookiePair } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    user: { id: 1, email: 'rafael@example.com', first_name: 'Rafael', last_name: 'Vilaça' },
  });

  await app.close();
  db.close();
});

test('/api/me rejects requests without or with invalid cookies', async () => {
  const { db, app } = await requireAuthScenario();

  const anonymous = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.json(), { error: 'Authentication required.' });

  const garbage = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: 'ta_session=deadbeef' },
  });
  assert.equal(garbage.statusCode, 401);

  const otherCookie = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: 'other=value' },
  });
  assert.equal(otherCookie.statusCode, 401);

  await app.close();
  db.close();
});

test('/api/me rejects expired sessions', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionTtlMs: 1 });
  const { cookiePair } = await registerAndLogin(app);

  await new Promise((resolve) => setTimeout(resolve, 20));

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookiePair } });
  assert.equal(me.statusCode, 401);

  await app.close();
  db.close();
});

test('logout deletes the session row and clears the cookie', async () => {
  const { db, app, cookiePair } = await requireAuthScenario();
  const token = cookiePair.replace('ta_session=', '');

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: cookiePair },
  });

  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json(), { status: 'ok' });

  const [clearCookie] = setCookies(logout);
  assert.match(clearCookie, /^ta_session=;/);
  assert.match(clearCookie, /Expires=Thu, 01 Jan 1970/i);
  assert.match(clearCookie, /HttpOnly/i);

  const remaining = db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE id = ?').get(token);
  assert.equal(remaining.total, 0);

  const meAfterLogout = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: cookiePair },
  });
  assert.equal(meAfterLogout.statusCode, 401);

  await app.close();
  db.close();
});

test('logout succeeds even without a session cookie', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json(), { status: 'ok' });
  assert.match(setCookies(logout)[0], /^ta_session=;/);

  await app.close();
  db.close();
});

test('GET / serves the authentication UI alongside the protected app shell', async () => {
  const app = await buildServer({});
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /id="authView"/);
  assert.match(response.body, /id="loginForm"/);
  assert.match(response.body, /id="registerForm"/);
  assert.match(response.body, /Sign In/);
  assert.match(response.body, /Create Account/);
  assert.match(response.body, /Don't have an account\? <strong>Register<\/strong>/);
  assert.match(response.body, /Already have an account\? <strong>Sign In<\/strong>/);
  assert.match(response.body, /id="logoutBtn"/);
  assert.match(response.body, /auth-ui\.js/);

  await app.close();
});

test('auth routes are absent when no database is provided', async () => {
  const app = await buildServer({});

  for (const [method, url] of [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/me'],
  ]) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
  }

  await app.close();
});
