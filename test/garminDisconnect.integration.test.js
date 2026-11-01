'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
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

async function startConnector(env) {
  const port = await freePort();
  const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--workers', '1', '--no-access-log'], {
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
