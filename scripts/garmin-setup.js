'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const Database = require('better-sqlite3');
const { resolveDatabaseFile } = require('../src/db/database');
const local = require('./garmin-local-config');

const MIN_PYTHON = [3, 12];

function parseVersion(output) {
  const match = String(output).match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

function isSupported(version) {
  return version && (version[0] > MIN_PYTHON[0]
    || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1]));
}

function findPython(options = {}) {
  const requested = options.python || process.env.GARMIN_PYTHON;
  const candidates = requested ? [requested] : ['python3', 'python'];
  for (const command of candidates) {
    const result = (options.spawnSync || spawnSync)(command, ['--version'], { encoding: 'utf8' });
    const version = parseVersion(`${result.stdout || ''} ${result.stderr || ''}`);
    if (result.status === 0 && isSupported(version)) return { command, version };
    if (requested && result.error) throw new Error('Requested Python was not found. Install Python 3.12 or newer, or set GARMIN_PYTHON to its executable.');
  }
  throw new Error('Garmin connector requires Python 3.12 or newer. Install Python 3.12+ and rerun npm run garmin:setup.');
}

function run(command, args, options = {}) {
  const result = (options.spawnSync || spawnSync)(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.failure || 'Local Garmin preparation failed; see the command output and retry.');
  }
  return result;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Private Garmin directory cannot be a symbolic link.');
  fs.chmodSync(directory, 0o700);
}

function chooseOwner(options = {}) {
  const cwd = options.cwd || process.cwd();
  const dotenvValues = local.readDotenv(options.envFile || path.join(cwd, '.env'));
  const databaseFile = options.databaseFile || process.env.DATABASE_FILE || dotenvValues.DATABASE_FILE
    || resolveDatabaseFile(cwd);
  const resolved = path.resolve(cwd, databaseFile);
  let db;
  try {
    db = new (options.Database || Database)(resolved, { readonly: true, fileMustExist: true });
  } catch {
    throw new Error(`Kinesis database was not found or could not be opened at ${resolved}. Start Kinesis once or set DATABASE_FILE; no database was created.`);
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (!tables) throw new Error('Kinesis database has no users table; no account was changed.');
    const row = db.prepare('SELECT id, email, is_active FROM users WHERE email = ? COLLATE NOCASE').get(options.email.trim());
    if (!row) throw new Error('No Kinesis account matches that email.');
    if (row.is_active !== 1) throw new Error('That Kinesis account is inactive and cannot be selected for the pilot.');
    return { id: String(row.id), email: row.email, active: row.is_active === 1 };
  } finally {
    db.close();
  }
}

function storeHasData(directory) {
  try { return fs.readdirSync(directory).length > 0; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('Could not inspect private Garmin token storage.');
  }
}

function writeConfig(config, options = {}) {
  const file = options.file || local.privateConfigPath();
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.garmin-pilot-${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (options.createOnly) {
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, file);
    }
    fs.chmodSync(file, 0o600);
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error('Could not save private Garmin configuration; existing configuration was preserved.');
  }
}

function makeConfig(ownerId, previous = null, options = {}) {
  const key = previous?.encryption_key || (options.randomBytes || crypto.randomBytes)(32).toString('base64url');
  const token = previous?.service_token || (options.randomBytes || crypto.randomBytes)(32).toString('base64url');
  const port = Number(options.port || process.env.GARMIN_CONNECTOR_PORT || previous?.connector_port || 8080);
  return local.validatePrivateConfig({
    version: 1,
    pilot_user_id: ownerId,
    service_token: token,
    encryption_key: key,
    connector_port: port,
  });
}

async function prepare(options = {}) {
  const cwd = options.cwd || process.cwd();
  if (options.requireTty !== false && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Garmin setup requires a local interactive terminal.');
  }
  const python = findPython(options);
  const venv = options.venvDir || local.virtualenvPath();
  const pythonPath = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(pythonPath)) {
    run(python.command, ['-m', 'venv', venv], { cwd, ...options, capture: false, failure: 'Could not create the dedicated Python virtual environment.' });
  }
  if (!fs.existsSync(pythonPath)) throw new Error('Python virtual environment was not created; rerun Garmin setup.');
  const versionResult = run(pythonPath, ['--version'], { cwd, ...options, failure: 'The existing Garmin virtualenv could not be checked.' });
  const venvVersion = parseVersion(`${versionResult.stdout || ''} ${versionResult.stderr || ''}`);
  if (!isSupported(venvVersion)) throw new Error('The existing Garmin virtualenv uses Python older than 3.12. Remove only .venv-garmin and rerun npm run garmin:setup.');
  const connectorDir = path.join(cwd, 'services', 'garmin-connector');
  run(pythonPath, ['-m', 'pip', 'install', '--require-hashes', '-r', 'requirements-dev.lock'], {
    cwd: connectorDir, ...options, capture: false,
    failure: 'Could not install the hash-locked Garmin connector dependencies.',
  });

  const configFile = options.configFile || local.privateConfigPath();
  const existing = local.readPrivateConfig({ configFile });
  const currentOwner = existing?.pilot_user_id;
  const prompt = options.prompt || createPrompt();
  try {
    const email = String(await prompt('Email da sua conta Kinesis autorizada ao piloto: ')).trim();
    if (!email || email.length > 254) throw new Error('Informe um email válido da conta Kinesis.');
    const owner = chooseOwner({ ...options, cwd, email });
    if (currentOwner && currentOwner !== owner.id && storeHasData(options.storeDir || local.privateStorePath())) {
      throw new Error('The pilot owner cannot change while local Garmin tokens or journal files exist. Disconnect and follow the documented recovery steps first.');
    }
    const confirmation = await prompt(`Conta encontrada: ${owner.email} (ID ${owner.id}, ativa). Usar esta conta no piloto? Digite yes: `);
    if (confirmation.trim().toLowerCase() !== 'yes') throw new Error('Pilot setup cancelled; saved configuration was not changed.');
    const recheckedOwner = chooseOwner({ ...options, cwd, email });
    if (recheckedOwner.id !== owner.id || recheckedOwner.email.toLowerCase() !== owner.email.toLowerCase()) {
      throw new Error('The selected Kinesis account changed during setup. Run preparation again and confirm the current account.');
    }
    const storeDir = options.storeDir || local.privateStorePath();
    if (!existing && storeHasData(storeDir)) {
      throw new Error('Private token storage exists without its configuration; no key was generated. Follow the documented recovery steps.');
    }
    ensurePrivateDirectory(path.dirname(configFile));
    ensurePrivateDirectory(storeDir);
    const config = makeConfig(recheckedOwner.id, existing, options);
    if (existing) {
      writeConfig(config, { file: configFile });
    } else {
      const file = options.configFile || configFile;
      if (fs.existsSync(file)) throw new Error('Local Garmin configuration appeared during setup; no values were overwritten.');
      writeConfig(config, { file, createOnly: true });
    }
    return { owner: recheckedOwner, python: python.version, venv: path.relative(cwd, venv) || '.', configFile };
  } finally {
    if (options.prompt) await prompt.close?.();
    else prompt.close();
  }
}

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return Object.assign((question) => rl.question(question), { close: () => rl.close() });
}

async function main(options = {}) {
  try {
    const result = await prepare(options);
    (options.writeOut || console.log)(`Garmin pilot prepared for Kinesis account ${result.owner.email} (ID ${result.owner.id}).\nPython ${result.python.join('.')} virtualenv: ${result.venv}\nPrivate settings saved with restricted permissions. No Garmin login was attempted.`);
  } catch (error) {
    (options.writeError || console.error)(error.message || 'Garmin setup failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MIN_PYTHON, chooseOwner, findPython, isSupported, main, makeConfig, parseVersion, prepare, run, storeHasData, writeConfig };
