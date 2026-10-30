'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const local = require('./garmin-local-config');

function connectorEnvironment(config, baseEnv = process.env) {
  const env = {
    PATH: baseEnv.PATH || '',
    HOME: baseEnv.HOME || os.homedir(),
    LANG: baseEnv.LANG || 'C.UTF-8',
    TMPDIR: baseEnv.TMPDIR || os.tmpdir(),
    GARMIN_PILOT_ENABLED: config.GARMIN_PILOT_ENABLED,
    GARMIN_PILOT_USER_ID: config.GARMIN_PILOT_USER_ID,
    KINESIS_GARMIN_SERVICE_TOKEN: config.KINESIS_GARMIN_SERVICE_TOKEN,
    GARMIN_ENCRYPTION_KEY: config.GARMIN_ENCRYPTION_KEY,
    GARMIN_STORE: config.GARMIN_STORE,
  };
  if (process.platform === 'win32' && baseEnv.SystemRoot) env.SystemRoot = baseEnv.SystemRoot;
  return env;
}

function start(options = {}) {
  const config = options.config || local.runtimeConfig(options);
  if (!config.GARMIN_PILOT_USER_ID || !config.KINESIS_GARMIN_SERVICE_TOKEN || !config.GARMIN_ENCRYPTION_KEY
      || config.GARMIN_PILOT_ENABLED !== 'true') {
    throw new Error('Local Garmin pilot is not prepared. Run npm run garmin:setup first.');
  }
  const configPort = Number(config.GARMIN_CONNECTOR_PORT || new URL(config.GARMIN_CONNECTOR_URL).port || 8080);
  const url = new URL(config.GARMIN_CONNECTOR_URL);
  if (url.hostname !== '127.0.0.1' || Number(url.port || 80) !== configPort) {
    throw new Error('Local connector URL and port must use the same 127.0.0.1 address and port.');
  }
  const venv = options.venvDir || local.virtualenvPath();
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('Garmin Python environment is missing. Run npm run garmin:setup first.');
  const connectorDir = options.connectorDir || path.resolve(__dirname, '../services/garmin-connector');
  const env = connectorEnvironment(config, options.baseEnv);
  const child = (options.spawn || spawn)(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(configPort), '--no-access-log'], {
    cwd: connectorDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const stop = (signal) => {
    if (child && child.exitCode === null && !child.killed) child.kill(signal);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  let startupError = false;
  child.once('error', () => {
    startupError = true;
    (options.writeError || ((value) => process.stderr.write(value)))('Could not start the local Garmin connector. Check its virtualenv and Python installation.\n');
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = startupError ? 1 : (code || 0);
  });
  return child;
}

function main(options = {}) {
  try {
    const config = local.runtimeConfig(options);
    start({ ...options, config });
  } catch (error) {
    process.stderr.write(`${error.message || 'Could not start the local Garmin connector.'}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { connectorEnvironment, main, start };
