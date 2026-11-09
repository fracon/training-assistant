'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');

const python = path.resolve(__dirname, '../.venv-garmin/bin/python');
const connectorDir = path.resolve(__dirname, '../services/garmin-connector');
const connectorModule = `
import json, os
from pathlib import Path
from app.main import _save_encrypted, _secret
root=Path(os.environ['GARMIN_STORE'])
root.mkdir(mode=0o700,parents=True,exist_ok=True)
key=_secret('GARMIN_ENCRYPTION_KEY')
_save_encrypted(root/'1-pilot.bin',key,b'{"synthetic_session":true}')
_save_encrypted(root/'1-pilot.ops',key,b'{"synthetic_provenance":true}')
`;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startConnector(env, synthetic = false) {
  const port = await freePort();
  const args = synthetic ? [path.resolve(__dirname, 'helpers/garmin_synthetic_connector.py'), String(port)]
    : ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--workers', '1', '--no-access-log'];
  const child = spawn(python, args, {
    cwd: connectorDir, env: { ...env, PYTHONPATH: '.', PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Synthetic Garmin connector exited during startup.');
    try { healthy = (await fetch(`${baseUrl}/healthz`)).ok; } catch {}
    if (healthy) break;
    await delay(50);
  }
  assert.equal(healthy, true, 'synthetic connector starts on loopback');
  return { child, baseUrl };
}

test('two authenticated owners complete simultaneous MFA through Node and real Python without crossing connections', { timeout: 30000 }, async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-owners-'));
  const env = { GARMIN_STORE: temporary, GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 73).toString('base64url'),
    KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-for-integration', GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser' };
  const db = createDatabase({ filename: ':memory:' });
  let connector; let app;
  let unblockCleanup; let cleanupStarted;
  const cleanupGate = new Promise(resolve => { unblockCleanup = resolve; });
  const cleanupObserved = new Promise(resolve => { cleanupStarted = resolve; });
  try {
    const cookies = [];
    for (const label of ['a', 'b']) {
      const user = await registerUser(db, { email: `${label}@example.test`, password: 'Synthetic-only-1', first_name: label, last_name: 'Runner' });
      cookies.push(`${SESSION_COOKIE_NAME}=${createSession(db, user.id).token}`);
    }
    connector = await startConnector(env, true);
    app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl },
      garminFetch: async (target, options = {}) => {
        if (String(target).endsWith('/1/pilot') && options.method === 'DELETE') { cleanupStarted(); await cleanupGate; }
        return fetch(target, options);
      },
      parseFitFile: async () => ({ activity: { sport: 'running', startTime: '2026-11-02T08:00:00Z' },
        totals: { durationSeconds: 600, durationLabel: '10:00', distanceKm: 2, avgPaceSecondsPerKm: 300, avgPaceLabel: '5:00' }, laps: [{ lap: 1, duration: 600, distanceKm: 2 }] }) });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const request = (cookie, method, route, body) => fetch(`${url}${route}`, { method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const starts = await Promise.all(cookies.map((cookie, index) => request(cookie, 'POST', '/api/garmin/auth/start',
      { email: `garmin-${index}@example.test`, password: 'synthetic' })));
    assert.deepEqual(starts.map(response => response.status), [200, 200]);
    const challenges = await Promise.all(starts.map(response => response.json()));
    assert.ok(challenges.every(challenge => challenge.status === 'mfa_required'));
    const cross = await request(cookies[1], 'POST', '/api/garmin/auth/finish', { challenge_id: challenges[0].challenge_id, code: '123456' });
    assert.equal(cross.status, 400);
    const finishes = await Promise.all(cookies.map((cookie, index) => request(cookie, 'POST', '/api/garmin/auth/finish',
      { challenge_id: challenges[index].challenge_id, code: '123456' })));
    assert.deepEqual(finishes.map(response => response.status), [200, 200]);
    assert.ok(existsSync(path.join(temporary, '1-pilot.bin')));
    assert.ok(existsSync(path.join(temporary, '2-pilot.bin')));
    const first = readFileSync(path.join(temporary, '1-pilot.bin'));
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,2,'2026-11-02','run','Synthetic')").run();
    const prescription = { version: 1, sport: 'running', name: 'Synthetic', steps: [
      { id: 'run', kind: 'run', end: { type: 'time', value: 600 }, target: { type: 'none' } },
    ] };
    const saved = await request(cookies[1], 'PUT', '/api/trainings/1/garmin/prescription', { expected_revision: null,
      expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    const published = await request(cookies[1], 'POST', '/api/trainings/1/garmin/publish', { fingerprint: savedBody.fingerprint,
      expected_revision: 1, expected_date: '2026-11-02', expected_connection_generation: 1 });
    assert.equal(published.status, 202);
    const operation = (await published.json()).operation_id;
    assert.equal((await request(cookies[0], 'GET', `/api/garmin/operations/${operation}`)).status, 404);
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await (await request(cookies[1], 'GET', `/api/garmin/operations/${operation}`)).json();
      if (state.operation.status !== 'publishing' && state.operation.status !== 'scheduling') break;
      await delay(20);
    }
    assert.equal(state.operation.status, 'scheduled', JSON.stringify(state));
    const list = await request(cookies[1], 'GET', '/api/trainings/1/garmin/activities');
    assert.equal(list.status, 200, await list.text());
    const reviewed = await request(cookies[1], 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
    assert.equal(reviewed.status, 200, await reviewed.clone().text());
    const imported = await request(cookies[1], 'POST', '/api/trainings/1/garmin/activity-import', { preview_id: (await reviewed.json()).preview_id });
    assert.equal(imported.status, 200, await imported.text());
    assert.deepEqual(readFileSync(path.join(temporary, '1-pilot.bin')), first);
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-02','run','Synthetic A')").run();
    const savedA = await request(cookies[0], 'PUT', '/api/trainings/2/garmin/prescription', { expected_revision: null,
      expected_training_date: '2026-11-02', expected_connection_generation: 1, prescription });
    assert.equal(savedA.status, 200);
    const startedA = await request(cookies[0], 'POST', '/api/trainings/2/garmin/publish', { fingerprint: (await savedA.json()).fingerprint,
      expected_revision: 1, expected_date: '2026-11-02', expected_connection_generation: 1 });
    assert.equal(startedA.status, 202);
    const operationA = (await startedA.json()).operation_id;
    for (let attempt = 0; attempt < 200 && !existsSync(path.join(temporary, 'pending-a')); attempt++) await delay(20);
    assert.ok(existsSync(path.join(temporary, 'pending-a')), 'synthetic Garmin accepted the workout');
    db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    assert.equal((await request(cookies[0], 'GET', '/api/garmin/status')).status, 401);
    assert.equal((await request(cookies[1], 'GET', '/api/garmin/status')).status, 200);
    assert.equal((await request(cookies[1], 'GET', `/api/garmin/operations/${operationA}`)).status, 404);
    writeFileSync(path.join(temporary, 'release-a'), 'release');
    await cleanupObserved;
    assert.equal((await request(cookies[1], 'GET', '/api/garmin/status')).status, 200, 'B remains usable while A cleanup is pending');
    unblockCleanup();
    let revoked;
    for (let attempt = 0; attempt < 200; attempt++) {
      revoked = db.prepare('SELECT user_id,status,workout_id FROM garmin_training_operations WHERE operation_id=?').get(operationA);
      if (revoked.status === 'outcome_unknown') break;
      await delay(20);
    }
    assert.deepEqual(revoked, { user_id: 1, status: 'outcome_unknown', workout_id: '42' });
    assert.ok(existsSync(path.join(temporary, '1-pilot.ops')));
    const disconnected = await request(cookies[1], 'DELETE', '/api/garmin/connection');
    assert.equal(disconnected.status, 200);
    assert.equal(existsSync(path.join(temporary, '2-pilot.bin')), false);
    assert.equal(existsSync(path.join(temporary, '1-pilot.bin')), false, 'revoked owner cleanup removed only A credentials');
  } finally {
    writeFileSync(path.join(temporary, 'release-a'), 'release');
    unblockCleanup();
    await app?.close(); db.close();
    if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Node disconnect reaches the real private Python endpoint, removes ciphertext and preserves journal across restart', { timeout: 30000 }, async () => {
  assert.equal(existsSync(python), true, 'prepared Garmin Python environment is available');
  const temporary = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-disconnect-integration-'));
  const store = path.join(temporary, 'store');
  const key = Buffer.alloc(32, 73).toString('base64url');
  const serviceKey = 'synthetic-node-python-key-only-for-this-test';
  const pilotEnv = {
    GARMIN_STORE: store,
    GARMIN_ENCRYPTION_KEY: key,
    KINESIS_GARMIN_SERVICE_TOKEN: serviceKey,
    GARMIN_PILOT_ENABLED: 'true',
    GARMIN_PILOT_USER_ID: '1',
  };
  const seed = spawn(python, ['-c', connectorModule], {
    cwd: connectorDir, env: { ...process.env, ...pilotEnv, PYTHONPATH: '.' }, stdio: 'ignore',
  });
  const db = createDatabase({ filename: ':memory:' });
  let nodeApp;
  let connector;
  let restarted;
  try {
    await once(seed, 'exit');
    const tokenPath = path.join(store, '1-pilot.bin');
    const journalPath = path.join(store, '1-pilot.ops');
    const originalJournal = readFileSync(journalPath);
    const owner = await registerUser(db, { email: 'disconnect-integration@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
    assert.equal(owner.id, 1);
    const cookie = createSession(db, owner.id).token;
    connector = await startConnector(pilotEnv);
    nodeApp = await buildServer({ db, sessionCookieSecure: false,
      garminConfig: { ...pilotEnv, GARMIN_CONNECTOR_URL: connector.baseUrl } });
    const url = await nodeApp.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${url}/api/garmin/connection`, {
      method: 'DELETE', headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'disconnected', connection_generation: 1 });
    assert.equal(existsSync(tokenPath), false, 'the Python endpoint removed only encrypted session credentials');
    assert.deepEqual(readFileSync(journalPath), originalJournal, 'encrypted operation provenance remains byte-for-byte intact');
    const connection = db.prepare('SELECT connection_generation,identity_fingerprint,cleanup_pending FROM garmin_pilot_connections WHERE user_id=1').get();
    assert.deepEqual(connection, { connection_generation: 1, identity_fingerprint: null, cleanup_pending: 0 });
    const status = await fetch(`${url}/api/garmin/status`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'disconnected');

    await nodeApp.close(); nodeApp = null;
    connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); connector = null;
    restarted = await startConnector(pilotEnv);
    await nodeApp?.close?.();
    nodeApp = await buildServer({ db, sessionCookieSecure: false,
      garminConfig: { ...pilotEnv, GARMIN_CONNECTOR_URL: restarted.baseUrl } });
    const restartedUrl = await nodeApp.listen({ port: 0, host: '127.0.0.1' });
    const resumed = await fetch(`${restartedUrl}/api/garmin/status`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).status, 'disconnected', 'a new Python process cannot restore removed local credentials');
    assert.deepEqual(readFileSync(journalPath), originalJournal);
  } finally {
    await nodeApp?.close?.(); db.close();
    for (const service of [connector, restarted]) {
      if (service?.child.exitCode === null) { service.child.kill('SIGTERM'); await once(service.child, 'exit'); }
    }
    if (seed.exitCode === null) seed.kill('SIGTERM');
    rmSync(temporary, { recursive: true, force: true });
  }
});
