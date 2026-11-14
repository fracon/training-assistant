'use strict';

// Athlete anamnesis (issue #80, PR 1): questionnaire domain, weight log,
// owner-scoped HTTP routes, the body_unit preference and the migration.
// Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase, migrateDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { saveProfile } = require('../src/ai/memory');
const {
  AnamnesisError,
  QUESTIONNAIRE_VERSION,
  RACE_DISTANCES,
  addWeight,
  completeAnamnesis,
  deleteAnamnesis,
  deleteWeight,
  exportAnamnesis,
  questionnaire,
  readAnamnesis,
  saveAnamnesis,
  updateWeight,
} = require('../src/anamnesis');

const NOW = '2026-11-13T12:00:00.000Z';
const YEAR = new Date().getUTCFullYear();

function setup() {
  const db = createDatabase({ filename: ':memory:' });
  const add = (email) => Number(db.prepare(
    "INSERT INTO users (email, password_hash, first_name, onboarding_status) VALUES (?, 'unused', 'Synthetic', 'active')",
  ).run(email).lastInsertRowid);
  return { db, owner: add('owner@example.test'), other: add('other@example.test') };
}

const COMPLETE_ANSWERS = {
  birth_year: { status: 'answered', value: YEAR - 35 },
  height_cm: { status: 'declined' },
  weight: { status: 'declined' },
  motivations: { status: 'answered', value: { options: ['weight_loss', 'health'] } },
  running_experience: { status: 'answered', value: 'two_to_5_years' },
  recent_consistency: { status: 'answered', value: 'regular' },
  runs_per_week: { status: 'answered', value: 3 },
  weekly_distance_km: { status: 'answered', value: 25.456 },
  longest_run_km: { status: 'unknown' },
  race_results: { status: 'answered', value: [] },
  strength_training: { status: 'answered', value: 'weekly_1' },
  other_activities: { status: 'answered', value: { answer: 'no' } },
  hr_device: { status: 'unknown' },
  current_pain: { status: 'answered', value: { answer: 'no' } },
  injuries_12_months: { status: 'unknown' },
  professional_restriction: { status: 'declined' },
  health_conditions: { status: 'answered', value: { answer: 'yes', details: '  synthetic condition  ' } },
};

function rejects(fn, status, code, extra) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AnamnesisError, error.stack);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (extra) assert.deepEqual(error.extra, extra);
    return true;
  });
}

function save(db, userId, answers, extra = {}) {
  const revision = readAnamnesis(db, userId).anamnesis.revision;
  return saveAnamnesis(db, userId, { answers, expected_revision: revision, ...extra }, NOW).anamnesis;
}

/* ── Questionnaire and answers ── */

test('a new account reads an empty, not-started questionnaire with every item missing', () => {
  const { db, owner } = setup();
  const data = readAnamnesis(db, owner);
  assert.equal(data.questionnaire.version, QUESTIONNAIRE_VERSION);
  assert.deepEqual(data.questionnaire.steps.map((step) => step.id), ['about', 'experience', 'routine', 'health']);
  assert.equal(data.anamnesis.status, 'not_started');
  assert.equal(data.anamnesis.revision, 0);
  assert.deepEqual(data.anamnesis.answers, {});
  assert.equal(data.anamnesis.missing.length, 17);
  assert.equal(data.anamnesis.sensitive_ai_consent, false);
  assert.deepEqual(data.weights, []);
  assert.deepEqual(data.experience, { value: '', version: 0 });
  assert.match(data.today, /^\d{4}-\d{2}-\d{2}$/);
  // Birth year bounds follow the account's civil year.
  const birth = questionnaire(2026).steps[0].items[0];
  assert.deepEqual([birth.min, birth.max], [1926, 2016]);
  assert.equal(RACE_DISTANCES['42k'], 42.195);
});

test('answers are canonicalized, drafts accumulate, and completion requires every item', () => {
  const { db, owner } = setup();
  const first = save(db, owner, { birth_year: COMPLETE_ANSWERS.birth_year });
  assert.equal(first.status, 'draft');
  assert.equal(first.revision, 1);
  assert.equal(first.created_at, NOW);
  rejects(() => completeAnamnesis(db, owner, { expected_revision: 1 }, NOW), 400, 'anamnesisIncomplete');
  const saved = save(db, owner, COMPLETE_ANSWERS);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.missing, []);
  assert.equal(saved.answers.weekly_distance_km.value, 25.46);
  assert.deepEqual(saved.answers.motivations.value, { options: ['health', 'weight_loss'] });
  assert.deepEqual(saved.answers.health_conditions.value, { answer: 'yes', details: 'synthetic condition' });
  const done = completeAnamnesis(db, owner, { expected_revision: 2 }, NOW).anamnesis;
  assert.equal(done.status, 'completed');
  assert.equal(done.completed_at, NOW);
  assert.equal(done.revision, 3);
  // A completed anamnesis cannot lose an answer and never silently returns to draft.
  rejects(() => saveAnamnesis(db, owner, { answers: { hr_device: null }, expected_revision: 3 }, NOW), 400, 'anamnesisIncomplete', { missing: ['hr_device'] });
  const edited = save(db, owner, { hr_device: { status: 'answered', value: 'chest_strap' } });
  assert.equal(edited.status, 'completed');
  assert.equal(edited.answers.hr_device.value, 'chest_strap');
  // A draft may clear an answer with null.
  const { db: db2, owner: owner2 } = setup();
  save(db2, owner2, { birth_year: COMPLETE_ANSWERS.birth_year });
  assert.deepEqual(save(db2, owner2, { birth_year: null }).answers, {});
});

test('runs per week of zero marks its follow-ups not applicable, and a positive count asks again', () => {
  const { db, owner } = setup();
  const zero = save(db, owner, { runs_per_week: { status: 'answered', value: 0 }, weekly_distance_km: { status: 'answered', value: 10 } });
  assert.deepEqual(zero.answers.weekly_distance_km, { status: 'not_applicable' });
  assert.deepEqual(zero.answers.longest_run_km, { status: 'not_applicable' });
  assert.equal(zero.missing.includes('weekly_distance_km'), false);
  const back = save(db, owner, { runs_per_week: { status: 'answered', value: 2 } });
  assert.equal(back.answers.weekly_distance_km, undefined);
  assert.equal(back.missing.includes('longest_run_km'), true);
  const unknown = save(db, owner, { runs_per_week: { status: 'unknown' }, longest_run_km: { status: 'answered', value: 12.345 } });
  assert.equal(unknown.answers.longest_run_km.value, 12.35);
});

test('every answer type validates status, value, bounds and stray fields', () => {
  const { db, owner } = setup();
  const bad = (answers, code, field) => rejects(
    () => saveAnamnesis(db, owner, { answers, expected_revision: 0 }, NOW), 400, code, field ? { field } : undefined,
  );
  bad({ birth_year: 'x' }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'answered', value: 1990, extra: 1 } }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'maybe' } }, 'invalidStatus', 'birth_year');
  bad({ birth_year: { status: 'unknown' } }, 'invalidStatus', 'birth_year');
  bad({ birth_year: { status: 'not_applicable' } }, 'invalidStatus', 'birth_year');
  bad({ birth_year: { status: 'declined', value: 1 } }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'answered', value: '1990' } }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'answered', value: Infinity } }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'answered', value: 1990.5 } }, 'invalidAnswer', 'birth_year');
  bad({ birth_year: { status: 'answered', value: YEAR - 5 } }, 'outOfRange', 'birth_year');
  bad({ birth_year: { status: 'answered', value: YEAR - 200 } }, 'outOfRange', 'birth_year');
  bad({ height_cm: { status: 'answered', value: 90 } }, 'outOfRange', 'height_cm');
  bad({ weight: { status: 'answered', value: 70 } }, 'invalidAnswer', 'weight');
  bad({ running_experience: { status: 'answered', value: 'forever' } }, 'invalidAnswer', 'running_experience');
  bad({ motivations: { status: 'answered', value: [] } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: 'health' } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: [] } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: ['health', 'health'] } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: ['fame'] } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: ['health'], other_text: 'x' } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: ['other'], other_text: 5 } } }, 'invalidAnswer', 'motivations');
  bad({ motivations: { status: 'answered', value: { options: ['other'], other_text: 'x'.repeat(121) } } }, 'textTooLong', 'motivations');
  bad({ current_pain: { status: 'answered', value: { answer: 'maybe' } } }, 'invalidAnswer', 'current_pain');
  bad({ current_pain: { status: 'answered', value: { answer: 'no', details: 'stale text' } } }, 'invalidAnswer', 'current_pain');
  bad({ current_pain: { status: 'answered', value: { answer: 'yes', details: 'x'.repeat(501) } } }, 'textTooLong', 'current_pain');
  bad({ current_pain: { status: 'unknown' } }, 'invalidStatus', 'current_pain');
  bad({ race_results: { status: 'answered', value: 'none' } }, 'invalidAnswer', 'race_results');
  bad({ race_results: { status: 'answered', value: Array(6).fill({ distance: '5k', time_seconds: 1500, year: 2024 }) } }, 'invalidAnswer', 'race_results');
  const race = (value) => {
    const { __code: code, ...rest } = typeof value === 'object' ? value : { value };
    bad({ race_results: { status: 'answered', value: [typeof value === 'object' ? rest : value] } }, ...(code || ['invalidAnswer', 'race_results']));
  };
  race({ distance: '5k', time_seconds: 1500, year: 2024, pace: 1 });
  race('5k');
  race({ distance: '3k', time_seconds: 1500, year: 2024 });
  race({ distance: 'other', distance_km: '15', time_seconds: 1500, year: 2024 });
  race({ distance: 'other', distance_km: 0.1, time_seconds: 1500, year: 2024, __code: ['outOfRange', 'race_results'] });
  race({ distance: '5k', distance_km: 5, time_seconds: 1500, year: 2024 });
  race({ distance: '5k', time_seconds: 1500.5, year: 2024 });
  race({ distance: '5k', time_seconds: 30, year: 2024, __code: ['outOfRange', 'race_results'] });
  race({ distance: '5k', time_seconds: 1500, year: '2024' });
  race({ distance: '5k', time_seconds: 1500, year: YEAR + 1, __code: ['outOfRange', 'race_results'] });
  // Accepted shapes.
  const ok = save(db, owner, {
    motivations: { status: 'answered', value: { options: ['other', 'race'], other_text: '  synthetic reason ' } },
    current_pain: { status: 'answered', value: { answer: 'no', details: null } },
    injuries_12_months: { status: 'answered', value: { answer: 'no', details: '' } },
    professional_restriction: { status: 'answered', value: { answer: 'yes', details: '   ' } },
    other_activities: { status: 'answered', value: { answer: 'yes' } },
    height_cm: { status: 'answered', value: 178.26 },
    race_results: { status: 'answered', value: [{ distance: 'other', distance_km: 15.12345, time_seconds: 4200, year: 2024 }, { distance: '42k', time_seconds: 14400, year: 2023 }] },
  });
  assert.deepEqual(ok.answers.motivations.value, { options: ['race', 'other'], other_text: 'synthetic reason' });
  assert.deepEqual(ok.answers.current_pain.value, { answer: 'no' });
  assert.deepEqual(ok.answers.professional_restriction.value, { answer: 'yes' });
  assert.equal(ok.answers.height_cm.value, 178.3);
  assert.deepEqual(ok.answers.race_results.value[0], { distance: 'other', distance_km: 15.123, time_seconds: 4200, year: 2024 });
  assert.equal(ok.answers.race_results.value[1].distance_km, 42.195);
});

test('request bodies, revisions and consent are validated, and consent keeps its first date', () => {
  const { db, owner } = setup();
  rejects(() => saveAnamnesis(db, owner, null, NOW), 400, 'invalidBody');
  rejects(() => saveAnamnesis(db, owner, [], NOW), 400, 'invalidBody');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 0, role: 'admin' }, NOW), 400, 'unknownField', { field: 'role' });
  rejects(() => saveAnamnesis(db, owner, { expected_revision: -1, answers: {} }, NOW), 400, 'invalidRevision');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: '0', answers: {} }, NOW), 400, 'invalidRevision');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 0 }, NOW), 400, 'noChanges');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 0, answers: [] }, NOW), 400, 'invalidBody');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 0, sensitive_ai_consent: 'yes' }, NOW), 400, 'invalidConsent');
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 0, answers: { shoe_size: null } }, NOW), 400, 'unknownField', { field: 'shoe_size' });
  rejects(() => saveAnamnesis(db, owner, { expected_revision: 1, answers: {} }, NOW), 409, 'anamnesisConflict');
  const granted = saveAnamnesis(db, owner, { expected_revision: 0, sensitive_ai_consent: true }, NOW).anamnesis;
  assert.equal(granted.sensitive_ai_consent, true);
  assert.equal(granted.sensitive_ai_consent_at, NOW);
  const kept = saveAnamnesis(db, owner, { expected_revision: 1, sensitive_ai_consent: true }, '2026-11-14T00:00:00.000Z').anamnesis;
  assert.equal(kept.sensitive_ai_consent_at, NOW);
  const untouched = saveAnamnesis(db, owner, { expected_revision: 2, answers: {} }, NOW).anamnesis;
  assert.equal(untouched.sensitive_ai_consent, true);
  const revoked = saveAnamnesis(db, owner, { expected_revision: 3, sensitive_ai_consent: false }, NOW).anamnesis;
  assert.equal(revoked.sensitive_ai_consent, false);
  assert.equal(revoked.sensitive_ai_consent_at, null);
  rejects(() => completeAnamnesis(db, owner, { expected_revision: 3 }, NOW), 409, 'anamnesisConflict');
  rejects(() => completeAnamnesis(db, owner, { expected_revision: 4, extra: 1 }, NOW), 400, 'unknownField');
  const { db: db2, owner: owner2 } = setup();
  rejects(() => completeAnamnesis(db2, owner2, { expected_revision: 0 }), 400, 'anamnesisIncomplete');
});

test('the weight answer is satisfied by the log, and a completed answer keeps one entry', () => {
  const { db, owner, other } = setup();
  save(db, owner, { ...COMPLETE_ANSWERS, weight: { status: 'answered' } });
  assert.deepEqual(readAnamnesis(db, owner).anamnesis.missing, ['weight']);
  const entry = addWeight(db, owner, { measured_on: '2026-01-10', weight_kg: 80.456 }, NOW).weight;
  assert.equal(entry.weight_kg, 80.46);
  assert.deepEqual(readAnamnesis(db, owner).anamnesis.missing, []);
  completeAnamnesis(db, owner, { expected_revision: 1 }, NOW);
  rejects(() => deleteWeight(db, owner, String(entry.id)), 409, 'weightRequired');
  const second = addWeight(db, owner, { measured_on: '2026-02-10', weight_kg: 79 }).weight;
  assert.deepEqual(deleteWeight(db, owner, entry.id), { id: entry.id });
  rejects(() => deleteWeight(db, owner, second.id), 409, 'weightRequired');
  // Another account can neither see nor change the entry.
  rejects(() => deleteWeight(db, other, second.id), 404, 'weightNotFound');
  rejects(() => updateWeight(db, other, second.id, { weight_kg: 70 }), 404, 'weightNotFound');
  assert.deepEqual(readAnamnesis(db, other).weights, []);
  // Switching the answer to "rather not say" releases the last entry.
  save(db, owner, { weight: { status: 'declined' } });
  deleteWeight(db, owner, second.id);
  assert.deepEqual(readAnamnesis(db, owner).weights, []);
  // A draft keeps no such guard, and an account without an anamnesis neither.
  const loose = addWeight(db, other, { measured_on: '2026-03-01', weight_kg: 60 }).weight;
  deleteWeight(db, other, loose.id);
  save(db, other, { weight: { status: 'answered' } });
  const draftEntry = addWeight(db, other, { measured_on: '2026-03-02', weight_kg: 61 }).weight;
  deleteWeight(db, other, draftEntry.id);
});

test('weight entries validate dates and values, one per day, and can be corrected', () => {
  const { db, owner } = setup();
  const today = readAnamnesis(db, owner).today;
  rejects(() => addWeight(db, owner, { measured_on: '2026-01-01', weight_kg: 70, note: 'x' }), 400, 'unknownField');
  rejects(() => addWeight(db, owner, { measured_on: 20260101, weight_kg: 70 }), 400, 'invalidWeightDate');
  rejects(() => addWeight(db, owner, { measured_on: '2026-1-1', weight_kg: 70 }), 400, 'invalidWeightDate');
  rejects(() => addWeight(db, owner, { measured_on: '2026-02-30', weight_kg: 70 }), 400, 'invalidWeightDate');
  rejects(() => addWeight(db, owner, { measured_on: '1899-12-31', weight_kg: 70 }), 400, 'weightDateOutOfRange');
  rejects(() => addWeight(db, owner, { measured_on: '2999-01-01', weight_kg: 70 }), 400, 'weightDateOutOfRange');
  rejects(() => addWeight(db, owner, { measured_on: today, weight_kg: '70' }), 400, 'invalidWeight');
  rejects(() => addWeight(db, owner, { measured_on: today, weight_kg: NaN }), 400, 'invalidWeight');
  rejects(() => addWeight(db, owner, { measured_on: today, weight_kg: 19.9 }), 400, 'weightOutOfRange');
  rejects(() => addWeight(db, owner, { measured_on: today, weight_kg: 400.1 }), 400, 'weightOutOfRange');
  const first = addWeight(db, owner, { measured_on: today, weight_kg: 70 }, NOW).weight;
  rejects(() => addWeight(db, owner, { measured_on: today, weight_kg: 71 }), 409, 'weightDateExists');
  const second = addWeight(db, owner, { measured_on: '2026-01-01', weight_kg: 72 }, NOW).weight;
  rejects(() => updateWeight(db, owner, 'abc', { weight_kg: 1 }), 400, 'invalidWeightId');
  rejects(() => updateWeight(db, owner, '0', { weight_kg: 1 }), 400, 'invalidWeightId');
  rejects(() => updateWeight(db, owner, undefined, { weight_kg: 1 }), 400, 'invalidWeightId');
  rejects(() => updateWeight(db, owner, first.id, {}), 400, 'noChanges');
  rejects(() => updateWeight(db, owner, first.id, { measured_on: '2026-01-01' }), 409, 'weightDateExists');
  rejects(() => updateWeight(db, owner, 9999, { weight_kg: 70 }), 404, 'weightNotFound');
  assert.equal(updateWeight(db, owner, first.id, { weight_kg: 69.5 }, NOW).weight.weight_kg, 69.5);
  assert.equal(updateWeight(db, owner, first.id, { measured_on: first.measured_on }).weight.measured_on, first.measured_on);
  const both = updateWeight(db, owner, second.id, { measured_on: '2026-01-02', weight_kg: 71 }).weight;
  assert.deepEqual([both.measured_on, both.weight_kg], ['2026-01-02', 71]);
  assert.deepEqual(readAnamnesis(db, owner).weights.map((entry) => entry.id), [first.id, second.id]);
  rejects(() => deleteWeight(db, owner, 'x'), 400, 'invalidWeightId');
  // The log is bounded.
  const insert = db.prepare('INSERT INTO body_weight_entries (user_id, measured_on, weight_kg, created_at, updated_at) VALUES (?, ?, 70, ?, ?)');
  const base = Date.UTC(1950, 0, 1);
  for (let index = 0; index < 998; index += 1)
    insert.run(owner, new Date(base + index * 86400000).toISOString().slice(0, 10), NOW, NOW);
  rejects(() => addWeight(db, owner, { measured_on: '2025-06-01', weight_kg: 70 }), 409, 'weightLimit');
});

test('experience notes reuse training memory, export is complete, and delete erases answers and weights', () => {
  const { db, owner, other } = setup();
  saveProfile(db, owner, { fields: { experience: 'Synthetic running notes' }, expected_version: 0 }, NOW);
  save(db, owner, { ...COMPLETE_ANSWERS }, { sensitive_ai_consent: true });
  addWeight(db, owner, { measured_on: '2026-01-01', weight_kg: 70 });
  addWeight(db, other, { measured_on: '2026-01-01', weight_kg: 90 });
  const data = readAnamnesis(db, owner);
  assert.deepEqual(data.experience, { value: 'Synthetic running notes', version: 1 });
  const exported = exportAnamnesis(db, owner, NOW);
  assert.equal(exported.exported_at, NOW);
  assert.equal(exported.running_experience_notes, 'Synthetic running notes');
  assert.deepEqual(exported.weights, [{ measured_on: '2026-01-01', weight_kg: 70 }]);
  assert.equal(exported.anamnesis.sensitive_ai_consent, true);
  assert.equal(exported.anamnesis.status, 'draft');
  assert.ok(exportAnamnesis(db, owner).exported_at);
  assert.deepEqual(deleteAnamnesis(db, owner), { deleted: { anamnesis: 1, weights: 1 } });
  const after = readAnamnesis(db, owner);
  assert.equal(after.anamnesis.status, 'not_started');
  assert.deepEqual(after.weights, []);
  assert.equal(after.experience.value, 'Synthetic running notes');
  assert.equal(readAnamnesis(db, other).weights.length, 1);
  assert.deepEqual(deleteAnamnesis(db, owner), { deleted: { anamnesis: 0, weights: 0 } });
  // Deleting the account cascades.
  save(db, other, { birth_year: COMPLETE_ANSWERS.birth_year });
  db.prepare('DELETE FROM users WHERE id = ?').run(other);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM athlete_anamnesis').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM body_weight_entries').get().n, 0);
});

/* ── Migration ── */

test('the migration adds body_unit to existing accounts and creates the tables idempotently', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('legacy@example.test', 'x')").run();
  // Simulate a database from before the migration.
  db.exec('DROP TABLE athlete_anamnesis; DROP TABLE body_weight_entries;');
  db.exec('ALTER TABLE users DROP COLUMN body_unit');
  db.prepare("DELETE FROM schema_migrations WHERE name = '2026-11-athlete-anamnesis-v1'").run();
  migrateDatabase(db);
  assert.equal(db.prepare('SELECT body_unit FROM users').get().body_unit, 'metric');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'athlete_anamnesis'").get());
  assert.throws(() => db.prepare("UPDATE users SET body_unit = 'stones'").run(), /CHECK/);
  // Re-running is a no-op; a missing marker with the column present only records it.
  migrateDatabase(db);
  db.prepare("DELETE FROM schema_migrations WHERE name = '2026-11-athlete-anamnesis-v1'").run();
  migrateDatabase(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '2026-11-athlete-anamnesis-v1'").get().n, 1);
});

/* ── HTTP ── */

async function serverSetup() {
  const data = setup();
  const app = await buildServer({ db: data.db, sessionCookieSecure: false });
  const cookie = (id) => `${SESSION_COOKIE_NAME}=${createSession(data.db, id).token}`;
  const call = (id, method, url, payload) => app.inject({ method, url, payload, headers: id ? { cookie: cookie(id) } : {} });
  return { ...data, app, call };
}

test('the anamnesis API is authenticated, owner-scoped, uncached and reports field errors', async () => {
  const { app, db, owner, other, call } = await serverSetup();
  for (const [method, url] of [['GET', '/api/anamnesis'], ['PUT', '/api/anamnesis'], ['POST', '/api/anamnesis/complete'], ['DELETE', '/api/anamnesis'], ['GET', '/api/anamnesis/export'], ['POST', '/api/body-weights'], ['PATCH', '/api/body-weights/1'], ['DELETE', '/api/body-weights/1']])
    assert.equal((await call(null, method, url, method === 'GET' || method === 'DELETE' ? undefined : {})).statusCode, 401, `${method} ${url}`);
  assert.equal((await call(null, 'GET', '/anamnesis.html')).headers.location, '/login.html');
  assert.equal((await call(owner, 'GET', '/anamnesis.html')).statusCode, 200);

  const read = await call(owner, 'GET', '/api/anamnesis');
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  const saved = await call(owner, 'PUT', '/api/anamnesis', { answers: COMPLETE_ANSWERS, expected_revision: 0 });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().anamnesis.revision, 1);
  const invalid = await call(owner, 'PUT', '/api/anamnesis', { answers: { birth_year: { status: 'answered', value: 1 } }, expected_revision: 1 });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'An answer is invalid.', errors: ['outOfRange'], field: 'birth_year' });
  const completed = await call(owner, 'POST', '/api/anamnesis/complete', { expected_revision: 1 });
  assert.equal(completed.json().anamnesis.status, 'completed');
  // Another account sees nothing of it.
  assert.equal((await call(other, 'GET', '/api/anamnesis')).json().anamnesis.status, 'not_started');

  const weight = await call(owner, 'POST', '/api/body-weights', { measured_on: '2026-01-01', weight_kg: 70 });
  assert.equal(weight.statusCode, 201);
  const id = weight.json().weight.id;
  assert.equal((await call(other, 'PATCH', `/api/body-weights/${id}`, { weight_kg: 50 })).statusCode, 404);
  assert.equal((await call(owner, 'PATCH', `/api/body-weights/${id}`, { weight_kg: 69 })).json().weight.weight_kg, 69);
  const exported = await call(owner, 'GET', '/api/anamnesis/export');
  assert.match(exported.headers['content-disposition'], /attachment; filename="kinesis-anamnesis\.json"/);
  assert.equal(exported.json().weights[0].weight_kg, 69);
  assert.equal((await call(owner, 'DELETE', `/api/body-weights/${id}`)).statusCode, 200);
  assert.deepEqual((await call(owner, 'DELETE', '/api/anamnesis')).json(), { deleted: { anamnesis: 1, weights: 0 } });

  // Unexpected failures stay 500 and are not reported as domain errors.
  db.exec('DROP TABLE body_weight_entries');
  assert.equal((await call(owner, 'GET', '/api/anamnesis')).statusCode, 500);
  await app.close();
});

test('the body_unit preference is optional, validated and returned with the session user', async () => {
  const { app, db, owner, call } = await serverSetup();
  const base = { first_day_of_week: 'Monday', distance_unit: 'km', temperature_unit: 'C' };
  const kept = await call(owner, 'PATCH', '/api/users/me/preferences', base);
  assert.equal(kept.statusCode, 200);
  assert.equal(kept.json().body_unit, 'metric');
  const changed = await call(owner, 'PATCH', '/api/users/me/preferences', { ...base, body_unit: 'IMPERIAL' });
  assert.equal(changed.json().body_unit, 'imperial');
  assert.equal(db.prepare('SELECT body_unit FROM users WHERE id = ?').get(owner).body_unit, 'imperial');
  assert.equal((await call(owner, 'PATCH', '/api/users/me/preferences', base)).json().body_unit, 'imperial');
  assert.equal((await call(owner, 'PATCH', '/api/users/me/preferences', { ...base, body_unit: 'stones' })).statusCode, 400);
  assert.equal((await call(owner, 'PATCH', '/api/users/me/preferences', { ...base, body_unit: 1 })).statusCode, 400);
  const me = await call(owner, 'GET', '/api/me');
  assert.equal(me.json().user.body_unit, 'imperial');
  await app.close();
});
