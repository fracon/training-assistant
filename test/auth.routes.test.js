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
      preferred_lang: 'en-US',
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
    user: {
      id: 1,
      email: 'rafael@example.com',
      first_name: 'Rafael',
      last_name: 'Vilaça',
      preferred_lang: 'en-US',
    },
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

test('anonymous visitors hitting protected paths are redirected to the login page', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  for (const url of ['/', '/training-result.html']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 302, url);
    assert.equal(response.headers.location, '/login.html', url);
  }

  await app.close();
  db.close();
});

test('GET /training-result.html serves the tool to authenticated users', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const response = await app.inject({
    method: 'GET',
    url: '/training-result.html',
    headers: { cookie: cookiePair },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /id="workoutForm"/);
  assert.match(response.body, /id="appView"/);
  assert.doesNotMatch(response.body, /id="logoutBtn"/);
  assert.match(response.body, /shared\/shell\.css/);
  assert.match(response.body, /unpkg\.com\/lucide/);

  await app.close();
  db.close();
});

test('GET / serves the TrainingResult tool to authenticated users', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const response = await app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: cookiePair },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /Training Result/);
  assert.match(response.body, /id="workoutForm"/);
  assert.match(response.body, /training-result\.js/);

  await app.close();
  db.close();
});

test('GET /login.html serves sign-in anonymously and redirects sessions home', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const anonymous = await app.inject({ method: 'GET', url: '/login.html' });
  assert.equal(anonymous.statusCode, 200);
  assert.match(anonymous.body, /Sign In/);
  assert.match(anonymous.body, /id="loginForm"/);
  assert.match(anonymous.body, /href="\/register\.html"/);
  assert.match(anonymous.body, /login\.js/);
  assert.match(anonymous.body, /class="lang-switch"/);
  assert.match(anonymous.body, /data-lang="pt-BR"/);
  assert.doesNotMatch(anonymous.body, /id="workoutForm"/);

  const authenticated = await app.inject({
    method: 'GET',
    url: '/login.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.statusCode, 302);
  assert.equal(authenticated.headers.location, '/');

  await app.close();
  db.close();
});

test('GET /register.html serves sign-up anonymously and redirects sessions home', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const anonymous = await app.inject({ method: 'GET', url: '/register.html' });
  assert.equal(anonymous.statusCode, 200);
  assert.match(anonymous.body, /Create Account/);
  assert.match(anonymous.body, /id="registerForm"/);
  assert.match(anonymous.body, /href="\/login\.html"/);
  assert.match(anonymous.body, /auth-error-box/);
  assert.match(anonymous.body, /register\.js/);
  assert.match(anonymous.body, /class="lang-switch"/);
  assert.match(anonymous.body, /id="preferredLang"/);
  assert.match(anonymous.body, /name="preferred_lang"/);

  const authenticated = await app.inject({
    method: 'GET',
    url: '/register.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.statusCode, 302);
  assert.equal(authenticated.headers.location, '/');

  await app.close();
  db.close();
});

test('shared assets and scripts are served publicly across pages', async () => {
  const app = await buildServer({});

  for (const asset of [
    '/shared/theme.css',
    '/login.css',
    '/register.css',
    '/training-result.css',
    '/form-state.js',
  ]) {
    const response = await app.inject({ method: 'GET', url: asset });
    assert.equal(response.statusCode, 200, asset);
  }

  const validators = await app.inject({ method: 'GET', url: '/shared/validators.js' });
  assert.equal(validators.statusCode, 200);
  assert.match(validators.body, /export function validateRegistration/);

  const api = await app.inject({ method: 'GET', url: '/shared/api.js' });
  assert.equal(api.statusCode, 200);
  assert.match(api.body, /export function signIn/);

  const i18nModule = await app.inject({ method: 'GET', url: '/shared/i18n.js' });
  assert.equal(i18nModule.statusCode, 200);
  assert.match(i18nModule.body, /export function createI18n/);

  const shellModule = await app.inject({ method: 'GET', url: '/shared/shell.js' });
  assert.equal(shellModule.statusCode, 200);
  assert.match(shellModule.body, /export async function initShell/);
  assert.match(shellModule.body, /data-lucide/);

  const shellStyles = await app.inject({ method: 'GET', url: '/shared/shell.css' });
  assert.equal(shellStyles.statusCode, 200);
  assert.match(shellStyles.body, /\.sidebar \{/);
  assert.match(shellStyles.body, /width 0\.3s ease/);

  for (const locale of ['/locales/en.json', '/locales/pt.json']) {
    const response = await app.inject({ method: 'GET', url: locale });
    assert.equal(response.statusCode, 200, locale);
    assert.match(response.headers['content-type'], /json/);
    assert.ok(JSON.parse(response.body).app.name);
  }

  await app.close();
});

test('auth routes are absent when no database is provided', async () => {
  const app = await buildServer({});

  for (const [method, url] of [
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/me'],
    ['PATCH', '/api/users/me/language'],
  ]) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
  }

  await app.close();
});

test('registration captures the preferred language selection', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...REGISTER_PAYLOAD, preferred_lang: 'pt-BR' },
  });
  assert.equal(register.statusCode, 201);
  assert.equal(register.json().preferred_lang, 'pt-BR');

  const me = await registerAndLogin(app).then(({ cookiePair }) =>
    app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookiePair } })
  );
  assert.equal(me.json().user.preferred_lang, 'pt-BR');

  await app.close();
  db.close();
});

test('registration defaults unknown or missing languages to en-US', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const junk = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...REGISTER_PAYLOAD, preferred_lang: 'fr-FR' },
  });
  assert.equal(junk.statusCode, 201);
  assert.equal(junk.json().preferred_lang, 'en-US');

  await app.close();
  db.close();
});

async function languageScenario() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const { cookiePair } = await registerAndLogin(app);
  return { db, app, cookiePair };
}

test('authenticated users can update their preferred language', async () => {
  const { db, app, cookiePair } = await languageScenario();

  const update = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/language',
    headers: { cookie: cookiePair },
    payload: { preferred_lang: 'pt-BR' },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), { preferred_lang: 'pt-BR' });

  const stored = db
    .prepare('SELECT preferred_lang FROM users WHERE email = ?')
    .get('rafael@example.com');
  assert.equal(stored.preferred_lang, 'pt-BR');

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: cookiePair },
  });
  assert.equal(me.json().user.preferred_lang, 'pt-BR');

  await app.close();
  db.close();
});

test('language updates canonicalize casing and whitespace', async () => {
  const { app, cookiePair } = await languageScenario();

  const update = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/language',
    headers: { cookie: cookiePair },
    payload: { preferred_lang: ' EN-us ' },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), { preferred_lang: 'en-US' });

  await app.close();
});

test('language updates reject unsupported values with 400', async () => {
  const { db, app, cookiePair } = await languageScenario();

  for (const preferred_lang of ['fr-FR', '', 'pt', null]) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/users/me/language',
      headers: { cookie: cookiePair },
      payload: { preferred_lang },
    });
    assert.equal(response.statusCode, 400, String(preferred_lang));
    assert.deepEqual(response.json(), { error: 'Unsupported language.' }, String(preferred_lang));
  }

  const noBody = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/language',
    headers: { cookie: cookiePair },
  });
  assert.equal(noBody.statusCode, 400);
  assert.deepEqual(noBody.json(), { error: 'Unsupported language.' });

  const unchanged = db
    .prepare('SELECT preferred_lang FROM users WHERE email = ?')
    .get('rafael@example.com');
  assert.equal(unchanged.preferred_lang, 'en-US');

  await app.close();
  db.close();
});

test('language updates require an authenticated session', async () => {
  const { db, app } = await languageScenario();

  const anonymous = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/language',
    payload: { preferred_lang: 'pt-BR' },
  });
  assert.equal(anonymous.statusCode, 401);

  const sessions = db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
  assert.equal(sessions.total, 1);

  await app.close();
  db.close();
});
