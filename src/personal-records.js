'use strict';

const { userToday } = require('./time-zone');
const { hash } = require('./ai/memory');
const DISTANCES = { '5k': 5, '10k': 10, '21k': 21.0975, '42k': 42.195 };

class RecordError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function migrateRecords(db) {
  const marker = '2026-11-personal-records-v1';
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker)) return;
    db.exec(`CREATE TABLE personal_records (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      distance TEXT NOT NULL CHECK(distance IN ('5k','10k','21k','42k')),
      time_seconds INTEGER NOT NULL CHECK(time_seconds > 0 AND time_seconds <= 604800),
      achieved_on TEXT,
      race_name TEXT,
      PRIMARY KEY(user_id,distance)
    );
    CREATE TABLE anamnesis_record_sources (
      user_id INTEGER PRIMARY KEY REFERENCES athlete_anamnesis(user_id) ON DELETE CASCADE,
      answer_json TEXT
    );
    INSERT INTO anamnesis_record_sources(user_id,answer_json)
      SELECT user_id,json_extract(answers_json,'$.race_results') FROM athlete_anamnesis;`);
    for (const { user_id } of db.prepare('SELECT user_id FROM athlete_anamnesis').all()) syncAnamnesisRecords(db, user_id);
    db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(marker);
  }).immediate();
}

function duration(value) {
  if (typeof value !== 'string' || !/^\d+(?::[0-5]\d){1,2}$/.test(value)) return null;
  return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

// Conservative measurement tolerance: the measured distance must reach the
// target and may exceed it by at most 2%. Always use the complete measured
// time, never extrapolate a shorter distance or scale an average pace.
function matches(actual, target) {
  return Number.isFinite(actual) && actual >= target && actual <= target * 1.02;
}

function readRecords(db, userId, includeDraftAnamnesis = true, includeSessions = true) {
  const today = userToday(db, userId);
  const manual = db.prepare('SELECT distance,time_seconds,achieved_on,race_name FROM personal_records WHERE user_id=? ORDER BY distance').all(userId);
  const source = db.prepare(`SELECT s.answer_json,a.status FROM anamnesis_record_sources s
    JOIN athlete_anamnesis a ON a.user_id=s.user_id WHERE s.user_id=?`).get(userId);
  const answer = source?.answer_json ? JSON.parse(source.answer_json) : null;
  const candidates = manual.map((row) => ({ ...row, year: row.achieved_on ? Number(row.achieved_on.slice(0, 4)) : null, origin: 'manual', training_id: null }));
  if (answer?.status === 'answered' && (includeDraftAnamnesis || source.status === 'completed')) {
    for (const race of answer.value) {
      if (Object.hasOwn(DISTANCES, race.distance)) candidates.push({
        distance: race.distance, time_seconds: race.time_seconds, achieved_on: null,
        year: race.year, race_name: null, origin: 'anamnesis', training_id: null,
      });
    }
  }
  const sessions = includeSessions ? db.prepare(`SELECT id,dia,fit_distance,fit_duration,fit_summary_json FROM trainings
    WHERE user_id=? AND result_data_source IN ('manual','fit_upload','garmin_connect') AND dia<=? ORDER BY dia,id`).all(userId, today) : [];
  for (const row of sessions) {
    let summary;
    try { summary = JSON.parse(row.fit_summary_json); } catch { continue; }
    if (summary?.activity?.sport && summary.activity.sport !== 'running') continue;
    const seconds = duration(row.fit_duration);
    for (const [distance, km] of Object.entries(DISTANCES)) {
      if (seconds >= 60 && seconds <= 604800 && matches(row.fit_distance, km)) candidates.push({
        distance, time_seconds: seconds, achieved_on: row.dia, year: Number(row.dia.slice(0, 4)),
        race_name: null, origin: 'session', training_id: row.id,
      });
    }
  }
  const records = Object.keys(DISTANCES).map((distance) => {
    const best = candidates.filter((row) => row.distance === distance)
      .sort((a, b) => a.time_seconds - b.time_seconds)[0];
    return { distance, distance_km: DISTANCES[distance], best: best || null,
      manual: manual.find((row) => row.distance === distance) || null };
  });
  return { records, today };
}

// Keep the athlete's original answer separate from the automatically derived
// answer, so deleting/correcting a source cannot preserve its own copied mark.
function captureAnamnesisRecords(db, userId, answer, previous) {
  const stored = db.prepare('SELECT answer_json FROM anamnesis_record_sources WHERE user_id=?').get(userId);
  if (stored && answer?.status === 'answered' && previous?.status === 'answered') {
    const original = stored.answer_json ? JSON.parse(stored.answer_json) : null;
    let races = [...answer.value];
    for (const distance of Object.keys(DISTANCES)) {
      const before = previous.value.filter((race) => race.distance === distance);
      const submitted = answer.value.filter((race) => race.distance === distance);
      if (JSON.stringify(before) === JSON.stringify(submitted)) {
        races = races.filter((race) => race.distance !== distance);
        if (original?.status === 'answered') races.push(...original.value.filter((race) => race.distance === distance));
      }
    }
    answer = { status: 'answered', value: races };
  }
  db.prepare(`INSERT INTO anamnesis_record_sources(user_id,answer_json) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET answer_json=excluded.answer_json`)
    .run(userId, answer === undefined ? null : JSON.stringify(answer));
}

function syncAnamnesisRecords(db, userId, now = new Date().toISOString()) {
  const row = db.prepare('SELECT answers_json FROM athlete_anamnesis WHERE user_id=?').get(userId);
  if (!row) return;
  const original = db.prepare('SELECT answer_json FROM anamnesis_record_sources WHERE user_id=?').get(userId);
  const answer = original?.answer_json ? JSON.parse(original.answer_json) : null;
  if (answer?.status !== 'answered') return;
  const answers = JSON.parse(row.answers_json);
  const races = answer.value.filter((race) => !Object.hasOwn(DISTANCES, race.distance)).map((race) => ({ ...race }));
  for (const record of readRecords(db, userId).records) {
    const best = record.best;
    if (!best) continue;
    // Missing record metadata must not erase an answer the athlete already gave.
    const previous = answers.race_results?.value?.find((race) => race.distance === record.distance);
    races.push({ distance: record.distance, distance_km: record.distance_km, time_seconds: best.time_seconds, year: best.year ?? previous?.year ?? null });
  }
  const order = (distance) => { const index = answer.value.findIndex((race) => race.distance === distance); return index < 0 ? answer.value.length : index; };
  races.sort((a, b) => order(a.distance) - order(b.distance));
  const next = { status: 'answered', value: races };
  if (JSON.stringify(answers.race_results) === JSON.stringify(next)) return;
  answers.race_results = next;
  db.prepare(`UPDATE athlete_anamnesis SET answers_json=?, revision=revision+1 WHERE user_id=?`)
    .run(JSON.stringify(answers), userId);
}

function validateRecord(body, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['time_seconds', 'achieved_on', 'race_name'].includes(key))) throw new RecordError('invalidRecord');
  if (!Number.isInteger(body.time_seconds) || body.time_seconds < 60 || body.time_seconds > 604800) throw new RecordError('invalidTime');
  const date = body.achieved_on ?? null;
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today || date < '1950-01-01')) throw new RecordError('invalidDate');
  const name = body.race_name ?? null;
  if (name !== null && (typeof name !== 'string' || name.length > 120)) throw new RecordError('invalidRaceName');
  return { time: body.time_seconds, date, name: name === null ? null : name.trim() || null };
}

function saveRecord(db, userId, distance, body) {
  if (!Object.hasOwn(DISTANCES, distance)) throw new RecordError('invalidDistance');
  const value = validateRecord(body, userToday(db, userId));
  return db.transaction(() => {
    db.prepare(`INSERT INTO personal_records(user_id,distance,time_seconds,achieved_on,race_name) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,distance) DO UPDATE SET time_seconds=excluded.time_seconds,
        achieved_on=excluded.achieved_on,race_name=excluded.race_name`).run(userId, distance, value.time, value.date, value.name);
    syncAnamnesisRecords(db, userId);
    return readRecords(db, userId);
  }).immediate();
}

function deleteRecord(db, userId, distance) {
  if (!Object.hasOwn(DISTANCES, distance)) throw new RecordError('invalidDistance');
  return db.transaction(() => {
    db.prepare('DELETE FROM personal_records WHERE user_id=? AND distance=?').run(userId, distance);
    syncAnamnesisRecords(db, userId);
    return readRecords(db, userId);
  }).immediate();
}

function recordsContext(db, userId) {
  const project = (selection) => selection.records.filter((row) => row.best).map((row) => ({
    distanceKm: row.distance_km, timeSeconds: row.best.time_seconds,
    achievedOn: row.best.achieved_on || 'not_informed', year: row.best.year,
    origin: row.best.origin,
  }));
  const records = project(readRecords(db, userId, false));
  const declared = project(readRecords(db, userId, false, false));
  return { records, version: hash(records), basisVersion: hash(declared) };
}

module.exports = { DISTANCES, RecordError, migrateRecords, readRecords, saveRecord, deleteRecord,
  captureAnamnesisRecords, syncAnamnesisRecords, recordsContext };
