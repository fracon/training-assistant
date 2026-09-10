'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const {
  ShoeMileageError,
  contribution,
  reconcileShoeMileage,
  resolveOwnedShoe,
  resolveOwnedShoeLabel,
} = require('../src/shoeMileage');

function fixture() {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('a@a.test', 'x'), ('b@b.test', 'x')").run();
  db.prepare(`INSERT INTO shoes (id, user_id, brand, model, mileage, status)
              VALUES ('a', 1, 'Acme', 'A', 5, 'active'),
                     ('b', 1, 'Acme', 'B', 2, 'retired'),
                     ('foreign', 2, 'Acme', 'F', 50, 'active')`).run();
  return db;
}

test('contribution accepts only completed, associated, positive finite canonical distances', () => {
  assert.deepEqual(contribution({ completed: 1, feedback_shoe_id: 'a', fit_distance: '10' }), { shoeId: 'a', distance: 10 });
  for (const row of [null, {}, { completed: 0, feedback_shoe_id: 'a', fit_distance: 10 },
    { completed: 1, feedback_shoe_id: null, fit_distance: 10 },
    { completed: 1, feedback_shoe_id: 'a', fit_distance: 0 },
    { completed: 1, feedback_shoe_id: 'a', fit_distance: 'bad' }]) {
    assert.equal(contribution(row), null);
  }
});

test('reconciliation applies only deltas for save retries, corrections, swaps and removals', () => {
  const db = fixture();
  const row = (shoe, distance, completed = 1) => ({ feedback_shoe_id: shoe, fit_distance: distance, completed });
  reconcileShoeMileage(db, 1, null, row('a', 10));
  reconcileShoeMileage(db, 1, row('a', 10), row('a', 10));
  reconcileShoeMileage(db, 1, row('a', 10), row('a', 12));
  reconcileShoeMileage(db, 1, row('a', 12), row('a', 8));
  reconcileShoeMileage(db, 1, row('a', 8), row('b', 8));
  reconcileShoeMileage(db, 1, row('b', 8), null);
  assert.deepEqual(db.prepare('SELECT id, mileage FROM shoes WHERE user_id = 1 ORDER BY id').all(), [
    { id: 'a', mileage: 5 }, { id: 'b', mileage: 2 },
  ]);
  reconcileShoeMileage(db, 1, row('a', 100), null);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 0);
  db.close();
});

test('shoe ownership resolution supports clears and rejects malformed or foreign IDs', () => {
  const db = fixture();
  assert.equal(resolveOwnedShoe(db, 1, null), null);
  assert.equal(resolveOwnedShoe(db, 1, ''), null);
  assert.equal(resolveOwnedShoe(db, 1, 'a').model, 'A');
  assert.equal(resolveOwnedShoeLabel(db, 1, ' Acme A ').id, 'a');
  assert.equal(resolveOwnedShoeLabel(db, 1, ''), null);
  assert.equal(resolveOwnedShoeLabel(db, 1, null), null);
  assert.throws(() => resolveOwnedShoeLabel(db, 1, 4), /must be a string/);
  assert.throws(() => resolveOwnedShoeLabel(db, 1, 'missing'), /exactly one/);
  assert.throws(() => resolveOwnedShoe(db, 1, 4), ShoeMileageError);
  assert.throws(() => resolveOwnedShoe(db, 1, 'foreign'), /authenticated user/);
  assert.throws(
    () => reconcileShoeMileage(db, 1, null, { completed: 1, feedback_shoe_id: 'foreign', fit_distance: 4 }),
    ShoeMileageError
  );
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'foreign'").get().mileage, 50);
  db.close();
});

test('a persistence failure rolls back both a training mutation and its mileage delta', () => {
  const db = fixture();
  db.prepare("INSERT INTO trainings (user_id, dia, tipo, completed, fit_distance, feedback_shoe_id) VALUES (1, '2026-01-01', 'Run', 0, 10, 'a')").run();
  db.exec("CREATE TRIGGER reject_mileage BEFORE UPDATE OF mileage ON shoes BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const save = db.transaction(() => {
    const before = db.prepare('SELECT * FROM trainings WHERE id = 1').get();
    db.prepare('UPDATE trainings SET completed = 1 WHERE id = 1').run();
    const after = db.prepare('SELECT * FROM trainings WHERE id = 1').get();
    reconcileShoeMileage(db, 1, before, after);
  });
  assert.throws(() => save(), /failure/);
  assert.equal(db.prepare('SELECT completed FROM trainings WHERE id = 1').get().completed, 0);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 5);
  db.close();
});
