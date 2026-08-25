'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const {
  VALID_STATUSES,
  DEFAULT_STATUS,
  CycleError,
  normalizeCycleInput,
  validateCycle,
  getActiveCycle,
  createCycle,
  getCyclesByUserId,
  getCycleById,
  updateCycle,
  deleteCycle,
} = require('../src/cycles');

function seedUser(db) {
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('runner@test.com', 'hash')"
  ).run();
  return db.prepare("SELECT id FROM users WHERE email = 'runner@test.com'").get().id;
}

/* ── VALID_STATUSES & DEFAULT_STATUS ── */

test('VALID_STATUSES contains active, completed, and cancelled', () => {
  assert.deepEqual(VALID_STATUSES, ['active', 'completed', 'cancelled']);
});

test('DEFAULT_STATUS is active', () => {
  assert.equal(DEFAULT_STATUS, 'active');
});

/* ── CycleError ── */

test('CycleError stores name and status', () => {
  const err = new CycleError('test', 422);
  assert.equal(err.name, 'CycleError');
  assert.equal(err.message, 'test');
  assert.equal(err.status, 422);
  assert.ok(err instanceof Error);
});

/* ── normalizeCycleInput ── */

test('normalizeCycleInput applies defaults for empty or missing fields', () => {
  const result = normalizeCycleInput({});
  assert.equal(result.objective, '');
  assert.equal(result.target_date, null);
  assert.equal(result.distance, null);
  assert.equal(result.run_before, null);
  assert.equal(result.run_count, null);
  assert.equal(result.primary_goal, null);
  assert.equal(result.secondary_goal, null);
  assert.equal(result.start_date, null);
  assert.equal(result.other_events, null);
  assert.equal(result.status, DEFAULT_STATUS);
});

test('normalizeCycleInput trims and lowercases status', () => {
  const result = normalizeCycleInput({ status: '  Completed  ' });
  assert.equal(result.status, 'completed');
});

test('normalizeCycleInput defaults to active for empty string status', () => {
  const result = normalizeCycleInput({ status: '' });
  assert.equal(result.status, 'active');
});

test('normalizeCycleInput defaults to active for non-string status', () => {
  const result = normalizeCycleInput({ status: 42 });
  assert.equal(result.status, 'active');
});

test('normalizeCycleInput trims objective', () => {
  const result = normalizeCycleInput({ objective: '  Marathon  ' });
  assert.equal(result.objective, 'Marathon');
});

test('normalizeCycleInput parses run_count from number', () => {
  const result = normalizeCycleInput({ run_count: 5 });
  assert.equal(result.run_count, 5);
});

test('normalizeCycleInput parses run_count from string', () => {
  const result = normalizeCycleInput({ run_count: '3' });
  assert.equal(result.run_count, 3);
});

test('normalizeCycleInput sets run_count to null for undefined', () => {
  const result = normalizeCycleInput({ run_count: undefined });
  assert.equal(result.run_count, null);
});

test('normalizeCycleInput sets run_count to null for null', () => {
  const result = normalizeCycleInput({ run_count: null });
  assert.equal(result.run_count, null);
});

test('normalizeCycleInput sets run_count to null for empty string', () => {
  const result = normalizeCycleInput({ run_count: '' });
  assert.equal(result.run_count, null);
});

test('normalizeCycleInput trims all string fields', () => {
  const result = normalizeCycleInput({
    objective: '  obj  ',
    target_date: '  2026-01-01  ',
    distance: '  10k  ',
    run_before: '  yes  ',
    primary_goal: '  speed  ',
    secondary_goal: '  endurance  ',
    start_date: '  2026-02-01  ',
    other_events: '  none  ',
  });
  assert.equal(result.objective, 'obj');
  assert.equal(result.target_date, '2026-01-01');
  assert.equal(result.distance, '10k');
  assert.equal(result.run_before, 'yes');
  assert.equal(result.primary_goal, 'speed');
  assert.equal(result.secondary_goal, 'endurance');
  assert.equal(result.start_date, '2026-02-01');
  assert.equal(result.other_events, 'none');
});

test('normalizeCycleInput returns null for non-string optional fields', () => {
  const result = normalizeCycleInput({
    target_date: 123,
    distance: true,
    run_before: 42,
    primary_goal: {},
    secondary_goal: [],
    start_date: undefined,
    other_events: null,
  });
  assert.equal(result.target_date, null);
  assert.equal(result.distance, null);
  assert.equal(result.run_before, null);
  assert.equal(result.primary_goal, null);
  assert.equal(result.secondary_goal, null);
  assert.equal(result.start_date, null);
  assert.equal(result.other_events, null);
});

test('normalizeCycleInput returns empty string for non-string objective', () => {
  const result = normalizeCycleInput({ objective: 42 });
  assert.equal(result.objective, '');
});

/* ── validateCycle ── */

test('validateCycle accepts valid input', () => {
  assert.doesNotThrow(() => validateCycle({
    objective: 'Marathon', status: 'active', run_count: null,
  }));
});

test('validateCycle accepts valid input with run_count', () => {
  assert.doesNotThrow(() => validateCycle({
    objective: 'Marathon', status: 'completed', run_count: 4,
  }));
});

test('validateCycle rejects missing objective', () => {
  assert.throws(
    () => validateCycle({ objective: '', status: 'active', run_count: null }),
    { name: 'CycleError', status: 400, message: /objective is required/ }
  );
});

test('validateCycle rejects invalid status', () => {
  assert.throws(
    () => validateCycle({ objective: 'Marathon', status: 'bad', run_count: null }),
    { name: 'CycleError', status: 400, message: /status must be one of/ }
  );
});

test('validateCycle rejects negative run_count', () => {
  assert.throws(
    () => validateCycle({ objective: 'Marathon', status: 'active', run_count: -1 }),
    { name: 'CycleError', message: /run_count must be null or a non-negative number/ }
  );
});

test('validateCycle rejects NaN run_count', () => {
  assert.throws(
    () => validateCycle({ objective: 'Marathon', status: 'active', run_count: NaN }),
    { name: 'CycleError', message: /run_count/ }
  );
});

test('validateCycle rejects non-number run_count', () => {
  assert.throws(
    () => validateCycle({ objective: 'Marathon', status: 'active', run_count: 'bad' }),
    { name: 'CycleError', message: /run_count/ }
  );
});

test('validateCycle aggregates multiple errors', () => {
  try {
    validateCycle({ objective: '', status: 'bad', run_count: -1 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CycleError);
    assert.equal(err.status, 400);
    assert.match(err.message, /objective is required/);
    assert.match(err.message, /status must be one of/);
    assert.match(err.message, /run_count/);
  }
});

/* ── getActiveCycle ── */

test('getActiveCycle returns the most recent active cycle', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const first = createCycle(db, userId, { objective: 'Marathon' });
  db.prepare("UPDATE training_cycles SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(first.id);
  const second = createCycle(db, userId, { objective: '5K', status: 'completed' });
  db.prepare("UPDATE training_cycles SET status = 'active', created_at = '2026-06-01 00:00:00' WHERE id = ?").run(second.id);

  const active = getActiveCycle(db, userId);
  assert.equal(active.id, second.id);
  assert.equal(active.objective, '5K');
  db.close();
});

test('getActiveCycle returns undefined when no active cycle exists', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(getActiveCycle(db, userId), undefined);
  db.close();
});

/* ── createCycle ── */

test('createCycle persists a cycle and returns the row', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon', status: 'completed' });
  assert.ok(cycle.id, 'returns a UUID id');
  assert.equal(cycle.user_id, userId);
  assert.equal(cycle.objective, 'Marathon');
  assert.equal(cycle.status, 'completed');
  assert.ok(cycle.created_at);
  assert.ok(cycle.updated_at);
  db.close();
});

test('createCycle defaults status to active when omitted', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: '5K' });
  assert.equal(cycle.status, 'active');
  db.close();
});

test('createCycle stores optional fields', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, {
    objective: 'Marathon',
    target_date: '2026-10-01',
    distance: '42k',
    run_before: 'yes',
    run_count: 4,
    primary_goal: 'finish',
    secondary_goal: 'sub4',
    start_date: '2026-06-01',
    other_events: 'none',
  });
  assert.equal(cycle.target_date, '2026-10-01');
  assert.equal(cycle.distance, '42k');
  assert.equal(cycle.run_before, 'yes');
  assert.equal(cycle.run_count, 4);
  assert.equal(cycle.primary_goal, 'finish');
  assert.equal(cycle.secondary_goal, 'sub4');
  assert.equal(cycle.start_date, '2026-06-01');
  assert.equal(cycle.other_events, 'none');
  db.close();
});

test('createCycle throws CycleError on invalid input', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.throws(
    () => createCycle(db, userId, { objective: '', status: 'bad' }),
    { name: 'CycleError', status: 400 }
  );
  db.close();
});

test('createCycle throws 409 when an active cycle already exists', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  createCycle(db, userId, { objective: 'First' });
  assert.throws(
    () => createCycle(db, userId, { objective: 'Second' }),
    { name: 'CycleError', status: 409, message: /active cycle already exists/ }
  );
  db.close();
});

test('createCycle allows a second active cycle after first is completed', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const first = createCycle(db, userId, { objective: 'First' });
  updateCycle(db, first.id, userId, { status: 'completed' });
  const second = createCycle(db, userId, { objective: 'Second' });
  assert.equal(second.status, 'active');
  assert.equal(second.objective, 'Second');
  db.close();
});

test('createCycle allows a cancelled cycle followed by a new active cycle', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const first = createCycle(db, userId, { objective: 'First' });
  updateCycle(db, first.id, userId, { status: 'cancelled' });
  const second = createCycle(db, userId, { objective: 'Second' });
  assert.equal(second.status, 'active');
  db.close();
});

test('createCycle allows creating a non-active cycle when one is already active', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  createCycle(db, userId, { objective: 'First', status: 'active' });
  const second = createCycle(db, userId, { objective: 'Second', status: 'completed' });
  assert.equal(second.status, 'completed');
  db.close();
});

/* ── getCyclesByUserId ── */

test('getCyclesByUserId returns cycles ordered by created_at DESC', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const first = createCycle(db, userId, { objective: 'First', status: 'completed' });
  db.prepare("UPDATE training_cycles SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(first.id);
  const second = createCycle(db, userId, { objective: 'Second', status: 'completed' });
  db.prepare("UPDATE training_cycles SET created_at = '2026-06-01 00:00:00' WHERE id = ?").run(second.id);

  const cycles = getCyclesByUserId(db, userId);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].objective, 'Second', 'most recent first');
  assert.equal(cycles[1].objective, 'First');
  db.close();
});

test('getCyclesByUserId returns empty array for user with no cycles', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.deepEqual(getCyclesByUserId(db, userId), []);
  db.close();
});

/* ── getCycleById ── */

test('getCycleById returns the cycle when it belongs to the user', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  const found = getCycleById(db, cycle.id, userId);
  assert.equal(found.id, cycle.id);
  assert.equal(found.objective, 'Marathon');
  db.close();
});

test('getCycleById returns undefined for non-existent id', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(getCycleById(db, 'non-existent', userId), undefined);
  db.close();
});

test('getCycleById returns undefined when id belongs to another user', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const cycle = createCycle(db, otherId, { objective: 'Marathon' });
  assert.equal(getCycleById(db, cycle.id, userId), undefined);
  db.close();
});

/* ── updateCycle ── */

test('updateCycle modifies fields and returns the updated row', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon', status: 'active' });
  const updated = updateCycle(db, cycle.id, userId, { objective: '5K', status: 'completed' });
  assert.equal(updated.objective, '5K');
  assert.equal(updated.status, 'completed');
  db.close();
});

test('updateCycle returns null when cycle does not exist', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(updateCycle(db, 'fake-id', userId, { objective: 'x' }), null);
  db.close();
});

test('updateCycle returns existing row when no updatable fields provided', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  const result = updateCycle(db, cycle.id, userId, {});
  assert.equal(result.id, cycle.id);
  assert.equal(result.objective, 'Marathon');
  db.close();
});

test('updateCycle throws CycleError for invalid status', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  assert.throws(
    () => updateCycle(db, cycle.id, userId, { status: 'bad' }),
    { name: 'CycleError', status: 400, message: /status must be one of/ }
  );
  db.close();
});

test('updateCycle throws 409 when setting status to active and another active cycle exists', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  createCycle(db, userId, { objective: 'First', status: 'active' });
  const second = createCycle(db, userId, { objective: 'Second', status: 'completed' });
  assert.throws(
    () => updateCycle(db, second.id, userId, { status: 'active' }),
    { name: 'CycleError', status: 409, message: /active cycle already exists/ }
  );
  db.close();
});

test('updateCycle allows setting status to active when the cycle is already the active one', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  const updated = updateCycle(db, cycle.id, userId, { status: 'active' });
  assert.equal(updated.status, 'active');
  db.close();
});

test('updateCycle updates the updated_at timestamp', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  const before = cycle.updated_at;
  const updated = updateCycle(db, cycle.id, userId, { objective: '5K' });
  assert.ok(updated.updated_at >= before, 'updated_at should move forward');
  db.close();
});

test('updateCycle ignores disallowed fields', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  const updated = updateCycle(db, cycle.id, userId, { user_id: 999, id: 'hacked' });
  assert.equal(updated.id, cycle.id);
  assert.equal(updated.user_id, userId);
  db.close();
});

/* ── deleteCycle ── */

test('deleteCycle removes the cycle and returns true', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const cycle = createCycle(db, userId, { objective: 'Marathon' });
  assert.equal(deleteCycle(db, cycle.id, userId), true);
  assert.equal(getCycleById(db, cycle.id, userId), undefined);
  db.close();
});

test('deleteCycle returns false for non-existent cycle', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(deleteCycle(db, 'fake-id', userId), false);
  db.close();
});

test('deleteCycle does not delete another user cycle', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const cycle = createCycle(db, otherId, { objective: 'Marathon' });
  assert.equal(deleteCycle(db, cycle.id, userId), false, 'cannot delete other user cycle');
  assert.ok(getCycleById(db, cycle.id, otherId), 'other user cycle still exists');
  db.close();
});

/* ── cascade delete ── */

test('deleting a user cascades and removes their cycles', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  createCycle(db, userId, { objective: 'Marathon' });
  assert.equal(getCyclesByUserId(db, userId).length, 1);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal(getCyclesByUserId(db, userId).length, 0);
  db.close();
});
