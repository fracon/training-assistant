'use strict';

// The legacy singleton is retained until its owner can be established from the
// persisted connection cleanup flag. An ambiguous singleton is never dispatched.
function migrateCleanupState(db) {
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS garmin_connection_cleanup (
      user_id INTEGER NOT NULL,
      connection_id TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 1 CHECK (pending IN (0,1)),
      preserve_identity INTEGER NOT NULL DEFAULT 0 CHECK (preserve_identity IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, connection_id)
    );
    CREATE TABLE IF NOT EXISTS garmin_legacy_cleanup_quarantine (
      id INTEGER PRIMARY KEY CHECK (id=1)
    )`);
    const legacy = db.prepare('SELECT pending,preserve_identity,updated_at FROM garmin_cleanup_state WHERE id=1').get();
    if (!legacy?.pending) return { status: 'clear' };
    if (db.prepare('SELECT id FROM garmin_legacy_cleanup_quarantine WHERE id=1').get()) {
      return { status: 'ambiguous', code: 'garmin_legacy_cleanup_owner_ambiguous' };
    }
    const owners = db.prepare('SELECT user_id FROM garmin_pilot_connections WHERE cleanup_pending=1').all();
    if (owners.length !== 1) {
      db.prepare('INSERT OR IGNORE INTO garmin_legacy_cleanup_quarantine(id) VALUES (1)').run();
      return { status: 'ambiguous', code: 'garmin_legacy_cleanup_owner_ambiguous' };
    }
    const owner = owners[0].user_id;
    const existing = db.prepare("SELECT pending,preserve_identity FROM garmin_connection_cleanup WHERE user_id=? AND connection_id='pilot'").get(owner);
    if (existing && (existing.pending !== legacy.pending || existing.preserve_identity !== legacy.preserve_identity)) {
      db.prepare('INSERT OR IGNORE INTO garmin_legacy_cleanup_quarantine(id) VALUES (1)').run();
      return { status: 'ambiguous', code: 'garmin_legacy_cleanup_conflict' };
    }
    db.prepare(`INSERT OR IGNORE INTO garmin_connection_cleanup
      (user_id,connection_id,pending,preserve_identity,updated_at) VALUES (?,'pilot',?,?,?)`)
      .run(owner, legacy.pending, legacy.preserve_identity, legacy.updated_at);
    db.prepare('DELETE FROM garmin_cleanup_state WHERE id=1').run();
    return { status: 'migrated', ownerId: owner, connectionId: 'pilot' };
  }).immediate();
}

module.exports = { migrateCleanupState };
