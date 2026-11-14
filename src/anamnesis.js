'use strict';

// Athlete anamnesis (issue #80, PR 1): a versioned, owner-scoped questionnaire
// plus a dated body-weight log. Nothing here calls AI or another service.
//
// Every questionnaire item stores an explicit status:
//   answered        a value (a negative answer is `answered` with "no")
//   unknown         "I don't know"
//   declined        "I'd rather not say"
//   not_applicable  set by the server only, for conditional follow-ups
// An absent item is simply not answered yet (draft). Nothing is pre-filled.
//
// The questionnaire deliberately does not ask again what Kinesis already owns:
// goals/races (cycles), availability (Request Workouts), units/language
// (preferences), name (account) and free-text experience (`ai_profiles`).

const { userToday } = require('./time-zone');
const { readMemory } = require('./ai/memory');

const QUESTIONNAIRE_VERSION = 'anamnesis-v1';
const STATUSES = ['answered', 'unknown', 'declined', 'not_applicable'];
const MAX_DETAILS = 500;
const MAX_OTHER_TEXT = 120;
const MAX_RACES = 5;
const MAX_WEIGHT_ENTRIES = 1000;
const RACE_DISTANCES = { '5k': 5, '10k': 10, '21k': 21.0975, '42k': 42.195 };

// The definition is the single source for validation and for the page, which
// renders it from `GET /api/anamnesis`. `sensitive` marks LGPD-sensitive items
// that may reach AI only with the separate consent (issue #80, PR 2).
function questionnaire(currentYear) {
  return {
    version: QUESTIONNAIRE_VERSION,
    steps: [
      {
        id: 'about',
        items: [
          { key: 'birth_year', type: 'integer', min: currentYear - 100, max: currentYear - 10, statuses: ['answered', 'declined'] },
          { key: 'height_cm', type: 'height', min: 100, max: 250, statuses: ['answered', 'declined'], sensitive: true },
          { key: 'weight', type: 'weight', statuses: ['answered', 'declined'], sensitive: true },
          { key: 'motivations', type: 'multi', options: ['health', 'weight_loss', 'performance', 'race', 'wellbeing', 'social', 'other'], statuses: ['answered'] },
        ],
      },
      {
        id: 'experience',
        items: [
          { key: 'running_experience', type: 'choice', options: ['never', 'under_6_months', 'six_to_24_months', 'two_to_5_years', 'over_5_years'], statuses: ['answered'] },
          { key: 'recent_consistency', type: 'choice', options: ['stopped', 'irregular', 'regular'], statuses: ['answered'] },
          { key: 'runs_per_week', type: 'integer', min: 0, max: 14, statuses: ['answered', 'unknown'] },
          { key: 'weekly_distance_km', type: 'distance', min: 0, max: 400, statuses: ['answered', 'unknown'], dependsOn: 'runs_per_week' },
          { key: 'longest_run_km', type: 'distance', min: 0, max: 100, statuses: ['answered', 'unknown'], dependsOn: 'runs_per_week' },
          { key: 'race_results', type: 'races', max: MAX_RACES, statuses: ['answered'] },
        ],
      },
      {
        id: 'routine',
        items: [
          { key: 'strength_training', type: 'choice', options: ['none', 'occasional', 'weekly_1', 'weekly_2_plus'], statuses: ['answered'] },
          { key: 'other_activities', type: 'yes_no', statuses: ['answered'] },
          { key: 'hr_device', type: 'choice', options: ['chest_strap', 'wrist_watch', 'none'], statuses: ['answered', 'unknown'] },
        ],
      },
      {
        id: 'health',
        sensitive: true,
        items: [
          { key: 'current_pain', type: 'yes_no', statuses: ['answered', 'declined'], sensitive: true },
          { key: 'injuries_12_months', type: 'yes_no', statuses: ['answered', 'unknown', 'declined'], sensitive: true },
          { key: 'professional_restriction', type: 'yes_no', statuses: ['answered', 'declined'], sensitive: true },
          { key: 'health_conditions', type: 'yes_no', statuses: ['answered', 'unknown', 'declined'], sensitive: true },
        ],
      },
    ],
  };
}

class AnamnesisError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AnamnesisError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function invalid(key, code = 'invalidAnswer') {
  return new AnamnesisError(400, code, 'An answer is invalid.', { field: key });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(body, allowed) {
  if (!isPlainObject(body)) throw new AnamnesisError(400, 'invalidBody', 'A JSON object is required.');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new AnamnesisError(400, 'unknownField', `Unsupported field: ${key}.`, { field: key });
  }
}

// Answer parts are reported against their question, never as a body error.
function answerShape(value, allowed, key) {
  if (!isPlainObject(value) || Object.keys(value).some((name) => !allowed.includes(name))) throw invalid(key);
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function boundedNumber(value, item, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(item.key);
  if (integer && !Number.isInteger(value)) throw invalid(item.key);
  if (value < item.min || value > item.max) throw invalid(item.key, 'outOfRange');
  return value;
}

function optionalText(value, key, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(key);
  const text = value.trim();
  if (text.length > max) throw invalid(key, 'textTooLong');
  return text || null;
}

function normalizeRace(race, key, currentYear) {
  answerShape(race, ['distance', 'distance_km', 'time_seconds', 'year'], key);
  if (race.distance !== 'other' && !Object.hasOwn(RACE_DISTANCES, race.distance)) throw invalid(key);
  let distanceKm = RACE_DISTANCES[race.distance];
  if (race.distance === 'other') {
    if (typeof race.distance_km !== 'number' || !Number.isFinite(race.distance_km)) throw invalid(key);
    if (race.distance_km < 0.4 || race.distance_km > 400) throw invalid(key, 'outOfRange');
    distanceKm = roundTo(race.distance_km, 3);
  } else if (race.distance_km !== undefined) {
    throw invalid(key);
  }
  if (!Number.isInteger(race.time_seconds)) throw invalid(key);
  if (race.time_seconds < 60 || race.time_seconds > 7 * 86400) throw invalid(key, 'outOfRange');
  if (!Number.isInteger(race.year)) throw invalid(key);
  if (race.year < 1950 || race.year > currentYear) throw invalid(key, 'outOfRange');
  return { distance: race.distance, distance_km: distanceKm, time_seconds: race.time_seconds, year: race.year };
}

// Validates one submitted answer against its item and returns the canonical
// stored form. `not_applicable` is never accepted from a client.
function normalizeAnswer(item, answer, currentYear) {
  answerShape(answer, ['status', 'value'], item.key);
  if (!STATUSES.includes(answer.status) || !item.statuses.includes(answer.status))
    throw invalid(item.key, 'invalidStatus');
  if (answer.status !== 'answered') {
    if (answer.value !== undefined) throw invalid(item.key);
    return { status: answer.status };
  }
  const value = answer.value;
  switch (item.type) {
    case 'integer':
      return { status: 'answered', value: boundedNumber(value, item, { integer: true }) };
    case 'height':
      return { status: 'answered', value: roundTo(boundedNumber(value, item), 1) };
    case 'distance':
      return { status: 'answered', value: roundTo(boundedNumber(value, item), 2) };
    case 'weight':
      // The value lives in the weight log; the item only records the choice.
      if (value !== undefined) throw invalid(item.key);
      return { status: 'answered' };
    case 'choice':
      if (!item.options.includes(value)) throw invalid(item.key);
      return { status: 'answered', value };
    case 'multi': {
      answerShape(value, ['options', 'other_text'], item.key);
      const options = value.options;
      if (!Array.isArray(options) || options.length === 0) throw invalid(item.key);
      if (new Set(options).size !== options.length || options.some((option) => !item.options.includes(option)))
        throw invalid(item.key);
      const ordered = item.options.filter((option) => options.includes(option));
      const otherText = optionalText(value.other_text, item.key, MAX_OTHER_TEXT);
      if (otherText && !ordered.includes('other')) throw invalid(item.key);
      return { status: 'answered', value: otherText ? { options: ordered, other_text: otherText } : { options: ordered } };
    }
    case 'yes_no': {
      answerShape(value, ['answer', 'details'], item.key);
      if (value.answer !== 'yes' && value.answer !== 'no') throw invalid(item.key);
      // A "no" never keeps details: an earlier "yes" text cannot linger hidden.
      if (value.answer === 'no') {
        if (value.details !== undefined && value.details !== null && value.details !== '') throw invalid(item.key);
        return { status: 'answered', value: { answer: 'no' } };
      }
      const details = optionalText(value.details, item.key, MAX_DETAILS);
      return { status: 'answered', value: details ? { answer: 'yes', details } : { answer: 'yes' } };
    }
    default: {
      // races
      if (!Array.isArray(value) || value.length > item.max) throw invalid(item.key);
      return { status: 'answered', value: value.map((race) => normalizeRace(race, item.key, currentYear)) };
    }
  }
}

function itemsOf(definition) {
  return definition.steps.flatMap((step) => step.items);
}

// Follow-ups of "runs per week" do not apply when the athlete runs zero times a
// week. Switching back to a positive count removes them, so they must be
// answered again instead of reappearing with a stale value.
function applyConditions(definition, answers) {
  const next = { ...answers };
  for (const item of itemsOf(definition)) {
    if (!item.dependsOn) continue;
    const parent = next[item.dependsOn];
    const notApplicable = parent?.status === 'answered' && parent.value === 0;
    if (notApplicable) next[item.key] = { status: 'not_applicable' };
    else if (next[item.key]?.status === 'not_applicable') delete next[item.key];
  }
  return next;
}

function weightCount(db, userId) {
  return db.prepare('SELECT COUNT(*) AS count FROM body_weight_entries WHERE user_id = ?').get(userId).count;
}

function missingItems(db, userId, definition, answers) {
  return itemsOf(definition)
    .filter((item) => {
      const answer = answers[item.key];
      if (!answer) return true;
      return item.type === 'weight' && answer.status === 'answered' && weightCount(db, userId) === 0;
    })
    .map((item) => item.key);
}

function currentYearOf(db, userId) {
  return Number(userToday(db, userId).slice(0, 4));
}

function readRow(db, userId) {
  return db.prepare('SELECT * FROM athlete_anamnesis WHERE user_id = ?').get(userId);
}

function publicWeights(db, userId) {
  return db
    .prepare(
      `SELECT id, measured_on, weight_kg, created_at, updated_at FROM body_weight_entries
        WHERE user_id = ? ORDER BY measured_on DESC, id DESC`,
    )
    .all(userId);
}

function publicAnamnesis(db, userId, definition, row) {
  const answers = row ? JSON.parse(row.answers_json) : {};
  return {
    status: row ? row.status : 'not_started',
    questionnaire_version: row ? row.questionnaire_version : QUESTIONNAIRE_VERSION,
    revision: row ? row.revision : 0,
    answers,
    missing: missingItems(db, userId, definition, answers),
    sensitive_ai_consent: Boolean(row?.sensitive_ai_consent),
    sensitive_ai_consent_at: row ? row.sensitive_ai_consent_at : null,
    created_at: row ? row.created_at : null,
    updated_at: row ? row.updated_at : null,
    completed_at: row ? row.completed_at : null,
  };
}

function readAnamnesis(db, userId) {
  const definition = questionnaire(currentYearOf(db, userId));
  const experience = readMemory(db, userId).profile;
  return {
    questionnaire: definition,
    anamnesis: publicAnamnesis(db, userId, definition, readRow(db, userId)),
    weights: publicWeights(db, userId),
    experience: { value: experience.fields.experience?.value ?? '', version: experience.version },
    today: userToday(db, userId),
  };
}

function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0)
    throw new AnamnesisError(400, 'invalidRevision', 'The expected revision is invalid.');
  return value;
}

function assertRevision(row, expected) {
  if ((row ? row.revision : 0) !== expected)
    throw new AnamnesisError(409, 'anamnesisConflict', 'The anamnesis changed in another session.');
}

// Saves part of the questionnaire. A completed anamnesis stays completed: an
// edit that would leave it incomplete is refused rather than silently turning
// it back into a draft.
function saveAnamnesis(db, userId, body, now = new Date().toISOString()) {
  exactKeys(body, ['answers', 'sensitive_ai_consent', 'expected_revision']);
  const expected = expectedRevision(body.expected_revision);
  if (body.answers === undefined && body.sensitive_ai_consent === undefined)
    throw new AnamnesisError(400, 'noChanges', 'Nothing to save.');
  if (body.answers !== undefined && !isPlainObject(body.answers))
    throw new AnamnesisError(400, 'invalidBody', 'Answers must be an object.');
  if (body.sensitive_ai_consent !== undefined && typeof body.sensitive_ai_consent !== 'boolean')
    throw new AnamnesisError(400, 'invalidConsent', 'Consent must be true or false.');
  const currentYear = currentYearOf(db, userId);
  const definition = questionnaire(currentYear);
  const items = new Map(itemsOf(definition).map((item) => [item.key, item]));
  const submitted = {};
  for (const [key, answer] of Object.entries(body.answers ?? {})) {
    const item = items.get(key);
    if (!item) throw new AnamnesisError(400, 'unknownField', `Unsupported field: ${key}.`, { field: key });
    submitted[key] = answer === null ? null : normalizeAnswer(item, answer, currentYear);
  }
  return db.transaction(() => {
    const row = readRow(db, userId);
    assertRevision(row, expected);
    let answers = row ? JSON.parse(row.answers_json) : {};
    for (const [key, answer] of Object.entries(submitted)) {
      if (answer === null) delete answers[key];
      else answers[key] = answer;
    }
    answers = applyConditions(definition, answers);
    const status = row ? row.status : 'draft';
    if (status === 'completed') {
      const missing = missingItems(db, userId, definition, answers);
      if (missing.length)
        throw new AnamnesisError(400, 'anamnesisIncomplete', 'A completed anamnesis cannot lose answers.', { missing });
    }
    const consent = body.sensitive_ai_consent ?? Boolean(row?.sensitive_ai_consent);
    const consentAt = consent
      ? (row?.sensitive_ai_consent ? row.sensitive_ai_consent_at : now)
      : null;
    if (row) {
      db.prepare(
        `UPDATE athlete_anamnesis SET answers_json = ?, sensitive_ai_consent = ?, sensitive_ai_consent_at = ?,
                questionnaire_version = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?`,
      ).run(JSON.stringify(answers), consent ? 1 : 0, consentAt, QUESTIONNAIRE_VERSION, now, userId);
    } else {
      db.prepare(
        `INSERT INTO athlete_anamnesis
          (user_id, questionnaire_version, status, answers_json, sensitive_ai_consent, sensitive_ai_consent_at,
           revision, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, 1, ?, ?)`,
      ).run(userId, QUESTIONNAIRE_VERSION, JSON.stringify(answers), consent ? 1 : 0, consentAt, now, now);
    }
    return { anamnesis: publicAnamnesis(db, userId, definition, readRow(db, userId)) };
  }).immediate();
}

function completeAnamnesis(db, userId, body, now = new Date().toISOString()) {
  exactKeys(body, ['expected_revision']);
  const expected = expectedRevision(body.expected_revision);
  const definition = questionnaire(currentYearOf(db, userId));
  return db.transaction(() => {
    const row = readRow(db, userId);
    assertRevision(row, expected);
    const answers = row ? JSON.parse(row.answers_json) : {};
    const missing = missingItems(db, userId, definition, answers);
    if (!row || missing.length)
      throw new AnamnesisError(400, 'anamnesisIncomplete', 'Some questions are not answered yet.', { missing });
    db.prepare(
      `UPDATE athlete_anamnesis SET status = 'completed', completed_at = ?, revision = revision + 1, updated_at = ?
        WHERE user_id = ?`,
    ).run(now, now, userId);
    return { anamnesis: publicAnamnesis(db, userId, definition, readRow(db, userId)) };
  }).immediate();
}

// Erases the questionnaire, the consent and the whole weight log. Prior
// running experience belongs to training memory and is left untouched.
function deleteAnamnesis(db, userId) {
  return db.transaction(() => {
    const answers = db.prepare('DELETE FROM athlete_anamnesis WHERE user_id = ?').run(userId).changes;
    const weights = db.prepare('DELETE FROM body_weight_entries WHERE user_id = ?').run(userId).changes;
    return { deleted: { anamnesis: answers, weights } };
  }).immediate();
}

function exportAnamnesis(db, userId, now = new Date().toISOString()) {
  const data = readAnamnesis(db, userId);
  return {
    exported_at: now,
    questionnaire_version: data.anamnesis.questionnaire_version,
    anamnesis: {
      status: data.anamnesis.status,
      answers: data.anamnesis.answers,
      sensitive_ai_consent: data.anamnesis.sensitive_ai_consent,
      sensitive_ai_consent_at: data.anamnesis.sensitive_ai_consent_at,
      completed_at: data.anamnesis.completed_at,
      updated_at: data.anamnesis.updated_at,
    },
    running_experience_notes: data.experience.value,
    weights: data.weights.map(({ measured_on, weight_kg }) => ({ measured_on, weight_kg })),
  };
}

/* ── Body-weight log ─────────────────────────────────────────── */

function weightId(value) {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < 1 || !Number.isSafeInteger(number))
    throw new AnamnesisError(400, 'invalidWeightId', 'Weight entry id is invalid.');
  return number;
}

function measuredOn(db, userId, value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.toISOString().slice(0, 10) !== value)
    throw new AnamnesisError(400, 'invalidWeightDate', 'The date is invalid.', { field: 'measured_on' });
  if (value < '1900-01-01' || value > userToday(db, userId))
    throw new AnamnesisError(400, 'weightDateOutOfRange', 'The date cannot be in the future.', { field: 'measured_on' });
  return value;
}

function weightKg(value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new AnamnesisError(400, 'invalidWeight', 'The weight is invalid.', { field: 'weight_kg' });
  if (value < 20 || value > 400)
    throw new AnamnesisError(400, 'weightOutOfRange', 'The weight is outside the accepted range.', { field: 'weight_kg' });
  return roundTo(value, 2);
}

function readWeight(db, userId, id) {
  const row = db
    .prepare('SELECT id, measured_on, weight_kg, created_at, updated_at FROM body_weight_entries WHERE id = ? AND user_id = ?')
    .get(id, userId);
  if (!row) throw new AnamnesisError(404, 'weightNotFound', 'Weight entry not found.');
  return row;
}

function assertDateFree(db, userId, date, exceptId = 0) {
  const clash = db
    .prepare('SELECT 1 FROM body_weight_entries WHERE user_id = ? AND measured_on = ? AND id <> ?')
    .get(userId, date, exceptId);
  if (clash)
    throw new AnamnesisError(409, 'weightDateExists', 'There is already a weight for this date.', { field: 'measured_on' });
}

function addWeight(db, userId, body, now = new Date().toISOString()) {
  exactKeys(body, ['measured_on', 'weight_kg']);
  const date = measuredOn(db, userId, body.measured_on);
  const kg = weightKg(body.weight_kg);
  return db.transaction(() => {
    assertDateFree(db, userId, date);
    if (weightCount(db, userId) >= MAX_WEIGHT_ENTRIES)
      throw new AnamnesisError(409, 'weightLimit', 'The weight log is full.');
    const id = db
      .prepare('INSERT INTO body_weight_entries (user_id, measured_on, weight_kg, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, date, kg, now, now).lastInsertRowid;
    return { weight: readWeight(db, userId, Number(id)) };
  }).immediate();
}

function updateWeight(db, userId, idParam, body, now = new Date().toISOString()) {
  const id = weightId(idParam);
  exactKeys(body, ['measured_on', 'weight_kg']);
  if (body.measured_on === undefined && body.weight_kg === undefined)
    throw new AnamnesisError(400, 'noChanges', 'Nothing to save.');
  const date = body.measured_on === undefined ? undefined : measuredOn(db, userId, body.measured_on);
  const kg = body.weight_kg === undefined ? undefined : weightKg(body.weight_kg);
  return db.transaction(() => {
    const current = readWeight(db, userId, id);
    if (date !== undefined) assertDateFree(db, userId, date, id);
    db.prepare('UPDATE body_weight_entries SET measured_on = ?, weight_kg = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(date ?? current.measured_on, kg ?? current.weight_kg, now, id, userId);
    return { weight: readWeight(db, userId, id) };
  }).immediate();
}

// A completed anamnesis whose weight answer is "answered" keeps at least one
// entry; the athlete can switch that answer to "rather not say" first.
function deleteWeight(db, userId, idParam) {
  const id = weightId(idParam);
  return db.transaction(() => {
    readWeight(db, userId, id);
    const row = readRow(db, userId);
    const answers = row ? JSON.parse(row.answers_json) : {};
    if (row?.status === 'completed' && answers.weight?.status === 'answered' && weightCount(db, userId) === 1)
      throw new AnamnesisError(409, 'weightRequired', 'A completed anamnesis keeps at least one weight entry.');
    db.prepare('DELETE FROM body_weight_entries WHERE id = ? AND user_id = ?').run(id, userId);
    return { id };
  }).immediate();
}

module.exports = {
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
};
