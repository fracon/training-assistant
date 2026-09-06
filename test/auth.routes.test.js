'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');
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
      first_day_of_week: 'Monday',
      distance_unit: 'km',
      temperature_unit: 'C',
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
      first_day_of_week: 'Monday',
      distance_unit: 'km',
      temperature_unit: 'C',
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

  for (const url of ['/', '/home.html', '/training-result.html', '/cycles.html']) {
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
  assert.match(response.body, /id="feedbackRpe"/);
  assert.match(response.body, /id="appView"/);
  assert.doesNotMatch(response.body, /id="logoutBtn"/);
  assert.match(response.body, /shared\/shell\.css/);
  assert.match(response.body, /unpkg\.com\/lucide/);

  await app.close();
  db.close();
});

test('GET /cycles.html serves the cycles page to authenticated users', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const response = await app.inject({
    method: 'GET',
    url: '/cycles.html',
    headers: { cookie: cookiePair },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /id="cycleList"/);
  assert.match(response.body, /shared\/shell\.css/);

  await app.close();
  db.close();
});

test('non-calendar pages ship the user menu bundle, immune to the cycle guard', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const cycles = await app.inject({
    method: 'GET',
    url: '/cycles.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(cycles.statusCode, 200);
  assert.match(cycles.body, /shared\/shell\.js/, 'the cycles page loads the shell bundle');
  assert.match(cycles.body, /shared\/shell\.css/);

  const shell = await app.inject({ method: 'GET', url: '/shared/shell.js' });
  assert.equal(shell.statusCode, 200);
  assert.match(shell.body, /export function buildUserMenu/, 'the menu factory ships in the bundle');
  assert.match(shell.body, /user-dropdown hidden/, 'the dropdown container ships hidden');
  assert.match(shell.body, /badge\.appendChild\(icon\('chevron-down'\)\)/, 'the chevron ships inside the badge pill');
  assert.match(shell.body, /user-menu-item/, 'the change-password item ships in the dropdown');
  assert.match(shell.body, /shell\.changePassword/, 'the item is localized through the i18n key');
  assert.match(shell.body, /export function wireUserMenu/, 'the click wiring ships globally');
  assert.match(
    shell.body,
    /getElementById\('userChangePassword'\)\.addEventListener\('click', \(\) => \{\s*\n\s*openChangePasswordModal\(\);\s*\n\s*\}\);/,
    'the change-password item opens the modal from the served bundle'
  );
  assert.match(shell.body, /export function openChangePasswordModal\(/, 'the modal builder ships globally');
  assert.match(
    shell.body,
    /the cycle guard must never halt the shell mount/,
    'a guard failure cannot block the bundle from mounting the user menu'
  );

  await app.close();
  db.close();
});

test('GET / routes authenticated users to the home dashboard regardless of cycle state', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const withoutCycle = await app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: cookiePair },
  });

  assert.equal(withoutCycle.statusCode, 302);
  assert.equal(withoutCycle.headers.location, '/home.html');

  const created = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie: cookiePair },
    payload: { objective: 'Base phase' },
  });
  assert.equal(created.statusCode, 201);

  const withCycle = await app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: cookiePair },
  });

  assert.equal(withCycle.statusCode, 302);
  assert.equal(withCycle.headers.location, '/home.html');

  await app.close();
  db.close();
});

test('GET /home.html is gated and serves the dashboard to authenticated users', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { cookiePair } = await registerAndLogin(app);

  const anonymous = await app.inject({ method: 'GET', url: '/home.html' });
  assert.equal(anonymous.statusCode, 302);
  assert.equal(anonymous.headers.location, '/login.html');

  const authenticated = await app.inject({
    method: 'GET',
    url: '/home.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.match(authenticated.body, /id="heroBanner"/);
  assert.match(authenticated.body, /id="cycleOverviewTitle"/);
  assert.match(authenticated.body, /home\.js/);
  assert.match(authenticated.body, /shared\/shell\.js/);
  assert.match(authenticated.body, /shared\/shell\.css/);

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
  assert.match(anonymous.body, /auth-eyebrow.*Kinesis/s, 'login card shows the KINESIS eyebrow');
  assert.match(anonymous.body, /class="auth-header"/, 'login has a minimal auth header');
  assert.match(anonymous.body, /data-lang="en-US"/, 'login header contains EN switcher');
  assert.match(anonymous.body, /data-lang="pt-BR"/, 'login header contains PT switcher');
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
  assert.match(anonymous.body, /auth-eyebrow.*Kinesis/s, 'register card shows the KINESIS eyebrow');
  assert.match(anonymous.body, /class="auth-header"/, 'register has a minimal auth header');
  assert.match(anonymous.body, /data-lang="en-US"/, 'register header contains EN switcher');
  assert.match(anonymous.body, /data-lang="pt-BR"/, 'register header contains PT switcher');
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
  assert.match(shellModule.body, /FOOTER_ELEMENT_TAG = 'footer'/);
  assert.match(shellModule.body, /VERSION_ENDPOINT = '\/api\/version'/);
  assert.match(shellModule.body, /'nav-label sidebar-label'/);
  assert.match(shellModule.body, /'toggle-label sidebar-label'/);

  const shellStyles = await app.inject({ method: 'GET', url: '/shared/shell.css' });
  assert.equal(shellStyles.statusCode, 200);
  assert.match(shellStyles.body, /\.sidebar \{/);
  assert.match(shellStyles.body, /width 0\.3s ease/);
  assert.match(shellStyles.body, /overflow-y: auto/);
  assert.match(shellStyles.body, /\.bottom-bar \{/);
  assert.match(shellStyles.body, /\.app-shell\.collapsed \.sidebar-label \{[\s\S]*?display: none;/);
  assert.match(shellStyles.body, /\.app-shell\.collapsed \.soon-chip \{[\s\S]*?display: none;/);
  assert.match(shellStyles.body, /\.app-shell\.collapsed \.sidebar-footer \{[\s\S]*?justify-content: center;/);

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

async function calendarScenario() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const { cookiePair } = await registerAndLogin(app);
  return { db, app, cookiePair };
}

test('registration captures the first day of week preference', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...REGISTER_PAYLOAD, first_day_of_week: 'Sunday' },
  });
  assert.equal(register.statusCode, 201);
  assert.equal(register.json().first_day_of_week, 'Sunday');

  const { login, cookiePair } = await registerAndLogin(app, {
    ...REGISTER_PAYLOAD,
    email: 'sunday-runner@example.com',
    first_day_of_week: 'Sunday',
  });
  assert.equal(login.json().user.first_day_of_week, 'Sunday');

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: cookiePair },
  });
  assert.equal(me.json().user.first_day_of_week, 'Sunday');

  await app.close();
  db.close();
});

test('registration defaults unknown or missing week starts to Monday', async () => {
  for (const first_day_of_week of [undefined, 'Funday', '']) {
    const db = createDatabase({ filename: ':memory:' });
    const app = await buildServer({ db });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        ...REGISTER_PAYLOAD,
        email: `mon-${String(first_day_of_week)}@example.com`,
        first_day_of_week,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().first_day_of_week, 'Monday');

    await app.close();
    db.close();
  }
});

test('authenticated users can update their week start preference', async () => {
  const { db, app, cookiePair } = await calendarScenario();

  const update = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/calendar-preference',
    headers: { cookie: cookiePair },
    payload: { first_day_of_week: 'Sunday' },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), { first_day_of_week: 'Sunday' });

  const stored = db
    .prepare('SELECT first_day_of_week FROM users WHERE email = ?')
    .get('rafael@example.com');
  assert.equal(stored.first_day_of_week, 'Sunday');

  const backToMonday = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/calendar-preference',
    headers: { cookie: cookiePair },
    payload: { first_day_of_week: ' monday ' },
  });
  assert.deepEqual(backToMonday.json(), { first_day_of_week: 'Monday' });

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: cookiePair },
  });
  assert.equal(me.json().user.first_day_of_week, 'Monday');

  await app.close();
  db.close();
});

test('authenticated users can update all dashboard preferences', async () => {
  const { db, app, cookiePair } = await calendarScenario();
  const update = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/preferences',
    headers: { cookie: cookiePair },
    payload: { first_day_of_week: 'sunday', distance_unit: 'MI', temperature_unit: 'f' },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json(), {
    first_day_of_week: 'Sunday',
    distance_unit: 'mi',
    temperature_unit: 'F',
  });
  assert.deepEqual(
    db.prepare('SELECT first_day_of_week, distance_unit, temperature_unit FROM users WHERE email = ?')
      .get('rafael@example.com'),
    { first_day_of_week: 'Sunday', distance_unit: 'mi', temperature_unit: 'F' }
  );
  await app.close();
  db.close();
});

test('preferences updates reject unsupported values and anonymous requests', async () => {
  const { db, app, cookiePair } = await calendarScenario();
  for (const payload of [
    { first_day_of_week: 'Tuesday', distance_unit: 'km', temperature_unit: 'C' },
    { first_day_of_week: 'Monday', distance_unit: 'yards', temperature_unit: 'C' },
    { first_day_of_week: 'Monday', distance_unit: 'km', temperature_unit: 'K' },
    {},
  ]) {
    const response = await app.inject({
      method: 'PATCH', url: '/api/users/me/preferences', headers: { cookie: cookiePair }, payload,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'Unsupported preference.' });
  }
  const missingBody = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/preferences',
    headers: { cookie: cookiePair },
  });
  assert.equal(missingBody.statusCode, 400);
  assert.deepEqual(missingBody.json(), { error: 'Unsupported preference.' });
  const anonymous = await app.inject({ method: 'PATCH', url: '/api/users/me/preferences', payload: {} });
  assert.equal(anonymous.statusCode, 401);
  await app.close();
  db.close();
});

test('week start updates reject unsupported values with 400', async () => {
  const { db, app, cookiePair } = await calendarScenario();

  for (const first_day_of_week of ['Funday', '', 'Mon', null]) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/users/me/calendar-preference',
      headers: { cookie: cookiePair },
      payload: { first_day_of_week },
    });
    assert.equal(response.statusCode, 400, String(first_day_of_week));
    assert.deepEqual(
      response.json(),
      { error: 'Unsupported week start.' },
      String(first_day_of_week)
    );
  }

  const noBody = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/calendar-preference',
    headers: { cookie: cookiePair },
  });
  assert.equal(noBody.statusCode, 400);
  assert.deepEqual(noBody.json(), { error: 'Unsupported week start.' });

  const unchanged = db
    .prepare('SELECT first_day_of_week FROM users WHERE email = ?')
    .get('rafael@example.com');
  assert.equal(unchanged.first_day_of_week, 'Monday');

  await app.close();
  db.close();
});

test('week start updates require an authenticated session', async () => {
  const { app } = await calendarScenario();

  const anonymous = await app.inject({
    method: 'PATCH',
    url: '/api/users/me/calendar-preference',
    payload: { first_day_of_week: 'Sunday' },
  });
  assert.equal(anonymous.statusCode, 401);

  await app.close();
});

test('calendar page requires an active training cycle', async () => {
  const { app, cookiePair } = await calendarScenario();

  const anonymous = await app.inject({ method: 'GET', url: '/calendar.html' });
  assert.equal(anonymous.statusCode, 302);
  assert.equal(anonymous.headers.location, '/login.html');

  const withoutCycle = await app.inject({
    method: 'GET',
    url: '/calendar.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(withoutCycle.statusCode, 302);
  assert.equal(withoutCycle.headers.location, '/cycles.html');

  const created = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie: cookiePair },
    payload: { objective: 'Anaerobic block' },
  });
  assert.equal(created.statusCode, 201);

  const authenticated = await app.inject({
    method: 'GET',
    url: '/calendar.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.match(authenticated.headers['content-type'], /text\/html/);
  assert.match(authenticated.body, /id="calendarGrid"/);
  assert.match(authenticated.body, /shared\/shell\.css/);
  assert.match(authenticated.body, /calendar\.js/);
  assert.doesNotMatch(authenticated.body, /id="logoutBtn"/);

  await app.close();
});

test('ai coach page is gated and served to authenticated users', async () => {
  const { app, cookiePair } = await calendarScenario();

  const anonymous = await app.inject({ method: 'GET', url: '/ai-coach.html' });
  assert.equal(anonymous.statusCode, 302);
  assert.equal(anonymous.headers.location, '/login.html');

  const authenticated = await app.inject({
    method: 'GET',
    url: '/ai-coach.html',
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.match(authenticated.headers['content-type'], /text\/html/);
  assert.match(authenticated.body, /id="promptForm"/);
  assert.match(authenticated.body, /shared\/shell\.css/);
  assert.match(authenticated.body, /ai-coach\.js/);
  assert.doesNotMatch(authenticated.body, /id="logoutBtn"/);

  await app.close();
});

test('auth pages ride the unified primary button design', () => {
  for (const page of ['login.html', 'register.html']) {
    const html = readFileSync(join(publicDir, page), 'utf8');
    assert.match(
      html,
      /id="submitBtn" class="btn-primary" type="submit"/,
      `${page} submit button uses the global primary class`
    );
  }

  for (const sheet of ['login.css', 'register.css']) {
    const css = readFileSync(join(publicDir, sheet), 'utf8');
    assert.ok(!css.includes('btn'), `${sheet} adds no local button overrides`);
  }

  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(
    theme,
    /\.btn-primary \{[^}]*display:\s*inline-flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*center;\s*\n\s*gap:\s*0\.5rem/,
    'the global primary centers icon and label with a strict flex rule'
  );
  assert.match(theme, /\.btn-primary > svg \{[^}]*flex-shrink:\s*0/, 'lucide icons never squish or drift off-center');
  assert.match(theme, /\.btn-primary \{[^}]*border-radius:\s*999px/, 'the pill shape matches every screen');
  assert.match(theme, /\.btn-primary \{[^}]*transition:\s*all 0\.2s ease/, 'one smooth animation curve');
  assert.match(
    theme,
    /\.btn-primary:hover:not\(:disabled\) \{[^}]*transform:\s*translateY\(-2px\)/,
    'auth buttons lift exactly like the app screens'
  );
  assert.match(theme, /\.btn-primary:hover:not\(:disabled\) \{[^}]*background:\s*#405c46/);
});

test('auth card eyebrow uses uppercase accent styling via theme.css', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.auth-eyebrow \{[^}]*text-transform:\s*uppercase/, 'eyebrow text is uppercased');
  assert.match(theme, /\.auth-eyebrow \{[^}]*color:\s*var\(--accent\)/, 'eyebrow uses the primary accent color');
  assert.match(theme, /\.auth-eyebrow \{[^}]*font-size:\s*0\.72rem/, 'eyebrow has a small font size');
  assert.match(theme, /\.auth-eyebrow \{[^}]*letter-spacing:\s*0\.12em/, 'eyebrow has generous letter-spacing');
  assert.match(theme, /\.auth-eyebrow \{[^}]*font-weight:\s*700/, 'eyebrow is bold');
});

test('auth header positions the language switcher in the top-right corner', () => {
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /\.auth-header \{[^}]*position:\s*absolute/, 'auth header is absolutely positioned');
  assert.match(theme, /\.auth-header \{[^}]*top:\s*1rem/, 'auth header sits near the top');
  assert.match(theme, /\.auth-header \{[^}]*right:\s*1rem/, 'auth header sits near the right edge');
});
