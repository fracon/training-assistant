'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const PRIVATE_DIR = path.join(ROOT, '.kinesis-private');
const CONFIG_FILE = path.join(PRIVATE_DIR, 'garmin-pilot.json');
const STORE_DIR = path.join(PRIVATE_DIR, 'garmin-store');
const VENV_DIR = path.join(ROOT, '.venv-garmin');
const PRIVATE_ENV = Object.freeze({
  GARMIN_PILOT_USER_ID: 'pilot_user_id',
  KINESIS_GARMIN_SERVICE_TOKEN: 'service_token',
  GARMIN_ENCRYPTION_KEY: 'encryption_key',
  GARMIN_CONNECTOR_PORT: 'connector_port',
});

function readDotenv(file = path.join(ROOT, '.env')) {
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Could not read the Kinesis environment file.');
  }
}

function validatePrivateConfig(config) {
  if (!config || config.version !== 1 || typeof config !== 'object') {
    throw new Error('Local Garmin configuration is invalid; use the documented recovery procedure.');
  }
  const expectedFields = ['connector_port', 'encryption_key', 'pilot_user_id', 'service_token', 'version'];
  if (expectedFields.some((name) => !Object.prototype.hasOwnProperty.call(config, name))) {
    throw new Error('Local Garmin configuration is incomplete; no values were changed. Review the recovery instructions.');
  }
  if (Array.isArray(config) || Object.keys(config).sort().join(',') !== expectedFields.join(',')) {
    throw new Error('Local Garmin configuration has unsupported fields; no values were changed. Review the recovery instructions.');
  }
  if (!/^[1-9]\d*$/.test(String(config.pilot_user_id || ''))
      || typeof config.service_token !== 'string' || config.service_token.length < 32
      || typeof config.encryption_key !== 'string'
      || !Number.isInteger(config.connector_port) || config.connector_port < 1024 || config.connector_port > 65535) {
    throw new Error('Local Garmin configuration is incomplete or invalid; no values were changed. Review the recovery instructions.');
  }
  let key;
  try {
    key = Buffer.from(config.encryption_key, 'base64url');
  } catch {
    key = Buffer.alloc(0);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.encryption_key) || key.length !== 32) {
    throw new Error('Local Garmin encryption configuration is invalid; no values were changed. Review the recovery instructions.');
  }
  return config;
}

function readPrivateConfig(options = {}) {
  const configFile = options.configFile || CONFIG_FILE;
  let source;
  try {
    const stat = fs.lstatSync(configFile);
    const dirStat = fs.lstatSync(path.dirname(configFile));
    if (stat.isSymbolicLink() || !stat.isFile() || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error('Local Garmin configuration path must be a regular private file.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Local Garmin configuration permissions are too broad; restrict access before continuing.');
    }
    if (process.platform !== 'win32' && (dirStat.mode & 0o077) !== 0) {
      throw new Error('Local Garmin configuration directory permissions are too broad; restrict access before continuing.');
    }
    source = fs.readFileSync(configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message?.startsWith('Local Garmin')) throw error;
    throw new Error('Could not read local Garmin configuration.');
  }
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error('Local Garmin configuration is malformed; no values were changed. Review the recovery instructions.');
  }
  return validatePrivateConfig(config);
}

function runtimeConfig(options = {}) {
  const explicit = options.explicitEnv || process.env;
  const dotenvValues = options.dotenvValues || readDotenv(options.envFile);
  const privateConfig = options.privateConfig === undefined
    ? readPrivateConfig({ configFile: options.configFile }) : options.privateConfig;
  const values = {};
  for (const [name, field] of Object.entries(PRIVATE_ENV)) {
    if (Object.prototype.hasOwnProperty.call(explicit, name)) values[name] = explicit[name];
    else if (privateConfig) values[name] = String(privateConfig[field]);
  }
  values.DATABASE_FILE = explicit.DATABASE_FILE || dotenvValues.DATABASE_FILE
    || path.join(options.cwd || ROOT, 'data', 'database.sqlite');
  values.GARMIN_CONNECTOR_URL = explicit.GARMIN_CONNECTOR_URL
    || `http://127.0.0.1:${values.GARMIN_CONNECTOR_PORT || '8080'}`;
  values.GARMIN_PILOT_ENABLED = Object.prototype.hasOwnProperty.call(explicit, 'GARMIN_PILOT_ENABLED')
    ? explicit.GARMIN_PILOT_ENABLED : (privateConfig ? 'true' : 'false');
  values.GARMIN_STORE = explicit.GARMIN_STORE || STORE_DIR;
  return values;
}

function privateConfigPath() { return CONFIG_FILE; }
function privateStorePath() { return STORE_DIR; }
function virtualenvPath() { return VENV_DIR; }

function applyRuntimeConfig(options = {}) {
  const values = runtimeConfig(options);
  const names = options.variables || [
    'GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN', 'GARMIN_CONNECTOR_PORT',
    'DATABASE_FILE', 'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED', 'GARMIN_STORE',
  ];
  for (const name of names) {
    if (values[name] !== undefined) process.env[name] = values[name];
  }
  return values;
}

module.exports = {
  CONFIG_FILE, PRIVATE_DIR, STORE_DIR, VENV_DIR, PRIVATE_ENV,
  privateConfigPath, privateStorePath, readDotenv, readPrivateConfig,
  applyRuntimeConfig, runtimeConfig, validatePrivateConfig, virtualenvPath,
};
