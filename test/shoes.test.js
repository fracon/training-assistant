'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const {
  VALID_STATUSES,
  DEFAULT_STATUS,
  DEFAULT_MILEAGE,
  ShoeError,
  normalizeShoeInput,
  validateShoe,
  createShoe,
  getShoesByUserId,
  getShoeById,
  updateShoe,
  deleteShoe,
} = require('../src/shoes');

function seedUser(db) {
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('runner@test.com', 'hash')"
  ).run();
  return db.prepare("SELECT id FROM users WHERE email = 'runner@test.com'").get().id;
}

/* ── normalizeShoeInput ── */

test('normalizeShoeInput applies defaults for empty or missing fields', () => {
  const result = normalizeShoeInput({});
  assert.equal(result.brand, '');
  assert.equal(result.model, '');
  assert.equal(result.mileage, DEFAULT_MILEAGE);
  assert.equal(result.target_mileage, null);
  assert.equal(result.status, DEFAULT_STATUS);
});

test('normalizeShoeInput trims and lowercases status', () => {
  const result = normalizeShoeInput({ status: '  Retired  ' });
  assert.equal(result.status, 'retired');
});

test('normalizeShoeInput parses numeric mileage and target_mileage', () => {
  const result = normalizeShoeInput({ mileage: '123.5', target_mileage: '800' });
  assert.equal(result.mileage, 123.5);
  assert.equal(result.target_mileage, 800);
});

test('normalizeShoeInput treats blank strings for mileage as the default', () => {
  const result = normalizeShoeInput({ mileage: '', target_mileage: '' });
  assert.equal(result.mileage, DEFAULT_MILEAGE);
  assert.equal(result.target_mileage, null);
});

test('normalizeShoeInput trims brand and model', () => {
  const result = normalizeShoeInput({ brand: '  Nike  ', model: '  Pegasus  ' });
  assert.equal(result.brand, 'Nike');
  assert.equal(result.model, 'Pegasus');
});

/* ── validateShoe ── */

test('validateShoe accepts valid input', () => {
  assert.doesNotThrow(() => validateShoe({
    brand: 'Nike', model: 'Pegasus 41', mileage: 100,
    target_mileage: 800, status: 'active',
  }));
});

test('validateShoe accepts null target_mileage', () => {
  assert.doesNotThrow(() => validateShoe({
    brand: 'Nike', model: 'Pegasus 41', mileage: 0,
    target_mileage: null, status: 'retired',
  }));
});

test('validateShoe rejects missing brand', () => {
  assert.throws(
    () => validateShoe({ brand: '', model: 'Pegasus', mileage: 0, target_mileage: null, status: 'active' }),
    { name: 'ShoeError', status: 400, message: /brand is required/ }
  );
});

test('validateShoe rejects missing model', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: '', mileage: 0, target_mileage: null, status: 'active' }),
    { name: 'ShoeError', status: 400, message: /model is required/ }
  );
});

test('validateShoe rejects negative mileage', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: 'Pegasus', mileage: -10, target_mileage: null, status: 'active' }),
    { name: 'ShoeError', message: /mileage must be a non-negative number/ }
  );
});

test('validateShoe rejects NaN mileage', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: 'Pegasus', mileage: NaN, target_mileage: null, status: 'active' }),
    { name: 'ShoeError' }
  );
});

test('validateShoe rejects negative target_mileage', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: 'Pegasus', mileage: 0, target_mileage: -1, status: 'active' }),
    { name: 'ShoeError', message: /target_mileage must be null or a non-negative number/ }
  );
});

test('validateShoe rejects NaN target_mileage', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: 'Pegasus', mileage: 0, target_mileage: NaN, status: 'active' }),
    { name: 'ShoeError' }
  );
});

test('validateShoe rejects invalid status', () => {
  assert.throws(
    () => validateShoe({ brand: 'Nike', model: 'Pegasus', mileage: 0, target_mileage: null, status: 'worn-out' }),
    { name: 'ShoeError', message: /status must be one of/ }
  );
});

test('validateShoe aggregates multiple errors', () => {
  try {
    validateShoe({ brand: '', model: '', mileage: -1, target_mileage: -5, status: 'bad' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ShoeError);
    assert.equal(err.status, 400);
    assert.match(err.message, /brand is required/);
    assert.match(err.message, /model is required/);
    assert.match(err.message, /mileage/);
    assert.match(err.message, /target_mileage/);
    assert.match(err.message, /status/);
  }
});

/* ── ShoeError ── */

test('ShoeError stores name and status', () => {
  const err = new ShoeError('test', 422);
  assert.equal(err.name, 'ShoeError');
  assert.equal(err.message, 'test');
  assert.equal(err.status, 422);
  assert.ok(err instanceof Error);
});

/* ── VALID_STATUSES & DEFAULTS ── */

test('VALID_STATUSES contains active and retired', () => {
  assert.deepEqual(VALID_STATUSES, ['active', 'retired']);
});

test('DEFAULT_STATUS is active', () => {
  assert.equal(DEFAULT_STATUS, 'active');
});

test('DEFAULT_MILEAGE is 0.0', () => {
  assert.equal(DEFAULT_MILEAGE, 0.0);
});

/* ── createShoe ── */

test('createShoe persists a shoe and returns the row', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, {
    brand: 'Nike', model: 'Pegasus 41', mileage: 50, target_mileage: 800, status: 'active',
  });
  assert.ok(shoe.id, 'returns a UUID id');
  assert.equal(shoe.user_id, userId);
  assert.equal(shoe.brand, 'Nike');
  assert.equal(shoe.model, 'Pegasus 41');
  assert.equal(shoe.mileage, 50);
  assert.equal(shoe.target_mileage, 800);
  assert.equal(shoe.status, 'active');
  assert.ok(shoe.created_at);
  assert.ok(shoe.updated_at);
  db.close();
});

test('createShoe defaults mileage and status when omitted', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Asics', model: 'Nimbus 26' });
  assert.equal(shoe.mileage, 0);
  assert.equal(shoe.target_mileage, null);
  assert.equal(shoe.status, 'active');
  db.close();
});

test('createShoe throws ShoeError on invalid input', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.throws(
    () => createShoe(db, userId, { brand: '', model: 'X' }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

/* ── getShoesByUserId ── */

test('getShoesByUserId returns shoes ordered by created_at DESC', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const first = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  db.prepare("UPDATE shoes SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(first.id);
  const second = createShoe(db, userId, { brand: 'Asics', model: 'Nimbus' });
  db.prepare("UPDATE shoes SET created_at = '2026-06-01 00:00:00' WHERE id = ?").run(second.id);

  const shoes = getShoesByUserId(db, userId);
  assert.equal(shoes.length, 2);
  assert.equal(shoes[0].brand, 'Asics', 'most recent first');
  assert.equal(shoes[1].brand, 'Nike');
  db.close();
});

test('getShoesByUserId returns empty array for user with no shoes', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.deepEqual(getShoesByUserId(db, userId), []);
  db.close();
});

/* ── getShoeById ── */

test('getShoeById returns the shoe when it belongs to the user', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Vaporfly' });
  const found = getShoeById(db, shoe.id, userId);
  assert.equal(found.id, shoe.id);
  assert.equal(found.brand, 'Nike');
  db.close();
});

test('getShoeById returns undefined for non-existent id', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(getShoeById(db, 'non-existent', userId), undefined);
  db.close();
});

/* ── updateShoe ── */

test('updateShoe modifies fields and returns the updated row', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus', mileage: 100 });
  const updated = updateShoe(db, shoe.id, userId, { mileage: 200, status: 'retired' });
  assert.equal(updated.mileage, 200);
  assert.equal(updated.status, 'retired');
  assert.equal(updated.brand, 'Nike', 'untouched field preserved');
  db.close();
});

test('updateShoe returns null when shoe does not exist', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(updateShoe(db, 'fake-id', userId, { mileage: 10 }), null);
  db.close();
});

test('updateShoe returns existing row when no updatable fields provided', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  const result = updateShoe(db, shoe.id, userId, {});
  assert.equal(result.id, shoe.id);
  assert.equal(result.brand, 'Nike');
  db.close();
});

test('updateShoe clears target_mileage when set to null', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus', target_mileage: 800 });
  const updated = updateShoe(db, shoe.id, userId, { target_mileage: null });
  assert.equal(updated.target_mileage, null);
  db.close();
});

test('updateShoe clears target_mileage when set to empty string', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus', target_mileage: 800 });
  const updated = updateShoe(db, shoe.id, userId, { target_mileage: '' });
  assert.equal(updated.target_mileage, null);
  db.close();
});

test('updateShoe throws ShoeError for invalid brand', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { brand: '  ' }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

test('updateShoe throws ShoeError for invalid model', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { model: '' }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

test('updateShoe throws ShoeError for negative mileage', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { mileage: -1 }),
    { name: 'ShoeError' }
  );
  db.close();
});

test('updateShoe throws ShoeError for invalid target_mileage', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { target_mileage: -10 }),
    { name: 'ShoeError' }
  );
  db.close();
});

test('updateShoe throws ShoeError for invalid status', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { status: 'worn' }),
    { name: 'ShoeError' }
  );
  db.close();
});

test('updateShoe throws ShoeError for non-string brand', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { brand: 123 }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

test('updateShoe throws ShoeError for non-string model', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { model: true }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

test('updateShoe throws ShoeError for non-string status', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.throws(
    () => updateShoe(db, shoe.id, userId, { status: 42 }),
    { name: 'ShoeError', status: 400 }
  );
  db.close();
});

test('updateShoe updates the updated_at timestamp', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  const before = shoe.updated_at;
  const updated = updateShoe(db, shoe.id, userId, { mileage: 50 });
  assert.ok(updated.updated_at >= before, 'updated_at should move forward');
  db.close();
});

/* ── deleteShoe ── */

test('deleteShoe removes the shoe and returns true', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  const shoe = createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.equal(deleteShoe(db, shoe.id, userId), true);
  assert.equal(getShoeById(db, shoe.id, userId), undefined);
  db.close();
});

test('deleteShoe returns false for non-existent shoe', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  assert.equal(deleteShoe(db, 'fake-id', userId), false);
  db.close();
});

test('deleteShoe does not delete another user shoe', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const shoe = createShoe(db, otherId, { brand: 'Nike', model: 'Pegasus' });
  assert.equal(deleteShoe(db, shoe.id, userId), false, 'cannot delete other user shoe');
  assert.ok(getShoeById(db, shoe.id, otherId), 'other user shoe still exists');
  db.close();
});

/* ── cascade delete ── */

test('deleting a user cascades and removes their shoes', () => {
  const db = createDatabase({ filename: ':memory:' });
  const userId = seedUser(db);
  createShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });
  assert.equal(getShoesByUserId(db, userId).length, 1);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal(getShoesByUserId(db, userId).length, 0);
  db.close();
});
