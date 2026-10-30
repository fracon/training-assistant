'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const local = require('../scripts/garmin-local-config');
const setup = require('../scripts/garmin-setup');
const connector = require('../scripts/garmin-connector');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-garmin-local-'));
  const configFile = path.join(root, '.kinesis-private', 'garmin-pilot.json');
  const storeDir = path.join(root, '.kinesis-private', 'garmin-store');
  const venvDir = path.join(root, '.venv-garmin');
  const databaseFile = path.join(root, 'data', 'database.sqlite');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new Database(databaseFile);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, is_active INTEGER NOT NULL);
           INSERT INTO users VALUES (17, 'pilot@example.test', 1);
           INSERT INTO users VALUES (18, 'inactive@example.test', 0);`);
  db.close();
  return { root, configFile, storeDir, venvDir, databaseFile };
}

function fakeCommands(venvDir) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (args[0] === '--version') return { status: 0, stdout: 'Python 3.12.4\n', stderr: '' };
    if (args[0] === '-m' && args[1] === 'venv') {
      fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(venvDir, 'bin', 'python'), 'synthetic interpreter');
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawnSync };
}

function promptStub(values) {
  const seen = [];
  const prompt = async (question) => {
    seen.push(question);
    return values.shift();
  };
  prompt.seen = seen;
  prompt.close = () => {};
  return prompt;
}

test('Python version parsing enforces 3.12 and gives a useful incompatible-runtime error', () => {
  assert.deepEqual(setup.parseVersion('Python 3.12.0'), [3, 12, 0]);
  assert.equal(setup.isSupported([3, 11, 9]), false);
  assert.equal(setup.isSupported([3, 12, 0]), true);
  assert.equal(setup.isSupported([4, 0, 0]), true);
  assert.throws(() => setup.findPython({
    spawnSync: () => ({ status: 0, stdout: 'Python 3.11.8', stderr: '' }),
  }), /Python 3\.12 or newer/);
  assert.throws(() => setup.findPython({ python: 'missing-python', spawnSync: () => ({ status: 1, error: new Error('missing') }) }), /Requested Python was not found/);
});

test('preparation installs hash-locked dependencies and selects an explicitly confirmed active Kinesis owner', async () => {
  const f = fixture();
  const commands = fakeCommands(f.venvDir);
  const prompt = promptStub(['pilot@example.test', 'yes']);
  const result = await setup.prepare({
    cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile, storeDir: f.storeDir,
    venvDir: f.venvDir, prompt, spawnSync: commands.spawnSync, requireTty: false,
  });
  assert.equal(result.owner.id, '17');
  assert.equal(result.owner.active, true);
  assert.equal(prompt.seen.length, 2);
  assert.equal(commands.calls.some((entry) => entry.args.includes('--require-hashes')
    && entry.args.includes('requirements-dev.lock')), true);
  assert.equal(commands.calls.some((entry) => JSON.stringify(entry).includes('GARMIN_ENCRYPTION_KEY')), false);
  const config = local.readPrivateConfig({ configFile: f.configFile });
  assert.equal(config.pilot_user_id, '17');
  assert.equal(config.service_token.length >= 32, true);
  assert.equal(Buffer.from(config.encryption_key, 'base64url').length, 32);
  assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.configFile)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(f.storeDir), true);
  assert.equal(fs.readdirSync(path.dirname(f.configFile)).some((name) => name.endsWith('.tmp')), false);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('repeated preparation preserves both internal secrets and a declined selection writes nothing', async () => {
  const f = fixture();
  let commands = fakeCommands(f.venvDir);
  await setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile, storeDir: f.storeDir,
    venvDir: f.venvDir, prompt: promptStub(['pilot@example.test', 'yes']), spawnSync: commands.spawnSync, requireTty: false });
  const before = local.readPrivateConfig({ configFile: f.configFile });
  commands = fakeCommands(f.venvDir);
  await setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile, storeDir: f.storeDir,
    venvDir: f.venvDir, prompt: promptStub(['pilot@example.test', 'yes']), spawnSync: commands.spawnSync, requireTty: false });
  const after = local.readPrivateConfig({ configFile: f.configFile });
  assert.equal(after.service_token, before.service_token);
  assert.equal(after.encryption_key, before.encryption_key);
  await assert.rejects(setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile,
    storeDir: f.storeDir, venvDir: f.venvDir, prompt: promptStub(['pilot@example.test', 'no']),
    spawnSync: commands.spawnSync, requireTty: false }), /cancelled/);
  assert.equal(local.readPrivateConfig({ configFile: f.configFile }).encryption_key, before.encryption_key);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('missing database, missing/inactive email and owner changes with tokens never create or replace configuration', async () => {
  const f = fixture();
  assert.throws(() => setup.chooseOwner({ cwd: f.root, databaseFile: path.join(f.root, 'absent.sqlite'), email: 'pilot@example.test' }), /no database was created/);
  assert.throws(() => setup.chooseOwner({ cwd: f.root, databaseFile: f.databaseFile, email: 'unknown@example.test' }), /No Kinesis account/);
  assert.throws(() => setup.chooseOwner({ cwd: f.root, databaseFile: f.databaseFile, email: 'inactive@example.test' }), /inactive/);
  const commands = fakeCommands(f.venvDir);
  await setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile, storeDir: f.storeDir,
    venvDir: f.venvDir, prompt: promptStub(['pilot@example.test', 'yes']), spawnSync: commands.spawnSync, requireTty: false });
  fs.writeFileSync(path.join(f.storeDir, '17-pilot.bin'), 'ciphertext');
  const db = new Database(f.databaseFile);
  db.prepare('UPDATE users SET is_active = 1 WHERE id = 18').run();
  db.close();
  const selected = local.readPrivateConfig({ configFile: f.configFile });
  await assert.rejects(setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile, storeDir: f.storeDir,
    venvDir: f.venvDir, prompt: promptStub(['inactive@example.test', 'yes']), spawnSync: commands.spawnSync, requireTty: false }), /owner cannot change/);
  assert.equal(local.readPrivateConfig({ configFile: f.configFile }).service_token, selected.service_token);
  assert.throws(() => setup.chooseOwner({ cwd: f.root, databaseFile: f.databaseFile, email: 'pilot@example.test; DROP TABLE users' }), /No Kinesis account/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('setup rechecks the selected account after the confirmation prompt before saving its owner ID', async () => {
  const f = fixture();
  const commands = fakeCommands(f.venvDir);
  const answers = ['pilot@example.test', 'yes'];
  let prompts = 0;
  const prompt = async () => {
    prompts += 1;
    if (prompts === 2) {
      const db = new Database(f.databaseFile);
      db.prepare('UPDATE users SET is_active = 0 WHERE id = 17').run();
      db.close();
    }
    return answers.shift();
  };
  prompt.close = () => {};
  await assert.rejects(setup.prepare({ cwd: f.root, databaseFile: f.databaseFile, configFile: f.configFile,
    storeDir: f.storeDir, venvDir: f.venvDir, prompt, spawnSync: commands.spawnSync, requireTty: false }), /inactive/);
  assert.equal(fs.existsSync(f.configFile), false);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('partial, malformed or broadly permissioned private configuration is refused unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-garmin-config-'));
  const dir = path.join(root, 'private');
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"version":1,"pilot_user_id":"17"}', { mode: 0o600 });
  assert.throws(() => local.readPrivateConfig({ configFile: file }), /incomplete/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"pilot_user_id":"17"}');
  fs.writeFileSync(file, 'not-json', { mode: 0o600 });
  assert.throws(() => local.readPrivateConfig({ configFile: file }), /malformed/);
  if (process.platform !== 'win32') {
    const valid = { version: 1, pilot_user_id: '17', service_token: 's'.repeat(43),
      encryption_key: Buffer.alloc(32).toString('base64url'), connector_port: 8080 };
    fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    fs.chmodSync(dir, 0o700);
    assert.throws(() => local.readPrivateConfig({ configFile: file }), /permissions are too broad/);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => local.readPrivateConfig({ configFile: file }), /directory permissions are too broad/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('explicit environment overrides private config, which overrides dotenv, without exporting secrets to unrelated child variables', () => {
  const privateConfig = {
    version: 1, pilot_user_id: '17', service_token: 's'.repeat(43),
    encryption_key: Buffer.alloc(32, 1).toString('base64url'), connector_port: 8080,
  };
  const values = local.runtimeConfig({
    explicitEnv: { KINESIS_GARMIN_SERVICE_TOKEN: 'explicit-secret', DATABASE_FILE: '/explicit/db.sqlite' },
    privateConfig,
    dotenvValues: { KINESIS_GARMIN_SERVICE_TOKEN: 'dotenv-secret', DATABASE_FILE: '/dotenv/db.sqlite',
      GARMIN_CONNECTOR_URL: 'http://garmin-connector:8080', GARMIN_STORE: '/zimaos/volume' },
  });
  assert.equal(values.KINESIS_GARMIN_SERVICE_TOKEN, 'explicit-secret');
  assert.equal(values.GARMIN_ENCRYPTION_KEY, privateConfig.encryption_key);
  assert.equal(values.DATABASE_FILE, '/explicit/db.sqlite');
  assert.equal(values.GARMIN_CONNECTOR_URL, 'http://127.0.0.1:8080');
  assert.equal(values.GARMIN_STORE, local.STORE_DIR);
  const env = connector.connectorEnvironment(values, { PATH: '/bin', NODE_OPTIONS: '--inspect', OPENAI_API_KEY: 'do-not-forward' });
  assert.equal(env.KINESIS_GARMIN_SERVICE_TOKEN, 'explicit-secret');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GARMIN_ENCRYPTION_KEY, privateConfig.encryption_key);
});

test('dotenv is read without mutating .env or exporting it into the application process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-garmin-dotenv-'));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, 'DATABASE_FILE=./custom.sqlite\nGARMIN_PILOT_ENABLED=true\n');
  const before = process.env.GARMIN_PILOT_ENABLED;
  const values = local.runtimeConfig({ cwd: root, envFile, explicitEnv: {}, privateConfig: null });
  assert.equal(values.DATABASE_FILE, './custom.sqlite');
  assert.equal(values.GARMIN_PILOT_ENABLED, 'false');
  assert.equal(values.GARMIN_CONNECTOR_URL, 'http://127.0.0.1:8080');
  assert.equal(values.GARMIN_STORE, local.STORE_DIR);
  assert.equal(process.env.GARMIN_PILOT_ENABLED, before);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'DATABASE_FILE=./custom.sqlite\nGARMIN_PILOT_ENABLED=true\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pilot CLI configuration does not copy the Python-only encryption key into Node environment', () => {
  const original = Object.fromEntries(['GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN',
    'GARMIN_ENCRYPTION_KEY', 'DATABASE_FILE', 'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED']
    .map((name) => [name, process.env[name]]));
  try {
    delete process.env.GARMIN_ENCRYPTION_KEY;
    local.applyRuntimeConfig({
      explicitEnv: {},
      dotenvValues: {},
      privateConfig: { version: 1, pilot_user_id: '17', service_token: 's'.repeat(43),
        encryption_key: Buffer.alloc(32).toString('base64url'), connector_port: 8080 },
      variables: ['GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN', 'DATABASE_FILE',
        'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED'],
    });
    assert.equal(process.env.GARMIN_PILOT_USER_ID, '17');
    assert.equal(process.env.KINESIS_GARMIN_SERVICE_TOKEN, 's'.repeat(43));
    assert.equal(process.env.GARMIN_ENCRYPTION_KEY, undefined);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('connector starts the prepared virtualenv on loopback with private env and no reload or shell activation', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.venvDir, 'bin'), { recursive: true });
  const python = path.join(f.venvDir, 'bin', 'python');
  fs.writeFileSync(python, '');
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => { child.lastSignal = signal; child.killed = true; };
  let call;
  const config = { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '17',
    KINESIS_GARMIN_SERVICE_TOKEN: 'internal-secret', GARMIN_ENCRYPTION_KEY: 'private-key',
    GARMIN_STORE: f.storeDir, GARMIN_CONNECTOR_PORT: '8123', GARMIN_CONNECTOR_URL: 'http://127.0.0.1:8123' };
  const started = connector.start({ config, venvDir: f.venvDir, connectorDir: f.root,
    baseEnv: { PATH: '/safe/path', NODE_OPTIONS: '--inspect' },
    spawn: (...args) => { call = args; return child; } });
  assert.equal(started, child);
  assert.deepEqual(call[0], python);
  assert.deepEqual(call[1], ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8123', '--no-access-log']);
  assert.equal(call[2].cwd, f.root);
  assert.equal(call[2].env.GARMIN_ENCRYPTION_KEY, 'private-key');
  assert.equal(call[2].env.NODE_OPTIONS, undefined);
  process.emit('SIGTERM');
  assert.equal(child.lastSignal, 'SIGTERM');
  assert.throws(() => connector.start({ config, venvDir: path.join(f.root, 'absent') }), /environment is missing/);
  child.emit('close', 0, null);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('connector reports unprepared, mismatched loopback configuration and child startup failure safely', () => {
  assert.throws(() => connector.start({ config: {} }), /garmin:setup/);
  const f = fixture();
  fs.mkdirSync(path.join(f.venvDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(f.venvDir, 'bin', 'python'), '');
  const config = { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '17',
    KINESIS_GARMIN_SERVICE_TOKEN: 'internal-secret', GARMIN_ENCRYPTION_KEY: 'private-key',
    GARMIN_STORE: f.storeDir, GARMIN_CONNECTOR_PORT: '8123', GARMIN_CONNECTOR_URL: 'http://0.0.0.0:8123' };
  assert.throws(() => connector.start({ config, venvDir: f.venvDir }), /127\.0\.0\.1/);
  fs.mkdirSync(path.join(f.venvDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(f.venvDir, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {};
  const errors = [];
  connector.start({ config: { ...config, GARMIN_CONNECTOR_URL: 'http://127.0.0.1:8123' },
    venvDir: f.venvDir, connectorDir: f.root, spawn: () => child,
    writeError: (value) => errors.push(value) });
  child.emit('error', new Error('sensitive spawn detail'));
  child.emit('close', null, null);
  assert.equal(process.exitCode, 1);
  assert.equal(errors.join('').includes('sensitive'), false);
  assert.match(errors.join(''), /Check its virtualenv/);
  process.exitCode = undefined;
  fs.rmSync(f.root, { recursive: true, force: true });
});
