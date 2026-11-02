'use strict';

const { resolveDatabaseFile } = require('../src/db/database');
const { createPrompts } = require('./admin-prompts');
const Database = require('better-sqlite3');
const { parseFitFile } = require('../src/fitParser');
const { resolveFitBuffer } = require('../src/fitUpload');
const localConfig = require('./garmin-local-config');
const crypto = require('node:crypto');

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

function pilotRuntimeConfig(options = {}) {
  return localConfig.runtimeConfig(options);
}

const PILOT_RUNTIME_VARIABLES = [
  'GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN', 'DATABASE_FILE',
  'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED',
];

function applyPilotRuntimeConfig(options = {}) {
  return localConfig.applyRuntimeConfig({ ...options, variables: PILOT_RUNTIME_VARIABLES });
}

function diagnosticError(code, { statusCode = null, stage = 'connector_response', diagnosticId = null } = {}) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.diagnosticStage = stage;
  error.diagnosticId = /^[a-f0-9]{32}$/.test(diagnosticId || '') ? diagnosticId : crypto.randomBytes(16).toString('hex');
  error.remote = true;
  return error;
}

function responseFailureCode(body, statusCode) {
  const code = body?.detail?.code || body?.error?.code;
  if (typeof code === 'string' && /^[a-z_]{1,48}$/.test(code)) return code;
  if (statusCode === 401) return 'connector_auth_failed';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'connector_service_error';
  return 'connector_invalid_response';
}

function displayPilotError(error) {
  if (error?.message === 'auth_required' && error.diagnosticStage === 'resume_mfa') {
    const id = /^[a-f0-9]{32}$/.test(error?.diagnosticId || '') ? ` (ID de diagnóstico: ${error.diagnosticId})` : '';
    return `O código MFA foi recusado ou expirou. Solicite um novo código e tente novamente${id}.`;
  }
  const messages = {
    connector_unavailable: 'Conector Garmin indisponível. Inicie npm run garmin:connector e tente novamente.',
    connector_timeout: 'O conector Garmin excedeu o tempo limite. Verifique o processo local e tente novamente.',
    garmin_timeout: 'A solicitação à Garmin excedeu o tempo limite. Nenhuma causa adicional foi confirmada; aguarde e consulte o estado antes de repetir.',
    connector_auth_failed: 'A autenticação interna entre Kinesis e o conector foi rejeitada. Confira a configuração local compartilhada.',
    service_auth_failed: 'A autenticação interna entre Kinesis e o conector foi rejeitada. Confira a configuração local compartilhada.',
    connector_configuration_error: 'A configuração Garmin está ausente ou inválida. Revise o arquivo privado do piloto e reinicie os processos locais.',
    service_configuration_error: 'A configuração Garmin está ausente ou inválida. Revise o arquivo privado do piloto e reinicie os processos locais.',
    auth_required: 'A autenticação Garmin foi recusada ou a sessão expirou. Confira a credencial informada; se a sessão anterior expirou, autentique novamente.',
    mfa_required: 'A Garmin solicitou uma verificação adicional. Informe o código apresentado no terminal.',
    rate_limited: 'A Garmin limitou temporariamente as tentativas. Aguarde antes de tentar novamente.',
    persistence_error: 'A autenticação Garmin foi concluída, mas não foi possível salvar a sessão cifrada. A sessão anterior foi preservada; confira permissões e espaço no armazenamento privado.',
    connector_service_error: 'O conector respondeu com erro durante a autenticação. Consulte o diagnóstico sanitizado no terminal do conector.',
    connector_invalid_response: 'O conector retornou uma resposta inválida durante a autenticação. Consulte o diagnóstico sanitizado no terminal do conector.',
    unavailable: 'A autenticação Garmin falhou sem uma causa classificada. Consulte o diagnóstico sanitizado no terminal do conector.',
  };
  const downloadStages = new Set([
    'restore_session', 'request_original', 'read_original', 'persist_session',
    'close_response', 'cleanup_temp', 'connector_response', 'resolve_archive', 'parse_fit',
  ]);
  if (downloadStages.has(error?.diagnosticStage)) {
    const diagnosticId = /^[a-f0-9]{32}$/.test(error.diagnosticId || '')
      ? `; diagnostic ID ${error.diagnosticId}` : '';
    const code = /^[a-z_]+$/.test(error.message || '') ? error.message : 'unavailable';
    return `Download Garmin falhou na etapa ${error.diagnosticStage} (${code})${diagnosticId}. Consulte o terminal do conector para o registro sanitizado.`;
  }
  const known = messages[error?.message];
  if (known) return `${known}${/^[a-f0-9]{32}$/.test(error?.diagnosticId || '') ? ` (ID de diagnóstico: ${error.diagnosticId})` : ''}`;
  if (error?.remote) {
    const code = /^[a-z_]{1,48}$/.test(error.message || '') ? error.message : 'unclassified_error';
    const id = /^[a-f0-9]{32}$/.test(error.diagnosticId || '') ? ` (ID de diagnóstico: ${error.diagnosticId})` : '';
    return `Falha não classificada na comunicação Garmin (${code}). Consulte o terminal do conector${id}.`;
  }
  return error?.message || 'unavailable';
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
    const failure = connectorFailure(error);
    failure.diagnosticStage ||= 'connector_request';
    failure.diagnosticId ||= crypto.randomBytes(16).toString('hex');
    failure.remote = true;
    throw failure;
  }
  await validateAccess(true);
  let body = {};
  try {
    if (response.headers.get('content-type')?.includes('application/json')) {
      body = await response.json();
    }
  } catch {
    await validateAccess(true);
    if (mutation) throw new Error('outcome_unknown');
    throw diagnosticError('connector_invalid_response', {
      statusCode: response.status,
      stage: 'connector_response',
      diagnosticId: response.headers.get('x-kinesis-diagnostic-id'),
    });
  }
  await validateAccess(true);
  if (!response.ok) {
    throw diagnosticError(responseFailureCode(body, response.status), {
      statusCode: response.status,
      stage: body?.detail?.stage || 'connector_response',
      diagnosticId: body?.detail?.diagnostic_id || body?.diagnostic_id || response.headers.get('x-kinesis-diagnostic-id'),
    });
  }
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
  const diagnosticId = response.headers.get('x-kinesis-diagnostic-id');
  const safeDiagnosticId = /^[a-f0-9]{32}$/.test(diagnosticId || '') ? diagnosticId : null;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body?.detail?.code || 'unavailable');
    error.diagnosticStage = 'connector_response';
    error.diagnosticId = safeDiagnosticId;
    throw error;
  }
  dependencies.onDiagnostic?.(safeDiagnosticId);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'text/html' || contentType === 'application/json'
      || contentType?.endsWith('+json')) {
    await response.body?.cancel().catch(() => {});
    const error = new Error('invalid_payload');
    error.diagnosticStage = 'connector_response';
    error.diagnosticId = safeDiagnosticId;
    throw error;
  }
  const maxBytes = 25 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    const error = new Error('invalid_payload');
    error.diagnosticStage = 'connector_response';
    error.diagnosticId = safeDiagnosticId;
    throw error;
  }
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const error = new Error('invalid_payload');
    error.diagnosticStage = 'read_original';
    error.diagnosticId = safeDiagnosticId;
    throw error;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error('invalid_payload');
        error.diagnosticStage = 'read_original';
        error.diagnosticId = safeDiagnosticId;
        throw error;
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
    error.diagnosticStage ||= 'read_original';
    error.diagnosticId ||= safeDiagnosticId;
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
  const sendOriginal = options.requestOriginal || ((path, dependencies = {}) => requestOriginal(path, {
    validate, invalidate, fetchImpl: options.fetchImpl, ...dependencies,
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
    let diagnosticId = null;
    let downloadStage = 'request_original';
    try {
      const archive = await sendOriginal(`${prefix}/activities/${activityId}/original`, {
        onDiagnostic(id) { diagnosticId = id; },
      });
      downloadStage = 'resolve_archive';
      const fit = await resolveBuffer({ buffer: archive, filename: 'garmin-original.zip' });
      downloadStage = 'parse_fit';
      const summary = await parse(fit);
      writeOut(`${JSON.stringify({
        activity: summary.activity,
        totals: summary.totals,
        laps: summary.laps.length,
        bytes: archive.length,
        diagnostic_id: diagnosticId,
      })}\n`);
    } catch (error) {
      error.diagnosticStage ||= downloadStage;
      error.diagnosticId ||= diagnosticId;
      throw error;
    }
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
    if (!['connected', 'mfa_required'].includes(result?.status)) {
      throw diagnosticError('connector_invalid_response', { stage: 'garmin_auth' });
    }
    if (result.status === 'mfa_required') {
      writeOut(`MFA challenge ID (expires in 5 minutes): ${result.challenge_id}\n`);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let code = await prompts.secret('Garmin MFA code: ');
          try {
            const completed = await send(`${prefix}/auth/finish`, {
              method: 'POST', body: JSON.stringify({ challenge_id: result.challenge_id, code }),
            });
            if (completed?.status !== 'connected') {
              throw diagnosticError('connector_invalid_response', { stage: 'garmin_auth' });
            }
            writeOut(`${completed.status}\n`);
            return;
          } catch (error) {
            writeError(`Falha na tentativa de autenticação. ${displayPilotError(error)}\n`);
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
    applyPilotRuntimeConfig();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    runMain().then((code) => { process.exitCode = code; });
  }
}

module.exports = { invalidateConnection, main, request, requestOriginal, runMain, validatePilot, connectorFailure,
  displayPilotError, pilotRuntimeConfig, applyPilotRuntimeConfig, responseFailureCode };
