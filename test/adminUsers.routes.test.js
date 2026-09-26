'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
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
  ['DELETE', '/api/admin/users/1'],
];

/* ── Authorization ── */

test('every account route refuses an anonymous request', async () => {
  const { app } = await setup();
  for (const [method, url] of ADMIN_REQUESTS) {
    const response = await app.inject({
      method,
      url,
      payload: { first_name: 'X', last_name: 'Y', email: 'x@y.com', password: PASSWORD, role: 'admin' },
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
      payload: { first_name: 'X', last_name: 'Y', email: 'x@y.com', password: PASSWORD, role: 'admin' },
    });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
});

test('the administration page is served to an administrator', async () => {
  const { app, adminCookie } = await setup();
  const response = await app.inject({ method: 'GET', url: '/admin.html', headers: { cookie: adminCookie } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /data-i18n="admin\.title"/);
});

test('the administration page sends anonymous visitors to login and others home', async () => {
  const { app, userCookie } = await setup();
  const anonymous = await app.inject({ method: 'GET', url: '/admin.html' });
  assert.equal(anonymous.statusCode, 302);
  assert.match(anonymous.headers.location, /\/login\.html$/);

  const regular = await app.inject({ method: 'GET', url: '/admin.html', headers: { cookie: userCookie } });
  assert.equal(regular.statusCode, 302);
  assert.match(regular.headers.location, /\/home\.html$/);
});

test('a role granted after sign-in is honoured without a new session', async () => {
  const { app, db, users } = await setup();
  const cookie = `${SESSION_COOKIE_NAME}=${createSession(db, users[0].id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: cookie } })).statusCode, 403);

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', users[0].id);
  const promoted = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: cookie } });
  assert.equal(promoted.statusCode, 200);
});

/* ── Reading ── */

test('the account list exposes identification and role only', async () => {
  const { app, adminCookie } = await setup();
  const response = await app.inject({
    method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie },
  });
  assert.equal(response.statusCode, 200);
  const { users } = response.json();
  assert.equal(users.length, 3);
  for (const account of users) {
    assert.deepEqual(Object.keys(account).sort(), [
      'created_at', 'email', 'first_name', 'id', 'last_name', 'role',
    ]);
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
      role: 'admin',
    },
  });
  assert.equal(response.statusCode, 201);
  const created = response.json().user;
  assert.equal(created.email, 'created@example.com');
  assert.equal(created.role, 'admin');

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
      password: PASSWORD, role: 'user',
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json().errors, ['emailInUse']);
});

test('creating answers registration failures with the same envelope as role failures', async () => {
  const { app, adminCookie } = await setup();
  const cases = [
    [{ email: 'not-an-email' }, 'invalidRegistration'],
    [{ password: 'short' }, 'invalidRegistration'],
    [{ first_name: '   ' }, 'invalidRegistration'],
    [{ role: 'superuser' }, 'invalidRole'],
    [{ role: undefined }, 'invalidRole'],
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
        role: 'user',
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
    payload: { first_name: 'Renamed', last_name: 'Person', role: 'admin' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.first_name, 'Renamed');
  assert.equal(response.json().user.role, 'admin');
});

test('a role change invalidates the target sessions immediately', async () => {
  const { app, db, adminCookie, users } = await setup();
  const targetCookie = `${SESSION_COOKIE_NAME}=${createSession(db, users[0].id).token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: targetCookie } })).statusCode, 200);

  const response = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${users[0].id}`,
    headers: { cookie: adminCookie },
    payload: { role: 'admin' },
  });
  assert.equal(response.statusCode, 200);

  const after = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: targetCookie } });
  assert.equal(after.statusCode, 401);
});

test('updating refuses the self demotion, the empty payload and unknown targets', async () => {
  const { app, adminCookie, admins, users } = await setup();
  const cases = [
    [`/api/admin/users/${admins[0].id}`, { role: 'user' }, 400, 'selfRoleChangeForbidden'],
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
      password: PASSWORD, role: 'user',
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
    method: 'PUT',
    url: `/api/admin/users/${created.id}`,
    headers: { cookie: adminCookie },
    payload: { role: 'admin' },
  });
  await app.inject({
    method: 'DELETE', url: `/api/admin/users/${created.id}`, headers: { cookie: adminCookie },
  });

  const rows = db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all();
  assert.deepEqual(rows.map((row) => row.action), [
    'account_created', 'account_updated', 'account_role_changed', 'account_deleted',
  ]);
  for (const row of rows) {
    assert.equal(row.actor_user_id, admins[0].id);
    assert.equal(row.actor_email, admins[0].email);
    assert.equal(row.target_email, 'audit@example.com');
  }
  // The deleted account is gone, yet its history remains.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(created.id).count, 0);
  assert.equal(rows.length, 4);
  assert.equal(/password_hash|scrypt|session|token/i.test(JSON.stringify(rows)), false);
  assert.ok(users[0].email);
});
