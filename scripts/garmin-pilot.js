'use strict';

const { resolveDatabaseFile } = require('../src/db/database');
const { createPrompts } = require('./admin-prompts');
const Database = require('better-sqlite3');
const { parseFitFile } = require('../src/fitParser');
const { resolveFitBuffer } = require('../src/fitUpload');
const localConfig = require('./garmin-local-config');

const API = () => process.env.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
const OWNER_ID = () => process.env.GARMIN_PILOT_USER_ID || '';
const CONNECTION_ID = 'pilot';

function connectorFailure(error) {
  const code = error?.cause?.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new Error('connector_timeout');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND'
      || (error instanceof TypeError && error.message === 'fetch failed')) {
    return new Error('connector_unavailable');
  }
  return error;
}

function displayPilotError(error) {
  const messages = {
    connector_unavailable: 'Conector Garmin indisponível. Inicie npm run garmin:connector e tente novamente.',
    connector_timeout: 'O conector Garmin excedeu o tempo limite. Verifique o processo local e tente novamente.',
  };
  return messages[error?.message] || error?.message || 'unavailable';
}

async function invalidateConnection(fetchImpl = fetch) {
  try {
    await fetchImpl(`${API()}/v1/connections/${OWNER_ID()}/${CONNECTION_ID}`, {
      method: 'DELETE',
      headers: { 'x-kinesis-service-key': process.env.KINESIS_GARMIN_SERVICE_TOKEN || '' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // This is a local token cleanup only; there is no remote Garmin revocation claim.
  }
}

async function request(path, options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const validate = dependencies.validate || validatePilot;
  const invalidate = dependencies.invalidate || invalidateConnection;
  const allowInactive = options.allowInactive === true;
  const mutation = options.mutation === true;
  const requestOptions = { ...options };
  delete requestOptions.allowInactive;
  delete requestOptions.mutation;
  const validateAccess = async (afterDispatch = false) => {
    if (allowInactive) return;
    try {
      validate();
    } catch {
      await invalidate(fetchImpl);
      throw new Error(afterDispatch && mutation ? 'outcome_unknown' : 'account_inactive');
    }
  };
  await validateAccess();
  let response;
  try {
    response = await fetchImpl(`${API()}${path}`, {
      ...requestOptions,
      headers: {
        'content-type': 'application/json',
        'x-kinesis-service-key': process.env.KINESIS_GARMIN_SERVICE_TOKEN || '',
        ...options.headers,
      },
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    await validateAccess(true);
    if (mutation) throw new Error('outcome_unknown');
    throw connectorFailure(error);
  }
  await validateAccess(true);
  let body = {};
  try {
    if (response.headers.get('content-type')?.includes('application/json')) {
      body = await response.json();
    }
  } catch {
    await validateAccess(true);
    throw new Error(mutation ? 'outcome_unknown' : 'unavailable');
  }
  await validateAccess(true);
  if (!response.ok) throw new Error(body?.detail?.code || 'unavailable');
  return body;
}

async function requestOriginal(path, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const validate = dependencies.validate || validatePilot;
  const invalidate = dependencies.invalidate || invalidateConnection;
  validate();
  let response;
  try {
    response = await fetchImpl(`${API()}${path}`, {
      headers: { 'x-kinesis-service-key': process.env.KINESIS_GARMIN_SERVICE_TOKEN || '' },
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    try {
      validate();
    } catch {
      await invalidate(fetchImpl);
      throw new Error('account_inactive');
    }
    throw connectorFailure(error);
  }
  try {
    validate();
  } catch {
    await invalidate(fetchImpl);
    throw new Error('account_inactive');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.detail?.code || 'unavailable');
  }
  const maxBytes = 25 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('invalid_payload');
  }
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_payload');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('invalid_payload');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    try {
      validate();
    } catch {
      await invalidate(fetchImpl);
      throw new Error('account_inactive');
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    validate();
  } catch {
    await invalidate(fetchImpl);
    throw new Error('account_inactive');
  }
  return Buffer.concat(chunks, total);
}

function validatePilot({ allowInactive = false } = {}) {
  if (process.env.GARMIN_PILOT_ENABLED !== 'true') {
    throw new Error('Garmin pilot is disabled. Run npm run garmin:setup for the local pilot, or enable it explicitly in the operator runtime configuration.');
  }
  const ownerId = OWNER_ID();
  if (!/^\d+$/.test(ownerId) || !process.env.KINESIS_GARMIN_SERVICE_TOKEN) {
    throw new Error('Local Garmin pilot configuration is missing. Run npm run garmin:setup, or configure the operator runtime settings.');
  }
  const db = new Database(process.env.DATABASE_FILE || resolveDatabaseFile(process.cwd()), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const owner = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(Number(ownerId));
    if (!owner && allowInactive) return null;
    if (!owner || (!allowInactive && owner.is_active !== 1)) {
      throw new Error('Configured pilot account is missing or inactive.');
    }
    return owner;
  } finally {
    db.close();
  }
}

async function main(options = {}) {
  const action = options.action || process.argv[2] || 'status';
  if (!options.action && process.argv.length > 3) throw new Error('Arguments are not accepted; use the local prompts.');
  const prompts = options.prompts || createPrompts();
  const validate = options.validate || validatePilot;
  const invalidate = options.invalidate || invalidateConnection;
  const send = options.request || ((path, requestOptions = {}) => request(path, requestOptions, {
    validate, invalidate, fetchImpl: options.fetchImpl,
  }));
  const sendOriginal = options.requestOriginal || ((path) => requestOriginal(path, {
    validate, invalidate, fetchImpl: options.fetchImpl,
  }));
  const resolveBuffer = options.resolveFitBuffer || resolveFitBuffer;
  const parse = options.parseFitFile || parseFitFile;
  const writeOut = options.writeOut || ((value) => process.stdout.write(value));
  const writeError = options.writeError || ((value) => process.stderr.write(value));
  try {
    validate({ allowInactive: action === 'disconnect' || action === 'cancel' });
  } catch (error) {
    await invalidate();
    throw error;
  }
  const prefix = `/v1/connections/${OWNER_ID()}/${CONNECTION_ID}`;
  if (['auth', 'disconnect', 'publish-simple', 'publish-interval', 'schedule', 'activities', 'download', 'cancel', 'capabilities', 'capabilities-diagnose'].includes(action)) {
    prompts.assertInteractive();
  }
  if (action === 'status') {
    const value = await send(`${prefix}/status`);
    writeOut(`${value.status}\n`);
    return;
  }
  if (action === 'capabilities') {
    const value = await send(`${prefix}/capabilities`);
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'capabilities-diagnose') {
    const value = await send(`${prefix}/workout-catalog`);
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'disconnect') {
    const confirmation = await prompts.question('Type disconnect to remove local Garmin tokens: ');
    if (confirmation !== 'disconnect') throw new Error('Disconnect cancelled.');
    const value = await send(prefix, { method: 'DELETE', allowInactive: true });
    writeOut(`${value.status}; remote revocation: ${value.remote_revocation}\n`);
    return;
  }
  if (action === 'publish-simple') {
    const operationId = await prompts.question('Operation ID (blank creates one; reuse it to reconcile): ');
    const id = operationId || require('node:crypto').randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Operation ID must be a UUID.');
    writeOut(`Record this operation ID for reconciliation: ${id}\n`);
    if (await prompts.question('Type publish to send a synthetic workout: ') !== 'publish') {
      throw new Error('Publication cancelled.');
    }
    const value = await send(`${prefix}/workouts`, {
      method: 'POST',
      mutation: true,
      body: JSON.stringify({
        operation_id: id,
        name: 'synthetic easy run', interval_seconds: 900,
      }),
    });
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'publish-interval') {
    const operationId = await prompts.question('Operation ID (blank creates one; reuse it to reconcile): ');
    const id = operationId || require('node:crypto').randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Operation ID must be a UUID.');
    writeOut(`Record this operation ID for reconciliation: ${id}\n`);
    if (await prompts.question('Type publish to send a synthetic workout: ') !== 'publish') {
      throw new Error('Publication cancelled.');
    }
    const value = await send(`${prefix}/workouts`, {
      method: 'POST',
      mutation: true,
      body: JSON.stringify({
        operation_id: id,
        name: 'synthetic intervals', warmup_seconds: 300,
        interval_seconds: 120, recovery_seconds: 60, repetitions: 4,
        cooldown_seconds: 240, target_lower_mps: 2.7, target_upper_mps: 3.1,
      }),
    });
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (!['auth', 'schedule', 'activities', 'download', 'cancel'].includes(action)) {
    throw new Error('Use auth, status, capabilities, capabilities-diagnose, disconnect, publish-simple, publish-interval, schedule, activities, download, or cancel.');
  }

  if (action === 'schedule') {
    const workoutId = await prompts.question('Synthetic Garmin workout ID: ');
    const date = await prompts.question('Calendar date (YYYY-MM-DD, Europe/Lisbon): ');
    if (!/^\d+$/.test(workoutId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Enter a numeric workout ID and a civil calendar date.');
    }
    if (await prompts.question('Type schedule to add this synthetic workout to the calendar: ') !== 'schedule') {
      throw new Error('Scheduling cancelled.');
    }
    const value = await send(`${prefix}/workouts/schedule`, {
      method: 'POST', mutation: true,
      body: JSON.stringify({ workout_id: Number(workoutId), date }),
    });
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'activities') {
    const start = await prompts.question('Start date (YYYY-MM-DD): ');
    const end = await prompts.question('End date (YYYY-MM-DD, maximum 31 days): ');
    const value = await send(`${prefix}/activities`, {
      method: 'POST', body: JSON.stringify({ start, end, limit: 10 }),
    });
    writeOut(`${JSON.stringify(value)}\n`);
    return;
  }
  if (action === 'download') {
    const activityId = await prompts.question('Your Garmin activity ID: ');
    if (!/^\d+$/.test(activityId)) throw new Error('Activity ID must be numeric.');
    const archive = await sendOriginal(`${prefix}/activities/${activityId}/original`);
    const fit = await resolveBuffer({ buffer: archive, filename: 'garmin-original.zip' });
    const summary = await parse(fit);
    writeOut(`${JSON.stringify({
      activity: summary.activity,
      totals: summary.totals,
      laps: summary.laps.length,
      bytes: archive.length,
    })}\n`);
    return;
  }
  if (action === 'cancel') {
    const challengeId = await prompts.question('Pending MFA challenge ID: ');
    const result = await send(`${prefix}/auth/cancel`, {
      allowInactive: true,
      method: 'POST', body: JSON.stringify({ challenge_id: challengeId }),
    });
    writeOut(`${result.status}\n`);
    return;
  }
  const email = await prompts.question('Garmin email: ');
  let password = await prompts.secret('Garmin password: ');
  try {
    const result = await send(`${prefix}/auth/start`, {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (result.status === 'mfa_required') {
      writeOut(`MFA challenge ID (expires in 5 minutes): ${result.challenge_id}\n`);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let code = await prompts.secret('Garmin MFA code: ');
          try {
            const completed = await send(`${prefix}/auth/finish`, {
              method: 'POST', body: JSON.stringify({ challenge_id: result.challenge_id, code }),
            });
            writeOut(`${completed.status}\n`);
            return;
          } catch (error) {
            writeError(`Authentication attempt failed (${error.message}).\n`);
            if (attempt === 2) throw error;
          } finally {
            code = '';
          }
        }
      } catch (error) {
        await send(`${prefix}/auth/cancel`, {
          allowInactive: true, method: 'POST',
          body: JSON.stringify({ challenge_id: result.challenge_id }),
        }).catch(() => {});
        throw error;
      }
    } else {
      writeOut(`${result.status}\n`);
    }
  } finally {
    password = '';
  }
}

async function runMain(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (error) {
    const writeError = options.writeError || ((value) => process.stderr.write(value));
    writeError(`${displayPilotError(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  try {
    localConfig.applyRuntimeConfig({ variables: [
      'GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN', 'DATABASE_FILE',
      'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED',
    ] });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    runMain().then((code) => { process.exitCode = code; });
  }
}

module.exports = { invalidateConnection, main, request, requestOriginal, runMain, validatePilot, connectorFailure, displayPilotError };
