'use strict';

// Administration AI prompt history (issue #113): cross-account, read-only,
// audited access to AI executions; domain, HTTP routes and the audit migration.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer, isAdminPageAlias } = require('../src/server');
const { createDatabase, migrateDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const {
  AI_PURPOSES,
  AI_STATES,
  AiHistoryError,
  getAiExecution,
  listAiAccounts,
  listAiExecutions,
} = require('../src/admin/ai-history');

const NOW = '2026-11-13T12:00:00.000Z';

function addUser(db, { email, first = null, last = null, role = 'user', active = 1 }) {
  const id = db
    .prepare(
      'INSERT INTO users (email, password_hash, first_name, last_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(email, 'unused-hash', first, last, role, active).lastInsertRowid;
  return { id: Number(id), email, role };
}

let sequence = 0;
function addExecution(db, userId, overrides = {}) {
  sequence += 1;
  const row = {
    id: `exec-${sequence}`,
    purpose: 'cycle',
    resource_id: '7',
    state: 'completed',
    external_prompt: `SECRET PROMPT ${sequence}`,
    context_json: JSON.stringify({ athlete: 'synthetic context' }),
    payload_json: JSON.stringify({ input: 'synthetic payload' }),
    configuration_json: JSON.stringify({ model: 'synthetic-model' }),
    response_json: JSON.stringify({ accepted: true }),
    created_at: `2026-11-${String(sequence).padStart(2, '0')}T08:00:00.000Z`,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO ai_executions
      (id, user_id, idempotency_key, purpose, resource_id, input_hash, prompt_version, external_prompt,
       context_json, payload_json, configuration_json, state, response_json, error_code,
       reserved_tokens, charged_tokens, reserved_cost, charged_cost, attempts, settled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'hash', 'prompt-v1', ?, ?, ?, ?, ?, ?, ?, 900, 450, 0.02, 0.01, 1, 1, ?, ?)`,
  ).run(
    row.id, userId, `key-${row.id}`, row.purpose, row.resource_id, row.external_prompt,
    row.context_json, row.payload_json, row.configuration_json, row.state, row.response_json,
    row.error_code ?? null, row.created_at, row.created_at,
  );
  return row;
}

function auditRows(db) {
  return db
    .prepare("SELECT * FROM admin_audit_log WHERE action = 'ai_execution_viewed' ORDER BY id")
    .all();
}

function fixture() {
  const db = createDatabase({ filename: ':memory:' });
  const admin = addUser(db, { email: 'admin@example.test', first: 'Ada', last: 'Admin', role: 'admin' });
  const athlete = addUser(db, { email: 'zed@example.test', first: 'Zed', last: 'Runner' });
  const quiet = addUser(db, { email: 'amy@example.test' });
  const suspended = addUser(db, { email: 'off@example.test', active: 0 });
  return { db, admin, athlete, quiet, suspended };
}

function assertHistoryError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AiHistoryError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

/* ── Domain ── */

test('accounts list every user with execution counts, active history first', () => {
  const { db, admin, athlete, quiet, suspended } = fixture();
  addExecution(db, athlete.id);
  addExecution(db, athlete.id);
  addExecution(db, suspended.id);
  const { accounts } = listAiAccounts(db);
  assert.deepEqual(accounts.map((account) => account.id), [suspended.id, athlete.id, admin.id, quiet.id]);
  assert.deepEqual(accounts[1], {
    id: athlete.id,
    email: 'zed@example.test',
    first_name: 'Zed',
    last_name: 'Runner',
    role: 'user',
    is_active: true,
    execution_count: 2,
    last_execution_at: accounts[1].last_execution_at,
  });
  assert.equal(accounts[0].is_active, false);
  assert.equal(accounts[3].execution_count, 0);
  assert.equal(accounts[3].last_execution_at, null);
  assert.equal(JSON.stringify(accounts).includes('password'), false);
});

test('an account execution list carries metadata only, newest first, filtered and paginated', () => {
  const { db, athlete, admin } = fixture();
  const first = addExecution(db, athlete.id, { purpose: 'cycle', state: 'failed', error_code: 'aiInvalidOutput' });
  const second = addExecution(db, athlete.id, { purpose: 'analysis', state: 'completed' });
  const third = addExecution(db, athlete.id, { purpose: 'workouts', state: 'completed' });
  addExecution(db, admin.id);
  const all = listAiExecutions(db, String(athlete.id));
  assert.deepEqual(all.executions.map((row) => row.id), [third.id, second.id, first.id]);
  assert.equal(all.total, 3);
  assert.equal(all.page, 1);
  assert.equal(all.limit, 25);
  assert.equal(all.account.email, 'zed@example.test');
  assert.deepEqual(Object.keys(all.executions[2]).sort(), [
    'attempts', 'charged_cost', 'charged_tokens', 'created_at', 'error_code', 'id', 'prompt_version',
    'purpose', 'reserved_tokens', 'resource_id', 'settled', 'state', 'updated_at',
  ]);
  assert.equal(all.executions[2].error_code, 'aiInvalidOutput');
  assert.equal(all.executions[2].settled, true);
  assert.equal(JSON.stringify(all).includes('SECRET PROMPT'), false);
  assert.equal(JSON.stringify(all).includes('synthetic context'), false);

  assert.deepEqual(listAiExecutions(db, athlete.id, { purpose: 'analysis' }).executions.map((row) => row.id), [second.id]);
  assert.deepEqual(listAiExecutions(db, athlete.id, { state: 'failed' }).executions.map((row) => row.id), [first.id]);
  const paged = listAiExecutions(db, athlete.id, { page: '2', limit: '2' });
  assert.deepEqual(paged.executions.map((row) => row.id), [first.id]);
  assert.equal(paged.total, 3);
  assert.equal(listAiExecutions(db, athlete.id, { limit: '500' }).limit, 100);
  assert.deepEqual(listAiExecutions(db, athlete.id, { purpose: 'cycle', state: 'completed' }).executions, []);
  // No audit record for metadata reads.
  assert.equal(auditRows(db).length, 0);
});

test('execution list input is validated before anything is read', () => {
  const { db, athlete } = fixture();
  assert.deepEqual(AI_PURPOSES, ['cycle', 'workouts', 'analysis']);
  assert.equal(AI_STATES.length, 7);
  assertHistoryError(() => listAiExecutions(db, athlete.id, { sort: 'x' }), 400, 'unknownField');
  assertHistoryError(() => listAiExecutions(db, undefined), 400, 'invalidAccountId');
  assertHistoryError(() => listAiExecutions(db, '0'), 400, 'invalidAccountId');
  assertHistoryError(() => listAiExecutions(db, '1.5'), 400, 'invalidAccountId');
  assertHistoryError(() => listAiExecutions(db, '99999999999999999999'), 400, 'invalidAccountId');
  assertHistoryError(() => listAiExecutions(db, athlete.id, { purpose: 'chat' }), 400, 'invalidPurpose');
  assertHistoryError(() => listAiExecutions(db, athlete.id, { state: 'done' }), 400, 'invalidState');
  assertHistoryError(() => listAiExecutions(db, athlete.id, { page: '0' }), 400, 'invalidPage');
  assertHistoryError(() => listAiExecutions(db, athlete.id, { limit: 'all' }), 400, 'invalidLimit');
  assertHistoryError(() => listAiExecutions(db, 4242), 404, 'accountNotFound');
});

test('reading another account execution returns the full trace and audits it atomically', () => {
  const { db, admin, athlete } = fixture();
  const row = addExecution(db, athlete.id, { purpose: 'analysis' });
  db.prepare(
    `INSERT INTO ai_execution_raw_outputs (execution_id, attempt, output_text, output_bytes, truncated, expires_at)
     VALUES (?, 1, 'live output', 11, 0, '2026-11-14T00:00:00.000Z'), (?, 2, 'stale output', 12, 0, '2026-11-12T00:00:00.000Z')`,
  ).run(row.id, row.id);
  const { execution } = getAiExecution(db, admin, row.id, () => NOW);
  assert.equal(execution.id, row.id);
  assert.equal(execution.account.id, athlete.id);
  assert.equal(execution.account.email, 'zed@example.test');
  assert.equal(execution.externalPrompt, row.external_prompt);
  assert.deepEqual(execution.context, { athlete: 'synthetic context' });
  assert.deepEqual(execution.payload, { input: 'synthetic payload' });
  assert.deepEqual(execution.configuration, { model: 'synthetic-model' });
  assert.deepEqual(execution.response, { accepted: true });
  assert.equal(execution.rawOutputs[0].output_text, 'live output');
  assert.equal(execution.rawOutputs[1].output_text, null);
  assert.equal(execution.rawOutputs[1].expired, 1);
  assert.equal(execution.costBasis, 'reserved_unknown_usage');

  const audits = auditRows(db);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_user_id, admin.id);
  assert.equal(audits[0].actor_email, 'admin@example.test');
  assert.equal(audits[0].target_user_id, athlete.id);
  assert.equal(audits[0].target_email, 'zed@example.test');
  assert.deepEqual(JSON.parse(audits[0].details), { execution_id: row.id, purpose: 'analysis' });
  // The audit trail never copies the trace itself.
  assert.equal(JSON.stringify(audits).includes('SECRET'), false);
  assert.equal(JSON.stringify(audits).includes('synthetic'), false);

  // Every read is recorded, and the identities outlive the deleted account.
  getAiExecution(db, admin, row.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(athlete.id);
  assert.equal(auditRows(db).length, 2);
  assert.equal(auditRows(db)[1].target_email, 'zed@example.test');
  assertHistoryError(() => getAiExecution(db, admin, row.id), 404, 'executionNotFound');
  assert.equal(auditRows(db).length, 2);
});

test('an administrator reading their own execution is not audited', () => {
  const { db, admin } = fixture();
  const row = addExecution(db, admin.id, { response_json: null, state: 'failed' });
  const { execution } = getAiExecution(db, admin, row.id, () => NOW);
  assert.equal(execution.response, null);
  assert.equal(execution.account.id, admin.id);
  assert.equal(auditRows(db).length, 0);
});

test('the detail read re-checks the actor and refuses invalid or unknown executions', () => {
  const { db, admin, athlete } = fixture();
  const row = addExecution(db, athlete.id);
  assertHistoryError(() => getAiExecution(db, admin, undefined), 400, 'invalidExecutionId');
  assertHistoryError(() => getAiExecution(db, admin, 'bad id!'), 400, 'invalidExecutionId');
  assertHistoryError(() => getAiExecution(db, admin, 'missing-id'), 404, 'executionNotFound');
  // A demotion committed after the route guard ran refuses the read.
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.id);
  assertHistoryError(() => getAiExecution(db, admin, row.id), 403, 'adminRequired');
  db.prepare("UPDATE users SET role = 'admin', is_active = 0 WHERE id = ?").run(admin.id);
  assertHistoryError(() => getAiExecution(db, admin, row.id), 403, 'adminRequired');
  assertHistoryError(() => getAiExecution(db, { id: 4242 }, row.id), 403, 'adminRequired');
  assert.equal(auditRows(db).length, 0);
});

/* ── Migration ── */

const OLD_AUDIT_TABLE = `CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER,
  actor_email TEXT NOT NULL DEFAULT '',
  target_user_id INTEGER,
  target_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN (
    'account_created', 'account_updated', 'account_role_changed', 'account_deleted',
    'account_activity_changed'
  )),
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

test('the audit migration extends the action list and keeps every existing row', () => {
  const db = createDatabase({ filename: ':memory:' });
  const marker = "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-11-admin-ai-execution-view-v1'";
  assert.equal(db.prepare(marker).get().count, 1);
  // Simulate a database from before the migration: the old CHECK and a trail.
  db.exec(`DROP TABLE admin_audit_log; ${OLD_AUDIT_TABLE};`);
  db.prepare(
    `INSERT INTO admin_audit_log (id, actor_user_id, actor_email, target_user_id, target_email, action, details, created_at)
     VALUES (7, 1, 'a@example.test', 2, 'b@example.test', 'account_activity_changed', '{"from":"active","to":"inactive"}', '2026-09-01 10:00:00')`,
  ).run();
  assert.throws(() => db.prepare("INSERT INTO admin_audit_log (action) VALUES ('ai_execution_viewed')").run(), /CHECK/);
  db.prepare("DELETE FROM schema_migrations WHERE name = '2026-11-admin-ai-execution-view-v1'").run();
  migrateDatabase(db);
  assert.equal(db.prepare(marker).get().count, 1);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM admin_audit_log WHERE id = 7').get() },
    {
      id: 7,
      actor_user_id: 1,
      actor_email: 'a@example.test',
      target_user_id: 2,
      target_email: 'b@example.test',
      action: 'account_activity_changed',
      details: '{"from":"active","to":"inactive"}',
      created_at: '2026-09-01 10:00:00',
    },
  );
  db.prepare("INSERT INTO admin_audit_log (action) VALUES ('ai_execution_viewed')").run();
  assert.throws(() => db.prepare("INSERT INTO admin_audit_log (action) VALUES ('unknown_action')").run(), /CHECK/);

  // Re-running is a no-op; a missing marker over an already extended table
  // only records the marker, without rebuilding or losing rows.
  migrateDatabase(db);
  db.prepare("DELETE FROM schema_migrations WHERE name = '2026-11-admin-ai-execution-view-v1'").run();
  migrateDatabase(db);
  assert.equal(db.prepare(marker).get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 2);
});

/* ── HTTP ── */

async function serverFixture() {
  const data = fixture();
  const app = await buildServer({ db: data.db, sessionCookieSecure: false });
  const cookie = (user) => `${SESSION_COOKIE_NAME}=${createSession(data.db, user.id).token}`;
  return { ...data, app, adminCookie: cookie(data.admin), userCookie: cookie(data.athlete) };
}

test('the prompt history page and API require a current administrator', async () => {
  const { app, db, adminCookie, userCookie, admin, athlete } = await serverFixture();
  const row = addExecution(db, athlete.id);
  const urls = ['/api/admin/ai/accounts', `/api/admin/ai/accounts/${athlete.id}/executions`, `/api/admin/ai/executions/${row.id}`];
  for (const url of urls) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: userCookie } })).statusCode, 403);
  }
  assert.equal(auditRows(db).length, 0);

  const anonymousPage = await app.inject({ method: 'GET', url: '/admin-ai-history.html' });
  assert.equal(anonymousPage.statusCode, 302);
  assert.equal(anonymousPage.headers.location, '/login.html');
  const userPage = await app.inject({ method: 'GET', url: '/admin-ai-history.html', headers: { cookie: userCookie } });
  assert.equal(userPage.headers.location, '/home.html');
  const adminPage = await app.inject({ method: 'GET', url: '/admin-ai-history.html', headers: { cookie: adminCookie } });
  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.body, /admin-ai-history\.js/);
  assert.equal(isAdminPageAlias('/./admin-ai-history.html'), true);
  assert.equal(isAdminPageAlias('/admin-ai-history.html'), false);
  const alias = await app.inject({ method: 'GET', url: '//admin-ai-history.html', headers: { cookie: userCookie } });
  assert.equal(alias.headers.location, '/home.html');

  // The role is re-read on every request.
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.id);
  assert.equal((await app.inject({ method: 'GET', url: urls[0], headers: { cookie: adminCookie } })).statusCode, 403);
  await app.close();
});

test('the prompt history API lists, reads with audit, and reports stable errors', async () => {
  const { app, db, adminCookie, athlete } = await serverFixture();
  const row = addExecution(db, athlete.id, { purpose: 'workouts' });
  const get = (url) => app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });

  const accounts = await get('/api/admin/ai/accounts');
  assert.equal(accounts.statusCode, 200);
  assert.equal(accounts.headers['cache-control'], 'no-store');
  assert.equal(accounts.json().accounts[0].id, athlete.id);

  const list = await get(`/api/admin/ai/accounts/${athlete.id}/executions?purpose=workouts&page=1&limit=10`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.deepEqual(list.json().executions.map((item) => item.id), [row.id]);
  assert.equal(list.body.includes('SECRET PROMPT'), false);

  const detail = await get(`/api/admin/ai/executions/${row.id}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.equal(detail.json().execution.externalPrompt, row.external_prompt);
  assert.equal(auditRows(db).length, 1);

  const invalid = await get(`/api/admin/ai/accounts/${athlete.id}/executions?state=nope`);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'State is invalid.', errors: ['invalidState'] });
  const missingAccount = await get('/api/admin/ai/accounts/9999/executions');
  assert.equal(missingAccount.statusCode, 404);
  assert.deepEqual(missingAccount.json().errors, ['accountNotFound']);
  const missing = await get('/api/admin/ai/executions/unknown-execution');
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json().errors, ['executionNotFound']);

  // Unexpected failures are not translated into domain errors.
  db.exec('DROP TABLE ai_execution_raw_outputs');
  assert.equal((await get(`/api/admin/ai/executions/${row.id}`)).statusCode, 500);
  db.exec('DROP TABLE ai_executions');
  assert.equal((await get(`/api/admin/ai/accounts/${athlete.id}/executions`)).statusCode, 500);
  assert.equal(auditRows(db).length, 1);
  await app.close();
});
