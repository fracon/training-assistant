'use strict';

const crypto = require('node:crypto');
const { findActiveSession, SESSION_COOKIE_NAME } = require('../auth/sessions');
const { validatePrescription, prescriptionFingerprint, previewPrescription, paceBoundsMps } = require('../garmin-workout-contract');

const CONNECTION = 'pilot';
const activeJobsByDatabase = new WeakMap();
const cleanupJobsByDatabase = new WeakMap();
const recoveredDatabases = new WeakSet();

function activeJobsFor(db) {
  if (!activeJobsByDatabase.has(db)) activeJobsByDatabase.set(db, new Set());
  return activeJobsByDatabase.get(db);
}

function createGarminProduct({ db, fetchImpl = fetch, config = process.env, now = () => Date.now() }) {
  const challenges = new Map();
  const authAttempts = new Map();
  const authInFlight = new Map();
  const connector = config.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
  const pilotOwner = Number(config.GARMIN_PILOT_USER_ID);
  const multiuser = config.GARMIN_ACCESS_MODE === 'multiuser';
  const validMode = !config.GARMIN_ACCESS_MODE || config.GARMIN_ACCESS_MODE === 'pilot' || multiuser;
  let closing = false;
  const controllers = new Set();
  const connectionTails = new Map();
  const workerTasks = new Set();
  let cleanupTimer = null;
  if (!cleanupJobsByDatabase.has(db)) cleanupJobsByDatabase.set(db, new Map());
  const cleanupJobs = cleanupJobsByDatabase.get(db);

  function eligible(request) {
    const owner = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(request.user.id);
    if (config.GARMIN_PILOT_ENABLED !== 'true' || !validMode || (!multiuser && (!pilotOwner || owner?.id !== pilotOwner)) || owner?.id !== request.user.id || owner.is_active !== 1) return false;
    return true;
  }

  function beginAuthTransition(ownerId) {
    const attempt = crypto.randomUUID();
    return db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO garmin_pilot_connections(user_id) VALUES (?)').run(ownerId);
      const changed = db.prepare('UPDATE garmin_pilot_connections SET auth_expected=auth_fence,auth_attempt=? WHERE user_id=? AND auth_attempt IS NULL AND cleanup_pending=0').run(attempt, ownerId);
      return changed.changes ? attempt : null;
    }).immediate();
  }

  function finishAuthTransition(ownerId, attempt, effect) {
    return db.transaction(() => {
      const row = db.prepare('SELECT auth_attempt FROM garmin_pilot_connections WHERE user_id=?').get(ownerId);
      if (row?.auth_attempt !== attempt) throw new Error('auth_required');
      const identity = effect?.status === 'connected' ? saveConnectionIdentity(ownerId, effect.identity_fingerprint) : null;
      db.prepare('UPDATE garmin_pilot_connections SET auth_fence=?,auth_expected=NULL,auth_attempt=NULL WHERE user_id=? AND auth_attempt=?').run(attempt, ownerId, attempt);
      return identity;
    }).immediate();
  }

  function authTransitionPending(ownerId) {
    return Boolean(db.prepare('SELECT auth_attempt FROM garmin_pilot_connections WHERE user_id=?').get(ownerId)?.auth_attempt);
  }

  function ownsAuthTransition(ownerId, attempt) {
    const row = db.prepare('SELECT auth_attempt FROM garmin_pilot_connections WHERE user_id=?').get(ownerId);
    return !attempt || !row || row.auth_attempt === attempt;
  }

  async function installAuthFence(request, attempt, expected) {
    const result = await remote(request, '/auth/fence', { method: 'POST', body: JSON.stringify({ expected: expected || null, attempt }) });
    if (result?.status !== 'fenced') throw Object.assign(new Error('connector_invalid_response'), { statusCode: 502 });
  }

  async function recoverAuthTransition(request) {
    if (authInFlight.has(request.user.id)) return false;
    authInFlight.set(request.user.id, true);
    const recover = async () => {
      const prior = db.prepare('SELECT auth_attempt,auth_expected FROM garmin_pilot_connections WHERE user_id=?').get(request.user.id);
      if (!prior?.auth_attempt) return true;
      await installAuthFence(request, prior.auth_attempt, prior.auth_expected);
      const next = crypto.randomUUID();
      const changed = db.prepare('UPDATE garmin_pilot_connections SET auth_expected=auth_attempt,auth_attempt=? WHERE user_id=? AND auth_attempt=?').run(next, request.user.id, prior.auth_attempt);
      if (!changed.changes) return false;
      await installAuthFence(request, next, prior.auth_attempt);
      let state = await remote(request, '/status');
      if (state.status === 'reauthentication_required') {
        state = await remote(request, '', { method: 'DELETE', headers: { 'x-kinesis-auth-attempt': next } });
      }
      if (!eligible(request) || !['connected', 'disconnected'].includes(state.status)) return false;
      finishAuthTransition(request.user.id, next, state);
      return true;
    };
    let result;
    try { result = await recover(); }
    catch { result = false; }
    authInFlight.delete(request.user.id);
    return result;
  }

  async function remote(request, path, options = {}) {
    const diagnosticId = crypto.randomBytes(16).toString('hex');
    let stage = 'configuration';
    let statusCode = null;
    let code = 'connector_configuration_error';
    const fail = (nextCode, nextStatus = 503) => {
      code = nextCode;
      const error = new Error(nextCode);
      error.statusCode = nextStatus;
      error.diagnosticId = diagnosticId;
      throw error;
    };
    try {
      const sessionValid = () => {
        if (!multiuser) return true;
        const session = findActiveSession(db, request.cookies?.[SESSION_COOKIE_NAME]);
        return session?.token === request.session?.token && session?.userId === request.user.id;
      };
      if (!sessionValid()) fail('auth_required', 401);
      const target = new URL(connector);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
          || !config.KINESIS_GARMIN_SERVICE_TOKEN) fail('connector_configuration_error');
      stage = 'connector_request';
      let response;
      try {
        response = await fetchImpl(`${connector}/v1/connections/${multiuser ? request.user.id : pilotOwner}/${CONNECTION}${path}`, {
          ...options,
          headers: {
            'content-type': 'application/json',
            'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN,
            ...options.headers,
          },
          signal: AbortSignal.timeout(90000),
        });
      } catch (error) {
        const causeCode = error?.cause?.code;
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') code = 'connector_timeout';
        else if (causeCode === 'ECONNREFUSED' || causeCode === 'ECONNRESET'
          || causeCode === 'ENOTFOUND' || error instanceof TypeError) code = 'connector_unavailable';
        else code = 'connector_service_error';
        throw error;
      }
      statusCode = response.status;
      stage = 'connector_response';
      let body;
      try { body = await response.json(); }
      catch { fail('connector_invalid_response', 502); }
      if (!sessionValid()) {
        const error = Object.assign(new Error('auth_required'), { statusCode: 401, diagnosticId });
        code = 'auth_required';
        if (response.ok && ['/auth/start', '/auth/finish'].includes(path)) error.authEffect = body;
        throw error;
      }
      if (!response.ok) {
        const remoteCode = body?.detail?.code;
        if (multiuser && ['/auth/start', '/auth/finish'].includes(path) && response.status === 401 && remoteCode === 'auth_required') {
          code = 'auth_required';
          throw Object.assign(new Error(code), { statusCode: 401, diagnosticId, authEffect: { status: 'auth_failed' } });
        }
        if (remoteCode === 'service_auth_failed') fail('connector_auth_failed');
        if (remoteCode === 'service_configuration_error') fail('connector_configuration_error');
        if (response.status >= 500) fail('connector_service_error', 503);
        if (['auth_required', 'mfa_required', 'rate_limited', 'unsupported', 'invalid_payload', 'outcome_unknown'].includes(remoteCode)) {
          fail(remoteCode, response.status);
        }
        fail('connector_service_error', 502);
      }
      if (path === '/status'
          && !['authenticating', 'mfa_required', 'connected', 'disconnected', 'reauthentication_required', 'temporarily_unavailable'].includes(body?.status)) {
        fail('connector_invalid_response', 502);
      }
      if (path === '/capabilities'
          && (!Array.isArray(body?.devices)
            || !['available', 'absent', 'unknown'].includes(body?.running_catalog_status))) {
        fail('connector_invalid_response', 502);
      }
      return body;
    } catch (error) {
      const safeError = error?.diagnosticId ? error : Object.assign(new Error(code), {
        statusCode: code === 'connector_unavailable' ? 503 : code === 'connector_timeout' ? 504 : 503,
        diagnosticId,
      });
      console.warn('[kinesis-garmin]', JSON.stringify({
        diagnostic_id: diagnosticId, stage, code, status: statusCode,
      }));
      throw safeError;
    }
  }

  async function cleanupRevokedConnection(ownerId, connectionId, { preserveIdentity = false, expectedFence } = {}) {
    const key = `${ownerId}:${connectionId}`;
    const existing = cleanupJobs.get(key);
    if (existing) {
      if (!preserveIdentity && existing.preserveIdentity) existing.revoked = true;
      const result = await existing.promise;
      if (existing.revoked) {
        existing.revoked = false;
        return cleanupRevokedConnection(ownerId, connectionId, { preserveIdentity: false, expectedFence: existing.expectedFence });
      }
      return result;
    }
    const cleanup = async () => {
      const prepareCleanup = db.transaction(() => {
        const cleanupState = db.prepare('SELECT pending,preserve_identity,auth_fence FROM garmin_connection_cleanup WHERE user_id=? AND connection_id=?').get(ownerId, connectionId);
        const wasPending = Boolean(cleanupState?.pending);
        const connection = db.prepare('SELECT auth_fence,auth_attempt FROM garmin_pilot_connections WHERE user_id=?').get(ownerId);
        if (wasPending && expectedFence !== undefined && cleanupState.auth_fence !== expectedFence) return { obsolete: true };
        if (!wasPending && expectedFence !== undefined && connection
            && connection.auth_fence !== expectedFence && connection.auth_attempt !== expectedFence) return { obsolete: true };
        const fence = wasPending ? cleanupState.auth_fence : (expectedFence !== undefined ? expectedFence : (connection?.auth_fence || null));
        const keepIdentity = wasPending ? Boolean(cleanupState.preserve_identity) && preserveIdentity : preserveIdentity;
        if (!wasPending) {
          if (db.prepare('SELECT 1 FROM users WHERE id=?').get(ownerId)) {
            db.prepare(`INSERT INTO garmin_pilot_connections
              (user_id,connection_generation,identity_fingerprint,cleanup_pending) VALUES (?,2,NULL,1)
              ON CONFLICT(user_id) DO UPDATE SET connection_generation=connection_generation+1,
                identity_fingerprint=NULL,cleanup_pending=1,updated_at=datetime('now')`).run(ownerId);
          }
          db.prepare(`INSERT INTO garmin_connection_cleanup (user_id,connection_id,pending,preserve_identity,auth_fence) VALUES (?,?,1,0,?)
            ON CONFLICT(user_id,connection_id) DO UPDATE SET pending=1,preserve_identity=0,auth_fence=excluded.auth_fence,updated_at=datetime('now')`).run(ownerId, connectionId, fence);
        } else if (!keepIdentity && cleanupState.preserve_identity) {
          db.prepare(`UPDATE garmin_pilot_connections SET connection_generation=connection_generation+
            CASE WHEN identity_fingerprint IS NULL THEN 0 ELSE 1 END,identity_fingerprint=NULL,
            cleanup_pending=1,updated_at=datetime('now') WHERE user_id=?`).run(ownerId);
          db.prepare(`UPDATE garmin_connection_cleanup SET preserve_identity=0,updated_at=datetime('now') WHERE user_id=? AND connection_id=?`).run(ownerId, connectionId);
        }
        return { fence };
      });
      const prepared = prepareCleanup.immediate();
      if (prepared.obsolete) return true;
      const authFence = prepared.fence;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const response = await fetchImpl(`${connector}/v1/connections/${ownerId}/${connectionId}`, {
          method: 'DELETE', headers: { 'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN || '', ...(authFence ? { 'x-kinesis-auth-attempt': authFence } : {}) },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        let confirmed = response.status === 404 || response.status === 204;
        if (response.ok && !confirmed) {
          const body = await response.json().catch(() => null);
          confirmed = body?.status === 'disconnected';
        }
        if (confirmed) {
          db.transaction(() => {
            const updated = db.prepare(`UPDATE garmin_connection_cleanup SET pending=0,preserve_identity=0,updated_at=datetime('now')
              WHERE user_id=? AND connection_id=? AND pending=1 AND auth_fence IS ?`).run(ownerId, connectionId, authFence);
            if (updated.changes) db.prepare(`UPDATE garmin_pilot_connections SET cleanup_pending=0,updated_at=datetime('now') WHERE user_id=?`).run(ownerId);
          }).immediate();
          return true;
        }
      } catch { /* durable pending flag is retried by the local cleanup worker */ }
      finally { controllers.delete(controller); }
      return false;
    };
    const priorCleanup = db.prepare('SELECT pending,auth_fence FROM garmin_connection_cleanup WHERE user_id=? AND connection_id=?').get(ownerId, connectionId);
    const snapshotFence = priorCleanup?.pending ? priorCleanup.auth_fence
      : (expectedFence !== undefined ? expectedFence : (db.prepare('SELECT auth_fence FROM garmin_pilot_connections WHERE user_id=?').get(ownerId)?.auth_fence || null));
    const job = { preserveIdentity, expectedFence: snapshotFence, revoked: false, promise: null };
    job.promise = cleanup();
    cleanupJobs.set(key, job);
    try { return await job.promise; }
    finally { if (cleanupJobs.get(key) === job) cleanupJobs.delete(key); }
  }

  function queueUserDisconnect(ownerId, connectionId) {
    const queue = db.transaction(() => {
      const generation = connectionGeneration(ownerId);
      const fence = db.prepare('SELECT auth_fence FROM garmin_pilot_connections WHERE user_id=?').get(ownerId)?.auth_fence || null;
      db.prepare(`INSERT INTO garmin_pilot_connections (user_id,connection_generation,identity_fingerprint,cleanup_pending)
        VALUES (?,?,NULL,1) ON CONFLICT(user_id) DO UPDATE SET cleanup_pending=1,updated_at=datetime('now')`)
        .run(ownerId, generation);
      db.prepare(`INSERT INTO garmin_connection_cleanup (user_id,connection_id,pending,preserve_identity,auth_fence) VALUES (?,?,1,1,?)
        ON CONFLICT(user_id,connection_id) DO UPDATE SET preserve_identity=CASE WHEN pending=1 THEN preserve_identity ELSE 1 END,
          auth_fence=CASE WHEN pending=1 THEN auth_fence ELSE excluded.auth_fence END,
          pending=1,updated_at=datetime('now')`).run(ownerId, connectionId, fence);
    });
    queue.immediate();
  }

  async function retryPendingCleanup(ownerId, connectionId) {
    const state = db.prepare('SELECT pending,preserve_identity FROM garmin_connection_cleanup WHERE user_id=? AND connection_id=?').get(ownerId, connectionId);
    if (closing || !state?.pending) return;
    return cleanupRevokedConnection(ownerId, connectionId, { preserveIdentity: Boolean(state.preserve_identity) });
  }

  function retryAllPendingCleanup() {
    if (closing) return;
    const rows = db.prepare('SELECT user_id,connection_id FROM garmin_connection_cleanup WHERE pending=1 AND connection_id=?').all(CONNECTION);
    for (const row of rows) {
      const task = retryPendingCleanup(row.user_id, row.connection_id);
      workerTasks.add(task);
      void task.finally(() => workerTasks.delete(task)).catch(() => {});
    }
  }

  function enqueueOperation(operation, current) {
    const key = `${operation.ownerId}:${CONNECTION}`;
    const operationFence = db.prepare('SELECT auth_fence FROM garmin_pilot_connections WHERE user_id=?').get(operation.ownerId)?.auth_fence || null;
    const previous = connectionTails.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runOperation(db, fetchImpl, config,
      operation, current, { shouldStop: () => closing, onOwnerIneligible: () => {
        const preserveIdentity = multiuser && Boolean(db.prepare('SELECT 1 FROM users WHERE id=?').get(operation.ownerId));
        if (preserveIdentity) queueUserDisconnect(operation.ownerId, CONNECTION);
        return cleanupRevokedConnection(operation.ownerId, CONNECTION, { preserveIdentity, expectedFence: operationFence });
      }, controllers }));
    workerTasks.add(task);
    connectionTails.set(key, task);
    void task.finally(() => {
      workerTasks.delete(task);
      if (connectionTails.get(key) === task) connectionTails.delete(key);
    });
  }

  function current(request, trainingId) {
    return db.prepare('SELECT id, dia, user_id, completed FROM trainings WHERE id = ? AND user_id = ?').get(trainingId, request.user.id);
  }

  function register(app, requireAuth) {
    // A database can back more than one Fastify instance in tests/embedded
    // deployments. Recover interrupted work once per process/database, without
    // replacing its persisted stage or remote IDs.
    if (!recoveredDatabases.has(db)) {
      db.prepare(`UPDATE garmin_training_operations SET status = 'outcome_unknown',
        error_code = 'outcome_unknown', updated_at = datetime('now')
        WHERE status IN ('publishing','scheduling')`).run();
      recoveredDatabases.add(db);
    }
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url.startsWith('/api/garmin/')) reply.header('cache-control', 'no-store');
      return payload;
    });
    cleanupTimer = setInterval(retryAllPendingCleanup, 30000);
    cleanupTimer.unref?.();
    app.addHook('onClose', async () => {
      closing = true;
      clearInterval(cleanupTimer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...workerTasks]);
    });
    retryAllPendingCleanup();
    app.get('/api/garmin/status', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (authTransitionPending(request.user.id) && !await recoverAuthTransition(request)) return reply.code(503).send({ code: 'cleanup_pending' });
      try {
        if (db.prepare('SELECT pending FROM garmin_connection_cleanup WHERE user_id=? AND connection_id=?').get(request.user.id, CONNECTION)?.pending
            && !await retryPendingCleanup(request.user.id, CONNECTION)) return reply.code(503).send({ code: 'cleanup_pending' });
        const result = await remote(request, '/status');
        if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
        const capabilities = result.status === 'connected' ? await remote(request, '/capabilities') : null;
        if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
        const trainingId = Number(request.query?.training_id);
        const training = Number.isInteger(trainingId) ? current(request, trainingId) : null;
        const sessionState = training ? db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id) : null;
      let operation = training ? db.prepare('SELECT operation_id, connection_generation, prescription_revision, status, stage, action, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id) : null;
        if (operation?.status === 'scheduled' && (operation.scheduled_date !== training.dia || operation.prescription_revision !== sessionState?.revision)) {
          db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(operation.operation_id, request.user.id);
          operation = { ...operation, status: 'outdated' };
        }
        const { identity_fingerprint: _privateIdentity, ...publicResult } = result;
        const savedPrescription = sessionState ? JSON.parse(sessionState.prescription_json) : null;
        return { ...publicResult, connection_generation: connectionGeneration(request.user.id), pilot: true, devices: capabilities?.devices || [], running_catalog_status: capabilities?.running_catalog_status || 'unknown', prescription: sessionState ? { revision: sessionState.revision, value: savedPrescription, fingerprint: sessionState.fingerprint, preview: previewPrescription(savedPrescription) } : null, training_date: training?.dia || null, operation: operation || null };
      } catch (error) {
        return reply.code(error.statusCode || 503).send({ code: safeCode(error), diagnostic_id: diagnosticIdFor(error, 'status') });
      }
    });
    app.post('/api/garmin/auth/start', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (db.prepare('SELECT pending FROM garmin_connection_cleanup WHERE user_id=? AND connection_id=?').get(request.user.id, CONNECTION)?.pending
          && !await retryPendingCleanup(request.user.id, CONNECTION)) return reply.code(503).send({ code: 'cleanup_pending' });
      if (authInFlight.has(request.user.id)) return reply.code(409).send({ code: 'auth_required' });
      const body = request.body || {};
      if (typeof body.email !== 'string' || body.email.length < 3 || body.email.length > 254 || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024) return reply.code(400).send({ code: 'invalid_payload' });
      const transition = multiuser ? beginAuthTransition(request.user.id) : null;
      if (multiuser && !transition) return reply.code(503).send({ code: 'cleanup_pending' });
      const attempt = (authAttempts.get(request.user.id) || 0) + 1;
      authAttempts.set(request.user.id, attempt);
      authInFlight.set(request.user.id, true);
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      const executeAuthStart = async () => {
      try {
        if (transition) {
          const expected = db.prepare('SELECT auth_expected FROM garmin_pilot_connections WHERE user_id=?').get(request.user.id)?.auth_expected;
          await installAuthFence(request, transition, expected);
        }
        const result = await remote(request, '/auth/start', { method: 'POST', body: JSON.stringify(body), ...(transition ? { headers: { 'x-kinesis-auth-attempt': transition } } : {}) });
        if (authAttempts.get(request.user.id) !== attempt) {
          if (ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition });
          return reply.code(409).send({ code: 'auth_required' });
        }
        if (!eligible(request)) {
          challenges.delete(result.challenge_id);
          if (ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition });
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (result.status === 'mfa_required' && typeof result.challenge_id === 'string') challenges.set(result.challenge_id, { owner: request.user.id, session: request.session.token, expires: now() + Math.min(300000, result.expires_in * 1000), generation: connectionGeneration(request.user.id), attempt });
        if (result.status === 'connected') {
          const identity = transition ? finishAuthTransition(request.user.id, transition, result) : saveConnectionIdentity(request.user.id, result.identity_fingerprint);
          return { status: 'connected', connection_generation: identity.generation, identity_changed: identity.changed };
        }
        if (transition && result.status === 'mfa_required') finishAuthTransition(request.user.id, transition, result);
        return result.status === 'mfa_required' ? { status: result.status, challenge_id: result.challenge_id, expires_in: result.expires_in } : { status: result.status };
      } catch (error) {
        if (transition && error.authEffect && eligible(request) && ['connected', 'mfa_required', 'auth_failed'].includes(error.authEffect.status)) {
          try { finishAuthTransition(request.user.id, transition, error.authEffect); }
          catch { /* The persisted transition keeps the connection blocked. */ }
        }
        if (!eligible(request) && ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition });
        return reply.code(error.statusCode || 503).send({ code: safeCode(error), diagnostic_id: diagnosticIdFor(error, 'auth_start') });
      }
      };
      const clearAuthStart = () => {
        body.password = '';
        authInFlight.delete(request.user.id);
      };
      let authStartResult;
      try { authStartResult = await executeAuthStart(); }
      catch (error) { clearAuthStart(); throw error; }
      clearAuthStart();
      return authStartResult;
    });
    app.post('/api/garmin/auth/finish', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const { challenge_id: id, code } = request.body || {};
      const challenge = challenges.get(id);
      if (!challenge || challenge.owner !== request.user.id || challenge.session !== request.session.token || challenge.expires <= now() || challenge.generation !== connectionGeneration(request.user.id)) return reply.code(400).send({ code: 'auth_required' });
      if (typeof code !== 'string' || code.length > 32) return reply.code(400).send({ code: 'invalid_payload' });
      if (authInFlight.has(request.user.id)) return reply.code(409).send({ code: 'auth_required' });
      const transition = multiuser ? beginAuthTransition(request.user.id) : null;
      if (multiuser && !transition) return reply.code(503).send({ code: 'cleanup_pending' });
      authInFlight.set(request.user.id, true);
      const executeMfaFinish = async () => {
      try {
        if (transition) {
          const expected = db.prepare('SELECT auth_expected FROM garmin_pilot_connections WHERE user_id=?').get(request.user.id)?.auth_expected;
          await installAuthFence(request, transition, expected);
        }
        const result = await remote(request, '/auth/finish', { method: 'POST', body: JSON.stringify({ challenge_id: id, code }), ...(transition ? { headers: { 'x-kinesis-auth-attempt': transition } } : {}) });
        if (!eligible(request)) {
          challenges.delete(id);
          if (ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition });
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (challenge.attempt !== authAttempts.get(request.user.id)) {
          challenges.delete(id);
          if (ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition });
          return reply.code(409).send({ code: 'auth_required' });
        }
        if (result.status === 'connected') challenges.delete(id);
        if (result.status === 'connected') {
          const identity = transition ? finishAuthTransition(request.user.id, transition, result) : saveConnectionIdentity(request.user.id, result.identity_fingerprint);
          return { status: result.status, connection_generation: identity.generation, identity_changed: identity.changed };
        }
        return { status: result.status };
      } catch (error) {
        if (transition && ['connected', 'auth_failed'].includes(error.authEffect?.status) && eligible(request)) {
          try { finishAuthTransition(request.user.id, transition, error.authEffect); }
          catch { /* The persisted transition keeps the connection blocked. */ }
        }
        if (!eligible(request)) { challenges.delete(id); if (ownsAuthTransition(request.user.id, transition)) await cleanupRevokedConnection(request.user.id, CONNECTION, { expectedFence: transition }); }
        return reply.code(error.statusCode || 503).send({ code: safeCode(error), diagnostic_id: diagnosticIdFor(error, 'auth_finish') });
      }
      };
      let finishResult;
      try { finishResult = await executeMfaFinish(); }
      catch (error) { authInFlight.delete(request.user.id); throw error; }
      authInFlight.delete(request.user.id);
      return finishResult;
    });
    app.post('/api/garmin/auth/cancel', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const id = request.body?.challenge_id;
      const challenge = challenges.get(id);
      if (!challenge || challenge.owner !== request.user.id || challenge.session !== request.session.token
          || challenge.expires <= now() || challenge.generation !== connectionGeneration(request.user.id)) return reply.code(400).send({ code: 'auth_required' });
      challenges.delete(id);
      try {
        const result = await remote(request, '/auth/cancel', { method: 'POST', body: JSON.stringify({ challenge_id: id }) });
        if (!eligible(request)) { await cleanupRevokedConnection(request.user.id, CONNECTION); return reply.code(401).send({ code: 'auth_required' }); }
        return result;
      } catch (error) {
        if (!eligible(request)) await cleanupRevokedConnection(request.user.id, CONNECTION);
        return reply.code(error.statusCode || 503).send({ code: safeCode(error), diagnostic_id: diagnosticIdFor(error, 'auth_cancel') });
      }
    });
    app.delete('/api/garmin/connection', { preHandler: requireAuth }, async (request, reply) => {
      // Local cleanup must remain available after account deactivation.
      if (!validMode || (multiuser ? !eligible(request) : request.user.id !== pilotOwner)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (authTransitionPending(request.user.id)) return reply.code(503).send({ code: 'cleanup_pending' });
      const unresolved = db.prepare(`SELECT 1 FROM garmin_training_operations WHERE user_id = ?
        AND status IN ('publishing','workout_created','scheduling','outcome_unknown','reauth_required','failed') LIMIT 1`).get(request.user.id);
      if (unresolved) return reply.code(409).send({ code: 'operation_pending' });
      authAttempts.set(request.user.id, (authAttempts.get(request.user.id) || 0) + 1);
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      try {
        queueUserDisconnect(request.user.id, CONNECTION);
        const disconnected = await cleanupRevokedConnection(request.user.id, CONNECTION, { preserveIdentity: true });
        if (!eligible(request)) {
          if (!disconnected) await cleanupRevokedConnection(request.user.id, CONNECTION);
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (!disconnected) {
          const diagnosticId = crypto.randomBytes(16).toString('hex');
          console.warn('[kinesis-garmin]', JSON.stringify({ diagnostic_id: diagnosticId,
            stage: 'disconnect_cleanup', code: 'cleanup_pending', status: null }));
          return reply.code(503).send({ code: 'cleanup_pending', diagnostic_id: diagnosticId });
        }
        return { status: 'disconnected', connection_generation: connectionGeneration(request.user.id) };
      } catch (error) {
        if (!eligible(request)) await cleanupRevokedConnection(request.user.id, CONNECTION);
        return reply.code(error.statusCode || 503).send({ code: safeCode(error), diagnostic_id: diagnosticIdFor(error, 'disconnect') });
      }
    });
    app.get('/api/trainings/:id/garmin', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const saved = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
      let operation = db.prepare('SELECT operation_id, connection_generation, prescription_revision, status, stage, action, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id);
      if (operation?.status === 'scheduled' && (operation.scheduled_date !== training.dia || operation.prescription_revision !== saved?.revision)) {
        db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(operation.operation_id, request.user.id);
        operation = { ...operation, status: 'outdated' };
      }
      const value = saved ? JSON.parse(saved.prescription_json) : null;
      return { connection_generation: connectionGeneration(request.user.id), training_date: training.dia,
        prescription: saved ? { revision: saved.revision, value, fingerprint: saved.fingerprint, preview: previewPrescription(value) } : null,
        operation: operation || null };
    });
    app.put('/api/trainings/:id/garmin/prescription', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      if (training.completed === 1) return reply.code(409).send({ code: 'session_not_planned' });
      let prescription;
      try { prescription = validatePrescription(request.body?.prescription); }
      catch (error) { return reply.code(400).send({ code: 'invalid_prescription', diagnostic: error.diagnostic }); }
      const fingerprint = prescriptionFingerprint(prescription);
      const expectedRevision = request.body?.expected_revision;
      const expectedDate = request.body?.expected_training_date;
      if (!(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision > 0))
          || expectedDate !== training.dia || request.body?.expected_connection_generation !== connectionGeneration(request.user.id)) return reply.code(409).send({ code: 'session_changed' });
      const save = db.transaction(() => {
        const latest = current(request, training.id);
        if (!eligible(request) || !latest || latest.dia !== expectedDate || latest.completed === 1
            || connectionGeneration(request.user.id) !== request.body.expected_connection_generation) return null;
        const old = db.prepare('SELECT revision, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
        if ((old?.revision ?? null) !== expectedRevision) return null;
        const revision = old ? old.revision + (old.fingerprint === fingerprint ? 0 : 1) : 1;
        db.prepare(`INSERT INTO garmin_workout_prescriptions (user_id, training_id, revision, prescription_json, fingerprint)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, training_id) DO UPDATE SET revision = excluded.revision,
          prescription_json = excluded.prescription_json, fingerprint = excluded.fingerprint, updated_at = datetime('now')`).run(request.user.id, training.id, revision, JSON.stringify(prescription), fingerprint);
        if (old && old.fingerprint !== fingerprint) db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE user_id = ? AND training_id = ? AND status = 'scheduled'`).run(request.user.id, training.id);
        return { revision, generation: connectionGeneration(request.user.id) };
      });
      const savedResult = save();
      if (savedResult === null) return reply.code(409).send({ code: 'session_changed' });
      return { revision: savedResult.revision, fingerprint, preview: previewPrescription(prescription), date: training.dia,
        connection_generation: savedResult.generation };
    });
    app.post('/api/trainings/:id/garmin/publish', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (connectionCleanupPending(request.user.id)) return reply.code(503).send({ code: 'cleanup_pending' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      if (training.completed === 1) return reply.code(409).send({ code: 'session_not_planned' });
      const saved = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
      if (!saved) return reply.code(409).send({ code: 'prescription_required' });
      const expected = request.body?.fingerprint;
      const expectedDate = request.body?.expected_date;
      const expectedRevision = request.body?.expected_revision;
      const expectedGeneration = request.body?.expected_connection_generation;
      if (expected !== saved.fingerprint || expectedDate !== training.dia
          || expectedRevision !== saved.revision || expectedGeneration !== connectionGeneration(request.user.id)) {
        return reply.code(409).send({ code: 'session_changed' });
      }
      const action = request.body?.action || 'publish';
      if (!['publish', 'update', 'reschedule'].includes(action)) return reply.code(400).send({ code: 'invalid_payload' });
      const sourceOperationId = request.body?.source_operation_id || null;
      let sourceOperation = null;
      if (action !== 'publish') {
        if (typeof sourceOperationId !== 'string') return reply.code(409).send({ code: 'operation_required' });
        sourceOperation = db.prepare(`SELECT * FROM garmin_training_operations WHERE operation_id = ? AND user_id = ? AND training_id = ?`)
          .get(sourceOperationId, request.user.id, training.id);
        if (!sourceOperation || !sourceOperation.workout_id || !sourceOperation.occurrence_id
            || !['scheduled', 'outdated'].includes(sourceOperation.status)) return reply.code(409).send({ code: 'operation_required' });
        if (sourceOperation.connection_generation !== expectedGeneration) return reply.code(409).send({ code: 'connection_changed' });
        if (action === 'reschedule' && sourceOperation.prescription_revision !== saved.revision) {
          return reply.code(409).send({ code: 'prescription_changed' });
        }
      }
      const operationId = crypto.randomUUID();
      try { toConnectorPayload({ operationId, prescription: JSON.parse(saved.prescription_json) }); }
      catch (error) { return reply.code(422).send({ code: error.message === 'unsupported' ? 'unsupported' : 'invalid_prescription',
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }); }
      const generation = connectionGeneration(request.user.id);
      const write = db.transaction(() => {
        const latest = current(request, training.id);
        const latestPrescription = db.prepare('SELECT revision, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
        if (!eligible(request) || !latest || latest.completed === 1 || latest.dia !== expectedDate
            || latestPrescription?.revision !== expectedRevision || latestPrescription.fingerprint !== expected
            || connectionGeneration(request.user.id) !== expectedGeneration) return { stale: true };
        if (action !== 'publish') {
          const latestSource = db.prepare('SELECT status,connection_generation,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id = ? AND user_id = ? AND training_id = ?')
            .get(sourceOperationId, request.user.id, training.id);
          if (!latestSource || latestSource.connection_generation !== expectedGeneration
              || latestSource.workout_id !== sourceOperation.workout_id || latestSource.occurrence_id !== sourceOperation.occurrence_id
              || !['scheduled','outdated'].includes(latestSource.status)) return { stale: true };
        }
        const inserted = db.prepare(`INSERT OR IGNORE INTO garmin_training_operations
          (operation_id, user_id, training_id, connection_generation, prescription_revision, fingerprint, converter_version, status, stage, scheduled_date, action, source_operation_id, workout_id, occurrence_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?, ?, ?)`)
          .run(operationId, request.user.id, training.id, generation, saved.revision, saved.fingerprint,
          [2, 3].includes(JSON.parse(saved.prescription_json).version) ? JSON.parse(saved.prescription_json).version : 1,
            action === 'publish' ? 'publish' : action, training.dia, action, sourceOperationId,
            sourceOperation?.workout_id || null, sourceOperation?.occurrence_id || null);
        if (!inserted.changes) {
          const existing = db.prepare(`SELECT operation_id, status FROM garmin_training_operations
            WHERE user_id = ? AND training_id = ? AND connection_generation = ? AND prescription_revision = ? AND scheduled_date = ? AND action = ?
              AND source_operation_id IS ?`)
            .get(request.user.id, training.id, generation, saved.revision, training.dia, action,
              sourceOperationId);
          return { existing };
        }
        return { created: true };
      });
      const writeResult = write();
      if (writeResult.stale) return reply.code(409).send({ code: 'session_changed' });
      if (writeResult.existing) {
        return reply.code(202).send({ operation_id: writeResult.existing.operation_id, status: writeResult.existing.status, reused: true });
      }
      const operation = { operationId, ownerId: request.user.id, trainingId: training.id, generation,
        revision: saved.revision, fingerprint: saved.fingerprint, date: training.dia,
        prescription: JSON.parse(saved.prescription_json), action, sourceOperation,
        stage: action === 'publish' ? 'publish' : action,
        workoutId: sourceOperation?.workout_id || null,
        occurrenceId: sourceOperation?.occurrence_id || null };
      queueMicrotask(() => enqueueOperation(operation, current));
      return reply.code(202).send({ operation_id: operationId, status: 'publishing' });
    });
    app.get('/api/garmin/operations/:id', { preHandler: requireAuth }, async (request, reply) => {
      const row = db.prepare('SELECT operation_id, training_id, connection_generation, action, source_operation_id, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE operation_id = ? AND user_id = ?').get(request.params.id, request.user.id);
      if (!row) return reply.code(404).send({ code: 'not_found' });
      return { operation: row };
    });
    app.post('/api/garmin/operations/:id/reconcile', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (connectionCleanupPending(request.user.id)) return reply.code(503).send({ code: 'cleanup_pending' });
      const row = db.prepare(`SELECT * FROM garmin_training_operations WHERE operation_id = ? AND user_id = ?`).get(request.params.id, request.user.id);
      if (!row) return reply.code(404).send({ code: 'not_found' });
      if (!['outcome_unknown', 'reauth_required', 'failed', 'workout_created'].includes(row.status)) return reply.code(409).send({ code: 'invalid_state' });
      const training = current(request, row.training_id);
      const prescription = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, row.training_id);
      if (!training || training.completed === 1 || training.dia !== row.scheduled_date || !prescription
          || prescription.revision !== row.prescription_revision || prescription.fingerprint !== row.fingerprint
          || connectionGeneration(request.user.id) !== row.connection_generation) return reply.code(409).send({ code: 'session_changed' });
      db.prepare(`UPDATE garmin_training_operations SET status = 'publishing', error_code = NULL, updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(row.operation_id, request.user.id);
      queueMicrotask(() => enqueueOperation({
        operationId: row.operation_id, ownerId: row.user_id, trainingId: row.training_id,
        generation: row.connection_generation, revision: row.prescription_revision,
        fingerprint: row.fingerprint, date: row.scheduled_date,
        prescription: JSON.parse(prescription.prescription_json),
        // action and stage are NOT NULL database invariants; avoid disguising
        // a corrupt row as a publish fallback.
        action: row.action, stage: row.stage,
        workoutId: row.workout_id || null, occurrenceId: row.occurrence_id || null,
        sourceOperation: row.source_operation_id ? db.prepare('SELECT * FROM garmin_training_operations WHERE operation_id = ? AND user_id = ?').get(row.source_operation_id, request.user.id) : null,
      }, current));
      return reply.code(202).send({ operation_id: row.operation_id, status: 'publishing' });
    });
  }

  function connectionGeneration(userId) {
    return db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id = ?').get(userId)?.connection_generation || 1;
  }
  function connectionCleanupPending(userId) {
    const row = db.prepare('SELECT cleanup_pending,auth_attempt FROM garmin_pilot_connections WHERE user_id=?').get(userId);
    return Boolean(row?.cleanup_pending || row?.auth_attempt);
  }
  function bumpGeneration(userId) {
    db.prepare(`INSERT INTO garmin_pilot_connections (user_id, connection_generation) VALUES (?, 2)
      ON CONFLICT(user_id) DO UPDATE SET connection_generation = connection_generation + 1, updated_at = datetime('now')`).run(userId);
  }
  function saveConnectionIdentity(userId, fingerprint) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('unavailable');
    const tx = db.transaction(() => {
      const currentIdentity = db.prepare('SELECT identity_fingerprint FROM garmin_pilot_connections WHERE user_id = ?').get(userId)?.identity_fingerprint || null;
      const hasRemoteBindings = Boolean(db.prepare(`SELECT 1 FROM garmin_training_operations
        WHERE user_id = ? AND (workout_id IS NOT NULL OR occurrence_id IS NOT NULL) LIMIT 1`).get(userId));
      // A legacy/local connection without a stored identity cannot safely
      // inherit any remote artifact IDs. Force a new generation when bindings
      // exist; an ordinary same-account reauth with a fingerprint stays stable.
      const changed = Boolean((currentIdentity && currentIdentity !== fingerprint)
        || (!currentIdentity && hasRemoteBindings));
      if (changed) {
        bumpGeneration(userId);
        db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', stage = 'garmin_identity_changed', updated_at = datetime('now')
          WHERE user_id = ? AND status = 'scheduled'`).run(userId);
      }
      db.prepare(`INSERT INTO garmin_pilot_connections (user_id, connection_generation, identity_fingerprint)
        VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET identity_fingerprint = excluded.identity_fingerprint, updated_at = datetime('now')`)
        .run(userId, fingerprint);
      return { changed, generation: connectionGeneration(userId) };
    });
    return tx();
  }
  return { register };
}

function safeCode(error) {
  return ['auth_required', 'mfa_required', 'rate_limited', 'unavailable', 'unsupported', 'invalid_payload', 'outcome_unknown',
    'cleanup_pending',
    'connector_unavailable', 'connector_timeout', 'connector_auth_failed', 'connector_configuration_error',
    'connector_service_error', 'connector_invalid_response'].includes(error.message) ? error.message : 'unavailable';
}

function diagnosticIdFor(error, stage) {
  if (error?.diagnosticId) return error.diagnosticId;
  const diagnosticId = crypto.randomBytes(16).toString('hex');
  console.warn('[kinesis-garmin]', JSON.stringify({ diagnostic_id: diagnosticId, stage,
    code: 'connector_service_error', status: Number.isInteger(error?.statusCode) ? error.statusCode : null }));
  return diagnosticId;
}

function connectorTarget(target) {
  if (target.type === 'none') return { kind: 'none', pace: null, lowerBpm: null, upperBpm: null };
  if (target.type === 'pace') return { kind: 'pace', pace: paceBoundsMps(target), lowerBpm: null, upperBpm: null };
  if (target.type === 'heart_rate' && target.mode === 'absolute') {
    return { kind: 'heart_rate', pace: null, lowerBpm: target.lower_bpm, upperBpm: target.upper_bpm };
  }
  throw new Error('unsupported');
}

function toConnectorPayload(operation) {
  const valid = validatePrescription(operation.prescription);
  if (valid.version === 2 || valid.version === 3) {
    return { operation_id: operation.operationId, version: valid.version, name: valid.name,
      steps: structuredClone(valid.steps) };
  }
  const ordered = valid.steps;
  const warmups = ordered.filter((step) => step.kind === 'warmup');
  const cooldowns = ordered.filter((step) => step.kind === 'cooldown');
  const mains = ordered.filter((step) => ['run', 'repeat'].includes(step.kind));
  if (ordered.some((step) => !['warmup', 'cooldown', 'run', 'repeat'].includes(step.kind))
      || warmups.length > 1 || cooldowns.length > 1 || mains.length !== 1
      || (warmups.length && ordered[0] !== warmups[0])
      || (cooldowns.length && ordered[ordered.length - 1] !== cooldowns[0])
      || (ordered.length !== warmups.length + cooldowns.length + mains.length)) throw new Error('unsupported');
  let warmup = 0, intervalSeconds = null, intervalDistanceMeters = null;
  let recovery = 0, cooldown = 0, repetitions = 1, pace = null;
  let targetKind = 'none';
  let lowerBpm = null;
  let upperBpm = null;
  let recoveryTargetKind = 'none';
  let recoveryPace = null;
  let recoveryLowerBpm = null;
  let recoveryUpperBpm = null;
  const applyTarget = (target, recoveryTarget = false) => {
    const converted = connectorTarget(target);
    if (recoveryTarget) {
      recoveryTargetKind = converted.kind; recoveryPace = converted.pace;
      recoveryLowerBpm = converted.lowerBpm; recoveryUpperBpm = converted.upperBpm;
    } else {
      targetKind = converted.kind; pace = converted.pace;
      lowerBpm = converted.lowerBpm; upperBpm = converted.upperBpm;
    }
  };
  for (const step of ordered) {
    if (step.kind === 'warmup' && step.end.type === 'time' && step.end.value <= 3600 && step.target.type === 'none') warmup = step.end.value;
    else if (step.kind === 'cooldown' && step.end.type === 'time' && step.end.value <= 3600 && step.target.type === 'none') cooldown = step.end.value;
    else if (step.kind === 'repeat' && ['time', 'distance'].includes(step.interval.end.type)
      && step.recovery.end.type === 'time' && step.repetitions <= 20) {
      if (step.recovery.end.value > 3600) throw new Error('unsupported');
      if (step.interval.end.type === 'time') intervalSeconds = step.interval.end.value;
      else intervalDistanceMeters = step.interval.end.value;
      recovery = step.recovery.end.value; repetitions = step.repetitions;
      applyTarget(step.interval.target);
      applyTarget(step.recovery.target, true);
    } else if (step.kind === 'run' && ['time', 'distance'].includes(step.end.type)) {
      if (step.end.type === 'time') intervalSeconds = step.end.value;
      else intervalDistanceMeters = step.end.value;
      applyTarget(step.target);
    } else throw new Error('unsupported');
  }
  return { operation_id: operation.operationId, name: valid.name, warmup_seconds: warmup,
    interval_seconds: intervalSeconds, interval_distance_meters: intervalDistanceMeters,
    recovery_seconds: recovery, repetitions, cooldown_seconds: cooldown, target_kind: targetKind,
    target_lower_mps: pace?.lower_mps ?? null, target_upper_mps: pace?.upper_mps ?? null,
    target_lower_bpm: lowerBpm, target_upper_bpm: upperBpm,
    recovery_target_kind: recoveryTargetKind,
    recovery_target_lower_mps: recoveryPace?.lower_mps ?? null,
    recovery_target_upper_mps: recoveryPace?.upper_mps ?? null,
    recovery_target_lower_bpm: recoveryLowerBpm,
    recovery_target_upper_bpm: recoveryUpperBpm,
    skip_last_rest_step: ordered.find((step) => step.kind === 'repeat')?.skip_last_rest_step !== false };
}

function toConnectorUpdatePayload(operation, workoutId) {
  return { ...toConnectorPayload(operation), workout_id: Number(workoutId),
    source_operation_id: operation.sourceOperation.operation_id,
    source_scheduled_workout_id: Number(operation.sourceOperation.occurrence_id) };
}

function toConnectorReschedulePayload(operation, workoutId, occurrenceId) {
  return { operation_id: operation.operationId, source_operation_id: operation.sourceOperation.operation_id,
    scheduled_workout_id: Number(occurrenceId), workout_id: Number(workoutId), date: operation.date };
}

async function runOperation(db, fetchImpl, config, operation, currentTraining, options = {}) {
  const activeJobs = activeJobsFor(db);
  if (activeJobs.has(operation.operationId)) return;
  activeJobs.add(operation.operationId);
  const update = db.prepare(`UPDATE garmin_training_operations SET status = ?, stage = ?, workout_id = COALESCE(?, workout_id), occurrence_id = COALESCE(?, occurrence_id), error_code = ?, updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`);
  const base = config.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
  const root = `${base}/v1/connections/${operation.ownerId}/${CONNECTION}`;
  const headers = { 'content-type': 'application/json', 'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN || '' };
  const controller = new AbortController();
  options.controllers?.add(controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
  let workoutId = operation.workoutId ? String(operation.workoutId) : null;
  let occurrenceId = operation.occurrenceId ? String(operation.occurrenceId) : null;
  let activeStage = operation.stage || (operation.action === 'publish' ? 'publish' : operation.action);
  const currentState = () => {
    const owner = db.prepare('SELECT is_active FROM users WHERE id = ?').get(operation.ownerId);
    if (!owner || owner.is_active !== 1) return 'owner_ineligible';
    const connection = db.prepare('SELECT connection_generation,cleanup_pending,auth_attempt FROM garmin_pilot_connections WHERE user_id = ?').get(operation.ownerId);
    if (connection?.cleanup_pending || connection?.auth_attempt || (connection?.connection_generation || 1) !== operation.generation) return 'connection_changed';
    const session = currentTraining({ user: { id: operation.ownerId } }, operation.trainingId);
    if (!session || session.completed !== 0 || session.dia !== operation.date) return 'session_changed';
    const revision = db.prepare('SELECT revision, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(operation.ownerId, operation.trainingId);
    if (revision?.revision !== operation.revision || revision.fingerprint !== operation.fingerprint) return 'prescription_changed';
    return 'current';
  };
  const invalidate = async (reason, remoteMayHaveChanged) => {
    const cleanupComplete = reason === 'owner_ineligible'
      ? await options.onOwnerIneligible?.() : undefined;
    update.run(remoteMayHaveChanged ? 'outcome_unknown' : 'outdated',
      reason === 'owner_ineligible' ? 'owner_revoked' : 'validation',
      workoutId || operation.workoutId || null, occurrenceId || operation.occurrenceId || null,
      reason === 'owner_ineligible' ? (cleanupComplete ? 'cleanup_complete' : 'cleanup_pending') : 'session_changed',
      operation.operationId, operation.ownerId);
  };
  const remoteRequest = async (path, init) => {
    if (options.shouldStop?.()) throw Object.assign(new Error('worker_stopping'), { beforeDispatch: true });
    return fetchImpl(`${root}${path}`, { ...init, headers, signal });
  };
  const readJson = async (response) => response.json().catch(() => ({}));
  const errorResult = (remoteCode, stage, workoutId, occurrenceId = null, remoteStatus = null) => {
    const code = remoteCode === 'service_auth_failed' ? 'connector_auth_failed'
      : remoteCode === 'service_configuration_error' ? 'connector_configuration_error' : remoteCode;
    if (remoteStatus !== null || ['outcome_unknown', 'connector_auth_failed', 'connector_configuration_error'].includes(code)) {
      const diagnosticId = crypto.randomBytes(16).toString('hex');
      console.warn('[kinesis-garmin]', JSON.stringify({ diagnostic_id: diagnosticId, stage, code, status: remoteStatus }));
    }
    const status = code === 'auth_required' ? 'reauth_required'
      : code === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
    update.run(status, stage, workoutId, occurrenceId, code, operation.operationId, operation.ownerId);
  };
  try {
    const before = currentState();
    if (before !== 'current') { await invalidate(before, false); return; }
    if (options.shouldStop?.()) { update.run('failed', 'worker_stopping', null, null, 'unavailable', operation.operationId, operation.ownerId); return; }
    const action = operation.action || 'publish';
    const source = operation.sourceOperation;
    const payload = toConnectorPayload(operation);
    let stage = operation.stage || (action === 'publish' ? 'publish' : action);
    if (action === 'update' && ['unknown', 'update_confirmation'].includes(stage)) stage = 'update';
    activeStage = stage;

    if (action === 'publish' && !workoutId) {
      const response = await remoteRequest('/workouts', { method: 'POST', body: JSON.stringify(payload) });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { workoutId = /^[0-9]+$/.test(String(body.workout_id || '')) ? String(body.workout_id) : null; await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'publish', null, null, response.status); return; }
      workoutId = String(body.workout_id || '');
      if (!/^[0-9]+$/.test(workoutId)) { errorResult('outcome_unknown', 'publish', null); return; }
      update.run('workout_created', 'schedule', workoutId, null, null, operation.operationId, operation.ownerId);
      stage = 'schedule';
    } else if (action === 'update' && stage === 'update') {
      if (!workoutId || !source?.workout_id || !source?.occurrence_id) {
        errorResult('outcome_unknown', 'update_reconciliation', workoutId, occurrenceId); return;
      }
      activeStage = 'update';
      update.run('publishing', activeStage, workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      const response = await remoteRequest(`/workouts/${encodeURIComponent(workoutId)}`, {
        method: 'PUT', body: JSON.stringify(toConnectorUpdatePayload(operation, workoutId)),
      });
      activeStage = 'update_confirmation';
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'update_confirmation', workoutId, occurrenceId, response.status); return; }
      if (String(body.workout_id) !== workoutId || !['updated', 'reconciled'].includes(body.status)) {
        errorResult('outcome_unknown', 'update_confirmation', workoutId, occurrenceId); return;
      }
      update.run('workout_created', 'schedule', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      stage = 'schedule';
      activeStage = stage;
    }

    if (action === 'reschedule') {
      if (!workoutId || !occurrenceId || !source?.operation_id) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      if (currentState() !== 'current') { await invalidate(currentState(), false); return; }
      activeStage = 'reschedule';
      update.run('scheduling', activeStage, workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      const response = await remoteRequest(`/workouts/schedule/${encodeURIComponent(occurrenceId)}`, {
        method: 'PUT', body: JSON.stringify(toConnectorReschedulePayload(operation, workoutId, occurrenceId)),
      });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'reschedule', workoutId, occurrenceId, response.status); return; }
      const returnedId = body.scheduled_workout_id;
      if (body.scheduled !== true || String(returnedId) !== String(occurrenceId)) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      update.run('scheduled', 'complete', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      return;
    }

    if (action === 'update' && source && source.scheduled_date !== operation.date) {
      if (!workoutId || !occurrenceId) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      if (currentState() !== 'current') { await invalidate(currentState(), true); return; }
      activeStage = 'reschedule';
      update.run('scheduling', activeStage, workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      const response = await remoteRequest(`/workouts/schedule/${encodeURIComponent(occurrenceId)}`, {
        method: 'PUT', body: JSON.stringify(toConnectorReschedulePayload(operation, workoutId, occurrenceId)),
      });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'reschedule', workoutId, occurrenceId, response.status); return; }
      if (body.scheduled !== true || String(body.scheduled_workout_id) !== String(occurrenceId)) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      update.run('scheduled', 'complete', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      return;
    }

    if (!workoutId) { errorResult('outcome_unknown', 'schedule_reconciliation', null); return; }
    if (occurrenceId && action === 'update') {
      if (currentState() !== 'current') { await invalidate(currentState(), true); return; }
      update.run('scheduled', 'complete', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      return;
    }
    if (currentState() !== 'current') { await invalidate(currentState(), true); return; }
    activeStage = 'schedule';
    update.run('scheduling', activeStage, workoutId, null, null, operation.operationId, operation.ownerId);
    const scheduleResponse = await remoteRequest('/workouts/schedule', { method: 'POST', body: JSON.stringify({
      operation_id: operation.operationId, workout_id: Number(workoutId), date: operation.date,
    }) });
    const scheduleBody = await readJson(scheduleResponse);
    const returnedOccurrence = scheduleBody.scheduled_workout_id;
    if ((typeof returnedOccurrence === 'number' && Number.isSafeInteger(returnedOccurrence) && returnedOccurrence > 0)
        || (typeof returnedOccurrence === 'string' && /^[0-9]+$/.test(returnedOccurrence))) {
      occurrenceId = String(returnedOccurrence);
    }
    const after = currentState();
    if (after !== 'current') { await invalidate(after, true); return; }
    if (!scheduleResponse.ok) { errorResult(scheduleBody?.detail?.code || 'unavailable', 'schedule', workoutId, null, scheduleResponse.status); return; }
    // IDs are normalized to strings before this point; a numeric ID branch
    // here is unreachable and could obscure malformed provider responses.
    if (scheduleBody.scheduled !== true || !(typeof occurrenceId === 'string' && /^[0-9]+$/.test(occurrenceId))) {
      errorResult('outcome_unknown', 'schedule_reconciliation', workoutId); return;
    }
    if (currentState() !== 'current') { await invalidate(currentState(), true); return; }
    update.run('scheduled', 'complete', workoutId, String(occurrenceId), null, operation.operationId, operation.ownerId);
  } catch (error) {
    const reason = currentState();
    const cleanupComplete = reason === 'owner_ineligible'
      ? await options.onOwnerIneligible?.() : undefined;
    const code = ['unsupported', 'invalid_prescription'].includes(error.message) ? error.message : 'outcome_unknown';
    const status = code === 'unsupported' ? 'failed' : 'outcome_unknown';
    if (code === 'outcome_unknown') console.warn('[kinesis-garmin]', JSON.stringify({
      diagnostic_id: crypto.randomBytes(16).toString('hex'), stage: activeStage || 'unknown', code, status: null,
    }));
    try { update.run(status, reason === 'owner_ineligible' ? 'owner_revoked' : error.beforeDispatch ? 'worker_stopping' : activeStage || 'unknown', workoutId || operation.workoutId || null, occurrenceId || operation.occurrenceId || null, reason === 'owner_ineligible' ? (cleanupComplete ? 'cleanup_complete' : 'cleanup_pending') : code, operation.operationId, operation.ownerId); } catch { /* restart recovery marks persisted in-flight work uncertain */ }
  } finally {
    options.controllers?.delete(controller);
    activeJobs.delete(operation.operationId);
  }
}

module.exports = { createGarminProduct, runOperation, safeCode, toConnectorPayload,
  toConnectorUpdatePayload, toConnectorReschedulePayload, connectorTarget };
