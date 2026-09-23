'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const fastifyCookie = require('@fastify/cookie');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { loginUser } = require('../src/auth/login');
const { createSession } = require('../src/auth/sessions');
const { createRequireAuth } = require('../src/auth/requireAuth');
const { verifyPassword } = require('../src/auth/passwords');
const { createRequireAdmin } = require('../src/auth/requireAdmin');
const {
  AdminOperationError,
  createFirstAdmin,
  findAccountByEmail,
  hasAdministrator,
  promoteAccount,
} = require('../src/admin/operations');
const { runBootstrap, runPromotion } = require('../scripts/admin-commands');

const adminInput = {
  email: 'First.Admin@example.com', password: 'secure-admin-password',
  first_name: 'First', last_name: 'Admin',
};

function mockPrompts(answers, secretAnswers = []) {
  const textAnswers = [...answers];
  const passwords = [...secretAnswers];
  return {
    assertInteractive() {},
    async question() { return textAnswers.shift(); },
    async secret() { return passwords.shift(); },
  };
}

test('first admin bootstrap creates a regular-login-compatible account with a hash and no secret in its DTO', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await createFirstAdmin(db, adminInput);
  const stored = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(user.role, 'admin');
  assert.equal(stored.role, 'admin');
  assert.equal(stored.onboarding_status, 'new');
  assert.equal(await verifyPassword(adminInput.password, stored.password_hash), true);
  const login = await loginUser(db, { email: adminInput.email, password: adminInput.password });
  assert.equal(login.user.role, 'admin');
  assert.equal(JSON.stringify(user).includes(adminInput.password), false);
  assert.equal(Object.hasOwn(user, 'password_hash'), false);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.close();
});

test('first-admin operation rejects an existing administrator and an occupied email without mutation', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await createFirstAdmin(db, adminInput);
  await assert.rejects(createFirstAdmin(db, { ...adminInput, email: 'other@example.com' }), { code: 'ADMIN_EXISTS' });
  const before = db.prepare('SELECT id, password_hash, role FROM users').get();
  await assert.rejects(createFirstAdmin(db, adminInput), { code: 'ADMIN_EXISTS' });
  assert.deepEqual(db.prepare('SELECT id, password_hash, role FROM users').get(), before);
  db.close();
});

test('bootstrap operation validates data and rejects an existing ordinary email without promoting it', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await registerUser(db, { ...adminInput, email: 'used@example.com' });
  await assert.rejects(createFirstAdmin(db, { ...adminInput, email: 'USED@example.com' }), { code: 'EMAIL_IN_USE' });
  await assert.rejects(createFirstAdmin(db, { ...adminInput, password: 'tiny' }), { name: 'RegistrationError' });
  assert.equal(db.prepare('SELECT role FROM users WHERE email = ?').get('used@example.com').role, 'user');
  db.close();
});

test('bootstrap atomically allows only one concurrent first administrator', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-admin-race-'));
  const filename = path.join(directory, 'database.sqlite');
  const db = createDatabase({ filename });
  const otherConnection = createDatabase({ filename });
  const outcomes = await Promise.allSettled([
    createFirstAdmin(db, adminInput),
    createFirstAdmin(otherConnection, { ...adminInput, email: 'second@example.com' }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected' && result.reason.code === 'ADMIN_EXISTS').length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
  db.close();
  otherConnection.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('bootstrap rechecks the email inside its write transaction after password hashing', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const pending = createFirstAdmin(db, { ...adminInput, email: 'racing@example.com' });
  setImmediate(() => {
    db.prepare("INSERT INTO users (email, password_hash) VALUES ('racing@example.com', 'ordinary-hash')").run();
  });
  await assert.rejects(pending, { code: 'EMAIL_IN_USE' });
  assert.equal(db.prepare('SELECT role FROM users WHERE email = ?').get('racing@example.com').role, 'user');
  db.close();
});

test('bootstrap rolls back account creation if persistence fails', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.exec("CREATE TRIGGER reject_admin BEFORE INSERT ON users WHEN NEW.role = 'admin' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(createFirstAdmin(db, adminInput), /test failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  db.close();
});

test('account lookup and explicit promotion are normalized, idempotent, and update only role', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const original = await registerUser(db, { ...adminInput, email: 'promote@example.com' });
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(original.id);
  const session = createSession(db, original.id);
  assert.equal(findAccountByEmail(db, ' PROMOTE@EXAMPLE.COM ').id, original.id);
  assert.equal(findAccountByEmail(db, ''), null);
  assert.equal(findAccountByEmail(db, null), null);
  assert.equal(findAccountByEmail(db, 'absent@example.com'), null);
  const result = promoteAccount(db, ' PROMOTE@example.com ');
  assert.equal(result.changed, true);
  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(original.id);
  assert.equal(after.role, 'admin');
  for (const column of ['email', 'password_hash', 'first_name', 'last_name', 'preferred_lang', 'onboarding_status', 'onboarding_guide_hidden']) {
    assert.equal(after[column], before[column], `${column} is preserved`);
  }
  assert.equal(promoteAccount(db, 'promote@example.com').changed, false);
  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(session.token).user_id, original.id);
  assert.throws(() => promoteAccount(db, ''), { code: 'INVALID_EMAIL' });
  assert.throws(() => promoteAccount(db, null), { code: 'INVALID_EMAIL' });
  assert.throws(() => promoteAccount(db, 'missing@example.com'), { code: 'ACCOUNT_NOT_FOUND' });
  db.close();
});

test('promotion reports a concurrent or invalid role change without silently succeeding', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await registerUser(db, { ...adminInput, email: 'ignored@example.com' });
  db.exec("CREATE TRIGGER ignore_promotion BEFORE UPDATE OF role ON users BEGIN SELECT RAISE(IGNORE); END");
  assert.throws(() => promoteAccount(db, 'ignored@example.com'), { code: 'INVALID_ROLE' });
  db.close();
});

test('bootstrap command handles already-complete, email collision, mismatch, and successful prompts safely', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const output = [];
  await createFirstAdmin(db, adminInput);
  let result = await runBootstrap({ db, prompts: mockPrompts([], []), write: (line) => output.push(line) });
  assert.equal(result.status, 'already-complete');
  assert.match(output.at(-1), /already been completed/);

  const fresh = createDatabase({ filename: ':memory:' });
  await registerUser(fresh, { ...adminInput, email: 'taken@example.com' });
  result = await runBootstrap({
    db: fresh, prompts: mockPrompts(['A', 'B', 'taken@example.com'], []), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'email-in-use');
  assert.match(output.at(-1), /admin:promote/);

  const mismatchDb = createDatabase({ filename: ':memory:' });
  result = await runBootstrap({
    db: mismatchDb, prompts: mockPrompts(['A', 'B', 'a@example.com'], ['secret-one', 'secret-two']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'password-mismatch');
  assert.equal(mismatchDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);

  const cleanDb = createDatabase({ filename: ':memory:' });
  result = await runBootstrap({
    db: cleanDb, prompts: mockPrompts(['A', 'B', 'cli-admin@example.com'], ['cli-secret-pass', 'cli-secret-pass']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'created');
  assert.equal(output.join('\n').includes('cli-secret-pass'), false);
  [db, fresh, mismatchDb, cleanDb].forEach((handle) => handle.close());
});

test('bootstrap requires an interactive terminal before doing work', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await assert.rejects(runBootstrap({
    db,
    prompts: { assertInteractive() { throw new Error('TTY required'); } },
    write() {},
  }), /TTY required/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  db.close();
});

test('promotion command confirms the identified account, handles cancel and not-found, and is repeatable', async () => {
  const db = createDatabase({ filename: ':memory:' });
  await registerUser(db, { ...adminInput, email: 'promote-cli@example.com' });
  const output = [];
  let result = await runPromotion({
    db, prompts: mockPrompts(['promote-cli@example.com', 'no']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'cancelled');
  assert.match(output[0], /promote-cli@example.com/);
  result = await runPromotion({
    db, prompts: mockPrompts(['missing@example.com']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'not-found');
  result = await runPromotion({
    db, prompts: mockPrompts([' PROMOTE-CLI@example.com ', 'yes']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'promoted');
  assert.equal(promoteAccount(db, 'promote-cli@example.com').changed, false);
  assert.equal(hasAdministrator(db), true);
  db.close();
});

test('promotion command identifies nullable names and reports an already-admin confirmation without mutation', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const admin = await createFirstAdmin(db, adminInput);
  db.prepare('UPDATE users SET first_name = NULL, last_name = NULL WHERE id = ?').run(admin.id);
  const output = [];
  const result = await runPromotion({
    db, prompts: mockPrompts([admin.email, 'yes']), write: (line) => output.push(line),
  });
  assert.equal(result.status, 'already-admin');
  assert.equal(result.changed, false);
  assert.match(output[0], /<first\.admin@example\.com> \[admin\]/);
  assert.match(output[1], /already an administrator/);
  db.close();
});

test('central admin guard distinguishes anonymous, user, invalid role, and administrator', async () => {
  const guard = createRequireAdmin();
  const invoke = async (user) => {
    let status;
    let body;
    await guard({ user }, { code(value) { status = value; return this; }, send(value) { body = value; } });
    return { status, body };
  };
  assert.deepEqual(await invoke(null), { status: 401, body: { error: 'Authentication required.' } });
  assert.deepEqual(await invoke({ role: 'user' }), { status: 403, body: { error: 'Administrator access required.' } });
  assert.deepEqual(await invoke({}), { status: 403, body: { error: 'Administrator access required.' } });
  assert.deepEqual(await invoke({ role: 'root' }), { status: 403, body: { error: 'Administrator access required.' } });
  assert.deepEqual(await invoke({ role: 'admin' }), { status: undefined, body: undefined });
});

test('admin test-harness route reads current database role on every request and preserves ownership checks', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = Fastify();
  await app.register(fastifyCookie);
  app.get('/__test/admin-only', { preHandler: [createRequireAuth(db), createRequireAdmin()] }, async () => ({ ok: true }));
  await registerUser(db, { ...adminInput, email: 'ordinary@example.com' });
  const { token } = createSession(db, 1);
  const cookie = `ta_session=${token}`;
  assert.equal((await app.inject({ method: 'GET', url: '/__test/admin-only' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/__test/admin-only', headers: { cookie } })).statusCode, 403);
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'ordinary@example.com'").run();
  assert.equal((await app.inject({ method: 'GET', url: '/__test/admin-only', headers: { cookie } })).statusCode, 200);
  db.prepare("UPDATE users SET role = 'user' WHERE email = 'ordinary@example.com'").run();
  assert.equal((await app.inject({ method: 'GET', url: '/__test/admin-only', headers: { cookie } })).statusCode, 403);
  db.prepare("DELETE FROM users WHERE email = 'ordinary@example.com'").run();
  assert.equal((await app.inject({ method: 'GET', url: '/__test/admin-only', headers: { cookie } })).statusCode, 401);
  await app.close();

  const appWithOwnership = await buildServer({ db });
  await registerUser(db, { ...adminInput, email: 'admin-owner@example.com' });
  await registerUser(db, { ...adminInput, email: 'peer@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin-owner@example.com'").run();
  const adminId = db.prepare('SELECT id FROM users WHERE email = ?').get('admin-owner@example.com').id;
  const peerId = db.prepare('SELECT id FROM users WHERE email = ?').get('peer@example.com').id;
  db.prepare("INSERT INTO training_cycles (id,user_id,status) VALUES ('peer-cycle',?,'active')").run(peerId);
  const workout = db.prepare('INSERT INTO trainings (user_id,training_cycle_id,dia,tipo) VALUES (?,?,?,?)')
    .run(peerId, 'peer-cycle', '2026-09-23', 'Run');
  const { token: adminToken } = createSession(db, adminId);
  const access = await appWithOwnership.inject({
    method: 'GET', url: `/api/trainings/${workout.lastInsertRowid}`, headers: { cookie: `ta_session=${adminToken}` },
  });
  assert.equal(access.statusCode, 404);
  await appWithOwnership.close();
  db.close();
});

test('public registration and preference updates cannot assign admin; admin retains row ownership boundaries', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const created = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...adminInput, role: 'admin' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().role, 'user');
  assert.equal(db.prepare('SELECT role FROM users WHERE email = ?').get('first.admin@example.com').role, 'user');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: adminInput.email, password: adminInput.password } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  await app.inject({
    method: 'PATCH', url: '/api/users/me/preferences', headers: { cookie },
    payload: { first_day_of_week: 'Monday', distance_unit: 'km', temperature_unit: 'C', role: 'admin' },
  });
  assert.equal(db.prepare('SELECT role FROM users WHERE email = ?').get('first.admin@example.com').role, 'user');
  await app.close();
  db.close();
});
