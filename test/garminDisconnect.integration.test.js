'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
    const pendingStatuses = await Promise.all(cookies.map(cookie => request(cookie, 'GET', '/api/garmin/status')));
    assert.deepEqual(pendingStatuses.map(response => response.status), [200, 200]);
    assert.ok((await Promise.all(pendingStatuses.map(response => response.json()))).every(status => status.status === 'mfa_required'));
    const cross = await request(cookies[1], 'POST', '/api/garmin/auth/finish', { challenge_id: challenges[0].challenge_id, code: '123456' });
    assert.equal(cross.status, 400);
    const finishes = await Promise.all(cookies.map((cookie, index) => request(cookie, 'POST', '/api/garmin/auth/finish',
      { challenge_id: challenges[index].challenge_id, code: '123456' })));
    assert.deepEqual(finishes.map(response => response.status), [200, 200]);
    assert.ok(existsSync(path.join(temporary, '1-pilot.bin')));
    assert.ok(existsSync(path.join(temporary, '2-pilot.bin')));
    db.prepare("INSERT INTO garmin_connection_cleanup(user_id,connection_id,pending,preserve_identity) VALUES(1,'pilot',0,0)").run();
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
    assert.equal(existsSync(path.join(temporary, '1-pilot.bin')), false, 'revoked owner cleanup removed only A credentials');
    db.prepare('UPDATE users SET is_active=1 WHERE id=1').run();
    const restoredCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 1).token}`;
    const restartedAuth = await request(restoredCookie, 'POST', '/api/garmin/auth/start', { email: 'garmin-a@example.test', password: 'synthetic' });
    assert.equal(restartedAuth.status, 200);
    const restartedChallenge = await restartedAuth.json();
    const restartedFinish = await request(restoredCookie, 'POST', '/api/garmin/auth/finish', { challenge_id: restartedChallenge.challenge_id, code: '123456' });
    assert.equal(restartedFinish.status, 200);
    assert.equal((await restartedFinish.json()).identity_changed, false);
    const reconciliation = await request(restoredCookie, 'POST', `/api/garmin/operations/${operationA}/reconcile`);
    assert.equal(reconciliation.status, 202, await reconciliation.text());
    for (let attempt = 0; attempt < 200; attempt++) {
      revoked = db.prepare('SELECT user_id,status,workout_id FROM garmin_training_operations WHERE operation_id=?').get(operationA);
      if (revoked.status === 'scheduled') break;
      await delay(20);
    }
    assert.deepEqual(revoked, { user_id: 1, status: 'scheduled', workout_id: '42' });
    const disconnected = await request(cookies[1], 'DELETE', '/api/garmin/connection');
    assert.equal(disconnected.status, 200);
    assert.equal(existsSync(path.join(temporary, '2-pilot.bin')), false);
    assert.ok(existsSync(path.join(temporary, '1-pilot.bin')), 'A reconnected without changing owner');
  } finally {
    writeFileSync(path.join(temporary, 'release-a'), 'release');
    unblockCleanup();
    await app?.close(); db.close();
    if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const variant of ['start', 'finish', 'lost', 'persist']) {
  test(`revoked session after Python persists a different Garmin account during ${variant} cannot import under the old fingerprint`, { timeout: 30000 }, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-auth-race-'));
    const env = { GARMIN_STORE: directory, GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 74).toString('base64url'),
      KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-for-auth-race', GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser' };
    const db = createDatabase({ filename: ':memory:' });
    let connector; let app; let revoke = false;
    try {
      const owner = await registerUser(db, { email: 'owner@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
      const other = await registerUser(db, { email: 'other@example.test', password: 'Synthetic-only-1', first_name: 'Other', last_name: 'Runner' });
      const otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db, other.id).token}`;
      const token = createSession(db, owner.id).token;
      const cookie = `${SESSION_COOKIE_NAME}=${token}`;
      db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','Synthetic')").run();
      connector = await startConnector(env, true);
      app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl },
        parseFitFile: async () => ({ activity: { sport: 'running' }, totals: { durationSeconds: 600, distanceKm: 2 }, laps: [{ lap: 1, duration: 600, distanceKm: 2 }] }),
        garminFetch: async (url, init = {}) => {
          const response = await fetch(url, init);
          if (revoke && url.endsWith(`/auth/${variant === 'lost' ? 'start' : variant}`)) {
            revoke = false;
            if (variant === 'lost') throw new TypeError('synthetic lost response');
            db.prepare('DELETE FROM sessions WHERE id=?').run(token);
          }
          return response;
        } });
      let base = await app.listen({ port: 0, host: '127.0.0.1' });
      const request = (sessionCookie, method, route, body) => fetch(`${base}${route}`, { method,
        headers: { cookie: sessionCookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const first = await request(cookie, 'POST', '/api/garmin/auth/start', { email: 'direct-account-a@example.test', password: 'synthetic' });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).status, 'connected');
      const previous = db.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
      if (variant === 'persist') db.exec(`CREATE TRIGGER synthetic_identity_failure BEFORE UPDATE OF identity_fingerprint ON garmin_pilot_connections
        WHEN NEW.identity_fingerprint IS NOT OLD.identity_fingerprint BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
      if (variant === 'start' || variant === 'lost') revoke = true;
      const second = await request(cookie, 'POST', '/api/garmin/auth/start', { email: `${variant !== 'finish' ? 'direct' : 'mfa'}-account-b@example.test`, password: 'synthetic' });
      if (variant === 'finish') {
        const challenge = await second.json();
        assert.equal(challenge.status, 'mfa_required');
        revoke = true;
        const finish = await request(cookie, 'POST', '/api/garmin/auth/finish', { challenge_id: challenge.challenge_id, code: '123456' });
        assert.equal(finish.status, 401);
      } else assert.equal(second.status, ['lost', 'persist'].includes(variant) ? 503 : 401);
      const verifyTokens = spawnSync(python, ['-c', `import json,os\nfrom pathlib import Path\nfrom app.main import _decrypt,_secret\nvalue=json.loads(_decrypt(Path(os.environ['GARMIN_STORE'])/'1-pilot.bin',_secret('GARMIN_ENCRYPTION_KEY')))\nassert value['di_token']=='synthetic-b'`],
        { cwd: connectorDir, env: { ...env, PYTHONPATH: '.' }, encoding: 'utf8' });
      assert.equal(verifyTokens.status, 0, verifyTokens.stderr);
      const newCookie = `${SESSION_COOKIE_NAME}=${createSession(db, owner.id).token}`;
      const remoteStatus = await fetch(`${connector.baseUrl}/v1/connections/1/pilot/status`, { headers: { 'x-kinesis-service-key': env.KINESIS_GARMIN_SERVICE_TOKEN } });
      const remoteIdentity = (await remoteStatus.json()).identity_fingerprint;
      if (variant === 'lost') {
        await app.close(); app = null;
        require('../src/db/database').initializeDatabase(db);
        app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl },
          parseFitFile: async () => ({ activity: { sport: 'running' }, totals: { durationSeconds: 600, distanceKm: 2 }, laps: [{ lap: 1, duration: 600, distanceKm: 2 }] }) });
        base = await app.listen({ port: 0, host: '127.0.0.1' });
      }
      const status = await request(newCookie, 'GET', '/api/garmin/status');
      if (variant === 'persist') {
        assert.equal(status.status, 503);
        assert.equal((await request(otherCookie, 'GET', '/api/garmin/status')).status, 200);
        const blocked = await request(newCookie, 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
        assert.notEqual(blocked.status, 200);
        await app.close(); app = null;
        require('../src/db/database').initializeDatabase(db);
        app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl } });
        base = await app.listen({ port: 0, host: '127.0.0.1' });
        assert.equal((await request(newCookie, 'GET', '/api/garmin/status')).status, 503);
        assert.equal((await request(otherCookie, 'GET', '/api/garmin/status')).status, 200);
        db.exec('DROP TRIGGER synthetic_identity_failure');
        assert.equal((await request(newCookie, 'GET', '/api/garmin/status')).status, 200);
        return;
      }
      assert.equal(status.status, 200);
      const state = await status.json();
      if (state.status !== 'connected') {
        const blocked = await request(newCookie, 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
        assert.notEqual(blocked.status, 200);
        return;
      }
      const stored = db.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
      assert.equal(stored.identity_fingerprint, remoteIdentity, 'the persisted fingerprint must match the connected Garmin account');
      assert.ok(stored.connection_generation > previous.connection_generation, 'changing Garmin account must advance its generation');
      const reviewed = await request(newCookie, 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
      assert.equal(reviewed.status, 200, await reviewed.clone().text());
      const imported = await request(newCookie, 'POST', '/api/trainings/1/garmin/activity-import', { preview_id: (await reviewed.json()).preview_id });
      assert.equal(imported.status, 200, await imported.text());
      assert.equal(db.prepare('SELECT account_fingerprint FROM garmin_activity_imports WHERE user_id=1').get().account_fingerprint, remoteIdentity);
    } finally {
      await app?.close(); db.close();
      if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('late authentication and cleanup cannot replace a newer session after recovery', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-fence-race-'));
  const env = { GARMIN_STORE: directory, GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 75).toString('base64url'),
    KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-fence-race-service-token', GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser' };
  const db = createDatabase({ filename: ':memory:' });
  let connector; let oldApp; let newApp; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  let hold = false; let staleAttempt;
  const parseFitFile = async () => ({ activity: { sport: 'running' }, totals: { durationSeconds: 600, distanceKm: 2 }, laps: [{ lap: 1, duration: 600, distanceKm: 2 }] });
  try {
    for (const label of ['one', 'two']) await registerUser(db, { email: `${label}@example.test`, password: 'Synthetic-only-1', first_name: label, last_name: 'Runner' });
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(db, 1).token}`;
    const otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 2).token}`;
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','Synthetic')").run();
    connector = await startConnector(env, true);
    const config = { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl };
    oldApp = await buildServer({ db, sessionCookieSecure: false, garminConfig: config, parseFitFile,
      garminFetch: async (url, options = {}) => {
        if (hold && url.endsWith('/auth/start')) { hold = false; staleAttempt = options.headers['x-kinesis-auth-attempt']; entered(); await gate; }
        return fetch(url, options);
      } });
    const oldBase = await oldApp.listen({ port: 0, host: '127.0.0.1' });
    const request = (base, userCookie, method, route, body) => fetch(`${base}${route}`, { method,
      headers: { cookie: userCookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const authenticate = (base, email) => request(base, cookie, 'POST', '/api/garmin/auth/start', { email, password: 'synthetic' });
    assert.equal((await authenticate(oldBase, 'direct-account-a@example.test')).status, 200);
    const first = db.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
    hold = true;
    const late = authenticate(oldBase, 'direct-account-a@example.test');
    await waiting;
    newApp = await buildServer({ db, sessionCookieSecure: false, garminConfig: config, parseFitFile });
    let newBase = await newApp.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await request(newBase, cookie, 'GET', '/api/garmin/status')).status, 200);
    assert.equal((await request(newBase, otherCookie, 'GET', '/api/garmin/status')).status, 200);
    assert.equal((await authenticate(newBase, 'direct-account-b@example.test')).status, 200);
    const current = db.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
    assert.notEqual(current.identity_fingerprint, first.identity_fingerprint);
    assert.ok(current.connection_generation > first.connection_generation);
    const tokenPath = path.join(directory, '1-pilot.bin');
    const newest = readFileSync(tokenPath);
    release();
    assert.notEqual((await late).status, 200);
    const staleDelete = await fetch(`${connector.baseUrl}/v1/connections/1/pilot`, { method: 'DELETE',
      headers: { 'x-kinesis-service-key': env.KINESIS_GARMIN_SERVICE_TOKEN, 'x-kinesis-auth-attempt': staleAttempt } });
    assert.equal(staleDelete.status, 409);
    assert.deepEqual(readFileSync(tokenPath), newest);
    await newApp.close(); newApp = null;
    connector.child.kill('SIGTERM'); await once(connector.child, 'exit');
    connector = await startConnector(env, true);
    newApp = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl }, parseFitFile });
    newBase = await newApp.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await request(newBase, cookie, 'GET', '/api/garmin/status')).status, 200);
    assert.deepEqual(db.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get(), current);
    const preview = await request(newBase, cookie, 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
    assert.equal(preview.status, 200, await preview.clone().text());
    const imported = await request(newBase, cookie, 'POST', '/api/trainings/1/garmin/activity-import', { preview_id: (await preview.json()).preview_id });
    assert.equal(imported.status, 200, await imported.text());
    assert.equal(db.prepare('SELECT account_fingerprint FROM garmin_activity_imports WHERE user_id=1').get().account_fingerprint, current.identity_fingerprint);
  } finally {
    release();
    await oldApp?.close(); await newApp?.close(); db.close();
    if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a delayed Node cleanup cannot delete a newer session after another instance retries it', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-cleanup-fence-'));
  const env = { GARMIN_STORE: path.join(directory, 'store'), GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 76).toString('base64url'),
    KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-cleanup-fence-service-token', GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser' };
  const databaseFile = path.join(directory, 'database.sqlite');
  const db1 = createDatabase({ filename: databaseFile });
  let db2; let connector; let app1; let app2; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  let hold = false;
  try {
    for (const label of ['one', 'two']) await registerUser(db1, { email: `${label}@example.test`, password: 'Synthetic-only-1', first_name: label, last_name: 'Runner' });
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(db1, 1).token}`;
    const otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db1, 2).token}`;
    db1.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','Synthetic')").run();
    connector = await startConnector(env, true);
    const config = { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl };
    const parseFitFile = async () => ({ activity: { sport: 'running' }, totals: { durationSeconds: 600, distanceKm: 2 }, laps: [{ lap: 1, duration: 600, distanceKm: 2 }] });
    app1 = await buildServer({ db: db1, sessionCookieSecure: false, garminConfig: config, parseFitFile,
      garminFetch: async (url, options = {}) => {
        if (hold && options.method === 'DELETE' && url.endsWith('/1/pilot')) { hold = false; entered(); await gate; }
        return fetch(url, options);
      } });
    const base1 = await app1.listen({ port: 0, host: '127.0.0.1' });
    const request = (base, userCookie, method, route, body) => fetch(`${base}${route}`, { method,
      headers: { cookie: userCookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const authenticate = (base, email) => request(base, cookie, 'POST', '/api/garmin/auth/start', { email, password: 'synthetic' });
    assert.equal((await authenticate(base1, 'direct-account-a@example.test')).status, 200);
    const first = db1.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
    hold = true;
    const late = request(base1, cookie, 'DELETE', '/api/garmin/connection');
    await waiting;
    db2 = createDatabase({ filename: databaseFile });
    app2 = await buildServer({ db: db2, sessionCookieSecure: false, garminConfig: config, parseFitFile });
    let base2 = await app2.listen({ port: 0, host: '127.0.0.1' });
    for (let attempt = 0; attempt < 200 && db2.prepare('SELECT cleanup_pending FROM garmin_pilot_connections WHERE user_id=1').get().cleanup_pending; attempt++) await delay(20);
    assert.equal(db2.prepare('SELECT cleanup_pending FROM garmin_pilot_connections WHERE user_id=1').get().cleanup_pending, 0);
    assert.equal((await request(base2, otherCookie, 'GET', '/api/garmin/status')).status, 200);
    assert.equal((await authenticate(base2, 'direct-account-b@example.test')).status, 200);
    const current = db2.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get();
    assert.notEqual(current.identity_fingerprint, first.identity_fingerprint);
    assert.ok(current.connection_generation > first.connection_generation);
    const tokenPath = path.join(env.GARMIN_STORE, '1-pilot.bin');
    const newest = readFileSync(tokenPath);
    release();
    assert.equal((await late).status, 503);
    assert.deepEqual(readFileSync(tokenPath), newest);
    assert.deepEqual(db2.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get(), current);
    await app2.close(); app2 = null;
    connector.child.kill('SIGTERM'); await once(connector.child, 'exit');
    connector = await startConnector(env, true);
    app2 = await buildServer({ db: db2, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl }, parseFitFile });
    base2 = await app2.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await request(base2, cookie, 'GET', '/api/garmin/status')).status, 200);
    assert.deepEqual(db2.prepare('SELECT identity_fingerprint,connection_generation FROM garmin_pilot_connections WHERE user_id=1').get(), current);
    const preview = await request(base2, cookie, 'POST', '/api/trainings/1/garmin/activity-preview', { activity_id: 2, source_cursor: 1 });
    assert.equal(preview.status, 200, await preview.clone().text());
    const imported = await request(base2, cookie, 'POST', '/api/trainings/1/garmin/activity-import', { preview_id: (await preview.json()).preview_id });
    assert.equal(imported.status, 200, await imported.text());
    assert.equal(db2.prepare('SELECT account_fingerprint FROM garmin_activity_imports WHERE user_id=1').get().account_fingerprint, current.identity_fingerprint);
  } finally {
    release(); await app1?.close(); await app2?.close(); db1.close(); db2?.close();
    if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
    rmSync(directory, { recursive: true, force: true });
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

test('pilot ciphertext and pending operation survive upgrade to multiuser and connector restart', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-upgrade-'));
  const env = { GARMIN_STORE: directory, GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 73).toString('base64url'),
    KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-upgrade-service-token', GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1' };
  const seed = spawn(python, ['-c', connectorModule], { cwd: connectorDir, env: { ...process.env, ...env, PYTHONPATH: '.' }, stdio: 'ignore' });
  const db = createDatabase({ filename: ':memory:' });
  let connector; let app;
  try {
    assert.equal((await once(seed, 'exit'))[0], 0);
    const owner = await registerUser(db, { email: 'upgrade@example.test', password: 'Synthetic-only-1', first_name: 'Pilot', last_name: 'Runner' });
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(db, owner.id).token}`;
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','Synthetic')").run();
    db.prepare(`INSERT INTO garmin_training_operations(operation_id,user_id,training_id,connection_generation,prescription_revision,
      fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id,action)
      VALUES('synthetic-upgrade',1,1,1,1,?,1,'publishing','schedule','2026-11-02','42','84','publish')`).run('a'.repeat(64));
    const token = readFileSync(path.join(directory, '1-pilot.bin'));
    const journal = readFileSync(path.join(directory, '1-pilot.ops'));
    connector = await startConnector(env, true);
    app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_CONNECTOR_URL: connector.baseUrl } });
    let url = await app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await fetch(`${url}/api/garmin/status`, { headers: { cookie } })).status, 200);
    await app.close(); app = null;
    connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); connector = null;
    connector = await startConnector({ ...env, GARMIN_ACCESS_MODE: 'multiuser', GARMIN_PILOT_USER_ID: '' }, true);
    app = await buildServer({ db, sessionCookieSecure: false, garminConfig: { ...env, GARMIN_ACCESS_MODE: 'multiuser', GARMIN_PILOT_USER_ID: '', GARMIN_CONNECTOR_URL: connector.baseUrl } });
    url = await app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await fetch(`${url}/api/garmin/status`, { headers: { cookie } })).status, 200);
    assert.deepEqual(readFileSync(path.join(directory, '1-pilot.bin')), token);
    assert.deepEqual(readFileSync(path.join(directory, '1-pilot.ops')), journal);
    const verified = spawnSync(python, ['-c', `from pathlib import Path\nfrom app.main import _decrypt, _secret\nimport os\np=Path(os.environ['GARMIN_STORE'])\nk=_secret('GARMIN_ENCRYPTION_KEY')\nassert _decrypt(p/'1-pilot.bin',k)==b'{"synthetic_session":true}'\nassert _decrypt(p/'1-pilot.ops',k)==b'{"synthetic_provenance":true}'`],
      { cwd: connectorDir, env: { ...env, PYTHONPATH: '.' }, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(db.prepare("SELECT user_id,status,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id='synthetic-upgrade'").get(),
      { user_id: 1, status: 'outcome_unknown', workout_id: '42', occurrence_id: '84' });
  } finally {
    await app?.close(); db.close();
    if (connector?.child.exitCode === null) { connector.child.kill('SIGTERM'); await once(connector.child, 'exit'); }
    if (seed.exitCode === null) seed.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  }
});
