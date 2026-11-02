'use strict';

const crypto = require('node:crypto');
const { FitUploadError, resolveFitBuffer } = require('../fitUpload');
const { normalizeCalories, formatDuration, formatPace } = require('../fitParser');
const { reconcileShoeMileage } = require('../shoeMileage');
const { SESSION_COOKIE_NAME, findActiveSession } = require('../auth/sessions');

const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS_PER_DB = 100;
const IMPORTER_VERSION = 1;
const previewsByDb = new WeakMap();

function resultFingerprint(row) {
  return crypto.createHash('sha256').update(JSON.stringify([
    row.dia, row.feedback_shoe_id,
    row.fit_duration, row.fit_distance, row.fit_avg_pace, row.fit_avg_hr,
    row.fit_max_hr, row.fit_elevation_gain, row.fit_calories,
    row.fit_summary_json, row.result_data_source, row.completed,
  ])).digest('hex');
}

function getCache(db) {
  if (!previewsByDb.has(db)) previewsByDb.set(db, new Map());
  return previewsByDb.get(db);
}

function activityId(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]{0,19}$/.test(raw)
    ? raw
    : Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
}

function activitySport(item) {
  const value = item?.activityType;
  if (typeof value === 'string' && value.trim()) return value.slice(0, 80);
  return 'unknown';
}

function isRunningOrUnknown(item) {
  const sport = activitySport(item).toLowerCase();
  return sport === 'unknown' || sport.includes('run');
}

function activityDateInWindow(item, start, end) {
  const date = typeof item?.startTimeLocal === 'string' ? item.startTimeLocal.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function createGarminActivityImporter({ db, fetchImpl = fetch, config = process.env,
  parseFile, resolveBuffer = resolveFitBuffer, resolveSession = findActiveSession, now = () => Date.now() }) {
  const ownerId = Number(config.GARMIN_PILOT_USER_ID);
  const connector = config.GARMIN_CONNECTOR_URL || 'http://127.0.0.1:8080';
  const caches = getCache(db);
  let remoteInFlight = false;

  function authorizationError(request) {
    const current = resolveSession(db, request.cookies?.[SESSION_COOKIE_NAME]);
    if (!current || current.token !== request.session?.token || current.userId !== request.user?.id) return 'session_expired';
    const row = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(request.user.id);
    if (config.GARMIN_PILOT_ENABLED !== 'true' || !Number.isSafeInteger(ownerId)
        || ownerId <= 0 || row?.id !== ownerId || row.is_active !== 1) return 'pilot_unavailable';
    return null;
  }

  function rejectUnauthorized(request, reply) {
    const code = authorizationError(request);
    if (!code) return null;
    return reply.code(code === 'session_expired' ? 401 : 404).send({ code });
  }

  function trainingFor(request) {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return db.prepare(`SELECT id,user_id,dia,completed,feedback_rpe,feedback_shoe_id,fit_duration,fit_distance,
      fit_avg_pace,fit_avg_hr,fit_max_hr,fit_elevation_gain,fit_calories,fit_summary_json,
      result_data_source FROM trainings WHERE id=? AND user_id=?`).get(id, request.user.id) || null;
  }

  function connection(request) {
    const row = db.prepare(`SELECT connection_generation,identity_fingerprint,cleanup_pending
      FROM garmin_pilot_connections WHERE user_id=?`).get(request.user.id);
    if (!row?.identity_fingerprint || row.cleanup_pending) return null;
    return row;
  }

  async function callConnector(request, path, { binary = false, method = 'GET', body } = {}) {
    if (remoteInFlight) throw Object.assign(new Error('connector_busy'), { statusCode: 409 });
    remoteInFlight = true;
    try { return await requestConnector(request, path, { binary, method, body }); }
    finally { remoteInFlight = false; }
  }

  async function requestConnector(request, path, { binary = false, method = 'GET', body } = {}) {
    const beforeRequest = authorizationError(request);
    if (beforeRequest) throw Object.assign(new Error(beforeRequest), { statusCode: beforeRequest === 'session_expired' ? 401 : 404 });
    let target;
    try { target = new URL(connector); }
    catch { throw Object.assign(new Error('connector_configuration_error'), { statusCode: 503 }); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
        || !config.KINESIS_GARMIN_SERVICE_TOKEN) throw Object.assign(new Error('connector_configuration_error'), { statusCode: 503 });
    let response;
    try {
      response = await fetchImpl(`${connector.replace(/\/+$/, '')}/v1/connections/${ownerId}/pilot${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { 'x-kinesis-service-key': config.KINESIS_GARMIN_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const afterFailure = authorizationError(request);
      if (afterFailure) throw Object.assign(new Error(afterFailure), { statusCode: afterFailure === 'session_expired' ? 401 : 404 });
      throw Object.assign(new Error(error?.name === 'TimeoutError' ? 'connector_timeout' : 'connector_unavailable'), { statusCode: 503 });
    }
    const afterResponse = authorizationError(request);
    if (afterResponse) throw Object.assign(new Error(afterResponse), { statusCode: afterResponse === 'session_expired' ? 401 : 404 });
    if (!response.ok) {
      let remoteCode = null;
      if (!binary) remoteCode = (await response.json().catch(() => null))?.detail?.code;
      const afterErrorBody = authorizationError(request);
      if (afterErrorBody) throw Object.assign(new Error(afterErrorBody), { statusCode: afterErrorBody === 'session_expired' ? 401 : 404 });
      const code = remoteCode === 'unavailable' ? 'connector_unavailable'
        : ['auth_required', 'rate_limited', 'invalid_payload'].includes(remoteCode)
          ? remoteCode : response.status === 429 ? 'rate_limited' : response.status === 401 ? 'auth_required' : 'connector_unavailable';
      throw Object.assign(new Error(code), { statusCode: response.status === 429 ? 429 : response.status === 401 ? 401 : 503 });
    }
    if (!binary) {
      let body;
      try {
        body = await response.json();
      }
      catch { throw Object.assign(new Error('connector_invalid_response'), { statusCode: 502 }); }
      const afterJson = authorizationError(request);
      if (afterJson) throw Object.assign(new Error(afterJson), { statusCode: afterJson === 'session_expired' ? 401 : 404 });
      return body;
    }
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(contentType)) throw Object.assign(new Error('invalid_payload'), { statusCode: 422 });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ORIGINAL_BYTES) throw Object.assign(new Error('invalid_payload'), { statusCode: 413 });
    const chunks = [];
    let received = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_ORIGINAL_BYTES) {
            await reader.cancel().catch(() => {});
            throw Object.assign(new Error('invalid_payload'), { statusCode: 413 });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock?.(); }
    } else {
      const value = Buffer.from(await response.arrayBuffer());
      received = value.length;
      if (received > MAX_ORIGINAL_BYTES) throw Object.assign(new Error('invalid_payload'), { statusCode: 413 });
      chunks.push(value);
    }
    const data = Buffer.concat(chunks, received);
    const afterDownload = authorizationError(request);
    if (afterDownload) throw Object.assign(new Error(afterDownload), { statusCode: afterDownload === 'session_expired' ? 401 : 404 });
    if (!data.length || data.length > MAX_ORIGINAL_BYTES || data[0] !== 0x50 || data[1] !== 0x4b) {
      throw Object.assign(new Error('invalid_payload'), { statusCode: 422 });
    }
    return data;
  }

  function register(app, requireAuth) {
    app.get('/api/trainings/:id/garmin/activities', { preHandler: requireAuth }, async (request, reply) => {
      const unauthorized = rejectUnauthorized(request, reply);
      if (unauthorized) return unauthorized;
      const training = trainingFor(request);
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const link = connection(request);
      if (!link) return reply.code(409).send({ code: 'connection_required' });
      const query = request.query;
      const offset = query.offset === undefined ? 0 : Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return reply.code(400).send({ code: 'invalid_payload' });
      const day = new Date(`${training.dia}T00:00:00Z`);
      if (Number.isNaN(day.valueOf())) return reply.code(409).send({ code: 'session_changed' });
      const start = new Date(day.valueOf() - 15 * 86400000).toISOString().slice(0, 10);
      const end = new Date(day.valueOf() + 15 * 86400000).toISOString().slice(0, 10);
      try {
        const response = await callConnector(request, '/activities', { method: 'POST', body: { start, end, offset, limit: 10 } });
        const authorization = rejectUnauthorized(request, reply);
        if (authorization) return authorization;
        const afterTraining = trainingFor(request);
        if (!afterTraining || afterTraining.dia !== training.dia) return reply.code(409).send({ code: 'session_changed' });
        const afterLink = connection(request);
        if (!afterLink || afterLink.connection_generation !== link.connection_generation
            || afterLink.identity_fingerprint !== link.identity_fingerprint) return reply.code(409).send({ code: 'connection_changed' });
        if (!Array.isArray(response?.items) || response.items.length > 10
            || !Number.isInteger(response.next_offset) || response.next_offset < offset
            || response.next_offset > 10000 || typeof response.has_more !== 'boolean'
            || (response.has_more && response.next_offset <= offset)) {
          throw Object.assign(new Error('connector_invalid_response'), { statusCode: 502 });
        }
        const items = response.items.map((item) => ({ item }))
          .filter(({ item }) => item && activityId(item.activityId)
            && Number.isInteger(item.source_cursor) && item.source_cursor >= offset && item.source_cursor < response.next_offset)
          .filter(({ item }) => activityDateInWindow(item, start, end))
          .filter(({ item }) => isRunningOrUnknown(item))
          .map(({ item }) => {
            const linked = db.prepare(`SELECT training_id FROM garmin_activity_imports
              WHERE account_fingerprint=? AND activity_id=?`).get(link.identity_fingerprint, String(item.activityId));
            const localDate = item.startTimeLocal.slice(0, 10);
            return { activity_id: String(item.activityId), source_cursor: item.source_cursor,
              name: typeof item.activityName === 'string' ? item.activityName.slice(0, 120) : '',
              start_time_local: item.startTimeLocal,
              sport: activitySport(item),
              duration_seconds: Number.isFinite(item.duration) ? item.duration : null,
              distance_m: Number.isFinite(item.distance) ? item.distance : null,
              approximate_pace_seconds_per_km: Number.isFinite(item.duration) && item.duration > 0
                && Number.isFinite(item.distance) && item.distance > 0
                ? Math.round(item.duration / (item.distance / 1000)) : null,
              average_hr: Number.isFinite(item.averageHR) ? item.averageHR : null,
              max_hr: Number.isFinite(item.maxHR) ? item.maxHR : null,
              calories: Number.isFinite(item.calories) ? item.calories : null,
              elevation_gain_m: Number.isFinite(item.elevationGain) ? item.elevationGain : null,
              linked_training_id: linked?.training_id || null,
              suggestion: localDate === training.dia ? 'same_local_date_requires_confirmation' : 'date_differs_requires_confirmation' };
          });
        return { items, window: { start, end }, offset, next_offset: response.next_offset,
          limit: 10, has_more: response.has_more, budget_exhausted: response.budget_exhausted === true };
      } catch (error) {
        const code = ['session_expired','pilot_unavailable','connector_busy','connector_configuration_error','connector_timeout','connector_unavailable',
          'connector_invalid_response','auth_required','rate_limited','invalid_payload'].includes(error.message)
          ? error.message : 'connector_unavailable';
        return reply.code(error.statusCode || 503).send({ code,
          ...(code === 'session_expired' ? {} : { diagnostic_id: crypto.randomBytes(12).toString('hex') }) });
      }
    });

    app.post('/api/trainings/:id/garmin/activity-preview', { preHandler: requireAuth }, async (request, reply) => {
      const unauthorized = rejectUnauthorized(request, reply);
      if (unauthorized) return unauthorized;
      const training = trainingFor(request);
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const expectedBefore = resultFingerprint(training);
      const link = connection(request);
      if (!link) return reply.code(409).send({ code: 'connection_required' });
      const id = activityId(request.body?.activity_id);
      if (!id) return reply.code(400).send({ code: 'invalid_payload' });
      const sourceCursor = request.body?.source_cursor;
      if (!Number.isInteger(sourceCursor) || sourceCursor < 0 || sourceCursor > 10000) return reply.code(400).send({ code: 'invalid_payload' });
      const day = new Date(`${training.dia}T00:00:00Z`);
      const allowedStart = new Date(day.valueOf() - 15 * 86400000).toISOString().slice(0, 10);
      const allowedEnd = new Date(day.valueOf() + 15 * 86400000).toISOString().slice(0, 10);
      let candidates;
      try {
        candidates = await callConnector(request, '/activities', { method: 'POST', body: {
          start: allowedStart, end: allowedEnd, offset: sourceCursor, limit: 10,
        } });
      } catch (error) {
        const code = ['session_expired','pilot_unavailable','connector_busy','connector_configuration_error','connector_timeout',
          'connector_unavailable','connector_invalid_response','auth_required','rate_limited','invalid_payload'].includes(error.message)
          ? error.message : 'connector_unavailable';
        return reply.code(error.statusCode || 503).send({ code,
          ...(code === 'session_expired' ? {} : { diagnostic_id: crypto.randomBytes(12).toString('hex') }) });
      }
      const authorizedAfterList = rejectUnauthorized(request, reply);
      if (authorizedAfterList) return authorizedAfterList;
      const afterListConnection = connection(request);
      if (!afterListConnection || afterListConnection.connection_generation !== link.connection_generation
          || afterListConnection.identity_fingerprint !== link.identity_fingerprint) return reply.code(409).send({ code: 'connection_changed' });
      const afterListTraining = trainingFor(request);
      if (!afterListTraining || afterListTraining.dia !== training.dia) return reply.code(409).send({ code: 'session_changed' });
      const candidate = Array.isArray(candidates?.items)
        ? candidates.items.find((item) => String(item?.activityId) === id && item?.source_cursor === sourceCursor
          && activityDateInWindow(item, allowedStart, allowedEnd)) : null;
      if (!candidate) return reply.code(404).send({ code: 'activity_not_found' });
      if (!isRunningOrUnknown(candidate)) return reply.code(422).send({ code: 'unsupported_activity' });
      const alreadyLinked = db.prepare(`SELECT training_id FROM garmin_activity_imports
        WHERE account_fingerprint=? AND activity_id=?`).get(link.identity_fingerprint, id);
      let buffer;
      let result;
      let parsing = false;
      try {
        buffer = await callConnector(request, `/activities/${encodeURIComponent(id)}/original`, { binary: true });
        const fitBuffer = await resolveBuffer({ buffer, filename: 'activity.zip' });
        parsing = true;
        result = await parseFile(fitBuffer);
      } catch (error) {
        const code = error instanceof FitUploadError ? error.code : error.message;
        const known = ['session_expired','pilot_unavailable','invalid_file','invalid_zip','unsafe_entry','encrypted_zip','too_many_entries','zip_too_large','fit_too_large','missing_fit','multiple_fit','unsupported_type','invalid_payload','auth_required','rate_limited','connector_timeout','connector_unavailable'].includes(code);
        const safeCode = known ? code : 'invalid_fit';
        const status = safeCode === 'session_expired' ? 401
          : safeCode === 'pilot_unavailable' ? 404
            : Number.isInteger(error.statusCode) ? error.statusCode : 422;
        return reply.code(status).send({ code: safeCode });
      }
      const authorizedAfterParsing = rejectUnauthorized(request, reply);
      if (authorizedAfterParsing) return authorizedAfterParsing;
      const latest = trainingFor(request);
      if (!latest || resultFingerprint(latest) !== expectedBefore
          || connection(request)?.connection_generation !== link.connection_generation) return reply.code(409).send({ code: 'session_changed' });
      if (result?.activity?.sport !== 'running' || !Array.isArray(result.laps) || !result.laps.length) return reply.code(422).send({ code: 'unsupported_activity' });
      const token = crypto.randomBytes(24).toString('base64url');
      const duration = result.totals?.durationSeconds > 0
        ? result.totals.durationLabel || formatDuration(result.totals.durationSeconds) : '0:00';
      const metrics = { fit_duration: duration, fit_distance: result.totals?.distanceKm ?? 0,
        fit_avg_pace: result.totals?.avgPaceSecondsPerKm == null ? null : result.totals.avgPaceLabel || formatPace(result.totals.avgPaceSecondsPerKm),
        fit_avg_hr: result.totals?.avgHeartRate ?? null, fit_max_hr: result.totals?.maxHeartRate ?? null,
        fit_elevation_gain: result.totals?.ascentMeters ?? null, fit_calories: normalizeCalories(result.totals?.calories) };
      const summary = JSON.stringify({ activity: result.activity, totals: { ...result.totals, calories: metrics.fit_calories }, laps: result.laps });
      const authorizedBeforePreview = rejectUnauthorized(request, reply);
      if (authorizedBeforePreview) return authorizedBeforePreview;
      caches.set(token, { userId: request.user.id, session: request.session.token, trainingId: training.id,
        activityId: id, identity: link.identity_fingerprint, generation: link.connection_generation,
        expected: resultFingerprint(latest), fileHash: crypto.createHash('sha256').update(buffer).digest('hex'),
        metrics, summary, laps: result.laps, createdAt: now(), linkedTrainingId: alreadyLinked?.training_id || null,
        activity: { activity_id: id, name: typeof candidate.activityName === 'string' ? candidate.activityName.slice(0, 120) : '',
          start_time_local: candidate.startTimeLocal,
          sport: activitySport(candidate) } });
      for (const [key, value] of caches) if (now() - value.createdAt > PREVIEW_TTL_MS) caches.delete(key);
      while (caches.size > MAX_PREVIEWS_PER_DB) caches.delete(caches.keys().next().value);
      return { preview_id: token, activity_id: id, metrics, laps: result.laps,
        replacing_result: latest.result_data_source !== 'none', linked_training_id: alreadyLinked?.training_id || null,
        activity: { activity_id: id, name: typeof candidate.activityName === 'string' ? candidate.activityName.slice(0, 120) : '',
          start_time_local: candidate.startTimeLocal,
          sport: activitySport(candidate) },
        feedback_pending: !(Number.isInteger(latest.feedback_rpe) && latest.feedback_rpe >= 1 && latest.feedback_rpe <= 5) };
    });

    app.post('/api/trainings/:id/garmin/activity-import', { preHandler: requireAuth }, async (request, reply) => {
      const unauthorized = rejectUnauthorized(request, reply);
      if (unauthorized) return unauthorized;
      const training = trainingFor(request);
      if (!training) return reply.code(404).send({ code: 'not_found' });
      const token = request.body?.preview_id;
      const preview = typeof token === 'string' ? caches.get(token) : null;
      if (!preview || preview.userId !== request.user.id || preview.session !== request.session.token
          || preview.trainingId !== training.id || now() - preview.createdAt > PREVIEW_TTL_MS) return reply.code(409).send({ code: 'preview_expired' });
      if (preview.linkedTrainingId && preview.linkedTrainingId !== training.id) return reply.code(409).send({ code: 'activity_already_linked' });
      const link = connection(request);
      const currentAuthorization = rejectUnauthorized(request, reply);
      if (currentAuthorization) return currentAuthorization;
      if (!link || link.identity_fingerprint !== preview.identity
          || link.connection_generation !== preview.generation) return reply.code(409).send({ code: 'connection_changed' });
      const confirmReplace = request.body?.confirm_replace === true;
      const tx = db.transaction(() => {
          const authorization = authorizationError(request);
          if (authorization) return { error: authorization };
          const current = trainingFor(request);
          const latestLink = db.prepare(`SELECT connection_generation,identity_fingerprint,cleanup_pending
            FROM garmin_pilot_connections WHERE user_id=?`).get(request.user.id);
          if (!current || current.user_id !== ownerId || !latestLink
              || latestLink.cleanup_pending || latestLink.identity_fingerprint !== preview.identity
              || latestLink.connection_generation !== preview.generation) return { error: 'session_changed' };
          if (resultFingerprint(current) !== preview.expected) return { error: 'session_changed' };
          if (current.result_data_source !== 'none' && !confirmReplace) return { error: 'confirm_replace' };
          const linked = db.prepare(`SELECT training_id,file_sha256,is_current FROM garmin_activity_imports
            WHERE account_fingerprint=? AND activity_id=?`).get(preview.identity, preview.activityId);
          if (linked && linked.training_id !== current.id) return { error: 'activity_already_linked' };
          if (linked && linked.training_id === current.id && linked.is_current === 1 && linked.file_sha256 === preview.fileHash
              && current.result_data_source === 'garmin_connect' && current.fit_summary_json === preview.summary) return { duplicate: true };
          const before = current;
          const metrics = preview.metrics;
          const completed = Number.isInteger(current.feedback_rpe) && current.feedback_rpe >= 1 && current.feedback_rpe <= 5
            ? current.completed : 0;
          db.prepare(`UPDATE trainings SET fit_duration=?,fit_distance=?,fit_avg_pace=?,fit_avg_hr=?,fit_max_hr=?,
            fit_elevation_gain=?,fit_calories=?,fit_summary_json=?,result_data_source='garmin_connect',completed=?
            WHERE id=? AND user_id=?`).run(metrics.fit_duration, metrics.fit_distance, metrics.fit_avg_pace,
            metrics.fit_avg_hr, metrics.fit_max_hr, metrics.fit_elevation_gain, metrics.fit_calories,
            preview.summary, completed, current.id, request.user.id);
          db.prepare(`UPDATE garmin_activity_imports SET is_current=0 WHERE user_id=? AND training_id=? AND is_current=1`)
            .run(request.user.id, current.id);
          db.prepare(`INSERT INTO garmin_activity_imports
            (user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
            VALUES(?,?,?,?,?,?,1) ON CONFLICT(account_fingerprint,activity_id) DO UPDATE SET
            training_id=excluded.training_id,file_sha256=excluded.file_sha256,importer_version=excluded.importer_version,
            is_current=1,imported_at=datetime('now')`).run(request.user.id, current.id, preview.identity, preview.activityId,
            preview.fileHash, IMPORTER_VERSION);
          reconcileShoeMileage(db, request.user.id, before, trainingFor(request));
          return { imported: true };
      });
      const result = tx.immediate();
      if (result.error) return reply.code(result.error === 'session_expired' ? 401 : 409).send({ code: result.error });
      if (result.duplicate) { caches.delete(token); return { imported: false, duplicate: true, training: trainingFor(request) }; }
      caches.delete(token);
      const importedTraining = trainingFor(request);
      importedTraining.garmin_activity = { activity_id: preview.activityId };
      return { imported: true, training: importedTraining, activity_id: preview.activityId,
        importer_version: IMPORTER_VERSION };
    });
  }

  return { register };
}

module.exports = { createGarminActivityImporter, resultFingerprint, activityId };
