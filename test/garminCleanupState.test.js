'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { migrateCleanupState } = require('../src/garmin/cleanup-state');

function fixture() {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES (1,'one@example.invalid','x'),(2,'two@example.invalid','x')").run();
  db.prepare('INSERT INTO garmin_cleanup_state(id,pending,preserve_identity) VALUES (1,1,1)').run();
  return db;
}

test('legacy cleanup migrates once only with one persisted pending connection', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO garmin_pilot_connections(user_id,cleanup_pending) VALUES (1,1),(2,0)').run();
    assert.deepEqual(migrateCleanupState(db), { status: 'migrated', ownerId: 1, connectionId: 'pilot' });
    assert.deepEqual(db.prepare('SELECT user_id,connection_id,pending,preserve_identity FROM garmin_connection_cleanup').all(),
      [{ user_id: 1, connection_id: 'pilot', pending: 1, preserve_identity: 1 }]);
    assert.deepEqual(migrateCleanupState(db), { status: 'clear' });
  } finally { db.close(); }
});

test('ambiguous or conflicting legacy cleanup remains untouched', () => {
  const db = fixture();
  try {
    assert.equal(migrateCleanupState(db).status, 'ambiguous');
    db.prepare('INSERT INTO garmin_pilot_connections(user_id,cleanup_pending) VALUES (1,1),(2,1)').run();
    assert.equal(migrateCleanupState(db).status, 'ambiguous');
    assert.equal(db.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get().pending, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM garmin_connection_cleanup').get().n, 0);
    db.prepare('UPDATE garmin_pilot_connections SET cleanup_pending=0 WHERE user_id=2').run();
    db.prepare("INSERT INTO garmin_connection_cleanup(user_id,connection_id,pending,preserve_identity) VALUES (1,'pilot',1,0)").run();
    assert.equal(migrateCleanupState(db).code, 'garmin_legacy_cleanup_conflict');
    assert.equal(db.prepare('SELECT preserve_identity FROM garmin_cleanup_state WHERE id=1').get().preserve_identity, 1);
  } finally { db.close(); }
});

test('normal initialization migrates proven cleanup and preserves ambiguous cleanup', () => {
  const { initializeDatabase } = require('../src/db/database');
  const db = fixture();
  try {
    db.prepare('INSERT INTO garmin_pilot_connections(user_id,cleanup_pending) VALUES (1,1)').run();
    initializeDatabase(db);
    assert.deepEqual(db.prepare('SELECT user_id,connection_id,pending FROM garmin_connection_cleanup').all(),
      [{ user_id: 1, connection_id: 'pilot', pending: 1 }]);
    initializeDatabase(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM garmin_connection_cleanup').get().n, 1);
  } finally { db.close(); }
  const ambiguous = fixture();
  try {
    initializeDatabase(ambiguous);
    assert.equal(ambiguous.prepare('SELECT pending FROM garmin_cleanup_state WHERE id=1').get().pending, 1);
    assert.equal(ambiguous.prepare('SELECT count(*) AS n FROM garmin_connection_cleanup').get().n, 0);
  } finally { ambiguous.close(); }
});
