'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { toConnectorPayload, runOperation, safeCode, connectorTarget } = require('../src/garmin/product');
const { prescriptionFingerprint } = require('../src/garmin-workout-contract');

async function login(app, email) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pilot-password' } });
  return [].concat(response.headers['set-cookie'])[0].split(';')[0];
}

async function productApiHarness({ garminFetch, config = {}, now } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1',
      KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid', ...config },
    garminFetch: garminFetch || (async () => Response.json({ status: 'disconnected' })), garminNow: now });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'product-harness@example.test', password: 'pilot-password', first_name: 'Pilot', last_name: 'Runner' } });
  const cookie = await login(app, 'product-harness@example.test');
  db.prepare('INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,\'2026-11-02\',\'run\',\'tempo\')').run();
  return { db, app, cookie, close: async () => { await app.close(); db.close(); } };
}

function workout() {
  return { version: 1, sport: 'running', name: 'Tempo session', steps: [
    { id: 'warmup', kind: 'warmup', end: { type: 'time', value: 600 }, target: { type: 'none' } },
    { id: 'repeat', kind: 'repeat', repetitions: 4,
      interval: { end: { type: 'time', value: 300 }, target: { type: 'pace', unit: 'min_per_km', slower_seconds: 360, faster_seconds: 300 } },
      recovery: { end: { type: 'time', value: 120 }, target: { type: 'none' } } },
    { id: 'cooldown', kind: 'cooldown', end: { type: 'time', value: 600 }, target: { type: 'none' } },
  ] };
}

function seedWorker(operationId, overrides = {}) {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash,is_active) VALUES (1,'worker@example.test','hash',?)").run(overrides.active ?? 1);
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare(`INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id,action)
    VALUES (?,1,1,1,1,?,1,'publishing',?,'2026-11-02',?,?,?)`).run(operationId, fingerprint, overrides.stage || 'schedule', overrides.workoutId || null, overrides.occurrenceId || null, overrides.action || 'publish');
  const operation = { operationId, ownerId: 1, trainingId: 1, generation: 1, revision: 1,
    fingerprint, date: '2026-11-02', prescription, action: overrides.action || 'publish',
    stage: overrides.stage || 'schedule', workoutId: overrides.workoutId || null,
    occurrenceId: overrides.occurrenceId || null, sourceOperation: overrides.sourceOperation };
  const current = (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id);
  return { db, operation, current };
}

test('Garmin session APIs require login, enforce pilot owner, and persist preview without remote mutation', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const remoteCalls = [];
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url) => { remoteCalls.push(url); return Response.json({ status: 'connected' }); },
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'pilot-ui@example.com', password: 'pilot-password', first_name: 'Runner', last_name: 'Test' } });
  const cookie = await login(app, 'pilot-ui@example.com');
  db.prepare('INSERT INTO trainings (user_id, dia, tipo, treino, detalhes) VALUES (1, ?, ?, ?, ?)').run('2026-11-02', 'Run', 'Intervals', '6 x 3 min');
  assert.equal((await app.inject({ method: 'GET', url: '/api/garmin/status' })).statusCode, 401);
  let response = await app.inject({ method: 'GET', url: '/api/garmin/status?training_id=1', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  response = await app.inject({ method: 'GET', url: '/api/trainings/1/garmin', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  response = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: workout() } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision, 1);
  assert.equal(response.json().preview.steps[1].repetitions, 4);
  assert.equal(db.prepare('SELECT detalhes FROM trainings WHERE id = 1').get().detalhes, '6 x 3 min');
  assert.deepEqual(remoteCalls, ['http://connector.invalid/v1/connections/1/pilot/status', 'http://connector.invalid/v1/connections/1/pilot/capabilities']);
  await app.close(); db.close();
});

test('prescription writes reject an obsolete expected revision without overwriting the current prescription', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40) },
    garminFetch: async () => Response.json({ status: 'connected' }),
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'revision@example.test', password: 'pilot-password', first_name: 'Revision', last_name: 'Runner' } });
  const cookie = await login(app, 'revision@example.test');
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino) VALUES (1,?,?,?)').run('2026-11-02', 'run', 'tempo');
  const first = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: workout() } });
  assert.equal(first.statusCode, 200);
  const changed = workout(); changed.name = 'Changed title';
  const second = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { expected_revision: 1, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: changed } });
  assert.equal(second.statusCode, 200);
  const noOp = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { expected_revision: 2, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: changed } });
  assert.equal(noOp.statusCode, 200);
  assert.equal(noOp.json().revision, 2, 'a no-op save does not manufacture a new prescription revision');
  const stale = workout(); stale.name = 'Stale overwrite';
  const response = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { expected_revision: 1, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: stale } });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json).name, 'Changed title');
  await app.close(); db.close();
});

test('status tolerates a disconnected connector without a training snapshot and cleanup failure stays recoverable', async () => {
  let db;
  const h = await productApiHarness({ config: { KINESIS_GARMIN_SERVICE_TOKEN: '' }, garminFetch: async (url, init) => {
    if (url.endsWith('/auth/start')) { db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(); return Response.json({ status: 'disconnected' }); }
    if (init.method === 'DELETE') throw new Error('synthetic transport failure');
    return Response.json({ status: 'disconnected' });
  } });
  db = h.db;
  try {
    const status = await h.app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie: h.cookie } });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json().devices, []);
    assert.equal(status.json().running_catalog_status, 'unknown');
    const local = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin', headers: { cookie: h.cookie } });
    assert.equal(local.statusCode, 200);
    assert.equal(local.json().prescription, null);
    assert.equal(local.json().operation, null);
    const revoked = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'garmin@example.test', password: 'transient' } });
    assert.equal(revoked.statusCode, 401);
    assert.equal(h.db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get().pending, 1);
  } finally { await h.close(); }
});

test('product API rejects absent and stale resources and keeps an unchanged scheduled occurrence', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => Response.json({
    status: 'disconnected', devices: [],
  }) });
  try {
    const cookie = h.cookie;
    const absent = await h.app.inject({ method: 'GET', url: '/api/trainings/404/garmin', headers: { cookie } });
    assert.equal(absent.statusCode, 404);
    const noPrescription = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie }, payload: {} });
    assert.equal(noPrescription.statusCode, 409);
    assert.equal(noPrescription.json().code, 'prescription_required');
    const missingOperation = await h.app.inject({ method: 'POST', url: '/api/garmin/operations/missing/reconcile', headers: { cookie } });
    assert.equal(missingOperation.statusCode, 404);
    const inserted = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: {
      expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: workout(),
    } });
    assert.equal(inserted.statusCode, 200);
    const fingerprint = inserted.json().fingerprint;
    h.db.prepare(`INSERT INTO garmin_training_operations
      (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
      VALUES ('still-current',1,1,1,1,?,1,'scheduled','complete','2026-11-02','42','77')`).run(fingerprint);
    const state = await h.app.inject({ method: 'GET', url: '/api/garmin/status?training_id=1', headers: { cookie } });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().operation.status, 'scheduled');
    assert.equal(state.json().operation.occurrence_id, '77');
    const duplicateReconcile = await h.app.inject({ method: 'POST', url: '/api/garmin/operations/still-current/reconcile', headers: { cookie } });
    assert.equal(duplicateReconcile.statusCode, 409);
    assert.equal(duplicateReconcile.json().code, 'invalid_state');
  } finally { await h.close(); }
});

test('authentication endpoints validate missing requests and preserve sanitized upstream failures', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) return Response.json({ detail: { code: 'rate_limited' } }, { status: 429 });
    if (url.endsWith('/auth/cancel') || init?.method === 'DELETE') return Response.json({ detail: { code: 'unavailable' } }, { status: 503 });
    return Response.json({ status: 'disconnected' });
  } });
  try {
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie } })).statusCode, 400);
    const denied = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'pilot@example.test', password: 'transient' } });
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.body.includes('transient'), false);
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: {} })).statusCode, 400);
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: h.cookie }, payload: {} })).statusCode, 400);
    const disconnect = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
    assert.equal(disconnect.statusCode, 503);
  } finally { await h.close(); }
});

test('status, auth start, cancel, and disconnect normalize connection failures', async () => {
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    if (url.endsWith('/auth/start')) throw new Error('private auth transport detail');
    if (url.endsWith('/auth/cancel')) return Response.json({ detail: { code: 'unavailable' } }, { status: 503 });
    if (url.endsWith('/status')) throw new Error('private status transport detail');
    if (init?.method === 'DELETE') return Response.json({ detail: { code: 'auth_required' } }, { status: 401 });
    return Response.json({ status: 'disconnected' });
  } });
  try {
    let response = await h.app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie: h.cookie } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('private status'), false);
    response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'garmin@example.test', password: 'transient' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('private auth'), false);
    response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'auth_required');
  } finally { await h.close(); }
});

test('connection identity requires the documented fingerprint and clears transient credentials on failure', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => url.endsWith('/auth/start')
    ? Response.json({ status: 'connected' }) : Response.json({ status: 'disconnected' }) });
  try {
    const response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: {
      email: 'garmin@example.test', password: 'transient-secret',
    } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('transient-secret'), false);
    assert.equal(h.db.prepare('SELECT identity_fingerprint FROM garmin_pilot_connections WHERE user_id=1').get(), undefined);
  } finally { await h.close(); }
});

test('MFA finish and cancellation keep challenges scoped after sanitized upstream failures', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'retryable-challenge', expires_in: 300 });
    if (url.endsWith('/auth/finish')) return Response.json({ detail: { code: 'auth_required' } }, { status: 401 });
    if (url.endsWith('/auth/cancel')) throw new Error('private cancellation detail');
    return Response.json({ status: 'disconnected' });
  } });
  try {
    const first = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'garmin@example.test', password: 'secret' } });
    assert.equal(first.json().status, 'mfa_required');
    const failedFinish = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: 'retryable-challenge', code: '111111' } });
    assert.equal(failedFinish.statusCode, 401);
    assert.equal(failedFinish.body.includes('private'), false);
    const failedCancel = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: h.cookie }, payload: { challenge_id: 'retryable-challenge' } });
    assert.equal(failedCancel.statusCode, 503);
    assert.equal(failedCancel.body.includes('private'), false);
    const retried = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: 'retryable-challenge', code: '222222' } });
    assert.equal(retried.statusCode, 400, 'a remote failure does not restore or widen the consumed local challenge');
  } finally { await h.close(); }
});

test('MFA failure after owner revocation discards the challenge and invokes internal cleanup', async () => {
  let h;
  let cleanupCalls = 0;
  h = await productApiHarness({ garminFetch: async (url, init) => {
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'revoked-challenge', expires_in: 300 });
    if (url.endsWith('/auth/finish')) {
      h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
      return Response.json({ detail: { code: 'auth_required' } }, { status: 401 });
    }
    if (init?.method === 'DELETE') { cleanupCalls += 1; return new Response(null, { status: 204 }); }
    return Response.json({ status: 'disconnected' });
  } });
  try {
    const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'garmin@example.test', password: 'secret' } });
    const finish = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '333333' } });
    assert.equal(finish.statusCode, 401);
    assert.equal(cleanupCalls, 1);
    const state = h.db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get();
    assert.equal(state.pending, 0);
  } finally { await h.close(); }
});

test('worker resumes scheduling an existing workout against the local connector default and retains uncertainty', async () => {
  const h = seedWorker('default-connector', { workoutId: '42', stage: 'schedule' });
  const calls = [];
  try {
    await runOperation(h.db, async (url, init) => {
      calls.push({ url, method: init.method });
      return Response.json({}, { status: 503 });
    }, {}, h.operation, h.current);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:8080/v1/connections/1/pilot/workouts/schedule', method: 'POST' }]);
    const row = h.db.prepare("SELECT status,stage,workout_id,error_code FROM garmin_training_operations WHERE operation_id='default-connector'").get();
    assert.deepEqual(row, { status: 'failed', stage: 'schedule', workout_id: '42', error_code: 'unavailable' });
  } finally { h.db.close(); }
});

test('worker catches an unsupported conversion before dispatch and records a terminal safe error', async () => {
  const h = seedWorker('unsupported-conversion');
  let calls = 0;
  try {
    h.operation.prescription.steps = [{ id: 'open', kind: 'open', end: { type: 'open' }, target: { type: 'none' } }];
    await runOperation(h.db, async () => { calls += 1; }, {}, h.operation, h.current);
    const row = h.db.prepare("SELECT status,stage,error_code FROM garmin_training_operations WHERE operation_id='unsupported-conversion'").get();
    assert.equal(calls, 0);
    assert.deepEqual(row, { status: 'failed', stage: 'unknown', error_code: 'unsupported' });
  } finally { h.db.close(); }
});

test('every Garmin product mutation remains unavailable outside the configured pilot owner', async () => {
  const h = await productApiHarness({ config: { GARMIN_PILOT_USER_ID: '99' }, garminFetch: async () => {
    throw new Error('must not reach connector');
  } });
  try {
    for (const [method, url, payload] of [
      ['POST', '/api/garmin/auth/start', { email: 'garmin@example.test', password: 'transient' }],
      ['POST', '/api/garmin/auth/finish', { challenge_id: 'opaque', code: '000000' }],
      ['POST', '/api/garmin/auth/cancel', { challenge_id: 'opaque' }],
      ['GET', '/api/trainings/1/garmin'],
      ['PUT', '/api/trainings/1/garmin/prescription', { expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription: workout() }],
      ['POST', '/api/trainings/1/garmin/publish', {}],
      ['POST', '/api/garmin/operations/opaque/reconcile'],
    ]) {
      const response = await h.app.inject({ method, url, headers: { cookie: h.cookie }, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
      assert.equal(response.json().code, 'pilot_unavailable');
    }
    const disconnect = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
    assert.equal(disconnect.statusCode, 404);
  } finally { await h.close(); }
});

test('publish rejects a date changed after the confirmed preview without dispatching a mutation', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const calls = [];
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url) => { calls.push(url); return Response.json({ status: 'connected' }); },
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'date-snapshot@example.test', password: 'pilot-password', first_name: 'Date', last_name: 'Runner' } });
  const cookie = await login(app, 'date-snapshot@example.test');
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino) VALUES (1,?,?,?)').run('2026-11-02', 'run', 'tempo');
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare("UPDATE trainings SET dia='2026-11-03' WHERE id=1").run();
  const response = await app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie }, payload: {
    fingerprint, expected_date: '2026-11-02', expected_revision: 1, expected_connection_generation: 1,
  } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'session_changed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM garmin_training_operations').get().count, 0);
  assert.deepEqual(calls, []);
  await app.close(); db.close();
});

test('Garmin pilot is limited to configured owner and active account and rejects malformed prescription', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40) },
    garminFetch: async () => Response.json({ status: 'connected' }),
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'pilot-owner@example.com', password: 'pilot-password', first_name: 'Runner', last_name: 'Test' } });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'another-owner@example.com', password: 'pilot-password', first_name: 'Other', last_name: 'Test' } });
  const cookie = await login(app, 'pilot-owner@example.com');
  const otherLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'another-owner@example.com', password: 'pilot-password' } });
  const otherCookie = [].concat(otherLogin.headers['set-cookie'])[0].split(';')[0];
  let response = await app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie: otherCookie } });
  assert.equal(response.statusCode, 404);
  response = await app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie }, payload: { email: 'x', password: 'never-persist-this' } });
  assert.equal(response.statusCode, 400);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 1').run();
  response = await app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie } });
  assert.equal(response.statusCode, 401);
  await app.close(); db.close();
});

test('connector conversion preserves timed repeat, pace and absolute HR semantics', () => {
  const operation = { operationId: 'op-1', prescription: workout() };
  const payload = toConnectorPayload(operation);
  assert.equal(payload.repetitions, 4);
  assert.equal(payload.warmup_seconds, 600);
  assert.equal(payload.recovery_seconds, 120);
  assert.equal(payload.target_kind, 'pace');
  assert.ok(payload.target_lower_mps < payload.target_upper_mps);
  operation.prescription.steps[1].interval.target = { type: 'heart_rate', mode: 'absolute', lower_bpm: 140, upper_bpm: 165 };
  const hrPayload = toConnectorPayload(operation);
  assert.equal(hrPayload.target_kind, 'heart_rate');
  assert.deepEqual([hrPayload.target_lower_bpm, hrPayload.target_upper_bpm], [140, 165]);
  operation.prescription.steps[1].interval.end = { type: 'distance', value: 1000 };
  const distancePayload = toConnectorPayload(operation);
  assert.equal(distancePayload.interval_seconds, null);
  assert.equal(distancePayload.interval_distance_meters, 1000);
  operation.prescription.steps[1].recovery.target = { type: 'heart_rate', mode: 'absolute', lower_bpm: 110, upper_bpm: 130 };
  const recoveryHr = toConnectorPayload(operation);
  assert.deepEqual([recoveryHr.recovery_target_kind, recoveryHr.recovery_target_lower_bpm,
    recoveryHr.recovery_target_upper_bpm], ['heart_rate', 110, 130]);
  operation.prescription.steps[1].recovery.target = { type: 'pace', unit: 'min_per_mile', slower_seconds: 600, faster_seconds: 540 };
  const recoveryPace = toConnectorPayload(operation);
  assert.equal(recoveryPace.recovery_target_kind, 'pace');
  assert.ok(recoveryPace.recovery_target_lower_mps < recoveryPace.recovery_target_upper_mps);
  operation.prescription.steps = [{ id: 'open', kind: 'open', end: { type: 'open' }, target: { type: 'none' } }];
  assert.throws(() => toConnectorPayload(operation), /unsupported/);
});

test('connector target conversion is explicit for every supported target and refuses unknown kinds', () => {
  assert.deepEqual(connectorTarget({ type: 'none' }), { kind: 'none', pace: null, lowerBpm: null, upperBpm: null });
  assert.deepEqual(connectorTarget({ type: 'heart_rate', mode: 'absolute', lower_bpm: 120, upper_bpm: 160 }),
    { kind: 'heart_rate', pace: null, lowerBpm: 120, upperBpm: 160 });
  assert.equal(connectorTarget({ type: 'pace', unit: 'min_per_km', slower_seconds: 360, faster_seconds: 300 }).kind, 'pace');
  assert.throws(() => connectorTarget({ type: 'heart_rate', mode: 'zone', lower_bpm: 2, upper_bpm: 4 }), /unsupported/);
  assert.equal(safeCode(new Error('rate_limited')), 'rate_limited');
  assert.equal(safeCode(new Error('sensitive upstream message')), 'unavailable');
});

test('converter preserves a single timed or distance run and refuses unsupported step combinations', () => {
  const operation = { operationId: 'single-run', prescription: workout() };
  operation.prescription.steps = [{ id: 'run', kind: 'run', end: { type: 'time', value: 900 }, target: { type: 'none' } }];
  assert.equal(toConnectorPayload(operation).interval_seconds, 900);
  operation.prescription.steps[0].end = { type: 'distance', value: 5000 };
  assert.equal(toConnectorPayload(operation).interval_distance_meters, 5000);
  operation.prescription.steps = [{ id: 'recovery', kind: 'recovery', end: { type: 'time', value: 120 }, target: { type: 'none' } }];
  assert.throws(() => toConnectorPayload(operation), /unsupported/);
  operation.prescription.steps = [{ id: 'warm', kind: 'warmup', end: { type: 'time', value: 600 }, target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 120, upper_bpm: 150 } },
    { id: 'run', kind: 'run', end: { type: 'time', value: 900 }, target: { type: 'none' } }];
  assert.throws(() => toConnectorPayload(operation), /unsupported/);
  operation.prescription.steps = workout().steps;
  operation.prescription.steps[1].recovery.end.value = 3601;
  assert.throws(() => toConnectorPayload(operation), /unsupported/);
  operation.prescription.steps[1].recovery.end.value = 120;
  operation.prescription.steps[1].repetitions = 21;
  assert.throws(() => toConnectorPayload(operation), /unsupported/);
});

test('MFA challenge is bound to the Kinesis login session and cancellation rejects another session', async () => {
  const db = createDatabase({ filename: ':memory:' }); const remotePaths = [];
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40) },
    garminFetch: async (url) => { remotePaths.push(url); return Response.json(url.endsWith('/auth/start')
      ? { status: 'mfa_required', challenge_id: 'opaque-challenge-id-12345', expires_in: 300 }
      : { status: 'disconnected' }); },
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'mfa-owner@example.com', password: 'pilot-password', first_name: 'Runner', last_name: 'Test' } });
  const sessionA = await login(app, 'mfa-owner@example.com');
  const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'mfa-owner@example.com', password: 'pilot-password' } });
  const sessionB = [].concat(loginB.headers['set-cookie'])[0].split(';')[0];
  const started = await app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: sessionA }, payload: { email: 'garmin@example.test', password: 'transient-only' } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().status, 'mfa_required');
  assert.equal(started.body.includes('transient-only'), false);
  let response = await app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: sessionB }, payload: { challenge_id: started.json().challenge_id } });
  assert.equal(response.statusCode, 400);
  assert.equal(remotePaths.filter((url) => url.endsWith('/auth/cancel')).length, 0);
  response = await app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: sessionA }, payload: { challenge_id: started.json().challenge_id } });
  assert.equal(response.statusCode, 200);
  assert.equal(remotePaths.filter((url) => url.endsWith('/auth/cancel')).length, 1);
  await app.close(); db.close();
});

test('persisted publication operation schedules the same workout without a transaction during network calls', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(`INSERT INTO users (id,email,password_hash) VALUES (1,'op@example.com','hash')`).run();
  db.prepare(`INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','intervals')`).run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare(`INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)`).run(JSON.stringify(prescription), fingerprint);
  db.prepare(`INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date) VALUES ('op-1',1,1,1,1,?,1,'publishing','publish','2026-11-02')`).run(fingerprint);
  const transaction = db.transaction;
  let calls = 0;
  const fakeFetch = async (url) => {
    assert.equal(db.inTransaction, false);
    calls += 1;
    if (url.endsWith('/workouts')) return Response.json({ workout_id: 42 });
    return Response.json({ scheduled: true, status: 'scheduled', scheduled_workout_id: 77 });
  };
  await runOperation(db, fakeFetch, { GARMIN_CONNECTOR_URL: 'http://connector', KINESIS_GARMIN_SERVICE_TOKEN: 'x' },
    { operationId: 'op-1', ownerId: 1, trainingId: 1, generation: 1, revision: 1, fingerprint, date: '2026-11-02', prescription },
    (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id));
  const row = db.prepare('SELECT status,workout_id,occurrence_id,stage FROM garmin_training_operations WHERE operation_id = ?').get('op-1');
  assert.equal(calls, 2);
  assert.deepEqual(row, { status: 'scheduled', workout_id: '42', occurrence_id: '77', stage: 'complete' });
  assert.equal(typeof transaction, 'function');
  db.close();
});

test('reconciliation after reauthentication resumes scheduling the persisted workout without republishing', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'resume@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare("INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,action) VALUES ('resume-1',1,1,1,1,?,1,'reauth_required','schedule','2026-11-02','42','publish')").run(fingerprint);
  const calls = [];
  const result = await runOperation(db, async (url) => {
    calls.push(url);
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic' }, {
    operationId: 'resume-1', ownerId: 1, trainingId: 1, generation: 1, revision: 1,
    fingerprint, date: '2026-11-02', prescription, action: 'publish', stage: 'schedule', workoutId: '42',
  }, (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id));
  const row = db.prepare("SELECT status,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id='resume-1'").get();
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/workouts\/schedule$/);
  assert.deepEqual(row, { status: 'scheduled', workout_id: '42', occurrence_id: '77' });
  db.close();
});

test('owner revocation during a remote publish preserves uncertainty and performs durable local cleanup', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'revoked@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare("INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date) VALUES ('revoked-1',1,1,1,1,?,1,'publishing','publish','2026-11-02')").run(fingerprint);
  let cleanupCalls = 0;
  const calls = [];
  const response = await runOperation(db, async (url, init) => {
    calls.push(url);
    if (init.method === 'POST') {
      db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
      return Response.json({ workout_id: 91 });
    }
    return new Response(null, { status: 204 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic' }, {
    operationId: 'revoked-1', ownerId: 1, trainingId: 1, generation: 1, revision: 1,
    fingerprint, date: '2026-11-02', prescription, action: 'publish',
  }, (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id), {
    onOwnerIneligible: async () => { cleanupCalls += 1; return true; },
  });
  const row = db.prepare("SELECT status,stage,error_code,workout_id FROM garmin_training_operations WHERE operation_id='revoked-1'").get();
  assert.equal(response, undefined);
  assert.equal(calls.length, 1, 'no schedule follows observed owner revocation');
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(row, { status: 'outcome_unknown', stage: 'owner_revoked', error_code: 'cleanup_complete', workout_id: '91' });
  db.close();
});

test('updating a changed prescription reuses the workout and reschedules only its linked occurrence', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'update@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-03','run','tempo')").run();
  const prescription = workout(); prescription.name = 'Updated tempo';
  const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,2,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare(`INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('source-update',1,1,1,1,'old',1,'outdated','complete','2026-11-02','42','77')`).run();
  db.prepare(`INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,action,source_operation_id,workout_id,occurrence_id)
    VALUES ('update-op',1,1,1,2,?,1,'publishing','update','2026-11-03','update','source-update','42','77')`).run(fingerprint);
  const calls = [];
  await runOperation(db, async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    if (url.endsWith('/workouts/42')) return Response.json({ updated: true, workout_id: 42 });
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic' }, {
    operationId: 'update-op', ownerId: 1, trainingId: 1, generation: 1, revision: 2,
    fingerprint, date: '2026-11-03', prescription, action: 'update', stage: 'update',
    workoutId: '42', occurrenceId: '77', sourceOperation: db.prepare("SELECT * FROM garmin_training_operations WHERE operation_id='source-update'").get(),
  }, (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id));
  assert.deepEqual(calls.map((call) => call.method), ['PUT', 'PUT']);
  assert.match(calls[0].url, /\/workouts\/42$/);
  assert.match(calls[1].url, /\/workouts\/schedule\/77$/);
  assert.equal(calls[1].body.date, '2026-11-03');
  assert.equal(db.prepare("SELECT status FROM garmin_training_operations WHERE operation_id='update-op'").get().status, 'scheduled');
  db.close();
});

test('worker restart marks interrupted stages uncertain once and preserves remote IDs across registrations', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'restart@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-03','run','tempo')").run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('interrupted-1',1,1,1,1,?,1,'scheduling','reschedule','2026-11-03','42','84')`).run(fingerprint);
  const config = { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2) };
  const first = await buildServer({ db, sessionCookieSecure: false, garminConfig: config, garminFetch: async () => Response.json({ status: 'disconnected' }) });
  assert.deepEqual(db.prepare("SELECT status,stage,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id='interrupted-1'").get(),
    { status: 'outcome_unknown', stage: 'reschedule', workout_id: '42', occurrence_id: '84' });
  await first.close();
  db.prepare("UPDATE garmin_training_operations SET status='scheduling' WHERE operation_id='interrupted-1'").run();
  const second = await buildServer({ db, sessionCookieSecure: false, garminConfig: config, garminFetch: async () => Response.json({ status: 'disconnected' }) });
  assert.equal(db.prepare("SELECT status FROM garmin_training_operations WHERE operation_id='interrupted-1'").get().status, 'scheduling',
    'registering a second server instance over the same database does not run process-restart recovery again');
  await second.close(); db.close();
});

test('same Garmin identity reauthentication preserves connection generation; account change advances it', async () => {
  const db = createDatabase({ filename: ':memory:' });
  let identity = 'a'.repeat(64);
  let failAuthentication = false;
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40) },
    garminFetch: async (url) => {
      if (url.endsWith('/auth/start')) return failAuthentication
        ? Response.json({ detail: { code: 'unavailable' } }, { status: 503 })
        : Response.json({ status: 'connected', identity_fingerprint: identity });
      return Response.json({ status: 'disconnected' });
    },
  });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'identity@example.test', password: 'pilot-password', first_name: 'Identity', last_name: 'Runner' } });
  const cookie = await login(app, 'identity@example.test');
  const authenticate = () => app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie }, payload: { email: 'owner@example.test', password: 'synthetic-only' } });
  let response = await authenticate();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connection_generation, 1);
  response = await authenticate();
  assert.equal(response.json().connection_generation, 1);
  identity = 'b'.repeat(64);
  response = await authenticate();
  assert.equal(response.json().connection_generation, 2);
  assert.doesNotMatch(response.body, /b{64}/);
  failAuthentication = true;
  response = await authenticate();
  assert.equal(response.statusCode, 503);
  assert.equal(db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id=1').get().connection_generation, 2);
  await app.close(); db.close();
});

function operationHarness({ id = 'stage-op', status = 'publishing', stage = 'publish', action = 'publish',
  ownerActive = 1, generation = 1, connectionGeneration = generation, date = '2026-11-02', trainingDate = date, completed = 0, revision = 1,
  workoutId = null, occurrenceId = null, sourceOperation = null } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash,is_active) VALUES (1,'stage@example.test','hash',?)").run(ownerActive);
  db.prepare('INSERT INTO trainings (id,user_id,dia,tipo,treino,completed) VALUES (1,1,?,\'run\',\'tempo\',?)').run(trainingDate, completed);
  const prescription = workout();
  const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,?,?,?)')
    .run(revision, JSON.stringify(prescription), fingerprint);
  db.prepare(`INSERT INTO garmin_pilot_connections (user_id,connection_generation) VALUES (1,?)`).run(connectionGeneration);
  if (sourceOperation) db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES (?,1,1,?,1,'source-fingerprint',1,'scheduled','complete',?,?,?)`)
    .run(sourceOperation.operation_id, generation, sourceOperation.scheduled_date, sourceOperation.workout_id, sourceOperation.occurrence_id);
  db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,action,source_operation_id,workout_id,occurrence_id)
    VALUES (?,1,1,?,?,?,1,?,?,?, ?,?,?,?)`).run(id, generation, revision, fingerprint, status, stage,
    date, action, sourceOperation?.operation_id || null, workoutId, occurrenceId);
  const operation = { operationId: id, ownerId: 1, trainingId: 1, generation, revision, fingerprint,
    date, prescription, action, stage, workoutId, occurrenceId, sourceOperation };
  const current = (_request, trainingId) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(trainingId);
  const row = () => db.prepare('SELECT status,stage,error_code,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id=?').get(id);
  return { db, operation, current, row };
}

test('reschedule updates only the linked occurrence and reaches a terminal state', async () => {
  const source = { operation_id: 'source-reschedule', scheduled_date: '2026-11-02', workout_id: '42', occurrence_id: '77' };
  const h = operationHarness({ id: 'reschedule-op', status: 'publishing', stage: 'reschedule', action: 'reschedule',
    date: '2026-11-03', workoutId: '42', occurrenceId: '77', sourceOperation: source });
  const calls = [];
  await runOperation(h.db, async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic' }, h.operation, h.current);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/workouts\/schedule\/77$/);
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, { operation_id: 'reschedule-op', scheduled_workout_id: 77, workout_id: 42, date: '2026-11-03' });
  assert.deepEqual(h.row(), { status: 'scheduled', stage: 'complete', error_code: null, workout_id: '42', occurrence_id: '77' });
  h.db.close();
});

test('schedule and reschedule refuse malformed success bodies without claiming completion', async () => {
  for (const config of [
    { id: 'bad-schedule', action: 'publish', stage: 'schedule', workoutId: '42', occurrenceId: null, response: { scheduled: true } },
    { id: 'bad-reschedule', action: 'reschedule', stage: 'reschedule', workoutId: '42', occurrenceId: '77', response: { scheduled: true, scheduled_workout_id: 88 } },
  ]) {
    const source = config.action === 'reschedule' ? { operation_id: `source-${config.id}`, scheduled_date: '2026-11-02', workout_id: '42', occurrence_id: '77' } : null;
    const h = operationHarness({ ...config, sourceOperation: source });
    const response = await runOperation(h.db, async () => Response.json(config.response),
      { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.equal(response, undefined);
    assert.equal(h.row().status, 'outcome_unknown');
    assert.match(h.row().stage, /reconciliation/);
    h.db.close();
  }
});

test('a same-date update reuses the linked occurrence after updating the workout once', async () => {
  const source = { operation_id: 'source-same-date', scheduled_date: '2026-11-02', workout_id: '42', occurrence_id: '77' };
  const h = operationHarness({ id: 'update-same-date', status: 'publishing', stage: 'update', action: 'update',
    workoutId: '42', occurrenceId: '77', sourceOperation: source });
  const calls = [];
  await runOperation(h.db, async (url, init) => { calls.push({ url, method: init.method }); return Response.json({ updated: true, workout_id: 42 }); },
    { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[0].url, /\/workouts\/42$/);
  assert.deepEqual(h.row(), { status: 'scheduled', stage: 'complete', error_code: null, workout_id: '42', occurrence_id: '77' });
  h.db.close();
});

test('runOperation preserves stage and IDs on HTTP failures and sanitizes thrown transport errors', async () => {
  for (const [id, fetchImpl, expected] of [
    ['http-failure', async () => Response.json({ detail: { code: 'auth_required' } }, { status: 401 }), { status: 'reauth_required', stage: 'publish', error_code: 'auth_required' }],
    ['transport-failure', async () => { throw new Error('private URL, cookie and payload'); }, { status: 'outcome_unknown', stage: 'unknown', error_code: 'outcome_unknown' }],
  ]) {
    const h = operationHarness({ id });
    await runOperation(h.db, fetchImpl, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.deepEqual({ status: h.row().status, stage: h.row().stage, error_code: h.row().error_code }, expected);
    assert.doesNotMatch(JSON.stringify(h.row()), /private URL|cookie|payload/);
    h.db.close();
  }
});

test('runOperation validates current owner, generation, completion, date and prescription before dispatch', async () => {
  for (const setup of [
    { id: 'inactive-before', ownerActive: 0, expectedStage: 'owner_revoked' },
    { id: 'generation-before', connectionGeneration: 2, expectedStage: 'validation' },
    { id: 'completed-before', completed: 1, expectedStage: 'validation' },
    { id: 'date-before', trainingDate: '2026-11-03', expectedStage: 'validation' },
  ]) {
    const h = operationHarness(setup);
    let calls = 0;
    await runOperation(h.db, async () => { calls += 1; return Response.json({ workout_id: 8 }); },
      { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current,
      { onOwnerIneligible: async () => true });
    assert.equal(calls, 0);
    assert.equal(h.row().stage, setup.expectedStage);
    assert.equal(h.row().status, 'outdated');
    h.db.close();
  }
});

test('worker stop before dispatch is terminal and never calls the connector', async () => {
  const h = operationHarness({ id: 'stopped-op' });
  let calls = 0;
  await runOperation(h.db, async () => { calls += 1; }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current,
    { shouldStop: () => true });
  assert.equal(calls, 0);
  assert.deepEqual(h.row(), { status: 'failed', stage: 'worker_stopping', error_code: 'unavailable', workout_id: null, occurrence_id: null });
  h.db.close();
});

test('worker rejects revoked owner before dispatch and reports cleanup-pending distinctly', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash,is_active) VALUES (1,'inactive@example.test','hash',0)").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  db.prepare("INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date) VALUES ('inactive-op',1,1,1,1,?,1,'publishing','publish','2026-11-02')").run(fingerprint);
  let dispatched = false; let cleanup = 0;
  await runOperation(db, async () => { dispatched = true; }, {}, {
    operationId: 'inactive-op', ownerId: 1, trainingId: 1, generation: 1, revision: 1, fingerprint,
    date: '2026-11-02', prescription,
  }, (_request, id) => db.prepare('SELECT id,dia,user_id,completed FROM trainings WHERE id=?').get(id), {
    onOwnerIneligible: async () => { cleanup += 1; return false; },
  });
  const state = db.prepare("SELECT status,stage,error_code FROM garmin_training_operations WHERE operation_id='inactive-op'").get();
  assert.equal(dispatched, false);
  assert.equal(cleanup, 1);
  assert.deepEqual(state, { status: 'outdated', stage: 'owner_revoked', error_code: 'cleanup_pending' });
  db.close();
});

test('a schedule auth failure retains the published workout for explicit reconciliation', async () => {
  const h = operationHarness({ id: 'auth-schedule-recovery' });
  let createCalls = 0; let scheduleCalls = 0;
  await runOperation(h.db, async (url) => {
    if (url.endsWith('/workouts')) { createCalls += 1; return Response.json({ workout_id: 42 }); }
    scheduleCalls += 1;
    return Response.json({ detail: { code: 'auth_required' } }, { status: 401 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
  assert.deepEqual(h.row(), { status: 'reauth_required', stage: 'schedule', error_code: 'auth_required', workout_id: '42', occurrence_id: null });
  const retry = { ...h.operation, stage: h.row().stage, workoutId: h.row().workout_id };
  await runOperation(h.db, async (url) => {
    if (url.endsWith('/workouts')) { createCalls += 1; return Response.json({ workout_id: 43 }); }
    scheduleCalls += 1;
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector' }, retry, h.current);
  assert.equal(createCalls, 1);
  assert.equal(scheduleCalls, 2);
  assert.equal(h.row().status, 'scheduled');
  h.db.close();
});

test('owner eligibility loss after HTTP and transport errors preserves uncertainty and records cleanup state', async () => {
  for (const failure of ['http', 'transport']) {
    const h = operationHarness({ id: `owner-loss-${failure}` });
    let cleanup = 0;
    await runOperation(h.db, async () => {
      h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
      if (failure === 'transport') throw new Error('private transport details');
      return Response.json({ detail: { code: 'unavailable' } }, { status: 503 });
    }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current,
    { onOwnerIneligible: async () => { cleanup += 1; return false; } });
    assert.equal(cleanup, 1);
    assert.equal(h.row().status, 'outcome_unknown');
    assert.equal(h.row().stage, 'owner_revoked');
    assert.equal(h.row().error_code, 'cleanup_pending');
    h.db.close();
  }
});

test('operation current-state checks distinguish deleted owner, missing session and changed prescription', async () => {
  for (const invalidation of ['deleted-owner', 'missing-session', 'changed-prescription']) {
    const h = operationHarness({ id: `changed-${invalidation}` });
    if (invalidation === 'deleted-owner') h.db.prepare('DELETE FROM users WHERE id=1').run();
    if (invalidation === 'missing-session') h.db.prepare('DELETE FROM trainings WHERE id=1').run();
    if (invalidation === 'changed-prescription') h.db.prepare('UPDATE garmin_workout_prescriptions SET revision=2 WHERE user_id=1 AND training_id=1').run();
    let calls = 0; let cleanup = 0;
    await runOperation(h.db, async () => { calls += 1; return Response.json({ workout_id: 9 }); },
      { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current,
      { onOwnerIneligible: async () => { cleanup += 1; return true; } });
    assert.equal(calls, 0);
    assert.equal(cleanup, invalidation === 'deleted-owner' ? 1 : 0);
    if (invalidation === 'changed-prescription') assert.equal(h.row().status, 'outdated');
    if (invalidation !== 'changed-prescription') assert.equal(h.row(), undefined, 'cascaded owner/session deletion is not recreated by a late worker');
    h.db.close();
  }
});

test('publish refuses missing IDs, unsupported response shapes, and remote errors without guessing', async () => {
  for (const scenario of [
    { id: 'missing-workout', response: Response.json({ created: true }), expected: 'outcome_unknown' },
    { id: 'publish-rate-limit', response: Response.json({ detail: { code: 'rate_limited' } }, { status: 429 }), expected: 'failed' },
  ]) {
    const h = operationHarness({ id: scenario.id });
    await runOperation(h.db, async () => scenario.response, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.equal(h.row().status, scenario.expected);
    assert.equal(h.row().stage, 'publish');
    assert.equal(h.row().workout_id, null);
    h.db.close();
  }
});

test('update and reschedule retain their exact stage when the connector refuses a mutation', async () => {
  const source = { operation_id: 'source-errors', scheduled_date: '2026-11-02', workout_id: '42', occurrence_id: '77' };
  for (const action of ['update', 'reschedule']) {
    const h = operationHarness({ id: `${action}-http-error`, status: 'publishing', stage: action, action,
      workoutId: '42', occurrenceId: '77', sourceOperation: source });
    await runOperation(h.db, async () => Response.json({ detail: { code: 'auth_required' } }, { status: 401 }),
      { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.equal(h.row().status, 'reauth_required');
    assert.equal(h.row().stage, action);
    assert.equal(h.row().workout_id, '42');
    assert.equal(h.row().occurrence_id, '77');
    h.db.close();
  }
});

test('a rescheduled or updated operation refuses incomplete remote identity before dispatch', async () => {
  for (const operation of [
    { id: 'no-workout-reschedule', action: 'reschedule', stage: 'reschedule', workoutId: null, occurrenceId: '77' },
    { id: 'no-occurrence-reschedule', action: 'reschedule', stage: 'reschedule', workoutId: '42', occurrenceId: null },
    { id: 'no-source-update', action: 'update', stage: 'update', workoutId: '42', occurrenceId: '77' },
  ]) {
    const source = operation.id === 'no-source-update' ? null
      : { operation_id: `source-${operation.id}`, scheduled_date: '2026-11-02', workout_id: '42', occurrence_id: '77' };
    const h = operationHarness({ ...operation, sourceOperation: source });
    let calls = 0;
    await runOperation(h.db, async () => { calls += 1; return Response.json({}); }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.equal(calls, 0);
    assert.equal(h.row().status, 'outcome_unknown');
    h.db.close();
  }
});

test('repeated remote page stages accept string occurrence IDs but keep malformed responses uncertain', async () => {
  for (const responseBody of [
    { scheduled: true, scheduled_workout_id: '770' },
    { scheduled: false, scheduled_workout_id: 770 },
    { scheduled: true, scheduled_workout_id: 7.7 },
  ]) {
    const id = `schedule-${String(responseBody.scheduled_workout_id)}-${responseBody.scheduled}`;
    const h = operationHarness({ id, stage: 'schedule', workoutId: '42' });
    await runOperation(h.db, async () => Response.json(responseBody), { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
    assert.equal(h.row().status, responseBody.scheduled === true && String(responseBody.scheduled_workout_id) === '770' ? 'scheduled' : 'outcome_unknown');
    h.db.close();
  }
});

test('a session edit after a remote effect preserves uncertainty and never accepts the stale response', async () => {
  const h = operationHarness({ id: 'edit-after-effect' });
  let calls = 0;
  await runOperation(h.db, async (url) => {
    calls += 1;
    if (url.endsWith('/workouts')) return Response.json({ workout_id: 42 });
    h.db.prepare("UPDATE trainings SET dia='2026-11-03' WHERE id=1").run();
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
  assert.equal(calls, 2);
  assert.deepEqual(h.row(), { status: 'outcome_unknown', stage: 'validation', error_code: 'session_changed', workout_id: '42', occurrence_id: null });
  h.db.close();
});

test('same operation ID is single flight across concurrent dispatch and releases its lock', async () => {
  const h = operationHarness({ id: 'single-flight' });
  let release; let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; if (url.endsWith('/workouts')) { started(); return held; } return Response.json({ scheduled: true, scheduled_workout_id: 77 }); };
  const first = runOperation(h.db, fetchImpl, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
  await didStart;
  const concurrent = await runOperation(h.db, fetchImpl, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current);
  assert.equal(concurrent, undefined);
  release(Response.json({ workout_id: 42 }));
  await first;
  assert.equal(calls, 2);
  assert.equal(h.row().status, 'scheduled');
  h.db.close();
});

test('worker stopping immediately before network dispatch is distinguished from remote uncertainty', async () => {
  const h = operationHarness({ id: 'stop-before-network' });
  let checks = 0; let calls = 0;
  await runOperation(h.db, async () => { calls += 1; }, { GARMIN_CONNECTOR_URL: 'http://connector' }, h.operation, h.current,
    { shouldStop: () => ++checks > 1 });
  assert.equal(checks, 2);
  assert.equal(calls, 0);
  assert.equal(h.row().stage, 'worker_stopping');
  h.db.close();
});

test('auth start and finish support MFA with the owner session, persist only identity, and sanitize failures', async () => {
  let finishMode = 'connected';
  const h = await productApiHarness({ garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'opaque-challenge-123456', expires_in: 300 });
    if (url.endsWith('/auth/finish')) return finishMode === 'connected'
      ? Response.json({ status: 'connected', identity_fingerprint: 'a'.repeat(64) })
      : Response.json({ status: 'mfa_required' });
    return Response.json({ status: 'disconnected' });
  } });
  const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'transient-password' } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().status, 'mfa_required');
  assert.doesNotMatch(started.body, /private@example|transient-password/);
  let finish = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: 123 } });
  assert.equal(finish.statusCode, 400);
  finish = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '123456' } });
  assert.equal(finish.statusCode, 200);
  assert.deepEqual(finish.json(), { status: 'connected', connection_generation: 1, identity_changed: false });
  assert.equal(h.db.prepare('SELECT identity_fingerprint FROM garmin_pilot_connections WHERE user_id=1').get().identity_fingerprint, 'a'.repeat(64));
  const replay = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '123456' } });
  assert.equal(replay.statusCode, 400);
  await h.close();
});

test('MFA retry retains a challenge; connection deletion invalidates it and remains owner scoped', async () => {
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url) => {
    calls.push(url);
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'opaque-challenge-retry-123', expires_in: 300 });
    if (url.endsWith('/auth/finish')) return Response.json({ status: 'mfa_required' });
    return Response.json({ status: 'disconnected' });
  } });
  const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'private' } });
  let response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: 'wrong' } });
  assert.equal(response.json().status, 'mfa_required');
  response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 200);
  response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: 'correct' } });
  assert.equal(response.statusCode, 400);
  assert.equal(calls.filter((url) => url.endsWith('/auth/finish')).length, 1);
  assert.equal(h.db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id=1').get().connection_generation, 2);
  await h.close();
});

test('MFA challenges expire on the product clock and cannot be canceled or finished afterward', async () => {
  let clock = 1000;
  let cancelCalls = 0;
  const h = await productApiHarness({ now: () => clock, garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'expires-opaque-123456', expires_in: 300 });
    if (url.endsWith('/auth/cancel')) cancelCalls += 1;
    return Response.json({ status: 'disconnected' });
  } });
  const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
  clock = 301001;
  let response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '123456' } });
  assert.equal(response.statusCode, 400);
  response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id } });
  assert.equal(response.statusCode, 400);
  assert.equal(cancelCalls, 0);
  await h.close();
});

test('cancel and disconnect normalize connector failures without exposing remote detail', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'cancel-error-123456', expires_in: 300 });
    return Response.json({ detail: { message: 'private connector body' } }, { status: 503 });
  } });
  const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
  let response = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: 'unavailable' });
  response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: 'unavailable' });
  assert.doesNotMatch(response.body, /private connector body/);
  await h.close();
});

test('connection cleanup remains scoped to pilot owner and inactive account sessions are refused', async () => {
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url) => { calls.push(url); return Response.json({ status: 'disconnected' }); } });
  await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other-owner@example.test', password: 'pilot-password', first_name: 'Other', last_name: 'Runner' } });
  const otherCookie = await login(h.app, 'other-owner@example.test');
  let response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: otherCookie } });
  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 0);
  h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 401, 'inactive account auth is refused before a web cleanup route');
  assert.equal(calls.length, 0, 'background owner-revocation cleanup uses the trusted server-to-connector path instead');
  h.db.prepare('UPDATE users SET is_active=1 WHERE id=1').run();
  response = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(calls.at(-1), 'http://connector.invalid/v1/connections/1/pilot');
  await h.close();
});

test('status preserves local operation when disconnected and sanitizes connector errors', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => url.endsWith('/status')
    ? Response.json({ status: 'disconnected', identity_fingerprint: 'must-not-leak' }) : Response.json({ devices: [] }) });
  const response = await h.app.inject({ method: 'GET', url: '/api/garmin/status?training_id=1', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().devices.length, 0);
  assert.equal(response.json().identity_fingerprint, undefined);
  await h.close();
});

test('status marks a remotely observed scheduled operation outdated and tolerates an incomplete capability DTO', async () => {
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    if (url.endsWith('/status')) return Response.json({ status: 'connected', identity_fingerprint: 'private' });
    if (url.endsWith('/capabilities')) return Response.json({ identity_fingerprint: 'private' });
    return new Response(JSON.stringify({ detail: { code: 'auth_required' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  } });
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('status-outdated',1,1,1,1,?,1,'scheduled','complete','2026-11-01','42','77')`).run(fingerprint);
  const response = await h.app.inject({ method: 'GET', url: '/api/garmin/status?training_id=1', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().operation.status, 'outdated');
  assert.deepEqual(response.json().devices, []);
  assert.equal(response.json().running_catalog_status, 'unknown');
  assert.equal(response.json().identity_fingerprint, undefined);
  assert.equal(h.db.prepare("SELECT status FROM garmin_training_operations WHERE operation_id='status-outdated'").get().status, 'outdated');
  await h.close();
});

test('status revalidates owner after both remote reads before returning private capability data', async () => {
  for (const stopAt of ['status', 'capabilities']) {
    let release; let started;
    const didStart = new Promise((resolve) => { started = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    let capsCalls = 0;
    const h = await productApiHarness({ garminFetch: async (url) => {
      if (url.endsWith('/status')) {
        if (stopAt === 'status') { started(); return held; }
        return Response.json({ status: 'connected' });
      }
      if (url.endsWith('/capabilities')) { capsCalls += 1; started(); return held; }
      return Response.json({});
    } });
    const pending = h.app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie: h.cookie } });
    await didStart;
    h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    release(Response.json(stopAt === 'status' ? { status: 'connected' } : { devices: [{ name: 'private device' }] }));
    const response = await pending;
    assert.equal(response.statusCode, 404);
    assert.doesNotMatch(response.body, /private device/);
    assert.equal(capsCalls, stopAt === 'status' ? 0 : 1);
    await h.close();
  }
});

test('remote connector HTTP errors are normalized without trusting arbitrary response messages', async () => {
  for (const [status, body, expected] of [
    [429, { detail: { code: 'rate_limited', message: 'private Garmin response' } }, 'rate_limited'],
    [503, { detail: { message: 'private Garmin response' } }, 'unavailable'],
  ]) {
    const h = await productApiHarness({ garminFetch: async () => Response.json(body, { status }), config: { KINESIS_GARMIN_SERVICE_TOKEN: undefined } });
    const response = await h.app.inject({ method: 'GET', url: '/api/garmin/status', headers: { cookie: h.cookie } });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { code: expected });
    assert.doesNotMatch(response.body, /private Garmin response/);
    await h.close();
  }
});

test('publish clicks with the same confirmed snapshot return one durable operation and create one workout', async () => {
  const remoteCalls = [];
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    remoteCalls.push({ url, method: init.method });
    if (url.endsWith('/status')) return Response.json({ status: 'connected' });
    if (url.endsWith('/capabilities')) return Response.json({ devices: [], running_catalog_status: 'present' });
    if (url.endsWith('/workouts')) return Response.json({ workout_id: 420 });
    if (url.endsWith('/workouts/schedule')) return Response.json({ scheduled: true, scheduled_workout_id: 770 });
    return Response.json({ status: 'disconnected' });
  } });
  const prescription = workout();
  const saved = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie: h.cookie }, payload: {
    prescription, expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1,
  } });
  const snapshot = { fingerprint: saved.json().fingerprint, expected_date: '2026-11-02', expected_revision: 1, expected_connection_generation: 1 };
  const first = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: snapshot });
  const second = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: snapshot });
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(first.json().operation_id, second.json().operation_id,
    JSON.stringify({ first: first.json(), second: second.json(), rows: h.db.prepare('SELECT operation_id,user_id,training_id,connection_generation,prescription_revision,scheduled_date,action,source_operation_id,occurrence_id FROM garmin_training_operations').all() }));
  assert.equal(second.json().reused, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remoteCalls.filter((call) => call.url.endsWith('/workouts')).length, 1);
  assert.equal(remoteCalls.filter((call) => call.url.endsWith('/workouts/schedule')).length, 1);
  await h.close();
});

test('server close aborts and awaits an in-flight Garmin worker without losing its uncertain state', async () => {
  let requestStarted; let abortSeen;
  const didStart = new Promise((resolve) => { requestStarted = resolve; });
  const didAbort = new Promise((resolve) => { abortSeen = resolve; });
  const h = await productApiHarness({ garminFetch: (_url, init) => new Promise((_resolve, reject) => {
    requestStarted();
    init.signal.addEventListener('abort', () => { abortSeen(); reject(new Error('synthetic abort')); }, { once: true });
  }) });
  const prescription = workout(); const saved = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription',
    headers: { cookie: h.cookie }, payload: { prescription, expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1 } });
  const response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: {
    fingerprint: saved.json().fingerprint, expected_date: '2026-11-02', expected_revision: 1, expected_connection_generation: 1,
  } });
  assert.equal(response.statusCode, 202);
  await didStart;
  const closing = h.app.close();
  await didAbort;
  await closing;
  assert.equal(h.db.prepare('SELECT status FROM garmin_training_operations WHERE operation_id=?').get(response.json().operation_id).status, 'outcome_unknown');
  h.db.close();
});

test('operation reads are owner scoped and explicit reconciliation resumes the saved stage', async () => {
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    calls.push({ url, method: init.method });
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  } });
  const prescription = workout();
  const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id)
    VALUES ('resume-stage',1,1,1,1,?,1,'reauth_required','schedule','2026-11-02','42')`).run(fingerprint);
  await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'non-owner@example.test', password: 'pilot-password', first_name: 'Other', last_name: 'Runner' } });
  const otherCookie = await login(h.app, 'non-owner@example.test');
  let response = await h.app.inject({ method: 'GET', url: '/api/garmin/operations/resume-stage', headers: { cookie: otherCookie } });
  assert.equal(response.statusCode, 404);
  response = await h.app.inject({ method: 'GET', url: '/api/garmin/operations/missing', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 404);
  response = await h.app.inject({ method: 'GET', url: '/api/garmin/operations/resume-stage', headers: { cookie: h.cookie } });
  assert.equal(response.json().operation.stage, 'schedule');
  response = await h.app.inject({ method: 'POST', url: '/api/garmin/operations/resume-stage/reconcile', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((call) => call.url.endsWith('/workouts')).length, 0);
  assert.equal(calls.filter((call) => call.url.endsWith('/workouts/schedule')).length, 1);
  response = await h.app.inject({ method: 'POST', url: '/api/garmin/operations/resume-stage/reconcile', headers: { cookie: h.cookie } });
  assert.equal(response.statusCode, 409);
  await h.close();
});

test('explicit reschedule action uses the stored source occurrence and retries its stable operation ID', async () => {
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    calls.push({ url, method: init.method });
    return Response.json({ scheduled: true, scheduled_workout_id: 77 });
  } });
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('reschedule-source',1,1,1,1,?,1,'scheduled','complete','2026-11-02','42','77')`).run(fingerprint);
  const payload = { action: 'reschedule', source_operation_id: 'reschedule-source', fingerprint,
    expected_date: '2026-11-02', expected_revision: 1, expected_connection_generation: 1 };
  const first = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload });
  const retry = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(retry.json().operation_id, first.json().operation_id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/workouts\/schedule\/77$/);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(h.db.prepare("SELECT occurrence_id FROM garmin_training_operations WHERE operation_id=?").get(first.json().operation_id).occurrence_id, '77');
  await h.close();
});

test('a concurrent auth start is refused while the first secret-bearing request is pending', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = await productApiHarness({ garminFetch: async (url) => {
    if (url.endsWith('/auth/start')) { calls += 1; return held; }
    return Response.json({ status: 'disconnected' });
  } });
  const payload = { email: 'transient@example.test', password: 'never-return-this' };
  const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload });
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload });
  assert.equal(concurrent.statusCode, 409);
  assert.doesNotMatch(concurrent.body, /transient@example|never-return-this/);
  release(Response.json({ status: 'disconnected' }));
  assert.equal((await pending).statusCode, 200);
  assert.equal(calls, 1);
  await h.close();
});

test('owner revocation while auth is pending invalidates the late identity and removes local tokens', async () => {
  let release;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const calls = [];
  const held = new Promise((resolve) => { release = resolve; });
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/auth/start')) { started(); return held; }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ status: 'disconnected' });
  } });
  const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'transient' } });
  await didStart;
  h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  release(Response.json({ status: 'connected', identity_fingerprint: 'b'.repeat(64) }));
  const response = await pending;
  assert.equal(response.statusCode, 401);
  assert.doesNotMatch(response.body, /private@example|transient|b{64}/);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(h.db.prepare('SELECT identity_fingerprint FROM garmin_pilot_connections WHERE user_id=1').get()?.identity_fingerprint ?? null, null);
  await h.close();
});

test('failed token cleanup survives restart and retries without requiring an active owner session', async () => {
  let release; let authStarted;
  const didStart = new Promise((resolve) => { authStarted = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let cleanupCalls = 0;
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    if (url.endsWith('/auth/start')) { authStarted(); return held; }
    if (init.method === 'DELETE') { cleanupCalls += 1; return Response.json({ detail: { code: 'unavailable' } }, { status: 503 }); }
    return Response.json({ status: 'disconnected' });
  } });
  const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
  await didStart;
  h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  release(Response.json({ status: 'connected', identity_fingerprint: 'c'.repeat(64) }));
  assert.equal((await pending).statusCode, 401);
  assert.equal(h.db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get().pending, 1);
  await h.app.close();

  const recovered = await buildServer({ db: h.db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (_url, init) => { if (init.method === 'DELETE') { cleanupCalls += 1; return new Response(null, { status: 204 }); } return Response.json({ status: 'disconnected' }); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get().pending, 0);
  assert.equal(cleanupCalls, 2);
  await recovered.close(); h.db.close();
});

test('training state read marks moved scheduled work outdated; remote status does not erase local state', async () => {
  const h = await productApiHarness({ garminFetch: async (url) => url.endsWith('/status')
    ? Response.json({ status: 'disconnected' }) : Response.json({}) });
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('moved-operation',1,1,1,1,?,1,'scheduled','complete','2026-11-02','42','77')`).run(fingerprint);
  h.db.prepare("UPDATE trainings SET dia='2026-11-04' WHERE id=1").run();
  const local = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin', headers: { cookie: h.cookie } });
  assert.equal(local.statusCode, 200);
  assert.equal(local.json().operation.status, 'outdated');
  assert.equal(local.json().operation.workout_id, '42');
  const remote = await h.app.inject({ method: 'GET', url: '/api/garmin/status?training_id=1', headers: { cookie: h.cookie } });
  assert.equal(remote.statusCode, 200);
  assert.equal(remote.json().operation.status, 'outdated');
  await h.close();
});

test('disconnect during authentication rejects late success and clears connector state', async () => {
  let release; let authStarted;
  const didStart = new Promise((resolve) => { authStarted = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/auth/start')) { authStarted(); return held; }
    return Response.json({ status: 'disconnected' });
  } });
  const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
  await didStart;
  const disconnected = await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
  assert.equal(disconnected.statusCode, 200);
  release(Response.json({ status: 'connected', identity_fingerprint: 'd'.repeat(64) }));
  const response = await pending;
  assert.equal(response.statusCode, 409);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 2);
  assert.equal(h.db.prepare('SELECT identity_fingerprint FROM garmin_pilot_connections WHERE user_id=1').get().identity_fingerprint, null);
  await h.close();
});

test('MFA completion revalidates eligibility and challenge generation after the remote response', async () => {
  for (const mode of ['owner-revoked', 'disconnected']) {
    let release; let finishStarted;
    const didFinish = new Promise((resolve) => { finishStarted = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const h = await productApiHarness({ garminFetch: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: `challenge-${mode}-123456`, expires_in: 300 });
      if (url.endsWith('/auth/finish')) { finishStarted(); return held; }
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ status: 'disconnected' });
    } });
    const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
    const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '123456' } });
    await didFinish;
    if (mode === 'owner-revoked') h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    else await h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
    release(mode === 'owner-revoked'
      ? Response.json({ status: 'connected', identity_fingerprint: 'e'.repeat(64) })
      : Response.json({ status: 'connected', identity_fingerprint: 'f'.repeat(64) }));
    const response = await pending;
    assert.equal(response.statusCode, mode === 'owner-revoked' ? 401 : 409);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, mode === 'owner-revoked' ? 1 : 2);
    assert.doesNotMatch(response.body, /e{64}|f{64}/);
    await h.close();
  }
});

test('MFA finish failures recheck revocation before returning and request token cleanup', async () => {
  let release; let finishStarted;
  const didFinish = new Promise((resolve) => { finishStarted = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'challenge-error-123456', expires_in: 300 });
    if (url.endsWith('/auth/finish')) { finishStarted(); return held; }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ status: 'disconnected' });
  } });
  const started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
  const pending = h.app.inject({ method: 'POST', url: '/api/garmin/auth/finish', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id, code: '123456' } });
  await didFinish;
  h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  release(Response.json({ detail: { code: 'unavailable' } }, { status: 503 }));
  const response = await pending;
  assert.equal(response.statusCode, 503);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  await h.close();
});

test('MFA cancellation and disconnect revalidate eligibility after an in-flight remote response', async () => {
  for (const action of ['cancel', 'disconnect']) {
    let release; let remoteStarted;
    const didStart = new Promise((resolve) => { remoteStarted = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    let cleanupCalls = 0;
    let disconnectStarted = false;
    const h = await productApiHarness({ garminFetch: async (url, init) => {
      if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: `challenge-${action}-123456`, expires_in: 300 });
      if ((action === 'cancel' && url.endsWith('/auth/cancel')) || (action === 'disconnect' && init.method === 'DELETE' && !disconnectStarted)) {
        disconnectStarted = true; remoteStarted(); return held;
      }
      if (init.method === 'DELETE') { cleanupCalls += 1; return new Response(null, { status: 204 }); }
      return Response.json({ status: 'disconnected' });
    } });
    let started;
    if (action === 'cancel') {
      started = await h.app.inject({ method: 'POST', url: '/api/garmin/auth/start', headers: { cookie: h.cookie }, payload: { email: 'private@example.test', password: 'secret' } });
    }
    const pending = action === 'cancel'
      ? h.app.inject({ method: 'POST', url: '/api/garmin/auth/cancel', headers: { cookie: h.cookie }, payload: { challenge_id: started.json().challenge_id } })
      : h.app.inject({ method: 'DELETE', url: '/api/garmin/connection', headers: { cookie: h.cookie } });
    await didStart;
    h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    release(Response.json({ status: 'disconnected' }));
    const response = await pending;
    assert.equal(response.statusCode, 401);
    assert.equal(cleanupCalls, 1, 'the post-response eligibility loss uses the trusted cleanup path');
    await h.close();
  }
});

test('rescheduling an old prescription revision is rejected without remote work', async () => {
  const h = await productApiHarness();
  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,2,?,?)').run(JSON.stringify(prescription), fingerprint);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('older-operation',1,1,1,1,'old-fingerprint',1,'outdated','complete','2026-11-02','42','77')`).run();
  const response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: {
    action: 'reschedule', source_operation_id: 'older-operation', fingerprint, expected_date: '2026-11-02',
    expected_revision: 2, expected_connection_generation: 1,
  } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'prescription_changed');
  await h.close();
});

test('prescription and publication routes reject invalid states and source identities before remote dispatch', async () => {
  const calls = [];
  const h = await productApiHarness({ garminFetch: async (url) => { calls.push(url); return Response.json({ status: 'disconnected' }); } });
  const base = { expected_revision: null, expected_training_date: '2026-11-02', expected_connection_generation: 1 };
  let response = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie: h.cookie }, payload: { ...base, prescription: null } });
  assert.equal(response.statusCode, 400);
  response = await h.app.inject({ method: 'PUT', url: '/api/trainings/999/garmin/prescription', headers: { cookie: h.cookie }, payload: { ...base, prescription: workout() } });
  assert.equal(response.statusCode, 404);
  h.db.prepare('UPDATE trainings SET completed=1 WHERE id=1').run();
  response = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie: h.cookie }, payload: { ...base, prescription: workout() } });
  assert.equal(response.statusCode, 409);
  h.db.prepare('UPDATE trainings SET completed=0 WHERE id=1').run();
  response = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie: h.cookie }, payload: { ...base, expected_training_date: '2026-11-03', prescription: workout() } });
  assert.equal(response.statusCode, 409);
  response = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie: h.cookie }, payload: { ...base, expected_revision: 0, prescription: workout() } });
  assert.equal(response.statusCode, 409);

  const prescription = workout(); const fingerprint = prescriptionFingerprint(prescription);
  h.db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)').run(JSON.stringify(prescription), fingerprint);
  const snapshot = { fingerprint, expected_date: '2026-11-02', expected_revision: 1, expected_connection_generation: 1 };
  response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: { ...snapshot, action: 'delete' } });
  assert.equal(response.statusCode, 400);
  response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: { ...snapshot, action: 'update', source_operation_id: 'missing' } });
  assert.equal(response.statusCode, 409);
  h.db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('invalid-source',1,1,2,1,?,1,'outdated','complete','2026-11-02','42','77')`).run(fingerprint);
  response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: { ...snapshot, action: 'update', source_operation_id: 'invalid-source' } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'connection_changed');
  assert.equal(calls.length, 0);
  response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/publish', headers: { cookie: h.cookie }, payload: snapshot });
  assert.equal(response.statusCode, 202);
  await h.close();
});
