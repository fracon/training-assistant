'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { hash } = require('../src/ai/memory');
const weekly = require('../src/ai/weekly-workouts');
const { recordSuggestion, readSuggestion, detailsHash } = require('../src/ai/structure-suggestions');
const { migrateWorkoutStructureSuggestions } = require('../src/ai/schema');
const { prescriptionFingerprint } = require('../src/garmin-workout-contract');

const NONE = { type: 'none', lowerBpm: null, upperBpm: null, fasterSecondsPerKm: null, slowerSecondsPerKm: null };
const hr = (lowerBpm, upperBpm) => ({ ...NONE, type: 'heart_rate', lowerBpm, upperBpm });
function step(phase, overrides = {}) {
  const repeated = phase === 'main' && (overrides.repetitions || 1) > 1;
  return {
    phase, repetitions: 1, minutes: null, distanceMeters: null,
    instruction: 'Run with relaxed form.', effort: 'Controlled breathing.', rpe: null, target: NONE,
    paceSecondsPerKm: null, recoveryMinutes: repeated ? 1 : null, recoveryGuidance: repeated ? 'Jog easily.' : null,
    recoveryRpe: null, recoveryTarget: repeated ? NONE : null, ...overrides,
  };
}
const DATES = { monday: '2026-10-26', wednesday: '2026-10-28', friday: '2026-10-30' };
function session(weekday, prescription, sessionKind = 'easy') {
  return {
    date: DATES[weekday], weekday, period: '08_12', sessionKind, prescription, shoeId: null,
    location: 'Porto, Portugal', weather: '', notes: '', justification: 'Builds on the applied plan.', evidence: ['cycle:cycle'],
  };
}
const easy = (weekday) => session(weekday, [step('warmup', { minutes: 10 }), step('main', { minutes: 40, target: hr(130, 145) }), step('cooldown', { minutes: 10 })]);
// Valid weekly output that Garmin cannot represent (more than 20 repetitions).
const tooManyRepeats = (weekday) => session(weekday, [
  step('warmup', { minutes: 10 }), step('main', { repetitions: 21, minutes: 1 }), step('cooldown', { minutes: 10 }),
], 'intervals');

function seed() {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'owner@example.invalid','synthetic','user','en-US')").run();
  db.prepare("INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(2,'other@example.invalid','synthetic','user','en-US')").run();
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES('cycle',1,'Base','active')").run();
  return db;
}
const availabilityRows = ['monday', 'wednesday', 'friday'].map((day_key) => ({
  day_key, can_train: 1, available_periods: '["08_12"]', available_minutes: 240, location: 'Porto, Portugal', updated_at: '2026-10-24',
}));
function stageProposal(db, id, sessions) {
  const response = { schemaVersion: weekly.VERSION, weekStart: '2026-10-26', sessions };
  const context = {
    resource: { weekStart: '2026-10-26' }, availability: availabilityRows, shoes: [],
    sources: [{ type: 'cycle', id: 'cycle' }], weather: [], preferences: { temperature: 'C', language: 'en-US' },
  };
  db.prepare(
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,?,'workouts','x','v','prompt',?,'{}',?,'completed',1,0,'2026-10-24','2026-10-24')`,
  ).run(id, `key-${id}`, JSON.stringify(context), JSON.stringify({ adapterVersion: weekly.VERSION }));
  db.prepare('INSERT INTO weekly_workout_proposals(execution_id,user_id,week_start,created_at) VALUES(?,1,?,?)').run(id, '2026-10-26', '2026-10-24');
  const service = { get: (_user, executionId) => ({ id: executionId, purpose: 'workouts', state: 'completed', outdated: false, response }) };
  return () => weekly.applyWeeklyProposal(db, 1, id, { expected_response_hash: hash(response) }, service, () => '2026-10-25T10:00:00.000Z');
}
const materialized = (value) => weekly.materializePrescription(value, 'en-US').value;
const insertTraining = (db, value, extra = {}) => db.prepare(
  'INSERT INTO trainings(user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,completed,feedback_rpe) VALUES(?,?,?,?,?,?,?,?,?)',
).run(extra.userId || 1, 'cycle', value.date, value.period, 'Run', materialized(value).workout, materialized(value).details,
  extra.completed ? 1 : 0, extra.completed ? 3 : null).lastInsertRowid;
const suggestions = (db) => db.prepare('SELECT * FROM training_structure_suggestions ORDER BY id').all();

test('applying a weekly proposal binds each structure to its own session and generation inside the same transaction', () => {
  const db = seed();
  // Pre-existing planned duplicate with a saved prescription (conflict), and a
  // completed duplicate that must never receive a suggestion.
  const plannedDuplicate = insertTraining(db, easy('friday'));
  const savedPrescription = { version: 3, sport: 'running', name: 'Easy run', steps: [
    { id: 'run-1', kind: 'run', end: { type: 'time', value: 3600 }, target: { type: 'none' } },
  ] };
  db.prepare('INSERT INTO garmin_workout_prescriptions(user_id,training_id,revision,prescription_json,fingerprint) VALUES(1,?,1,?,?)')
    .run(plannedDuplicate, JSON.stringify(savedPrescription), prescriptionFingerprint(savedPrescription));
  const completed = session('wednesday', [step('warmup', { minutes: 5 }), step('main', { minutes: 30 }), step('cooldown', { minutes: 5 })]);
  insertTraining(db, completed, { completed: true });
  const sessions = [easy('monday'), tooManyRepeats('wednesday'), completed, easy('friday'), easy('monday')];
  const apply = stageProposal(db, 'week-1', sessions);
  const result = apply();
  assert.equal(result.added, 2);
  assert.equal(result.ignored, 3);
  assert.deepEqual(result.structures, { suggested: 3, incompatible: 1, conflicts: 1 });
  const rows = suggestions(db);
  assert.deepEqual(rows.map((row) => [row.training_id, row.session_index, row.compatibility, row.status]), [
    [result.addedIds[0], 0, 'ready', 'pending_review'],
    [result.addedIds[1], 1, 'incompatible', 'pending_review'],
    [plannedDuplicate, 3, 'ready', 'pending_review'],
  ]);
  const responseHash = hash({ schemaVersion: weekly.VERSION, weekStart: '2026-10-26', sessions });
  for (const row of rows) {
    assert.equal(row.execution_id, 'week-1');
    assert.equal(row.response_hash, responseHash);
    assert.equal(row.adapter_version, weekly.VERSION);
    assert.equal(row.converter_version, 1);
    assert.equal(row.created_at, '2026-10-25T10:00:00.000Z');
    const training = db.prepare('SELECT detalhes FROM trainings WHERE id=?').get(row.training_id);
    assert.equal(row.details_hash, detailsHash(training.detalhes));
  }
  assert.equal(rows[1].prescription_json, null);
  assert.equal(JSON.parse(rows[1].issues_json)[0].code, 'repetition_count_invalid');
  assert.deepEqual(JSON.parse(rows[0].prescription_json).steps[1].target, { type: 'heart_rate', mode: 'absolute', lower_bpm: 130, upper_bpm: 145 });
  // The canonical prescription of the duplicate is untouched.
  assert.equal(
    db.prepare('SELECT fingerprint FROM garmin_workout_prescriptions WHERE training_id=?').get(plannedDuplicate).fingerprint,
    prescriptionFingerprint(savedPrescription),
  );
  assert.equal(readSuggestion(db, 1, plannedDuplicate).conflict, true);
  // A session whose guidance was cleared reports the change instead of failing.
  db.prepare('UPDATE trainings SET detalhes=NULL WHERE id=?').run(result.addedIds[1]);
  assert.equal(readSuggestion(db, 1, result.addedIds[1]).details_changed, true);
  // Idempotent replay neither adds nor rebinds anything.
  assert.equal(apply().alreadyApplied, true);
  assert.equal(suggestions(db).length, 3);

  // A later generation that duplicates a session supersedes its pending
  // suggestion instead of overwriting it.
  const second = stageProposal(db, 'week-2', [easy('monday')])();
  assert.deepEqual(second.structures, { suggested: 1, incompatible: 0, conflicts: 1 });
  const after = suggestions(db);
  assert.equal(after[0].status, 'superseded');
  assert.equal(after[0].revision, 2);
  assert.deepEqual([after[3].training_id, after[3].execution_id, after[3].status], [result.addedIds[0], 'week-2', 'pending_review']);
  db.close();
});

test('an ambiguous duplicate is never bound by title or position', () => {
  const db = seed();
  insertTraining(db, easy('monday'));
  insertTraining(db, easy('monday'));
  const result = stageProposal(db, 'week-ambiguous', [easy('monday')])();
  assert.equal(result.ignored, 1);
  assert.deepEqual(result.structures, { suggested: 0, incompatible: 0, conflicts: 0 });
  assert.equal(suggestions(db).length, 0);
  db.close();
});

test('the structure migration is idempotent, preserves prescriptions and keeps provenance after deletions', () => {
  const db = seed();
  const training = insertTraining(db, easy('monday'));
  const prescription = { version: 3, sport: 'running', name: 'Easy run', steps: [
    { id: 'run-1', kind: 'run', end: { type: 'time', value: 3600 }, target: { type: 'none' } },
  ] };
  db.prepare('INSERT INTO garmin_workout_prescriptions(user_id,training_id,revision,prescription_json,fingerprint) VALUES(1,?,4,?,?)')
    .run(training, JSON.stringify(prescription), prescriptionFingerprint(prescription));
  // Simulate a database from before the migration.
  db.exec('DROP TABLE training_structure_suggestions');
  db.exec('CREATE TABLE prescriptions_old AS SELECT user_id,training_id,revision,prescription_json,fingerprint,updated_at FROM garmin_workout_prescriptions');
  db.exec('DROP TABLE garmin_workout_prescriptions');
  db.exec(`CREATE TABLE garmin_workout_prescriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0), prescription_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, training_id))`);
  db.exec('INSERT INTO garmin_workout_prescriptions SELECT * FROM prescriptions_old; DROP TABLE prescriptions_old');
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-ai-workout-structure-v1'").run();
  migrateWorkoutStructureSuggestions(db);
  migrateWorkoutStructureSuggestions(db);
  const row = db.prepare('SELECT revision,fingerprint,source,suggestion_id FROM garmin_workout_prescriptions').get();
  assert.deepEqual(row, { revision: 4, fingerprint: prescriptionFingerprint(prescription), source: 'manual', suggestion_id: null });
  // Re-running after a partial state (marker removed, columns present) is safe.
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-ai-workout-structure-v1'").run();
  migrateWorkoutStructureSuggestions(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-11-ai-workout-structure-v1'").get().n, 1);
  assert.throws(() => db.prepare("UPDATE garmin_workout_prescriptions SET source='robot'").run(), /CHECK/);

  db.prepare(
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES('gone',1,'k','workouts','x','v','p','{}','{}','{}','completed',1,0,'t','t')`,
  ).run();
  const common = { userId: 1, trainingId: training, sessionIndex: 0, responseHash: 'h', version: weekly.VERSION, name: 'Easy run', details: 'd', now: 't' };
  recordSuggestion(db, { ...common, executionId: 'gone', session: easy('monday') });
  assert.throws(() => db.prepare(
    "INSERT INTO training_structure_suggestions(user_id,training_id,session_index,response_hash,adapter_version,converter_version,status,compatibility,prescription_json,fingerprint,issues_json,details_hash,created_at) VALUES(1,?,0,'h','v',1,'pending_review','ready',NULL,NULL,'[]','d','t')",
  ).run(training), /CHECK|UNIQUE/);
  db.prepare("DELETE FROM ai_executions WHERE id='gone'").run();
  assert.equal(suggestions(db)[0].execution_id, null, 'execution cleanup keeps the suggestion and its copied provenance');
  db.prepare('DELETE FROM trainings WHERE id=?').run(training);
  assert.equal(suggestions(db).length, 0, 'deleting the session cascades its suggestions');
  db.close();
});

async function harness({ config = {} } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const remoteCalls = [];
  const app = await buildServer({
    db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser', KINESIS_GARMIN_SERVICE_TOKEN: 'x'.repeat(40), GARMIN_CONNECTOR_URL: 'http://connector.invalid', ...config },
    garminFetch: async (url) => { remoteCalls.push(url); return Response.json({ status: 'disconnected' }); },
    garminNow: () => Date.parse('2026-10-25T11:00:00.000Z'),
  });
  const cookies = [];
  for (const email of ['suggest-owner@example.test', 'suggest-other@example.test']) {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'pilot-password', first_name: 'Runner', last_name: 'Test' } });
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pilot-password' } });
    cookies.push([].concat(response.headers['set-cookie'])[0].split(';')[0]);
  }
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES('cycle',1,'Base','active')").run();
  return { db, app, cookies, remoteCalls, close: async () => { await app.close(); db.close(); } };
}
const suggest = (db, trainingId, value, extra = {}) => recordSuggestion(db, {
  userId: 1, trainingId, executionId: null, sessionIndex: 0, responseHash: 'h', version: weekly.VERSION,
  session: value, name: materialized(value).workout, details: materialized(value).details, now: '2026-10-25T10:00:00.000Z', ...extra,
});

test('the editor read exposes the pending suggestion, and only an explicit save that names it accepts it', async () => {
  const { db, app, cookies, remoteCalls, close } = await harness();
  const [cookie, otherCookie] = cookies;
  const value = easy('monday');
  const trainingId = insertTraining(db, value);
  suggest(db, trainingId, value);
  const read = async (id = trainingId, who = cookie) => app.inject({ method: 'GET', url: `/api/trainings/${id}/garmin`, headers: { cookie: who } });
  let local = (await read()).json();
  assert.equal(local.prescription, null);
  const suggestion = local.suggestion;
  assert.equal(suggestion.compatibility, 'ready');
  assert.equal(suggestion.revision, 1);
  assert.equal(suggestion.value.name, 'Easy run');
  assert.equal(suggestion.preview.steps.length, 3);
  assert.deepEqual(suggestion.issues, []);
  assert.deepEqual(suggestion.origin, { execution_id: null, adapter_version: weekly.VERSION, converter_version: 1, created_at: '2026-10-25T10:00:00.000Z' });
  assert.equal(suggestion.details_changed, false);
  assert.equal(suggestion.conflict, false);
  assert.equal((await read(trainingId, otherCookie)).statusCode, 404, 'another account cannot read the suggestion');

  const put = (body, who = cookie) => app.inject({ method: 'PUT', url: `/api/trainings/${trainingId}/garmin/prescription`, headers: { cookie: who },
    payload: { expected_training_date: value.date, expected_connection_generation: 1, prescription: suggestion.value, ...body } });
  assert.equal((await put({ expected_revision: null, suggestion_id: suggestion.id })).statusCode, 400);
  assert.equal((await put({ expected_revision: null, expected_suggestion_revision: 1 })).statusCode, 400);
  for (const stale of [{ suggestion_id: suggestion.id, expected_suggestion_revision: 2 }, { suggestion_id: '1', expected_suggestion_revision: 1 },
    { suggestion_id: suggestion.id + 99, expected_suggestion_revision: 1 }]) {
    const response = await put({ expected_revision: null, ...stale });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'suggestion_changed');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM garmin_workout_prescriptions').get().n, 0, 'a refused acceptance writes nothing');
  // The user edited the structure before accepting it.
  const edited = structuredClone(suggestion.value);
  edited.steps[1].end.value = 2700;
  const accepted = await put({ expected_revision: null, suggestion_id: suggestion.id, expected_suggestion_revision: 1, prescription: edited });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().revision, 1);
  local = (await read()).json();
  assert.equal(local.suggestion, null);
  assert.equal(local.prescription.source, 'ai_suggestion');
  assert.equal(local.prescription.suggestion_id, suggestion.id);
  assert.notEqual(local.prescription.fingerprint, suggestion.fingerprint, 'edits before accepting stay visible by fingerprint');
  assert.deepEqual(db.prepare('SELECT status,revision,decided_at FROM training_structure_suggestions WHERE id=?').get(suggestion.id),
    { status: 'accepted', revision: 2, decided_at: '2026-10-25T11:00:00.000Z' });
  // Accepting twice is refused; a later plain save keeps the provenance.
  assert.equal((await put({ expected_revision: 1, suggestion_id: suggestion.id, expected_suggestion_revision: 2 })).json().code, 'suggestion_changed');
  assert.equal((await put({ expected_revision: 1 })).statusCode, 200);
  local = (await read()).json();
  assert.deepEqual([local.prescription.revision, local.prescription.source, local.prescription.suggestion_id], [2, 'ai_suggestion', suggestion.id]);

  // A new suggestion with a different structure is a conflict; the guidance
  // edit is reported; an identical structure is not a conflict.
  const changed = easy('monday');
  changed.prescription[1] = { ...changed.prescription[1], minutes: 50 };
  suggest(db, trainingId, changed);
  db.prepare('UPDATE trainings SET detalhes=? WHERE id=?').run('Edited by the athlete', trainingId);
  local = (await read()).json();
  assert.equal(local.suggestion.conflict, true);
  assert.equal(local.suggestion.details_changed, true);
  assert.equal(local.prescription.source, 'ai_suggestion', 'a pending suggestion never changes the canonical prescription');
  suggest(db, trainingId, value);
  const same = (await read()).json().suggestion;
  db.prepare('UPDATE training_structure_suggestions SET fingerprint=(SELECT fingerprint FROM garmin_workout_prescriptions WHERE training_id=?), prescription_json=(SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=?) WHERE id=?')
    .run(trainingId, trainingId, same.id);
  assert.equal((await read()).json().suggestion.conflict, false);

  // Manual saves on a session without suggestion stay manual.
  const manual = easy('wednesday');
  const manualId = insertTraining(db, manual);
  for (const expected of [null, 1]) {
    const response = await app.inject({ method: 'PUT', url: `/api/trainings/${manualId}/garmin/prescription`, headers: { cookie },
      payload: { expected_revision: expected, expected_training_date: manual.date, expected_connection_generation: 1, prescription: suggestion.value } });
    assert.equal(response.statusCode, 200);
  }
  local = (await read(manualId)).json();
  assert.deepEqual([local.prescription.source, local.prescription.suggestion_id, local.suggestion], ['manual', null, null]);

  // Completed sessions expose no suggestion.
  suggest(db, manualId, manual);
  db.prepare('UPDATE trainings SET completed=1, feedback_rpe=3 WHERE id=?').run(manualId);
  assert.equal((await read(manualId)).json().suggestion, null);
  assert.deepEqual(remoteCalls, [], 'reading, accepting and saving never reach the Garmin connector');
  await close();
});

test('dismissing a suggestion is explicit, optimistic and owner-scoped', async () => {
  const { db, app, cookies, remoteCalls, close } = await harness();
  const [cookie, otherCookie] = cookies;
  const value = tooManyRepeats('monday');
  const trainingId = insertTraining(db, value);
  suggest(db, trainingId, value);
  const suggestion = (await app.inject({ method: 'GET', url: `/api/trainings/${trainingId}/garmin`, headers: { cookie } })).json().suggestion;
  assert.equal(suggestion.compatibility, 'incompatible');
  assert.equal(suggestion.value, null);
  assert.equal(suggestion.preview, null);
  assert.equal(suggestion.issues[0].code, 'repetition_count_invalid');
  const dismiss = (payload, who = cookie, id = trainingId) =>
    app.inject({ method: 'POST', url: `/api/trainings/${id}/garmin/suggestion/dismiss`, headers: { cookie: who }, payload });
  for (const payload of [{}, { suggestion_id: suggestion.id }, { suggestion_id: suggestion.id, expected_revision: 1, extra: true },
    { suggestion_id: suggestion.id, revision: 1 }]) {
    const response = await dismiss(payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().code, 'invalid_payload');
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/trainings/${trainingId}/garmin/suggestion/dismiss`, headers: { cookie } })).statusCode, 400);
  assert.equal((await dismiss({ suggestion_id: suggestion.id, expected_revision: 1 }, otherCookie)).statusCode, 404);
  const otherTraining = insertTraining(db, easy('monday'), { userId: 2 });
  assert.equal((await dismiss({ suggestion_id: suggestion.id, expected_revision: 1 }, cookie, otherTraining)).statusCode, 404);
  assert.equal((await dismiss({ suggestion_id: suggestion.id, expected_revision: 2 })).json().code, 'suggestion_changed');
  const ok = await dismiss({ suggestion_id: suggestion.id, expected_revision: 1 });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { dismissed: true });
  assert.equal(db.prepare('SELECT status FROM training_structure_suggestions WHERE id=?').get(suggestion.id).status, 'dismissed');
  assert.equal((await dismiss({ suggestion_id: suggestion.id, expected_revision: 1 })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/trainings/${trainingId}/garmin`, headers: { cookie } })).json().suggestion, null);
  assert.deepEqual(remoteCalls, []);
  await close();

  const disabled = await harness({ config: { GARMIN_PILOT_ENABLED: 'false' } });
  const id = insertTraining(disabled.db, value);
  const response = await disabled.app.inject({ method: 'POST', url: `/api/trainings/${id}/garmin/suggestion/dismiss`,
    headers: { cookie: disabled.cookies[0] }, payload: { suggestion_id: 1, expected_revision: 1 } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, 'pilot_unavailable');
  await disabled.close();
});
