'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adminAliasDecision, buildServer, isAdminPageAlias } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');

const PASSWORD = 'strong-password-1';

async function makeAccount(db, { email, firstName, lastName = 'Tester', role = 'user' }) {
  const account = await registerUser(db, {
    email,
    password: PASSWORD,
    first_name: firstName,
    last_name: lastName,
  });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, account.id);
  return { ...account, role };
}

async function setup({ admins = 1, users = 2 } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });

  const adminAccounts = [];
  for (let index = 0; index < admins; index += 1) {
    adminAccounts.push(await makeAccount(db, {
      email: `admin${index}@example.com`, firstName: `Admin${index}`, role: 'admin',
    }));
  }
  const userAccounts = [];
  for (let index = 0; index < users; index += 1) {
    userAccounts.push(await makeAccount(db, {
      email: `user${index}@example.com`, firstName: `User${index}`,
    }));
  }

  const cookieFor = (account) => `${SESSION_COOKIE_NAME}=${createSession(db, account.id).token}`;

  return {
    db,
    app,
    admins: adminAccounts,
    users: userAccounts,
    adminCookie: cookieFor(adminAccounts[0]),
    userCookie: cookieFor(userAccounts[0]),
  };
}

const ADMIN_REQUESTS = [
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/users/1'],
  ['POST', '/api/admin/users'],
  ['PUT', '/api/admin/users/1'],
  ['POST', '/api/admin/users/1/activity'],
  ['DELETE', '/api/admin/users/1'],
];

test('admin page alias detection handles encoded, dot, repeated, canonical, and malformed paths', () => {
  assert.equal(isAdminPageAlias('//admin-users.html'), true);
  assert.equal(isAdminPageAlias('/%2fadmin-users.html'), true);
  assert.equal(isAdminPageAlias('/x%2f..%2fadmin-users.html'), true);
  assert.equal(isAdminPageAlias('/x/../admin-users.html'), true);
  assert.equal(isAdminPageAlias('/./admin-users.html?lang=en'), true);
  assert.equal(isAdminPageAlias('///admin-users.html?lang=en'), true);
  assert.equal(isAdminPageAlias('/admin-users.html'), false);
  assert.equal(isAdminPageAlias('/%zzadmin-users.html'), false);
  assert.equal(isAdminPageAlias(undefined), false);
  assert.equal(adminAliasDecision(null, null), 'login');
});

/* ── Authorization ── */

test('every account route refuses an anonymous request', async () => {
  const { app } = await setup();
  for (const [method, url] of ADMIN_REQUESTS) {
    const response = await app.inject({
      method,
      url,
      payload: { first_name: 'X', last_name: 'Y', email: 'x@y.com', password: PASSWORD },
    });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test('every account route refuses a signed-in non-administrator', async () => {
  const { app, userCookie } = await setup();
  for (const [method, url] of ADMIN_REQUESTS) {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: userCookie },
      payload: { first_name: 'X', last_name: 'Y', email: 'x@y.com', password: PASSWORD },
    });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
});

test('the administration page is served to an administrator', async () => {
  const { app, adminCookie } = await setup();
  const response = await app.inject({ method: 'GET', url: '/admin-users.html', headers: { cookie: adminCookie } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /data-i18n="admin\.title"/);
});

test('the administration page sends anonymous visitors to login and others home', async () => {
  const { app, userCookie } = await setup();
  const anonymous = await app.inject({ method: 'GET', url: '/admin-users.html' });
  assert.equal(anonymous.statusCode, 302);
  assert.match(anonymous.headers.location, /\/login\.html$/);

  const regular = await app.inject({ method: 'GET', url: '/admin-users.html', headers: { cookie: userCookie } });
  assert.equal(regular.statusCode, 302);
  assert.match(regular.headers.location, /\/home\.html$/);
});

test('admin document path aliases always pass through the canonical authorization gate', async () => {
  const { app, adminCookie, userCookie } = await setup();
  for (const url of [
    '//admin-users.html', '/%2fadmin-users.html', '///admin-users.html',
    '/x%2f..%2fadmin-users.html', '/x/../admin-users.html', '/./admin-users.html?tab=users',
  ]) {
    const anonymous = await app.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 302, `anonymous ${url}`);
    assert.match(anonymous.headers.location, /\/login\.html$/);

    const regular = await app.inject({ method: 'GET', url, headers: { cookie: userCookie } });
    assert.equal(regular.statusCode, 302, `regular ${url}`);
    assert.match(regular.headers.location, /\/home\.html$/);

    const admin = await app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
    assert.equal(admin.statusCode, 200, `admin ${url}`);
    assert.match(admin.body, /data-i18n="admin\.title"/);
  }
  for (const url of ['//assets/brand/favicon.png', '/%2fassets/brand/favicon.png']) {
    const asset = await app.inject({ method: 'GET', url });
    assert.equal(asset.statusCode, 200, `public asset ${url}`);
    assert.match(asset.headers['content-type'], /^image\//);
  }
  const malformed = await app.inject({ method: 'GET', url: '/%zzadmin-users.html' });
  assert.notEqual(malformed.statusCode, 200);
  assert.doesNotMatch(malformed.body, /data-i18n="admin\.title"/);
});

test('a role granted after sign-in is honoured without a new session', async () => {
  const { app, db, users } = await setup();
  const cookie = `${SESSION_COOKIE_NAME}=${createSession(db, users[0].id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: cookie } })).statusCode, 403);

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', users[0].id);
  const promoted = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: cookie } });
  assert.equal(promoted.statusCode, 200);
});

/* ── Activity ── */

test('deactivating an account answers with its state and ends its access', async () => {
  const { app, db, adminCookie, users } = await setup();
  const target = users[0];
  const targetCookie = `${SESSION_COOKIE_NAME}=${createSession(db, target.id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: targetCookie } })).statusCode, 200);

  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target.id}/activity`,
    headers: { cookie: adminCookie },
    payload: { active: false, expected_active: true },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.is_active, false);
  assert.equal(response.json().user.email, target.email);

  // The existing session is gone, and a session created for the same account
  // afterwards is refused by the central lookup.
  const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: targetCookie } });
  assert.equal(after.statusCode, 401);
  const replacement = `${SESSION_COOKIE_NAME}=${createSession(db, target.id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: replacement } })).statusCode, 401);

  // The list and the read expose the new state, and the credentials no longer
  // sign in.
  const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
  assert.equal(
    list.json().users.find((account) => account.id === target.id).is_active,
    false
  );
  const single = await app.inject({
    method: 'GET', url: `/api/admin/users/${target.id}`, headers: { cookie: adminCookie },
  });
  assert.equal(single.json().user.is_active, false);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { email: target.email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 403);
  assert.deepEqual(login.json().errors, ['accountInactive']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(target.id).count, 1);

  // Reactivating restores the login without restoring the revoked session.
  const activated = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target.id}/activity`,
    headers: { cookie: adminCookie },
    payload: { active: true, expected_active: false },
  });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().user.is_active, true);
  const signIn = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { email: target.email, password: PASSWORD },
  });
  assert.equal(signIn.statusCode, 200);
  const oldToken = (await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: replacement },
  })).statusCode;
  assert.equal(oldToken, 401, 'the session refused while inactive is never honoured again');
});

test('the activity route refuses every unsupported body with a stable code', async () => {
  const { app, adminCookie, users } = await setup();
  for (const [payload, status, code] of [
    [{ active: false, expected_active: true, is_active: false }, 400, 'unknownField'],
    [{ active: false, expected_active: true, role: 'admin' }, 400, 'privilegedField'],
    [{ active: false, expected_active: true, password_confirmation: 'x' }, 400, 'unknownField'],
    [{ active: 'false', expected_active: true }, 400, 'invalidActivity'],
    [{ active: false }, 400, 'invalidActivity'],
    [{}, 400, 'invalidActivity'],
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${users[0].id}/activity`,
      headers: { cookie: adminCookie },
      payload,
    });
    assert.equal(response.statusCode, status, JSON.stringify(payload));
    assert.deepEqual(response.json().errors, [code], JSON.stringify(payload));
  }
  const unchanged = await app.inject({
    method: 'GET', url: `/api/admin/users/${users[0].id}`, headers: { cookie: adminCookie },
  });
  assert.equal(unchanged.json().user.is_active, true);
});

test('the activity route refuses privileged, self and stale requests', async () => {
  const { app, db, adminCookie, admins, users } = await setup({ admins: 2, users: 2 });
  const post = async (id, payload) => app.inject({
    method: 'POST',
    url: `/api/admin/users/${id}/activity`,
    headers: { cookie: adminCookie },
    payload,
  });

  assert.deepEqual(
    (await post(admins[0].id, { active: false, expected_active: true })).json().errors,
    ['selfActivityForbidden']
  );
  const privileged = await post(admins[1].id, { active: false, expected_active: true });
  assert.equal(privileged.statusCode, 403);
  assert.deepEqual(privileged.json().errors, ['privilegedTarget']);

  assert.equal((await post(users[0].id, { active: false, expected_active: true })).statusCode, 200);
  const stale = await post(users[0].id, { active: false, expected_active: true });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json().errors, ['activityConflict']);

  const missing = await post(9999, { active: false, expected_active: true });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json().errors, ['accountNotFound']);
  const invalid = await post('abc', { active: false, expected_active: true });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json().errors, ['invalidId']);

  // A regular account cannot suspend anyone, and the guard runs before the
  // body is read.
  const asUser = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${users[1].id}/activity`,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, users[1].id).token}` },
    payload: { active: false, expected_active: true },
  });
  assert.equal(asUser.statusCode, 403);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id = ?').get(users[1].id).is_active, 1);

  // A suspended account never reaches the administration guard at all: its
  // session is refused by authentication first.
  const suspendedCookie = `${SESSION_COOKIE_NAME}=${createSession(db, users[0].id).token}`;
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(users[0].id);
  const asSuspended = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${users[1].id}/activity`,
    headers: { cookie: suspendedCookie },
    payload: { active: false, expected_active: true },
  });
  assert.equal(asSuspended.statusCode, 401);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id = ?').get(users[1].id).is_active, 1);
});

test('an activity transition is audited once with the states it moved between', async () => {
  const { app, db, adminCookie, admins, users } = await setup();
  await app.inject({
    method: 'POST',
    url: `/api/admin/users/${users[0].id}/activity`,
    headers: { cookie: adminCookie },
    payload: { active: false, expected_active: true },
  });
  await app.inject({
    method: 'POST',
    url: `/api/admin/users/${users[0].id}/activity`,
    headers: { cookie: adminCookie },
    payload: { active: true, expected_active: false },
  });
  const rows = db.prepare(
    "SELECT * FROM admin_audit_log WHERE action = 'account_activity_changed' ORDER BY id"
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor_user_id, admins[0].id);
  assert.equal(rows[0].target_user_id, users[0].id);
  assert.deepEqual(JSON.parse(rows[0].details), { from: 'active', to: 'inactive' });
  assert.deepEqual(JSON.parse(rows[1].details), { from: 'inactive', to: 'active' });
  assert.equal(/password|hash|token|secret/i.test(JSON.stringify(rows)), false);
});

/* ── Reading ── */

test('the account list exposes identification, role and activity state only', async () => {
  const { app, adminCookie } = await setup();
  const response = await app.inject({
    method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie },
  });
  assert.equal(response.statusCode, 200);
  const { users } = response.json();
  assert.equal(users.length, 3);
  for (const account of users) {
    // The activity state is the only addition: it decides whether the account
    // can sign in and is needed to render the row, and it is not private data.
    assert.deepEqual(Object.keys(account).sort(), [
      'created_at', 'email', 'first_name', 'id', 'is_active', 'last_name', 'role',
    ]);
    assert.equal(account.is_active, true);
  }
  assert.equal(/password|hash|session|token/i.test(response.body), false);
});

test('a single account is readable and an unknown id reports a stable code', async () => {
  const { app, adminCookie, users } = await setup();
  const found = await app.inject({
    method: 'GET', url: `/api/admin/users/${users[0].id}`, headers: { cookie: adminCookie },
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().user.email, users[0].email);

  const missing = await app.inject({
    method: 'GET', url: '/api/admin/users/9999', headers: { cookie: adminCookie },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json().errors, ['accountNotFound']);
});

/* ── Creating ── */

test('an administrator creates an account and the new user can sign in', async () => {
  const { app, db, adminCookie } = await setup();
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie },
    payload: {
      first_name: 'Created',
      last_name: 'Account',
      email: 'Created@Example.com',
      password: PASSWORD,
    },
  });
  assert.equal(response.statusCode, 201);
  const created = response.json().user;
  assert.equal(created.email, 'created@example.com');
  assert.equal(created.role, 'user');

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'created@example.com', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 4);
});

test('creating rejects a duplicate email with a conflict code', async () => {
  const { app, adminCookie, users } = await setup();
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie },
    payload: {
      first_name: 'Dup', last_name: 'Licate', email: users[0].email,
      password: PASSWORD,
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json().errors, ['emailInUse']);
});

test('creating answers registration and privilege failures with the same envelope', async () => {
  const { app, adminCookie } = await setup();
  const cases = [
    [{ email: 'not-an-email' }, 'invalidRegistration'],
    [{ password: 'short' }, 'invalidRegistration'],
    [{ first_name: '   ' }, 'invalidRegistration'],
    [{ role: 'admin' }, 'privilegedField'],
    [{ expected_role: 'user' }, 'privilegedField'],
    [{ onboarding_status: 'active' }, 'unknownField'],
  ];
  for (const [override, code] of cases) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: {
        first_name: 'Probe',
        last_name: 'Probe',
        email: `probe-${code}-${Object.keys(override).join('') || 'x'}@example.com`,
        password: PASSWORD,
        ...override,
      },
    });
    assert.equal(response.statusCode, 400, JSON.stringify(override));
    assert.deepEqual(response.json().errors, [code], JSON.stringify(override));
  }
});

/* ── Updating ── */

test('an administrator updates an account', async () => {
  const { app, adminCookie, users } = await setup();
  const response = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${users[0].id}`,
    headers: { cookie: adminCookie },
    payload: { first_name: 'Renamed', last_name: 'Person' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.first_name, 'Renamed');
  assert.equal(response.json().user.role, 'user');
});

test('privilege fields are rejected without changing the account or sessions', async () => {
  const { app, db, adminCookie, users } = await setup();
  const targetCookie = `${SESSION_COOKIE_NAME}=${createSession(db, users[0].id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: targetCookie } })).statusCode, 200);

  const response = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${users[0].id}`,
    headers: { cookie: adminCookie },
    payload: { role: 'admin' },
  });
  assert.equal(response.statusCode, 400);

  const after = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: targetCookie } });
  assert.equal(after.statusCode, 200);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(users[0].id).role, 'user');
});

test('updating refuses the self demotion, the empty payload and unknown targets', async () => {
  const { app, adminCookie, admins, users } = await setup();
  const cases = [
    [`/api/admin/users/${admins[0].id}`, { role: 'user' }, 400, 'privilegedField'],
    [`/api/admin/users/${users[0].id}`, {}, 400, 'noChanges'],
    [`/api/admin/users/${users[0].id}`, { password: 'another-secret' }, 400, 'unknownField'],
    ['/api/admin/users/not-a-number', { first_name: 'X' }, 400, 'invalidId'],
    ['/api/admin/users/9999', { first_name: 'X' }, 404, 'accountNotFound'],
    [`/api/admin/users/${users[0].id}`, { email: 'nope' }, 400, 'invalidRegistration'],
    [`/api/admin/users/${users[0].id}`, { email: users[1].email }, 409, 'emailInUse'],
  ];
  for (const [url, payload, status, code] of cases) {
    const response = await app.inject({
      method: 'PUT', url, headers: { cookie: adminCookie }, payload,
    });
    assert.equal(response.statusCode, status, `${url} ${JSON.stringify(payload)}`);
    assert.deepEqual(response.json().errors, [code], `${url} ${JSON.stringify(payload)}`);
  }
});

/* ── Deleting ── */

test('an administrator deletes another account and its dependent data', async () => {
  const { app, db, adminCookie, users } = await setup();
  const target = users[0];
  createSession(db, target.id);
  db.prepare(
    `INSERT INTO training_cycles (id, user_id, objective, target_date, start_date, status)
     VALUES ('cycle-x', ?, 'Maratona', '2026-12-06', '2026-09-01', 'active')`
  ).run(target.id);

  const response = await app.inject({
    method: 'DELETE', url: `/api/admin/users/${target.id}`, headers: { cookie: adminCookie },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(target.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(target.id).count, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM training_cycles WHERE user_id = ?').get(target.id).count,
    0,
  );

  const [entry] = db.prepare('SELECT * FROM admin_audit_log').all();
  assert.equal(entry.action, 'account_deleted');
  assert.equal(entry.target_email, target.email);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
});

test('deleting refuses the signed-in account and reports unknown targets', async () => {
  const { app, adminCookie, admins } = await setup();
  const self = await app.inject({
    method: 'DELETE', url: `/api/admin/users/${admins[0].id}`, headers: { cookie: adminCookie },
  });
  assert.equal(self.statusCode, 400);
  assert.deepEqual(self.json().errors, ['selfDeleteForbidden']);

  const missing = await app.inject({
    method: 'DELETE', url: '/api/admin/users/9999', headers: { cookie: adminCookie },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json().errors, ['accountNotFound']);
});

test('an unexpected failure is not disguised as an account error', async () => {
  const { app, db, adminCookie, users } = await setup();
  const original = db.prepare.bind(db);
  // Force the read to fail with something the account layer never throws, so
  // the route must rethrow instead of inventing an envelope.
  const broken = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          if (/FROM users WHERE id/.test(sql)) throw new Error('storage unavailable');
          return original(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Swap the instance the route closure reads from.
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    value: broken.prepare,
  });
  try {
    const response = await app.inject({
      method: 'GET', url: `/api/admin/users/${users[0].id}`, headers: { cookie: adminCookie },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().errors, undefined, 'no account code is invented');
  } finally {
    Object.defineProperty(db, 'prepare', { configurable: true, value: original });
  }
});

/* ── Audit trail ── */

test('account changes are audited with the actor and never with secrets', async () => {
  const { app, db, adminCookie, admins, users } = await setup();
  await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie },
    payload: {
      first_name: 'Audit', last_name: 'Target', email: 'audit@example.com',
      password: PASSWORD,
    },
  });
  const created = db.prepare('SELECT id FROM users WHERE email = ?').get('audit@example.com');
  await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${created.id}`,
    headers: { cookie: adminCookie },
    payload: { last_name: 'Renamed' },
  });
  await app.inject({
    method: 'DELETE', url: `/api/admin/users/${created.id}`, headers: { cookie: adminCookie },
  });

  const rows = db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all();
  assert.deepEqual(rows.map((row) => row.action), [
    'account_created', 'account_updated', 'account_deleted',
  ]);
  for (const row of rows) {
    assert.equal(row.actor_user_id, admins[0].id);
    assert.equal(row.actor_email, admins[0].email);
    assert.equal(row.target_email, 'audit@example.com');
  }
  // The deleted account is gone, yet its history remains.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(created.id).count, 0);
  assert.equal(rows.length, 3);
  assert.equal(/password_hash|scrypt|session|token/i.test(JSON.stringify(rows)), false);
  assert.ok(users[0].email);
});

/*
 * `POST /api/admin/users` derives its password hash with an `await`, so a second
 * administrator can revoke the acting account's authority while that hash is
 * pending. Two independent refusals close the window, and which one answers
 * depends only on how the interleaving happened to fall:
 *
 *   401 — the revocation also deletes the acting account's sessions, so if the
 *         guard has not run yet it never finds one.
 *   403 — the guard already authorized the request, and the domain layer
 *         re-reads the actor inside the insert transaction and refuses.
 *
 * Either way no account may be created. The 403 path and the
 * `adminAuthorityRevoked` code are covered deterministically at the domain
 * level in test/adminUsers.test.js, which can hold the hash pending without
 * relying on scheduling.
 */
async function assertRefusedAfterRevocation(app, db, creator, revoke) {
  const otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db, revoke.actor.id).token}`;
  const revoked = app.inject(revoke.request(otherCookie));
  const pending = app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: creator.cookie },
    payload: {
      first_name: 'Back', last_name: 'Door', email: 'backdoor@example.com',
      password: PASSWORD,
    },
  });
  assert.ok([200, 204].includes((await revoked).statusCode));

  const response = await pending;
  assert.ok(
    [401, 403].includes(response.statusCode),
    `expected the revoked create to be refused, got ${response.statusCode}`,
  );
  if (response.statusCode === 403) {
    assert.deepEqual(response.json().errors, ['adminAuthorityRevoked']);
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('backdoor@example.com').count,
    0,
    'a revoked actor creates no account, not even another administrator',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'account_created'").get().count,
    0,
  );
  assert.ok(creator.id);
}

test('a create request whose authority is demoted mid-hash creates no account', async () => {
  const { app, db, adminCookie, admins } = await setup({ admins: 2 });
  const [creator, other] = admins;
  await assertRefusedAfterRevocation(app, db, { id: creator.id, cookie: adminCookie }, {
    actor: other,
    request: (cookie) => ({
      method: 'DELETE', url: `/api/admin/users/${creator.id}`, headers: { cookie },
    }),
  });
  // The revocation itself removes the account; no role-change audit is made.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'account_role_changed'").get().count,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
});

test('a create request whose acting account is deleted mid-hash creates no account', async () => {
  const { app, db, adminCookie, admins } = await setup({ admins: 2 });
  const [creator, other] = admins;
  await assertRefusedAfterRevocation(app, db, { id: creator.id, cookie: adminCookie }, {
    actor: other,
    request: (cookie) => ({
      method: 'DELETE', url: `/api/admin/users/${creator.id}`, headers: { cookie },
    }),
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(creator.id).count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'account_deleted'").get().count,
    1,
  );
});
