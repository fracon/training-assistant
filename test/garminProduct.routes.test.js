'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { toConnectorPayload, runOperation } = require('../scripts/garmin-product');
const { prescriptionFingerprint } = require('../src/garmin-workout-contract');

async function login(app, email) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pilot-password' } });
  return [].concat(response.headers['set-cookie'])[0].split(';')[0];
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
  response = await app.inject({ method: 'PUT', url: '/api/trainings/1/garmin/prescription', headers: { cookie }, payload: { prescription: workout() } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision, 1);
  assert.equal(response.json().preview[1].repetitions, 4);
  assert.equal(db.prepare('SELECT detalhes FROM trainings WHERE id = 1').get().detalhes, '6 x 3 min');
  assert.deepEqual(remoteCalls, ['http://connector.invalid/v1/connections/1/pilot/status', 'http://connector.invalid/v1/connections/1/pilot/capabilities']);
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
  operation.prescription.steps = [{ id: 'open', kind: 'open', end: { type: 'open' }, target: { type: 'none' } }];
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
