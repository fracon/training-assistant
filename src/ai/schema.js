'use strict';
const { createHash } = require('node:crypto');

function migrateAi(db) {
  db.transaction(() => {
    const marker = '2026-10-ai-foundation-v1';
    if (
      db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(marker)
    )
      return;
    db.exec(`
      CREATE TABLE ai_profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        fields_json TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ai_memory (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('restriction','milestone','interruption','recommendation','interpretation','action')),
        authority TEXT NOT NULL CHECK(authority IN ('user_report','ai_interpretation','recommendation','user_action')),
        text TEXT NOT NULL,
        observed_on TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('current','resolved','unconfirmed')),
        source_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ai_memory_owner ON ai_memory(user_id, observed_on);
      CREATE TABLE ai_executions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('cycle','workouts','analysis')),
        resource_id TEXT,
        input_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        external_prompt TEXT NOT NULL,
        context_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','uncertain','cancelled','outdated')),
        response_json TEXT,
        usage_json TEXT,
        error_code TEXT,
        reserved_tokens INTEGER NOT NULL,
        charged_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_cost REAL NOT NULL,
        charged_cost REAL NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id,idempotency_key)
      );
      CREATE INDEX ai_execution_owner ON ai_executions(user_id,created_at);
      CREATE TABLE ai_global_usage (
        day TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE ai_usage (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,day)
      );
    `);
    db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(marker);
  }).immediate();
}
function migrateAiDiagnostics(db) {
  db.transaction(() => {
    const marker = '2026-10-ai-execution-diagnostics-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker))
      return;
    if (
      !db
        .pragma('table_info(ai_executions)')
        .some((column) => column.name === 'diagnostics_json')
    )
      db.exec(
        "ALTER TABLE ai_executions ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]'",
      );
    db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
  }).immediate();
}
function migrateWeeklyWorkouts(db) {
  db.transaction(() => {
    const marker = '2026-10-weekly-workouts-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker))
      return;
    db.exec(`CREATE TABLE IF NOT EXISTS weekly_workout_proposals (
      execution_id TEXT PRIMARY KEY REFERENCES ai_executions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,
      applied_at TEXT,
      application_json TEXT,
      created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS weekly_workout_owner ON weekly_workout_proposals(user_id,week_start,created_at);`);
    db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
  }).immediate();
}
function migrateWeeklyAvailabilityRevision(db) {
  db.transaction(() => {
    const marker = '2026-10-weekly-availability-revision-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker))
      return;
    const columns = db.pragma('table_info(ai_coach_availability)');
    if (!columns.some((column) => column.name === 'revision'))
      db.exec(
        'ALTER TABLE ai_coach_availability ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)',
      );
    db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
  }).immediate();
}
function migrateWorkoutAnalysis(db) {
  db.transaction(() => {
    const marker = '2026-10-workout-analysis-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker))
      return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_analysis_versions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        adapter_version TEXT NOT NULL,
        context_json TEXT NOT NULL,
        response_json TEXT,
        state TEXT NOT NULL DEFAULT 'queued',
        error_code TEXT,
        language TEXT NOT NULL CHECK(language IN ('pt-BR','en-US')),
        created_at TEXT NOT NULL,
        UNIQUE(user_id, training_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS workout_analysis_owner
        ON workout_analysis_versions(user_id,training_id,sequence DESC);
      CREATE TABLE IF NOT EXISTS ai_interpretations (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        analysis_id TEXT NOT NULL REFERENCES workout_analysis_versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('pattern','recommendation','attention')),
        text TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('pending','confirmed','corrected','dismissed','superseded')),
        correction_text TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id,kind,evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS ai_interpretation_owner
        ON ai_interpretations(user_id,disposition,updated_at DESC);
    `);
    db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
  }).immediate();
}
function migrateWorkoutInterpretationIdentity(db) {
  db.transaction(() => {
    const marker = '2026-10-workout-interpretation-identity-v2';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(marker)) return;
    const columns = db.pragma('table_info(ai_interpretations)');
    if (!columns.length) throw new Error('workout-analysis-v1 must be installed first');
    if (!columns.some((column) => column.name === 'content_hash')) {
      const rows = db.prepare('SELECT * FROM ai_interpretations ORDER BY id').all();
      db.exec(`CREATE TABLE ai_interpretations_v2 (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        analysis_id TEXT NOT NULL REFERENCES workout_analysis_versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('pattern','recommendation','attention')),
        text TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('pending','confirmed','corrected','dismissed','superseded')),
        correction_text TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id,kind,evidence_hash,content_hash)
      )`);
      const insert = db.prepare(`INSERT INTO ai_interpretations_v2
        (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,correction_text,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of rows) {
        const contentHash = createHash('sha256').update(JSON.stringify({ kind: row.kind, text: row.text })).digest('hex');
        insert.run(row.id,row.user_id,row.training_id,row.analysis_id,row.kind,row.text,row.evidence_json,row.evidence_key,row.evidence_hash,contentHash,row.disposition,row.correction_text,row.version,row.created_at,row.updated_at);
      }
      db.exec('DROP TABLE ai_interpretations; ALTER TABLE ai_interpretations_v2 RENAME TO ai_interpretations;');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ai_interpretation_owner
      ON ai_interpretations(user_id,disposition,updated_at DESC);
      CREATE TABLE IF NOT EXISTS ai_interpretation_replacements (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        replaced_interpretation_id TEXT NOT NULL REFERENCES ai_interpretations(id) ON DELETE CASCADE,
        replacement_interpretation_id TEXT NOT NULL REFERENCES ai_interpretations(id) ON DELETE CASCADE,
        replacement_analysis_id TEXT NOT NULL REFERENCES workout_analysis_versions(id) ON DELETE CASCADE,
        replaced_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(replaced_interpretation_id,replacement_interpretation_id)
      );
      CREATE INDEX IF NOT EXISTS ai_interpretation_replacement_owner
        ON ai_interpretation_replacements(user_id,replacement_analysis_id);`);
    db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
  }).immediate();
}
module.exports = {
  migrateAi,
  migrateAiDiagnostics,
  migrateWeeklyWorkouts,
  migrateWeeklyAvailabilityRevision,
  migrateWorkoutAnalysis,
  migrateWorkoutInterpretationIdentity,
};
