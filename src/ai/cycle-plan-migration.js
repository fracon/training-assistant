'use strict';
function migrateCyclePlans(db) {
  db.transaction(()=>{
    // Legacy partial databases may not have cycles until initializeDatabase runs SCHEMA.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_cycles'").get()) return;
    const marker='2026-10-cycle-planning-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker)) return;
    db.exec(`ALTER TABLE training_cycles ADD COLUMN planning_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE cycle_plan_proposals (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cycle_id TEXT NOT NULL REFERENCES training_cycles(id) ON DELETE CASCADE,
        execution_id TEXT UNIQUE REFERENCES ai_executions(id) ON DELETE SET NULL,
        sequence INTEGER NOT NULL, base_version INTEGER NOT NULL,
        plan_json TEXT, created_at TEXT NOT NULL,
        UNIQUE(cycle_id,sequence)
      );
      CREATE TABLE cycle_plan_versions (
        id TEXT PRIMARY KEY REFERENCES cycle_plan_proposals(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cycle_id TEXT NOT NULL REFERENCES training_cycles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, plan_json TEXT NOT NULL,
        context_hash TEXT NOT NULL, cycle_hash TEXT NOT NULL, fingerprint_json TEXT NOT NULL,
        sources_json TEXT NOT NULL, applied_at TEXT NOT NULL,
        UNIQUE(cycle_id,version)
      );
      CREATE INDEX cycle_plan_owner ON cycle_plan_proposals(user_id,cycle_id,sequence);`);
    db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(marker);
  }).immediate();
}
module.exports={migrateCyclePlans};
