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
  db.prepare(`INSERT INTO trainings (id, user_id, dia, tipo) VALUES
              (5, 1, '2026-01-01', 'Run'), (7, 1, '2026-01-02', 'Run'),
              (9, 1, '2026-01-03', 'Run'), (42, 1, '2026-01-04', 'Run')`).run();
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
  const row = (shoe, distance, completed = 1) => ({ id: 42, feedback_shoe_id: shoe, fit_distance: distance, completed });
  reconcileShoeMileage(db, 1, { id: 42, completed: 0 }, row('a', 10));
  reconcileShoeMileage(db, 1, row('a', 10), row('a', 10));
  reconcileShoeMileage(db, 1, row('a', 10), row('a', 12));
  reconcileShoeMileage(db, 1, row('a', 12), row('a', 8));
  reconcileShoeMileage(db, 1, row('a', 8), row('b', 8));
  reconcileShoeMileage(db, 1, row('b', 8), null);
  assert.deepEqual(db.prepare('SELECT id, mileage FROM shoes WHERE user_id = 1 ORDER BY id').all(), [
    { id: 'a', mileage: 5 }, { id: 'b', mileage: 2 },
  ]);
  assert.deepEqual(db.prepare('SELECT * FROM training_shoe_mileage').all(), []);
  db.close();
});

test('an unrecorded historical contribution is never added or subtracted', () => {
  const db = fixture();
  reconcileShoeMileage(db, 1, null, null);
  const historical = { id: 7, completed: 1, feedback_shoe_id: 'a', fit_distance: 10 };
  reconcileShoeMileage(db, 1, historical, { ...historical, feedback_shoe_id: 'b' });
  reconcileShoeMileage(db, 1, historical, { ...historical, fit_distance: 12 });
  reconcileShoeMileage(db, 1, historical, null);
  assert.deepEqual(db.prepare('SELECT id, mileage FROM shoes WHERE user_id = 1 ORDER BY id').all(), [
    { id: 'a', mileage: 5 }, { id: 'b', mileage: 2 },
  ]);
  assert.deepEqual(db.prepare('SELECT * FROM training_shoe_mileage').all(), []);
  db.close();
});

test('a recorded contribution remains user-scoped and never drives mileage below zero', () => {
  const db = fixture();
  db.prepare("INSERT INTO trainings (id, user_id, dia, tipo) VALUES (200, 2, '2026-01-05', 'Run')").run();
  db.prepare("INSERT INTO training_shoe_mileage (training_id, user_id, shoe_id, distance) VALUES (200, 2, 'foreign', 20)").run();
  db.prepare("UPDATE shoes SET mileage = 0 WHERE id = 'a'").run();
  const before = { id: 42, completed: 1, feedback_shoe_id: 'a', fit_distance: 10 };
  db.prepare("INSERT INTO training_shoe_mileage (training_id, user_id, shoe_id, distance) VALUES (42, 1, 'a', 10)").run();
  reconcileShoeMileage(db, 1, before, null);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 0);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'foreign'").get().mileage, 50);
  assert.equal(db.prepare("SELECT 1 FROM training_shoe_mileage WHERE training_id = 42").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM training_shoe_mileage WHERE training_id = 200 AND user_id = 2").get());
  db.close();
});

test('a recorded training can be removed and reattached reversibly', () => {
  const db = fixture();
  const detached = { id: 9, completed: 1, feedback_shoe_id: null, fit_distance: 10 };
  const attached = { ...detached, feedback_shoe_id: 'a' };
  reconcileShoeMileage(db, 1, detached, attached);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 15);
  reconcileShoeMileage(db, 1, attached, detached);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 5);
  reconcileShoeMileage(db, 1, detached, attached);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 15);
  assert.deepEqual(db.prepare('SELECT training_id, shoe_id, distance FROM training_shoe_mileage').all(),
    [{ training_id: 9, shoe_id: 'a', distance: 10 }]);
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
    () => reconcileShoeMileage(db, 1, { id: 5, completed: 0 }, { id: 5, completed: 1, feedback_shoe_id: 'foreign', fit_distance: 4 }),
    ShoeMileageError
  );
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'foreign'").get().mileage, 50);
  db.close();
});

test('a persistence failure rolls back both a training mutation and its mileage delta', () => {
  const db = fixture();
  db.prepare("INSERT INTO trainings (id, user_id, dia, tipo, completed, fit_distance, feedback_shoe_id) VALUES (100, 1, '2026-01-01', 'Run', 0, 10, 'a')").run();
  db.exec("CREATE TRIGGER reject_mileage BEFORE UPDATE OF mileage ON shoes BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const save = db.transaction(() => {
    const before = db.prepare('SELECT * FROM trainings WHERE id = 100').get();
    db.prepare('UPDATE trainings SET completed = 1 WHERE id = 100').run();
    const after = db.prepare('SELECT * FROM trainings WHERE id = 100').get();
    reconcileShoeMileage(db, 1, before, after);
  });
  assert.throws(() => save(), /failure/);
  assert.equal(db.prepare('SELECT completed FROM trainings WHERE id = 100').get().completed, 0);
  assert.equal(db.prepare("SELECT mileage FROM shoes WHERE id = 'a'").get().mileage, 5);
  db.close();
});
