'use strict';

const crypto = require('node:crypto');
const { validatePrescription, prescriptionFingerprint, previewPrescription } = require('../src/garmin-workout-contract');

const CONNECTION = 'pilot';
const activeJobs = new Set();

function createGarminProduct({ db, fetchImpl = fetch, config = process.env, now = () => Date.now() }) {
  const challenges = new Map();
  const connector = config.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
  const pilotOwner = Number(config.GARMIN_PILOT_USER_ID);

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

  function current(request, trainingId) {
    return db.prepare('SELECT id, dia, user_id, completed FROM trainings WHERE id = ? AND user_id = ?').get(trainingId, request.user.id);
  }

  function register(app, requireAuth) {
    db.prepare(`UPDATE garmin_training_operations SET status = 'outcome_unknown', stage = 'restart_reconciliation',
      error_code = 'outcome_unknown', updated_at = datetime('now') WHERE status IN ('publishing','scheduling')`).run();
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url.startsWith('/api/garmin/')) reply.header('cache-control', 'no-store');
      return payload;
    });
    app.get('/api/garmin/status', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      try {
        const result = await remote(request, '/status');
        const capabilities = result.status === 'connected' ? await remote(request, '/capabilities') : null;
        const trainingId = Number(request.query?.training_id);
        const training = Number.isInteger(trainingId) ? current(request, trainingId) : null;
        const sessionState = training ? db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id) : null;
        let operation = training ? db.prepare('SELECT operation_id, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id) : null;
        if (operation?.status === 'scheduled' && (operation.scheduled_date !== training.dia || operation.prescription_revision !== sessionState?.revision)) {
          db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(operation.operation_id, request.user.id);
          operation = { ...operation, status: 'outdated' };
        }
        return { ...result, pilot: true, devices: capabilities?.devices || [], running_catalog_status: capabilities?.running_catalog_status || 'unknown', prescription: sessionState ? { revision: sessionState.revision, value: JSON.parse(sessionState.prescription_json), fingerprint: sessionState.fingerprint } : null, operation: operation || null };
      } catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
    });
    app.post('/api/garmin/auth/start', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const body = request.body || {};
      if (typeof body.email !== 'string' || body.email.length < 3 || body.email.length > 254 || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024) return reply.code(400).send({ code: 'invalid_payload' });
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      bumpGeneration(request.user.id);
      try {
        const result = await remote(request, '/auth/start', { method: 'POST', body: JSON.stringify(body) });
        if (!eligible(request)) {
          challenges.delete(result.challenge_id);
          await remote(request, '', { method: 'DELETE' }).catch(() => {});
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (result.status === 'mfa_required' && typeof result.challenge_id === 'string') challenges.set(result.challenge_id, { owner: request.user.id, session: request.session.token, expires: now() + Math.min(300000, result.expires_in * 1000), generation: connectionGeneration(request.user.id) });
        return result.status === 'mfa_required' ? { status: result.status, challenge_id: result.challenge_id, expires_in: result.expires_in } : { status: result.status };
      } catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
      finally { body.password = ''; }
    });
    app.post('/api/garmin/auth/finish', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const { challenge_id: id, code } = request.body || {};
      const challenge = challenges.get(id);
      if (!challenge || challenge.owner !== request.user.id || challenge.session !== request.session.token || challenge.expires <= now() || challenge.generation !== connectionGeneration(request.user.id)) return reply.code(400).send({ code: 'auth_required' });
      if (typeof code !== 'string' || code.length > 32) return reply.code(400).send({ code: 'invalid_payload' });
      try {
        const result = await remote(request, '/auth/finish', { method: 'POST', body: JSON.stringify({ challenge_id: id, code }) });
        if (!eligible(request)) {
          challenges.delete(id);
          await remote(request, '', { method: 'DELETE' }).catch(() => {});
          return reply.code(401).send({ code: 'auth_required' });
        }
        if (result.status === 'connected') challenges.delete(id);
        return { status: result.status };
      } catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
    });
    app.post('/api/garmin/auth/cancel', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const id = request.body?.challenge_id;
      const challenge = challenges.get(id);
      if (!challenge || challenge.owner !== request.user.id || challenge.session !== request.session.token
          || challenge.expires <= now() || challenge.generation !== connectionGeneration(request.user.id)) return reply.code(400).send({ code: 'auth_required' });
      challenges.delete(id);
      try { return await remote(request, '/auth/cancel', { method: 'POST', body: JSON.stringify({ challenge_id: id }) }); }
      catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
    });
    app.delete('/api/garmin/connection', { preHandler: requireAuth }, async (request, reply) => {
      // Local cleanup must remain available after account deactivation.
      if (request.user.id !== pilotOwner) return reply.code(404).send({ code: 'pilot_unavailable' });
      challenges.forEach((challenge, id) => { if (challenge.owner === request.user.id) challenges.delete(id); });
      db.prepare(`INSERT INTO garmin_pilot_connections (user_id, connection_generation) VALUES (?, 2)
        ON CONFLICT(user_id) DO UPDATE SET connection_generation = connection_generation + 1, updated_at = datetime('now')`).run(request.user.id);
      try { return await remote(request, '', { method: 'DELETE' }); }
      catch (error) { return reply.code(error.statusCode || 503).send({ code: safeCode(error) }); }
    });
    app.get('/api/trainings/:id/garmin', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const saved = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
      let operation = db.prepare('SELECT operation_id, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE user_id = ? AND training_id = ? ORDER BY rowid DESC LIMIT 1').get(request.user.id, training.id);
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
      const save = db.transaction(() => {
        const latest = current(request, training.id);
        if (!latest || latest.dia !== training.dia) return null;
        const old = db.prepare('SELECT revision, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
        const revision = old ? old.revision + (old.fingerprint === fingerprint ? 0 : 1) : 1;
        db.prepare(`INSERT INTO garmin_workout_prescriptions (user_id, training_id, revision, prescription_json, fingerprint)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, training_id) DO UPDATE SET revision = excluded.revision,
          prescription_json = excluded.prescription_json, fingerprint = excluded.fingerprint, updated_at = datetime('now')`).run(request.user.id, training.id, revision, JSON.stringify(prescription), fingerprint);
        if (old && old.fingerprint !== fingerprint) db.prepare(`UPDATE garmin_training_operations SET status = 'outdated', updated_at = datetime('now') WHERE user_id = ? AND training_id = ? AND status = 'scheduled'`).run(request.user.id, training.id);
        return revision;
      });
      const revision = save();
      if (revision === null) return reply.code(409).send({ code: 'session_changed' });
      return { revision, fingerprint, preview: previewPrescription(prescription) };
    });
    app.post('/api/trainings/:id/garmin/publish', { preHandler: requireAuth }, async (request, reply) => {
      if (!eligible(request)) return reply.code(404).send({ code: 'pilot_unavailable' });
      const training = current(request, Number(request.params.id));
      if (!training) return reply.code(404).send({ code: 'not_found' });
      if (training.completed === 1) return reply.code(409).send({ code: 'session_not_planned' });
      const saved = db.prepare('SELECT revision, prescription_json, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(request.user.id, training.id);
      if (!saved) return reply.code(409).send({ code: 'prescription_required' });
      const expected = request.body?.fingerprint;
      if (expected !== saved.fingerprint) return reply.code(409).send({ code: 'session_changed' });
      const operationId = crypto.randomUUID();
      try { toConnectorPayload({ operationId, prescription: JSON.parse(saved.prescription_json) }); }
      catch (error) { return reply.code(422).send({ code: error.message === 'unsupported' ? 'unsupported' : 'invalid_prescription' }); }
      const generation = connectionGeneration(request.user.id);
      const inserted = db.prepare(`INSERT OR IGNORE INTO garmin_training_operations
        (operation_id, user_id, training_id, connection_generation, prescription_revision, fingerprint, converter_version, status, stage, scheduled_date)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'publishing', 'publish', ?)`)
        .run(operationId, request.user.id, training.id, generation, saved.revision, saved.fingerprint, training.dia);
      if (!inserted.changes) {
        const existing = db.prepare(`SELECT operation_id, status FROM garmin_training_operations
          WHERE user_id = ? AND training_id = ? AND connection_generation = ? AND prescription_revision = ?`).get(request.user.id, training.id, generation, saved.revision);
        return reply.code(202).send({ operation_id: existing.operation_id, status: existing.status, reused: true });
      }
      const operation = { operationId, ownerId: request.user.id, trainingId: training.id, generation, revision: saved.revision, fingerprint: saved.fingerprint, date: training.dia, prescription: JSON.parse(saved.prescription_json) };
      queueMicrotask(() => runOperation(db, fetchImpl, config, operation, current));
      return reply.code(202).send({ operation_id: operationId, status: 'publishing' });
    });
    app.get('/api/garmin/operations/:id', { preHandler: requireAuth }, async (request, reply) => {
      const row = db.prepare('SELECT operation_id, training_id, prescription_revision, status, stage, workout_id, occurrence_id, scheduled_date, error_code, updated_at FROM garmin_training_operations WHERE operation_id = ? AND user_id = ?').get(request.params.id, request.user.id);
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
      db.prepare(`UPDATE garmin_training_operations SET status = 'publishing', stage = 'explicit_reconciliation', error_code = NULL, updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`).run(row.operation_id, request.user.id);
      queueMicrotask(() => runOperation(db, fetchImpl, config, {
        operationId: row.operation_id, ownerId: row.user_id, trainingId: row.training_id,
        generation: row.connection_generation, revision: row.prescription_revision,
        fingerprint: row.fingerprint, date: row.scheduled_date,
        prescription: JSON.parse(prescription.prescription_json),
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
  return { register };
}

function safeCode(error) {
  return ['auth_required', 'mfa_required', 'rate_limited', 'unavailable', 'unsupported', 'invalid_payload', 'outcome_unknown'].includes(error.message) ? error.message : 'unavailable';
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
  const applyTarget = (target) => {
    if (target.type === 'none') return;
    if (target.type === 'pace') { targetKind = 'pace'; pace = require('../src/garmin-workout-contract').paceBoundsMps(target); return; }
    if (target.type === 'heart_rate' && target.mode === 'absolute') {
      targetKind = 'heart_rate'; lowerBpm = target.lower_bpm; upperBpm = target.upper_bpm; return;
    }
    throw new Error('unsupported');
  };
  for (const step of ordered) {
    if (step.kind === 'warmup' && step.end.type === 'time' && step.end.value <= 3600 && step.target.type === 'none') warmup = step.end.value;
    else if (step.kind === 'cooldown' && step.end.type === 'time' && step.end.value <= 3600 && step.target.type === 'none') cooldown = step.end.value;
    else if (step.kind === 'repeat' && ['time', 'distance'].includes(step.interval.end.type) && step.recovery.end.type === 'time'
      && step.recovery.target.type === 'none' && step.repetitions <= 20) {
      if (step.recovery.end.value > 3600) throw new Error('unsupported');
      if (step.interval.end.type === 'time') intervalSeconds = step.interval.end.value;
      else intervalDistanceMeters = step.interval.end.value;
      recovery = step.recovery.end.value; repetitions = step.repetitions;
      applyTarget(step.interval.target);
    } else if (step.kind === 'run' && ['time', 'distance'].includes(step.end.type)) {
      if (intervalSeconds !== null || intervalDistanceMeters !== null) throw new Error('unsupported');
      if (step.end.type === 'time') intervalSeconds = step.end.value;
      else intervalDistanceMeters = step.end.value;
      applyTarget(step.target);
    } else throw new Error('unsupported');
  }
  if ((intervalSeconds === null) === (intervalDistanceMeters === null)) throw new Error('unsupported');
  return { operation_id: operation.operationId, name: valid.name, warmup_seconds: warmup,
    interval_seconds: intervalSeconds, interval_distance_meters: intervalDistanceMeters,
    recovery_seconds: recovery, repetitions, cooldown_seconds: cooldown, target_kind: targetKind,
    target_lower_mps: pace?.lower_mps ?? null, target_upper_mps: pace?.upper_mps ?? null,
    target_lower_bpm: lowerBpm, target_upper_bpm: upperBpm };
}

async function runOperation(db, fetchImpl, config, operation, currentTraining) {
  if (activeJobs.has(operation.operationId)) return;
  activeJobs.add(operation.operationId);
      const update = db.prepare(`UPDATE garmin_training_operations SET status = ?, stage = ?, workout_id = COALESCE(?, workout_id), occurrence_id = COALESCE(?, occurrence_id), error_code = ?, updated_at = datetime('now') WHERE operation_id = ? AND user_id = ?`);
  const base = config.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
  const root = `${base}/v1/connections/${operation.ownerId}/${CONNECTION}`;
  const headers = { 'content-type': 'application/json', 'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN || '' };
  const stillCurrent = () => {
    const session = currentTraining({ user: { id: operation.ownerId } }, operation.trainingId);
    const revision = db.prepare('SELECT revision, fingerprint FROM garmin_workout_prescriptions WHERE user_id = ? AND training_id = ?').get(operation.ownerId, operation.trainingId);
    const generation = db.prepare('SELECT connection_generation FROM garmin_pilot_connections WHERE user_id = ?').get(operation.ownerId)?.connection_generation || 1;
    const owner = db.prepare('SELECT is_active FROM users WHERE id = ?').get(operation.ownerId);
    return Boolean(owner?.is_active === 1 && session && session.completed === 0 && session.dia === operation.date && revision?.revision === operation.revision && revision.fingerprint === operation.fingerprint && generation === operation.generation);
  };
  try {
    if (!stillCurrent()) { update.run('outdated', 'validation', null, null, 'session_changed', operation.operationId, operation.ownerId); return; }
    const payload = toConnectorPayload(operation);
    const response = await fetchImpl(`${root}/workouts`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = body?.detail?.code || 'unavailable';
      update.run(code === 'outcome_unknown' ? 'outcome_unknown' : code === 'auth_required' ? 'reauth_required' : 'failed', 'publish', null, null, code, operation.operationId, operation.ownerId);
      return;
    }
    const workoutId = String(body.workout_id || '');
    if (!/^[0-9]+$/.test(workoutId)) { update.run('outcome_unknown', 'publish', null, null, 'outcome_unknown', operation.operationId, operation.ownerId); return; }
    update.run('workout_created', 'schedule', workoutId, null, null, operation.operationId, operation.ownerId);
    if (!stillCurrent()) { update.run('outcome_unknown', 'post_publish_validation', workoutId, null, 'session_changed', operation.operationId, operation.ownerId); return; }
    update.run('scheduling', 'schedule', workoutId, null, null, operation.operationId, operation.ownerId);
    const scheduleResponse = await fetchImpl(`${root}/workouts/schedule`, { method: 'POST', headers, body: JSON.stringify({ workout_id: Number(workoutId), date: operation.date }), signal: AbortSignal.timeout(90000) });
    const scheduleBody = await scheduleResponse.json().catch(() => ({}));
    if (!scheduleResponse.ok) {
      const code = scheduleBody?.detail?.code || 'unavailable';
      update.run(code === 'outcome_unknown' ? 'outcome_unknown' : code === 'auth_required' ? 'reauth_required' : 'failed', 'schedule', workoutId, null, code, operation.operationId, operation.ownerId);
      return;
    }
    const occurrenceId = scheduleBody.scheduled_workout_id;
    if (scheduleBody.scheduled !== true || !((typeof occurrenceId === 'number' && Number.isSafeInteger(occurrenceId) && occurrenceId > 0) || (typeof occurrenceId === 'string' && /^[0-9]+$/.test(occurrenceId)))) {
      update.run('outcome_unknown', 'schedule_reconciliation', workoutId, null, 'outcome_unknown', operation.operationId, operation.ownerId);
      return;
    }
    if (!stillCurrent()) { update.run('outcome_unknown', 'post_schedule_validation', workoutId, String(occurrenceId), 'session_changed', operation.operationId, operation.ownerId); return; }
    update.run('scheduled', 'complete', workoutId, String(occurrenceId), null, operation.operationId, operation.ownerId);
  } catch (error) {
    const code = ['unsupported', 'invalid_prescription'].includes(error.message) ? error.message : 'outcome_unknown';
    update.run(code === 'unsupported' ? 'failed' : 'outcome_unknown', 'unknown', null, null, code, operation.operationId, operation.ownerId);
  } finally { activeJobs.delete(operation.operationId); }
}

module.exports = { createGarminProduct, runOperation, safeCode, toConnectorPayload };
