'use strict';

const crypto = require('node:crypto');
const { validatePrescription, prescriptionFingerprint, previewPrescription, paceBoundsMps } = require('../garmin-workout-contract');

const CONNECTION = 'pilot';
const activeJobsByDatabase = new WeakMap();
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
  let closing = false;
  const controllers = new Set();
  const connectionTails = new Map();
  const workerTasks = new Set();
  let cleanupTimer = null;

  function eligible(request) {
    const owner = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(request.user.id);
    if (config.GARMIN_PILOT_ENABLED !== 'true' || !pilotOwner || owner?.id !== pilotOwner || owner.is_active !== 1) return false;
    return true;
  }

  async function remote(request, path, options = {}) {
    const response = await fetchImpl(`${connector}/v1/connections/${pilotOwner}/${CONNECTION}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN || '',
        ...options.headers,
      },
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.detail?.code || 'unavailable');
      error.statusCode = response.status;
      throw error;
    }
    return body;
  }

  async function cleanupRevokedConnection() {
    const pending = db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get()?.pending;
    if (!pending) db.prepare(`UPDATE garmin_pilot_connections SET connection_generation=connection_generation+1,
      identity_fingerprint=NULL,cleanup_pending=1,updated_at=datetime('now') WHERE user_id=?`).run(pilotOwner);
    db.prepare(`INSERT INTO garmin_cleanup_state (id,pending) VALUES (1,1)
      ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=datetime('now')`).run();
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await fetchImpl(`${connector}/v1/connections/${pilotOwner}/${CONNECTION}`, {
        method: 'DELETE', headers: { 'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN || '' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (response.ok || response.status === 404) {
        db.prepare(`UPDATE garmin_cleanup_state SET pending=0,updated_at=datetime('now') WHERE id=1`).run();
        db.prepare(`UPDATE garmin_pilot_connections SET cleanup_pending=0,identity_fingerprint=NULL,updated_at=datetime('now') WHERE user_id=?`).run(pilotOwner);
        return true;
      }
    } catch { /* durable pending flag is retried by the local cleanup worker */ }
    finally { controllers.delete(controller); }
    return false;
  }

  async function retryPendingCleanup() {
    if (closing || !db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get()?.pending) return;
    await cleanupRevokedConnection();
  }

  function enqueueOperation(operation, current) {
    const key = `${operation.ownerId}:${CONNECTION}`;
    const previous = connectionTails.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runOperation(db, fetchImpl, config,
      operation, current, { shouldStop: () => closing, onOwnerIneligible: cleanupRevokedConnection, controllers }));
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
    cleanupTimer = setInterval(() => { void retryPendingCleanup(); }, 30000);
    cleanupTimer.unref?.();
    app.addHook('onClose', async () => {
      closing = true;
      clearInterval(cleanupTimer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...workerTasks]);
    });
    void retryPendingCleanup();
    app.get('/api/garmin/status', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      try {
        const result = await remote(request, '/status');
        if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
        const capabilities = result.status === 'connected' ? await remote(request, '/capabilities') : null;
        if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
        const trainingId = Number(request.query?.training_id);
        const training = Number.isInteger(trainingId) ? current(request, trainingId) : null;
        const sessionState = training ? db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id) : null;
      let operation = training ? db.prepare('SELECT operation_id, connection_generation, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id) : null;
        if (operation?.status === 'scheduled' && (operation.scheduled_date !== training.dia || operation.prescription_revision !== sessionState?.revision)) {
          db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(operation.operation_id, request.user.id);
          operation = { ...operation, status: 'outdated' };
        }
        const { identity_fingerprint: _privateIdentity, ...publicResult } = result;
        return { ...publicResult, connection_generation: connectionGeneration(request.user.id), pilot: true, devices: capabilities?.devices || [], running_catalog_status: capabilities?.running_catalog_status || 'unknown', prescription: sessionState ? { revision: sessionState.revision, value: JSON.parse(sessionState.prescription_json), fingerprint: sessionState.fingerprint } : null, operation: operation || null };
      } catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
    });
    app.post('/api/garmin/auth/start', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      if (authInFlight.has(request.user.id)) return reply.code(409).send({ code: 'auth_required' });
      const body = request.body || {};
      if (typeof body.email !== 'string' || body.email.length < 3 || body.email.length > 254 || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024) return reply.code(400).send({ code: 'invalid_payload' });
      const attempt = (authAttempts.get(request.user.id) || 0) + 1;
      authAttempts.set(request.user.id, attempt);
      authInFlight.set(request.user.id, true);
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      try {
        const result = await remote(request, '/auth/start', { method: 'POST', body: JSON.stringify(body) });
        if (authAttempts.get(request.user.id) !== attempt) {
          await cleanupRevokedConnection();
          return reply.code(409).send({ code: 'auth_required' });
        }
        if (!eligible(request)) {
          challenges.delete(result.challenge_id);
          await cleanupRevokedConnection();
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (result.status === 'mfa_required' && typeof result.challenge_id === 'string') challenges.set(result.challenge_id, { owner: request.user.id, session: request.session.token, expires: now() + Math.min(300000, result.expires_in * 1000), generation: connectionGeneration(request.user.id), attempt });
        if (result.status === 'connected') {
          const identity = saveConnectionIdentity(request.user.id, result.identity_fingerprint);
          return { status: 'connected', connection_generation: identity.generation, identity_changed: identity.changed };
        }
        return result.status === 'mfa_required' ? { status: result.status, challenge_id: result.challenge_id, expires_in: result.expires_in } : { status: result.status };
      } catch (error) {
        if (!eligible(request)) await cleanupRevokedConnection();
        return reply.code(error.statusCode || 503).send({ code: safeCode(error) });
      }
      finally {
        body.password = '';
        // The in-flight guard prevents another attempt from starting before
        // this finally block runs.
        authInFlight.delete(request.user.id);
      }
    });
    app.post('/api/garmin/auth/finish', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const { challenge_id: id, code } = request.body || {};
      const challenge = challenges.get(id);
      if (!challenge || challenge.owner !== request.user.id || challenge.session !== request.session.token || challenge.expires <= now() || challenge.generation !== connectionGeneration(request.user.id)) return reply.code(400).send({ code: 'auth_required' });
      if (typeof code !== 'string' || code.length > 32) return reply.code(400).send({ code: 'invalid_payload' });
      if (authInFlight.has(request.user.id)) return reply.code(409).send({ code: 'auth_required' });
      authInFlight.set(request.user.id, true);
      try {
        const result = await remote(request, '/auth/finish', { method: 'POST', body: JSON.stringify({ challenge_id: id, code }) });
        if (!eligible(request)) {
          challenges.delete(id);
          await cleanupRevokedConnection();
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (challenge.attempt !== authAttempts.get(request.user.id)) {
          challenges.delete(id);
          await cleanupRevokedConnection();
          return reply.code(409).send({ code: 'auth_required' });
        }
        if (result.status === 'connected') challenges.delete(id);
        if (result.status === 'connected') {
          const identity = saveConnectionIdentity(request.user.id, result.identity_fingerprint);
          return { status: result.status, connection_generation: identity.generation, identity_changed: identity.changed };
        }
        return { status: result.status };
      } catch (error) {
        if (!eligible(request)) { challenges.delete(id); await cleanupRevokedConnection(); }
        return reply.code(error.statusCode || 503).send({ code: safeCode(error) });
      } finally {
        authInFlight.delete(request.user.id);
      }
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
        if (!eligible(request)) { await cleanupRevokedConnection(); return reply.code(401).send({ code: 'auth_required' }); }
        return result;
      } catch (error) {
        if (!eligible(request)) await cleanupRevokedConnection();
        return reply.code(error.statusCode || 503).send({ code: safeCode(error) });
      }
    });
    app.delete('/api/garmin/connection', { preHandler: requireAuth }, async (request, reply) => {
      // Local cleanup must remain available after account deactivation.
      if (request.user.id !== pilotOwner) return reply.code(404).send({ code: 'pilot_unavailable' });
      authAttempts.set(request.user.id, (authAttempts.get(request.user.id) || 0) + 1);
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      db.prepare(`INSERT INTO garmin_pilot_connections (user_id, connection_generation,identity_fingerprint) VALUES (?, 2,NULL)
        ON CONFLICT(user_id) DO UPDATE SET connection_generation = connection_generation + 1, identity_fingerprint=NULL, updated_at = datetime('now')`).run(request.user.id);
      try {
        const result = await remote(request, '', { method: 'DELETE' });
        if (!eligible(request)) { await cleanupRevokedConnection(); return reply.code(401).send({ code: 'auth_required' }); }
        return result;
      } catch (error) {
        if (!eligible(request)) await cleanupRevokedConnection();
        return reply.code(error.statusCode || 503).send({ code: safeCode(error) });
      }
    });
    app.get('/api/trainings/:id/garmin', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const saved = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
      let operation = db.prepare('SELECT operation_id, connection_generation, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id);
      if (operation?.status === 'scheduled' && (operation.scheduled_date !== training.dia || operation.prescription_revision !== saved?.revision)) {
        db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(operation.operation_id, request.user.id);
        operation = { ...operation, status: 'outdated' };
      }
      return { connection_generation: connectionGeneration(request.user.id), prescription: saved ? { revision: saved.revision, value: JSON.parse(saved.prescription_json), fingerprint: saved.fingerprint } : null, operation: operation || null };
    });
    app.put('/api/trainings/:id/garmin/prescription', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      if (training.completed === 1) return reply.code(409).send({ code: 'session_not_planned' });
      let prescription;
      try { prescription = validatePrescription(request.body?.prescription); }
      catch { return reply.code(400).send({ code: 'invalid_prescription' }); }
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
      catch (error) { return reply.code(422).send({ code: error.message === 'unsupported' ? 'unsupported' : 'invalid_prescription' }); }
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
          VALUES (?, ?, ?, ?, ?, ?, 1, 'publishing', ?, ?, ?, ?, ?, ?)`)
          .run(operationId, request.user.id, training.id, generation, saved.revision, saved.fingerprint,
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
        action: row.action || 'publish', stage: row.stage,
        workoutId: row.workout_id || null, occurrenceId: row.occurrence_id || null,
        sourceOperation: row.source_operation_id ? db.prepare('SELECT * FROM garmin_training_operations WHERE operation_id = ? AND user_id = ?').get(row.source_operation_id, request.user.id) : null,
      }, current));
      return reply.code(202).send({ operation_id: row.operation_id, status: 'publishing' });
    });
  }

  function connectionGeneration(userId) {
    return db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id = ?').get(userId)?.connection_generation || 1;
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
  return ['auth_required', 'mfa_required', 'rate_limited', 'unavailable', 'unsupported', 'invalid_payload', 'outcome_unknown'].includes(error.message) ? error.message : 'unavailable';
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
  const currentState = () => {
    const owner = db.prepare('SELECT is_active FROM users WHERE id = ?').get(operation.ownerId);
    if (!owner || owner.is_active !== 1) return 'owner_ineligible';
    const generation = db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id = ?').get(operation.ownerId)?.connection_generation || 1;
    if (generation !== operation.generation) return 'connection_changed';
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
  const errorResult = (code, stage, workoutId, occurrenceId = null) => {
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

    if (action === 'publish' && !workoutId) {
      const response = await remoteRequest('/workouts', { method: 'POST', body: JSON.stringify(payload) });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { workoutId = /^[0-9]+$/.test(String(body.workout_id || '')) ? String(body.workout_id) : null; await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'publish', null); return; }
      workoutId = String(body.workout_id || '');
      if (!/^[0-9]+$/.test(workoutId)) { errorResult('outcome_unknown', 'publish', null); return; }
      update.run('workout_created', 'schedule', workoutId, null, null, operation.operationId, operation.ownerId);
      stage = 'schedule';
    } else if (action === 'update' && stage === 'update') {
      if (!workoutId || !source?.workout_id) { errorResult('outcome_unknown', 'update_reconciliation', workoutId); return; }
      const response = await remoteRequest(`/workouts/${encodeURIComponent(workoutId)}`, {
        method: 'PUT', body: JSON.stringify({ ...payload, workout_id: Number(workoutId) }),
      });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'update', workoutId, occurrenceId); return; }
      update.run('workout_created', 'schedule', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      stage = 'schedule';
    }

    if (action === 'reschedule') {
      if (!workoutId || !occurrenceId) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      if (currentState() !== 'current') { await invalidate(currentState(), false); return; }
      update.run('scheduling', 'reschedule', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      const response = await remoteRequest(`/workouts/schedule/${encodeURIComponent(occurrenceId)}`, {
        method: 'PUT', body: JSON.stringify({ operation_id: operation.operationId,
          scheduled_workout_id: Number(occurrenceId), workout_id: Number(workoutId), date: operation.date }),
      });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'reschedule', workoutId, occurrenceId); return; }
      const returnedId = body.scheduled_workout_id;
      if (body.scheduled !== true || String(returnedId) !== String(occurrenceId)) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      update.run('scheduled', 'complete', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      return;
    }

    if (action === 'update' && source && source.scheduled_date !== operation.date) {
      if (!workoutId || !occurrenceId) { errorResult('outcome_unknown', 'reschedule_reconciliation', workoutId, occurrenceId); return; }
      if (currentState() !== 'current') { await invalidate(currentState(), true); return; }
      update.run('scheduling', 'reschedule', workoutId, occurrenceId, null, operation.operationId, operation.ownerId);
      const response = await remoteRequest(`/workouts/schedule/${encodeURIComponent(occurrenceId)}`, {
        method: 'PUT', body: JSON.stringify({ operation_id: operation.operationId,
          scheduled_workout_id: Number(occurrenceId), workout_id: Number(workoutId), date: operation.date }),
      });
      const body = await readJson(response);
      const after = currentState();
      if (after !== 'current') { await invalidate(after, true); return; }
      if (!response.ok) { errorResult(body?.detail?.code || 'unavailable', 'reschedule', workoutId, occurrenceId); return; }
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
    update.run('scheduling', 'schedule', workoutId, null, null, operation.operationId, operation.ownerId);
    const scheduleResponse = await remoteRequest('/workouts/schedule', { method: 'POST', body: JSON.stringify({ workout_id: Number(workoutId), date: operation.date }) });
    const scheduleBody = await readJson(scheduleResponse);
    const after = currentState();
    if (after !== 'current') { await invalidate(after, true); return; }
    if (!scheduleResponse.ok) { errorResult(scheduleBody?.detail?.code || 'unavailable', 'schedule', workoutId); return; }
    occurrenceId = scheduleBody.scheduled_workout_id;
    if (scheduleBody.scheduled !== true || !((typeof occurrenceId === 'number' && Number.isSafeInteger(occurrenceId) && occurrenceId > 0) || (typeof occurrenceId === 'string' && /^[0-9]+$/.test(occurrenceId)))) {
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
    try { update.run(status, reason === 'owner_ineligible' ? 'owner_revoked' : error.beforeDispatch ? 'worker_stopping' : 'unknown', workoutId || operation.workoutId || null, occurrenceId || operation.occurrenceId || null, reason === 'owner_ineligible' ? (cleanupComplete ? 'cleanup_complete' : 'cleanup_pending') : code, operation.operationId, operation.ownerId); } catch { /* restart recovery marks persisted in-flight work uncertain */ }
  } finally {
    options.controllers?.delete(controller);
    activeJobs.delete(operation.operationId);
  }
}

module.exports = { createGarminProduct, runOperation, safeCode, toConnectorPayload, connectorTarget };
