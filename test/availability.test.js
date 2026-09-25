'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase, migrateDatabase } = require('../src/db/database');
const {
  DAY_KEYS, PERIOD_KEYS, MAX_AVAILABLE_MINUTES, normalizeAvailabilityWeek,
  getAvailabilityWeek, saveAvailabilityWeek,
} = require('../src/availability');

function validWeek(overrides = {}) {
  return { days: DAY_KEYS.map((day, index) => ({
    day,
    can_train: index === 0,
    available_periods: index === 0 ? ['12_14', 'after_18'] : [],
    available_minutes: index === 0 ? 60 : null,
    location: index === 0 ? 'Fânzeres, Gondomar' : '',
    ...overrides[day],
  })) };
}

test('availability constants define stable days, periods and a 12-hour maximum', () => {
  assert.deepEqual(DAY_KEYS, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  assert.deepEqual(PERIOD_KEYS, ['before_08', '08_12', '12_14', '14_18', 'after_18']);
  assert.equal(MAX_AVAILABLE_MINUTES, 720);
});

test('week payload rejects malformed shapes, unknown and duplicate days, and missing days', () => {
  assert.deepEqual(normalizeAvailabilityWeek(null), { valid: false, error: 'availability_invalid_week' });
  assert.deepEqual(normalizeAvailabilityWeek({ days: [] }), { valid: false, error: 'availability_invalid_week' });
  const duplicate = validWeek(); duplicate.days[6].day = 'monday';
  assert.deepEqual(normalizeAvailabilityWeek(duplicate), { valid: false, error: 'availability_invalid_day' });
  const unknown = validWeek(); unknown.days[0].day = 'holiday';
  assert.deepEqual(normalizeAvailabilityWeek(unknown), { valid: false, error: 'availability_invalid_day' });
  const noBoolean = validWeek(); noBoolean.days[0].can_train = 'yes';
  assert.deepEqual(normalizeAvailabilityWeek(noBoolean), { valid: false, error: 'availability_invalid_day' });
});

test('unavailable days discard periods, duration and location without requiring them', () => {
  const week = validWeek({ tuesday: { can_train: false, available_periods: ['bogus'], available_minutes: -1, location: 'ignored' } });
  const result = normalizeAvailabilityWeek(week);
  assert.equal(result.valid, true);
  assert.deepEqual(result.days[1], { day: 'tuesday', can_train: false, available_periods: [], available_minutes: null, location: '' });
});

test('available days require known periods, positive bounded whole minutes, and a location', () => {
  for (const available_periods of [[], ['unknown'], '12_14']) {
    const result = normalizeAvailabilityWeek(validWeek({ monday: { available_periods } }));
    assert.deepEqual(result, { valid: false, error: 'availability_invalid_periods' });
  }
  for (const available_minutes of [0, -1, NaN, 1.5, MAX_AVAILABLE_MINUTES + 1, '60', null]) {
    const result = normalizeAvailabilityWeek(validWeek({ monday: { available_minutes } }));
    assert.deepEqual(result, { valid: false, error: 'availability_invalid_duration' });
  }
  for (const location of ['', '  ', 4, 'x'.repeat(201)]) {
    const result = normalizeAvailabilityWeek(validWeek({ monday: { location } }));
    assert.deepEqual(result, { valid: false, error: 'availability_invalid_location' });
  }
});

test('normalization deduplicates periods and validates but preserves exact locations', () => {
  const result = normalizeAvailabilityWeek(validWeek({ monday: {
    available_periods: ['12_14', 'after_18', '12_14'], location: '  Porto  ',
  } }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.days[0].available_periods, ['12_14', 'after_18']);
  assert.equal(result.days[0].location, '  Porto  ');
});

test('availability persistence is user scoped, canonical and idempotent', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('one@example.test', 'hash'), ('two@example.test', 'hash')").run();
  const canonical = normalizeAvailabilityWeek(validWeek()).days;
  assert.deepEqual(getAvailabilityWeek(db, 1), {
    days: DAY_KEYS.map((day) => ({ day, can_train: null, available_periods: [], available_minutes: null, location: '' })),
    needsReview: true,
  });
  const saved = saveAvailabilityWeek(db, 1, canonical);
  assert.equal(saved.needsReview, false);
  assert.equal(saved.days[0].available_minutes, 60);
  assert.deepEqual(saved.days[0].available_periods, ['12_14', 'after_18']);
  assert.equal(saved.days[0].location, 'Fânzeres, Gondomar');
  assert.equal(getAvailabilityWeek(db, 2).needsReview, true);
  const changed = normalizeAvailabilityWeek(validWeek({ monday: { available_minutes: 45 } })).days;
  saveAvailabilityWeek(db, 1, changed);
  assert.equal(getAvailabilityWeek(db, 1).days[0].available_minutes, 45);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_coach_availability').get().count, 7);
  db.close();
});

test('availability migration on the role-migrated main database retains admins and account data', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(`INSERT INTO users (email, password_hash, role, preferred_lang, distance_unit)
    VALUES ('main-admin@example.test', 'kept-hash', 'admin', 'pt-BR', 'mi')`).run();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('kept-session', 1, '2999-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO trainings (user_id, dia, tipo, treino, location) VALUES (1, '2026-09-21', 'Run', 'Easy run', 'Porto')").run();

  // Model the PR #40 database: roles and its marker exist, while the new table
  // and migration marker from this feature have not yet been installed.
  db.exec('DROP TABLE ai_coach_availability');
  db.prepare("DELETE FROM schema_migrations WHERE name = '2026-09-structured-ai-coach-availability-v1'").run();
  migrateDatabase(db);
  migrateDatabase(db);

  assert.equal(db.prepare('SELECT role FROM users WHERE id = 1').get().role, 'admin');
  assert.equal(db.prepare('SELECT preferred_lang FROM users WHERE id = 1').get().preferred_lang, 'pt-BR');
  assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get('kept-session').id, 'kept-session');
  assert.equal(db.prepare('SELECT treino, location FROM trainings WHERE user_id = 1').get().location, 'Porto');
  assert.deepEqual(getAvailabilityWeek(db, 1).days.map((day) => day.can_train), Array(7).fill(null));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-09-user-roles-v1'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-09-structured-ai-coach-availability-v1'").get().count, 1);
  db.close();
});

test('every valid integer duration round-trips through persistence without loss', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('minutes@example.test', 'hash')").run();
  for (const minutes of [1, 75, 137, 720]) {
    const days = normalizeAvailabilityWeek(validWeek({ monday: { available_minutes: minutes } })).days;
    const saved = saveAvailabilityWeek(db, 1, days);
    assert.equal(saved.days[0].available_minutes, minutes);
    assert.equal(getAvailabilityWeek(db, 1).days[0].available_minutes, minutes);
  }
  db.close();
});

test('migration on existing accounts preserves their location and does not infer old free text', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('legacy@example.test', 'hash')").run();
  db.prepare("INSERT INTO trainings (user_id, dia, tipo, location, observacoes) VALUES (1, '2026-09-21', 'Run', 'Fânzeres, Gondomar', 'Rotina normal')").run();
  migrateDatabase(db);
  migrateDatabase(db);
  const week = getAvailabilityWeek(db, 1);
  assert.equal(week.needsReview, true);
  assert.ok(week.days.every((day) => day.can_train === null && day.available_periods.length === 0 && day.available_minutes === null));
  assert.equal(db.prepare('SELECT location, observacoes FROM trainings WHERE id = 1').get().location, 'Fânzeres, Gondomar');
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '2026-09-structured-ai-coach-availability-v1'").get());
  db.close();
});
