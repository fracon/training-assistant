'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  first_name     TEXT,
  last_name      TEXT,
  preferred_lang TEXT    NOT NULL DEFAULT 'en-US',
  first_day_of_week TEXT NOT NULL DEFAULT 'Monday',
  distance_unit TEXT NOT NULL DEFAULT 'km',
  temperature_unit TEXT NOT NULL DEFAULT 'C',
  onboarding_status TEXT NOT NULL DEFAULT 'active',
  onboarding_guide_hidden INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trainings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  training_cycle_id TEXT REFERENCES training_cycles(id) ON DELETE SET NULL,
  dia         TEXT NOT NULL,
  periodo     TEXT,
  tipo        TEXT NOT NULL,
  treino      TEXT,
  detalhes    TEXT,
  fc_alvo     TEXT,
  rpe         TEXT,
  tenis       TEXT,
  previsao    TEXT,
  observacoes TEXT,
  location    TEXT,
  feedback_rpe   INTEGER,
  feedback_notas TEXT,
  completed       INTEGER NOT NULL DEFAULT 0,
  has_smartwatch     INTEGER NOT NULL DEFAULT 1,
  feedback_shoe      TEXT,
  feedback_shoe_id   TEXT REFERENCES shoes(id) ON DELETE SET NULL,
  feedback_hr_source TEXT,
  feedback_weather   TEXT,
  feedback_terrain   TEXT,
  feedback_breathing TEXT,
  feedback_muscle    TEXT,
  feedback_energy    TEXT,
  feedback_has_pain  TEXT,
  feedback_pain      TEXT,
  fit_duration       TEXT,
  fit_distance       REAL,
  fit_avg_pace       TEXT,
  fit_avg_hr         INTEGER,
  fit_max_hr         INTEGER,
  fit_elevation_gain REAL,
  fit_calories       INTEGER,
  fit_summary_json   TEXT,
  result_data_source TEXT NOT NULL DEFAULT 'none',
  created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shoes (
  id             TEXT    PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand          TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  mileage        REAL    NOT NULL DEFAULT 0.0,
  base_mileage   REAL    NOT NULL DEFAULT 0.0,
  target_mileage REAL,
  status         TEXT    NOT NULL DEFAULT 'active',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_shoe_mileage (
  training_id INTEGER PRIMARY KEY REFERENCES trainings(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shoe_id     TEXT    NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
  distance    REAL    NOT NULL CHECK (distance > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_coach_availability (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL CHECK (day_key IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  can_train INTEGER NOT NULL CHECK (can_train IN (0, 1)),
  available_periods TEXT NOT NULL DEFAULT '[]',
  available_minutes INTEGER,
  location TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day_key),
  CHECK ((can_train = 0 AND available_periods = '[]' AND available_minutes IS NULL AND location = '') OR
    (can_train = 1 AND typeof(available_minutes) = 'integer' AND available_minutes BETWEEN 1 AND 720 AND TRIM(location) <> ''))
);

CREATE TABLE IF NOT EXISTS training_cycles (
  id             TEXT    PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  objective      TEXT,
  target_date    TEXT,
  distance       TEXT,
  run_before     TEXT,
  run_count      INTEGER,
  primary_goal   TEXT,
  secondary_goal TEXT,
  start_date     TEXT,
  other_events   TEXT,
  status         TEXT    NOT NULL DEFAULT 'active',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id              INTEGER PRIMARY KEY,
  author_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_email    TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('bug', 'suggestion', 'other')),
  description     TEXT NOT NULL,
  pathname        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
  internal_note   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);
`;

function resolveDatabaseFile(cwd) {
  return path.join(cwd, 'data', 'database.sqlite');
}

function ensureTrainingResultEvidenceIdentity(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_result_evidence'").get();
  const requiredColumns = ['user_id', 'training_id', 'evidence_type', 'evidence_value', 'source'];
  const columns = table ? db.prepare('PRAGMA table_info(training_result_evidence)').all() : [];
  if (!table || requiredColumns.some((name) => !columns.some((column) => column.name === name))) {
    throw new Error('Cannot repair training_result_evidence: required table or identity columns are missing. Restore the table from backup or run a reviewed schema repair.');
  }
  const indexes = db.prepare('PRAGMA index_list(training_result_evidence)').all();
  const indexColumns = (index) => db.prepare(`PRAGMA index_xinfo("${index.name.replaceAll('"', '""')}")`).all()
    .filter((column) => column.key === 1);
  const isIdentityIndex = (index) => {
    if (!index.unique || index.partial) return false;
    const key = indexColumns(index);
    return key.length === requiredColumns.length
      && key.every((column, position) => column.name === requiredColumns[position] && column.coll === 'BINARY' && column.desc === 0);
  };
  const matchesIdentity = indexes.some(isIdentityIndex);
  const legacyFourColumnKey = indexes.find((index) => index.unique && !index.partial
    && JSON.stringify(indexColumns(index).map((column) => column.name))
      === JSON.stringify(requiredColumns.slice(0, 4)));
  const repairIndex = indexes.find((index) => index.name === 'idx_training_result_evidence_identity_v2');
  if (repairIndex && !isIdentityIndex(repairIndex)) {
    throw new Error('Cannot repair training_result_evidence: idx_training_result_evidence_identity_v2 exists with an incompatible definition. No evidence rows were changed; review the index and retry migration.');
  }
  const unsupportedUniqueIndexes = indexes.filter((index) => index.unique && !index.partial
    && index !== legacyFourColumnKey && !isIdentityIndex(index));
  if (unsupportedUniqueIndexes.length) {
    throw new Error('Cannot repair training_result_evidence: it has an unrecognized UNIQUE constraint. No evidence rows were changed; review the index definition before retrying migration.');
  }
  if (legacyFourColumnKey) {
    const expectedColumns = ['id','user_id','training_id','evidence_type','evidence_value','source','is_current','created_at'];
    if (JSON.stringify(columns.map((column) => column.name)) !== JSON.stringify(expectedColumns)) {
      throw new Error('Cannot safely rebuild training_result_evidence: its legacy columns differ from the known v1 schema. No evidence rows were changed; review the table and restore from backup if needed.');
    }
    const unexpectedIndexes = indexes.filter((index) => index.origin === 'c'
      && !['idx_training_result_evidence_training','idx_training_result_evidence_current_identity','idx_training_result_evidence_identity_v2'].includes(index.name));
    if (unexpectedIndexes.length) {
      throw new Error('Cannot safely rebuild training_result_evidence: it has additional custom indexes. No evidence rows were changed; review those indexes before retrying migration.');
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(training_result_evidence)').all();
    const hasRequiredForeignKeys = foreignKeys.some((key) => key.table === 'users' && key.from === 'user_id' && key.to === 'id' && key.on_delete === 'CASCADE')
      && foreignKeys.some((key) => key.table === 'trainings' && key.from === 'training_id' && key.to === 'id' && key.on_delete === 'CASCADE');
    if (!hasRequiredForeignKeys || db.prepare('PRAGMA foreign_key_check(training_result_evidence)').all().length) {
      throw new Error('Cannot safely rebuild training_result_evidence: required ownership foreign keys or row references are invalid. No evidence rows were changed; review the table before retrying migration.');
    }
    const currentDuplicates = db.prepare(`SELECT COUNT(*) AS groups FROM (
      SELECT 1 FROM training_result_evidence WHERE is_current=1
      GROUP BY user_id,evidence_type,evidence_value HAVING COUNT(*) > 1
    )`).get().groups;
    if (currentDuplicates) {
      throw new Error(`Cannot safely rebuild training_result_evidence: ${currentDuplicates} duplicate current identity group(s) prevent its uniqueness constraint. No evidence rows were changed; resolve the ambiguity and retry migration.`);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_result_evidence_repair_v1'").get()) {
      throw new Error('Cannot safely rebuild training_result_evidence: a prior repair table exists. No evidence rows were changed; review it before retrying migration.');
    }
    db.exec(`DROP INDEX IF EXISTS idx_training_result_evidence_training;
      DROP INDEX IF EXISTS idx_training_result_evidence_current_identity;
      ALTER TABLE training_result_evidence RENAME TO training_result_evidence_repair_v1;
      CREATE TABLE training_result_evidence (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('fit_sha256','fit_file_id','garmin_activity')),
        evidence_value TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('fit_upload','garmin_connect')),
        is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id,training_id,evidence_type,evidence_value,source)
      );
      INSERT INTO training_result_evidence
        (id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at)
        SELECT id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at
        FROM training_result_evidence_repair_v1;
      DROP TABLE training_result_evidence_repair_v1;
      CREATE INDEX idx_training_result_evidence_training
        ON training_result_evidence(user_id,training_id,is_current);
      CREATE UNIQUE INDEX idx_training_result_evidence_current_identity
        ON training_result_evidence(user_id,evidence_type,evidence_value) WHERE is_current=1;`);
  } else if (!matchesIdentity) {
    const duplicates = db.prepare(`SELECT COUNT(*) AS groups FROM (
      SELECT 1 FROM training_result_evidence
      GROUP BY user_id,training_id,evidence_type,evidence_value,source HAVING COUNT(*) > 1
    )`).get().groups;
    if (duplicates) {
      throw new Error(`Cannot repair training_result_evidence: ${duplicates} duplicate identity group(s) prevent a unique index. No evidence rows were changed; resolve the ambiguity and retry migration.`);
    }
    db.exec(`CREATE UNIQUE INDEX idx_training_result_evidence_identity_v2
      ON training_result_evidence(user_id,training_id,evidence_type,evidence_value,source)`);
  }
}

function migrateDatabase(db) {
  const columns = db.pragma('table_info(users)');
  if (!columns.some((column) => column.name === 'role')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))",
    );
  }
  if (!columns.some((column) => column.name === 'preferred_lang')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN preferred_lang TEXT NOT NULL DEFAULT 'en-US'",
    );
  }
  if (!columns.some((column) => column.name === 'first_day_of_week')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN first_day_of_week TEXT NOT NULL DEFAULT 'Monday'",
    );
  }
  if (!columns.some((column) => column.name === 'distance_unit')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN distance_unit TEXT NOT NULL DEFAULT 'km'",
    );
  }
  if (!columns.some((column) => column.name === 'temperature_unit')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN temperature_unit TEXT NOT NULL DEFAULT 'C'",
    );
  }
  if (!columns.some((column) => column.name === 'onboarding_status')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'legacy'",
    );
  }
  if (!columns.some((column) => column.name === 'onboarding_guide_hidden')) {
    db.exec(
      'ALTER TABLE users ADD COLUMN onboarding_guide_hidden INTEGER NOT NULL DEFAULT 0',
    );
  }
  // Accounts present before the two-state onboarding model were assigned
  // `legacy`; treat them as active without changing their presentation choices.
  db.prepare(
    "UPDATE users SET onboarding_status = 'active' WHERE onboarding_status = 'legacy'",
  ).run();

  const trainingColumns = db.pragma('table_info(trainings)');
  const hasShoesTable = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shoes'",
      )
      .get(),
  );
  if (!trainingColumns.some((column) => column.name === 'feedback_rpe')) {
    db.exec('ALTER TABLE trainings ADD COLUMN feedback_rpe INTEGER');
  }
  if (!trainingColumns.some((column) => column.name === 'feedback_notas')) {
    db.exec('ALTER TABLE trainings ADD COLUMN feedback_notas TEXT');
  }
  if (!trainingColumns.some((column) => column.name === 'completed')) {
    db.exec(
      'ALTER TABLE trainings ADD COLUMN completed INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!trainingColumns.some((column) => column.name === 'has_smartwatch')) {
    db.exec(
      'ALTER TABLE trainings ADD COLUMN has_smartwatch INTEGER NOT NULL DEFAULT 1',
    );
  }
  for (const [name, type] of [
    ['feedback_shoe', 'TEXT'],
    [
      'feedback_shoe_id',
      hasShoesTable ? 'TEXT REFERENCES shoes(id) ON DELETE SET NULL' : 'TEXT',
    ],
    ['feedback_hr_source', 'TEXT'],
    ['feedback_weather', 'TEXT'],
    ['feedback_terrain', 'TEXT'],
    ['feedback_breathing', 'TEXT'],
    ['feedback_muscle', 'TEXT'],
    ['feedback_energy', 'TEXT'],
    ['feedback_has_pain', 'TEXT'],
    ['feedback_pain', 'TEXT'],
    ['fit_duration', 'TEXT'],
    ['fit_distance', 'REAL'],
    ['fit_avg_pace', 'TEXT'],
    ['fit_avg_hr', 'INTEGER'],
    ['fit_max_hr', 'INTEGER'],
    ['fit_elevation_gain', 'REAL'],
    ['fit_calories', 'INTEGER'],
    ['fit_summary_json', 'TEXT'],
    ['result_data_source', "TEXT NOT NULL DEFAULT 'none'"],
  ]) {
    if (!trainingColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE trainings ADD COLUMN ${name} ${type}`);
    }
  }

  if (!trainingColumns.some((column) => column.name === 'location')) {
    db.exec('ALTER TABLE trainings ADD COLUMN location TEXT');
  }

  // Link legacy labels without changing the authoritative mileage users have
  // already entered. Historical distances are deliberately not put in the
  // ledger because whether they are already included cannot be inferred.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS garmin_workout_prescriptions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      prescription_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, training_id)
    );
    CREATE TABLE IF NOT EXISTS garmin_training_operations (
      operation_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
      prescription_revision INTEGER NOT NULL CHECK (prescription_revision > 0),
      fingerprint TEXT NOT NULL,
      converter_version INTEGER NOT NULL CHECK (converter_version > 0),
      status TEXT NOT NULL CHECK (status IN ('publishing','workout_created','scheduling','scheduled','reauth_required','failed','outcome_unknown','outdated')),
      stage TEXT NOT NULL,
      workout_id TEXT,
      occurrence_id TEXT,
      scheduled_date TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'publish' CHECK (action IN ('publish','update','reschedule')),
      source_operation_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (source_operation_id IS NULL OR source_operation_id <> operation_id)
    );
    CREATE TABLE IF NOT EXISTS garmin_pilot_connections (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      connection_generation INTEGER NOT NULL DEFAULT 1 CHECK (connection_generation > 0),
      identity_fingerprint TEXT,
      cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS garmin_cleanup_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0,1)),
      -- User-initiated disconnect preserves the non-secret identity fingerprint
      -- so reconnecting the same Garmin account can retain its provenance.
      preserve_identity INTEGER NOT NULL DEFAULT 0 CHECK (preserve_identity IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cleanupColumns = db.prepare('PRAGMA table_info(garmin_cleanup_state)').all().map((row) => row.name);
  if (!cleanupColumns.includes('preserve_identity')) {
    db.exec('ALTER TABLE garmin_cleanup_state ADD COLUMN preserve_identity INTEGER NOT NULL DEFAULT 0 CHECK (preserve_identity IN (0,1))');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run('2026-11-garmin-cleanup-identity-v1');
  db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(
    '2026-10-garmin-session-publish-v1',
  );
  const garminV2 = '2026-10-garmin-session-publish-v2';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(garminV2)) {
    const operationColumns = db.prepare('PRAGMA table_info(garmin_training_operations)').all().map((row) => row.name);
    if (!operationColumns.includes('action') || !operationColumns.includes('source_operation_id')) {
      db.exec(`CREATE TABLE garmin_training_operations_v2 (
        operation_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
        prescription_revision INTEGER NOT NULL CHECK (prescription_revision > 0),
        fingerprint TEXT NOT NULL,
        converter_version INTEGER NOT NULL CHECK (converter_version > 0),
        status TEXT NOT NULL CHECK (status IN ('publishing','workout_created','scheduling','scheduled','reauth_required','failed','outcome_unknown','outdated')),
        stage TEXT NOT NULL,
        workout_id TEXT,
        occurrence_id TEXT,
        scheduled_date TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'publish' CHECK (action IN ('publish','update','reschedule')),
        source_operation_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (source_operation_id IS NULL OR source_operation_id <> operation_id)
      );
      INSERT INTO garmin_training_operations_v2 (
        operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,
        status,stage,workout_id,occurrence_id,scheduled_date,error_code,created_at,updated_at
      ) SELECT operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,
        status,stage,workout_id,occurrence_id,scheduled_date,error_code,created_at,updated_at
        FROM garmin_training_operations;
      DROP TABLE garmin_training_operations;
      ALTER TABLE garmin_training_operations_v2 RENAME TO garmin_training_operations;`);
    }
    const connectionColumns = db.prepare('PRAGMA table_info(garmin_pilot_connections)').all().map((row) => row.name);
    if (!connectionColumns.includes('identity_fingerprint')) db.exec('ALTER TABLE garmin_pilot_connections ADD COLUMN identity_fingerprint TEXT');
    if (!connectionColumns.includes('cleanup_pending')) db.exec('ALTER TABLE garmin_pilot_connections ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0,1))');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS garmin_operation_identity_v2
      ON garmin_training_operations(user_id,training_id,connection_generation,prescription_revision,scheduled_date,action);
      CREATE INDEX IF NOT EXISTS garmin_cleanup_pending_v1 ON garmin_pilot_connections(cleanup_pending);`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(garminV2);
  }
  require('../garmin/cleanup-state').migrateCleanupState(db);
  const cleanupFenceColumns = db.prepare('PRAGMA table_info(garmin_connection_cleanup)').all().map(row => row.name);
  if (!cleanupFenceColumns.includes('auth_fence')) db.exec('ALTER TABLE garmin_connection_cleanup ADD COLUMN auth_fence TEXT');
  const authTransitionColumns = db.prepare('PRAGMA table_info(garmin_pilot_connections)').all().map(row => row.name);
  if (!authTransitionColumns.includes('auth_attempt')) db.exec('ALTER TABLE garmin_pilot_connections ADD COLUMN auth_attempt TEXT');
  if (!authTransitionColumns.includes('auth_fence')) db.exec('ALTER TABLE garmin_pilot_connections ADD COLUMN auth_fence TEXT');
  if (!authTransitionColumns.includes('auth_expected')) db.exec('ALTER TABLE garmin_pilot_connections ADD COLUMN auth_expected TEXT');
  const activityImportMarker = '2026-11-garmin-activity-import-v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(activityImportMarker)) {
    const initializeActivityImports = db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS garmin_activity_imports (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        account_fingerprint TEXT NOT NULL CHECK (length(account_fingerprint) = 64),
        activity_id TEXT NOT NULL,
        file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
        importer_version INTEGER NOT NULL CHECK (importer_version > 0),
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_fingerprint, activity_id)
      );`);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(activityImportMarker);
    });
    initializeActivityImports.immediate();
  }
  const activityImportRepairMarker = '2026-11-garmin-activity-import-v2';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(activityImportRepairMarker)) {
    const repairActivityImports = db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='garmin_activity_imports'").get();
      if (!exists) {
        throw new Error('Garmin activity import repair cannot find its v1 table; restore the database backup or contact the operator.');
      }
      const columns = db.prepare('PRAGMA table_info(garmin_activity_imports)').all();
      const names = new Set(columns.map((column) => column.name));
      const required = ['id', 'user_id', 'training_id', 'account_fingerprint', 'activity_id',
        'file_sha256', 'importer_version', 'imported_at'];
      const missing = required.filter((name) => !names.has(name));
      if (missing.length) {
        throw new Error(`Garmin activity import repair found an incomplete v1 table (missing ${missing.join(', ')}); no records were changed.`);
      }
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(garmin_activity_imports)').all();
      const hasOwnerForeignKey = foreignKeys.some((key) => key.table === 'users' && key.from === 'user_id' && key.to === 'id' && key.on_delete === 'CASCADE');
      const hasTrainingForeignKey = foreignKeys.some((key) => key.table === 'trainings' && key.from === 'training_id' && key.to === 'id' && key.on_delete === 'CASCADE');
      if (!hasOwnerForeignKey || !hasTrainingForeignKey) {
        throw new Error('Garmin activity import repair found incompatible ownership foreign keys; no records were changed. Restore a compatible schema or contact the operator.');
      }

      if (!names.has('is_current')) {
        // The old schema has no persisted pointer to say which import currently
        // supplies a training result. Keep every row as history; only a later
        // explicit import confirmation may establish a current binding.
        db.exec('ALTER TABLE garmin_activity_imports ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1))');
      } else {
        const currentColumn = columns.find((column) => column.name === 'is_current');
        const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='garmin_activity_imports'").get().sql;
        if (String(currentColumn.type).toUpperCase() !== 'INTEGER' || currentColumn.notnull !== 1
            || !/CHECK\s*\(\s*is_current\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql)) {
          throw new Error('Garmin activity import repair found an invalid is_current constraint; no records were changed. Restore a compatible schema or contact the operator.');
        }
      }

      const duplicateIdentity = db.prepare(`SELECT 1 FROM garmin_activity_imports
        GROUP BY account_fingerprint,activity_id HAVING COUNT(*)>1 LIMIT 1`).get();
      if (duplicateIdentity) {
        throw new Error('Garmin activity import repair cannot add the account/activity uniqueness constraint because duplicate identities exist; no records were changed. Preserve a backup and reconcile those records before retrying.');
      }
      const duplicateCurrent = db.prepare(`SELECT 1 FROM garmin_activity_imports WHERE is_current=1
        GROUP BY user_id,training_id HAVING COUNT(*)>1 LIMIT 1`).get();
      if (duplicateCurrent) {
        throw new Error('Garmin activity import repair cannot add the current-binding constraint because a session has multiple current activities; no records were changed. Preserve a backup and reconcile those records before retrying.');
      }

      const indexRows = () => db.prepare('PRAGMA index_list(garmin_activity_imports)').all();
      const indexColumns = (name) => db.prepare(`PRAGMA index_xinfo(${JSON.stringify(name)})`).all()
        .filter((column) => column.key === 1).map((column) => ({ name: column.name, desc: column.desc }));
      const dropIndex = (name) => {
        if (indexRows().some((index) => index.name === name)) db.exec(`DROP INDEX ${JSON.stringify(name)}`);
      };
      const trainingIndexName = 'idx_garmin_activity_import_training';
      const trainingIndex = indexRows().find((index) => index.name === trainingIndexName);
      if (trainingIndex && (trainingIndex.unique || JSON.stringify(indexColumns(trainingIndexName))
          !== JSON.stringify([{ name: 'user_id', desc: 0 }, { name: 'training_id', desc: 0 }, { name: 'imported_at', desc: 1 }]))) {
        dropIndex(trainingIndexName);
      }
      if (!indexRows().some((index) => index.name === trainingIndexName)) {
        db.exec(`CREATE INDEX ${trainingIndexName} ON garmin_activity_imports(user_id,training_id,imported_at DESC)`);
      }

      const identityIndexName = 'idx_garmin_activity_import_identity';
      const identityIndex = indexRows().find((index) => index.name === identityIndexName);
      if (identityIndex && (!identityIndex.unique || identityIndex.partial
          || JSON.stringify(indexColumns(identityIndexName)) !== JSON.stringify([
            { name: 'account_fingerprint', desc: 0 }, { name: 'activity_id', desc: 0 },
          ]))) dropIndex(identityIndexName);
      const hasIdentityUnique = indexRows().some((index) => index.unique && !index.partial
        && JSON.stringify(indexColumns(index.name)) === JSON.stringify([
          { name: 'account_fingerprint', desc: 0 }, { name: 'activity_id', desc: 0 },
        ]));
      if (!hasIdentityUnique) {
        db.exec(`CREATE UNIQUE INDEX ${identityIndexName} ON garmin_activity_imports(account_fingerprint,activity_id)`);
      }

      const currentIndexName = 'idx_garmin_activity_import_current_training';
      const currentIndex = indexRows().find((index) => index.name === currentIndexName);
      const currentSql = currentIndex ? db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(currentIndexName).sql : '';
      if (currentIndex && (!currentIndex.unique || !currentIndex.partial
          || JSON.stringify(indexColumns(currentIndexName)) !== JSON.stringify([{ name: 'user_id', desc: 0 }, { name: 'training_id', desc: 0 }])
          || !/WHERE\s+is_current\s*=\s*1\s*$/i.test(currentSql))) dropIndex(currentIndexName);
      if (!indexRows().some((index) => index.name === currentIndexName)) {
        db.exec(`CREATE UNIQUE INDEX ${currentIndexName} ON garmin_activity_imports(user_id,training_id) WHERE is_current=1`);
      }
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(activityImportRepairMarker);
    });
    repairActivityImports.immediate();
  }
  const activityImportHistoryMarker = '2026-11-garmin-activity-import-v3';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(activityImportHistoryMarker)) {
    const evolveActivityImportHistory = db.transaction(() => {
      const rows = db.prepare('PRAGMA table_info(garmin_activity_imports)').all();
      const columns = new Set(rows.map((row) => row.name));
      const required = ['id','user_id','training_id','account_fingerprint','activity_id','file_sha256','importer_version','is_current','imported_at'];
      const missing = required.filter((name) => !columns.has(name));
      if (missing.length) throw new Error(`Garmin activity history migration cannot continue; missing columns: ${missing.join(', ')}. No records were changed.`);
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(garmin_activity_imports)').all();
      if (!foreignKeys.some((key) => key.table === 'users' && key.from === 'user_id' && key.to === 'id' && key.on_delete === 'CASCADE')
          || !foreignKeys.some((key) => key.table === 'trainings' && key.from === 'training_id' && key.to === 'id' && key.on_delete === 'CASCADE')) {
        throw new Error('Garmin activity history migration found incompatible ownership foreign keys. No records were changed. Restore a compatible schema or contact the operator.');
      }
      const existingForeignKeyFailure = db.prepare('PRAGMA foreign_key_check(garmin_activity_imports)').get();
      if (existingForeignKeyFailure) throw new Error('Garmin activity history migration found an invalid owner or training reference. No records were changed; reconcile the referenced record before retrying.');
      const duplicateCurrentIdentity = db.prepare(`SELECT 1 FROM garmin_activity_imports WHERE is_current=1
        GROUP BY account_fingerprint,activity_id HAVING COUNT(*)>1 LIMIT 1`).get();
      if (duplicateCurrentIdentity) throw new Error('Garmin activity history migration found an activity currently linked to multiple sessions. No records were changed; reconcile the current links before retrying.');
      const duplicateSessionIdentity = db.prepare(`SELECT 1 FROM garmin_activity_imports
        GROUP BY user_id,training_id,account_fingerprint,activity_id HAVING COUNT(*)>1 LIMIT 1`).get();
      if (duplicateSessionIdentity) throw new Error('Garmin activity history migration found duplicate activity history for one session. No records were changed; reconcile duplicate history before retrying.');

      const indexes = db.prepare('PRAGMA index_list(garmin_activity_imports)').all();
      const indexedColumns = (name) => db.prepare(`PRAGMA index_xinfo(${JSON.stringify(name)})`).all()
        .filter((column) => column.key === 1).map((column) => column.name);
      const hasLegacyIdentityConstraint = indexes.some((index) => index.unique && !index.partial
        && JSON.stringify(indexedColumns(index.name)) === JSON.stringify(['account_fingerprint','activity_id']));
      if (hasLegacyIdentityConstraint) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='garmin_activity_imports_v3'").get()) {
          throw new Error('Garmin activity history migration found an unexpected intermediate table. No records were changed; contact the operator.');
        }
        db.exec(`CREATE TABLE garmin_activity_imports_v3 (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
          account_fingerprint TEXT NOT NULL CHECK (length(account_fingerprint) = 64),
          activity_id TEXT NOT NULL,
          file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
          importer_version INTEGER NOT NULL CHECK (importer_version > 0),
          is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
          imported_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO garmin_activity_imports_v3
          (id,user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current,imported_at)
          SELECT id,user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current,imported_at
          FROM garmin_activity_imports;
        DROP TABLE garmin_activity_imports;
        ALTER TABLE garmin_activity_imports_v3 RENAME TO garmin_activity_imports;`);
      }

      db.exec(`DROP INDEX IF EXISTS idx_garmin_activity_import_training;
        DROP INDEX IF EXISTS idx_garmin_activity_import_identity;
        DROP INDEX IF EXISTS idx_garmin_activity_import_current_training;
        DROP INDEX IF EXISTS idx_garmin_activity_import_current_identity;
        DROP INDEX IF EXISTS idx_garmin_activity_import_training_activity;
        CREATE INDEX idx_garmin_activity_import_training ON garmin_activity_imports(user_id,training_id,imported_at DESC);
        CREATE UNIQUE INDEX idx_garmin_activity_import_current_training ON garmin_activity_imports(user_id,training_id) WHERE is_current=1;
        CREATE UNIQUE INDEX idx_garmin_activity_import_current_identity ON garmin_activity_imports(account_fingerprint,activity_id) WHERE is_current=1;
        CREATE UNIQUE INDEX idx_garmin_activity_import_training_activity ON garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id);`);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(activityImportHistoryMarker);
    });
    evolveActivityImportHistory.immediate();
  }
  const ownerActivityMarker = '2026-11-garmin-activity-owner-v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(ownerActivityMarker)) {
    db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_garmin_activity_import_current_identity;
        CREATE UNIQUE INDEX idx_garmin_activity_import_current_identity
          ON garmin_activity_imports(user_id,account_fingerprint,activity_id) WHERE is_current=1;`);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(ownerActivityMarker);
    }).immediate();
  }
  const resultEvidenceMarker = '2026-11-training-result-evidence-v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(resultEvidenceMarker)) {
    const addResultEvidence = db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS training_result_evidence (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('fit_sha256','fit_file_id','garmin_activity')),
        evidence_value TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('fit_upload','garmin_connect')),
        is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id,training_id,evidence_type,evidence_value,source)
      );
      CREATE INDEX IF NOT EXISTS idx_training_result_evidence_training
        ON training_result_evidence(user_id,training_id,is_current);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_training_result_evidence_current_identity
        ON training_result_evidence(user_id,evidence_type,evidence_value) WHERE is_current=1;`);
      // Only Garmin's account-qualified activity identifier is recoverable from
      // legacy rows. FIT bytes and stable FIT file IDs are never inferred.
      db.exec(`INSERT OR IGNORE INTO training_result_evidence
        (user_id,training_id,evidence_type,evidence_value,source,is_current,created_at)
        SELECT user_id,training_id,'garmin_activity',account_fingerprint || ':' || activity_id,
          'garmin_connect',is_current,imported_at FROM garmin_activity_imports`);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(resultEvidenceMarker);
    });
    addResultEvidence.immediate();
  }
  // V2 repairs the source-less key shape when first encountered. V3 repeats
  // this idempotent check because early v2 builds could have marked the index
  // as repaired without removing the legacy, stricter four-column constraint.
  const evidenceRepairMarker = '2026-11-training-result-evidence-v2';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(evidenceRepairMarker)) {
    const repairEvidenceIdentity = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(evidenceRepairMarker)) return;
      ensureTrainingResultEvidenceIdentity(db);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(evidenceRepairMarker);
    });
    repairEvidenceIdentity.immediate();
  }
  const evidenceRepairFollowup = '2026-11-training-result-evidence-v3';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(evidenceRepairFollowup)) {
    const finishEvidenceRepair = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(evidenceRepairFollowup)) return;
      ensureTrainingResultEvidenceIdentity(db);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(evidenceRepairFollowup);
    });
    finishEvidenceRepair.immediate();
  }
  const garminV3 = '2026-10-garmin-session-publish-v3';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(garminV3)) {
    db.exec(`DROP INDEX IF EXISTS garmin_operation_identity_v2;
      CREATE UNIQUE INDEX garmin_operation_identity_v3 ON garmin_training_operations(
        user_id,training_id,connection_generation,prescription_revision,scheduled_date,action,
        COALESCE(source_operation_id,''),COALESCE(occurrence_id,''));`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(garminV3);
  }
  const garminV4 = '2026-10-garmin-session-publish-v4';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(garminV4)) {
    // occurrence_id is filled after dispatch. It cannot be part of the idempotency
    // key or a second click would acquire a different identity after first success.
    // source_operation_id already scopes each explicitly linked reschedule.
    db.exec(`DROP INDEX IF EXISTS garmin_operation_identity_v3;
      CREATE UNIQUE INDEX garmin_operation_identity_v4 ON garmin_training_operations(
        user_id,training_id,connection_generation,prescription_revision,scheduled_date,action,
        COALESCE(source_operation_id,''));`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(garminV4);
  }
  const roleMarker = '2026-09-user-roles-v1';
  const migrateRoles = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(roleMarker)
    )
      return;
    // Existing rows receive the column's user default; never infer or assign admins.
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      roleMarker,
    );
  });
  migrateRoles();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_coach_availability (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL CHECK (day_key IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
    can_train INTEGER NOT NULL CHECK (can_train IN (0, 1)),
    available_periods TEXT NOT NULL DEFAULT '[]',
    available_minutes INTEGER,
    location TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, day_key),
    CHECK ((can_train = 0 AND available_periods = '[]' AND available_minutes IS NULL AND location = '') OR
      (can_train = 1 AND typeof(available_minutes) = 'integer' AND available_minutes BETWEEN 1 AND 720 AND TRIM(location) <> ''))
  )`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(
    '2026-09-structured-ai-coach-availability-v1',
  );
  if (
    hasShoesTable &&
    !db
      .pragma('table_info(shoes)')
      .some((column) => column.name === 'base_mileage')
  ) {
    db.exec(
      'ALTER TABLE shoes ADD COLUMN base_mileage REAL NOT NULL DEFAULT 0.0',
    );
  }
  const shoeColumns = db
    .pragma('table_info(shoes)')
    .map((column) => column.name);
  const canRepairShoes = [
    'id',
    'user_id',
    'brand',
    'model',
    'mileage',
    'base_mileage',
    'updated_at',
  ].every((name) => shoeColumns.includes(name));
  const repair = db.transaction(() => {
    const marker = '2026-09-shoe-mileage-accounting-v1';
    if (
      db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(marker)
    )
      return;
    db.exec(`
      UPDATE trainings
         SET feedback_shoe_id = (
           SELECT MIN(s.id) FROM shoes s
            WHERE s.user_id = trainings.user_id
              AND TRIM(s.brand || ' ' || s.model) = TRIM(trainings.feedback_shoe)
         )
       WHERE feedback_shoe_id IS NULL
         AND COALESCE(TRIM(feedback_shoe), '') <> ''
         AND 1 = (SELECT COUNT(*) FROM shoes s
                   WHERE s.user_id = trainings.user_id
                     AND TRIM(s.brand || ' ' || s.model) = TRIM(trainings.feedback_shoe));

      UPDATE shoes SET base_mileage = mileage, updated_at = datetime('now');
    `);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(marker);
  });
  if (canRepairShoes) repair();

  // Repair databases that briefly used a derived baseline without a ledger.
  // The current total remains authoritative; resetting the non-negative base
  // to that total and starting an empty ledger avoids inventing history.
  const ledgerMarker = '2026-09-shoe-mileage-ledger-v2';
  const initializeLedger = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(ledgerMarker)
    )
      return;
    if (hasShoesTable && trainingColumns.length > 0) {
      db.exec(`CREATE TABLE IF NOT EXISTS training_shoe_mileage (
        training_id INTEGER PRIMARY KEY REFERENCES trainings(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shoe_id TEXT NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
        distance REAL NOT NULL CHECK (distance > 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    }
    if (canRepairShoes)
      db.exec('UPDATE shoes SET base_mileage = MAX(0, mileage)');
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      ledgerMarker,
    );
  });
  initializeLedger();

  // Existing results were necessarily uploaded FIT files before provenance was
  // introduced. Only classify unclassified rows, keeping repeat migrations
  // harmless and never overwriting a future supported source.
  db.prepare(
    `UPDATE trainings SET result_data_source = 'fit_upload'
     WHERE result_data_source = 'none' AND (
       COALESCE(TRIM(fit_summary_json), '') <> '' OR fit_duration IS NOT NULL OR
       fit_distance IS NOT NULL OR fit_avg_pace IS NOT NULL OR fit_avg_hr IS NOT NULL OR
       fit_max_hr IS NOT NULL OR fit_elevation_gain IS NOT NULL
     )`,
  ).run();

  // FIT pace was briefly stored as decimal minutes (for example 6.53), while
  // the application contract is elapsed minutes:seconds (6:32). Convert only
  // recognized old FIT values; repeated initialization is naturally idempotent.
  const oldFitPaces = db
    .prepare(
      "SELECT id, fit_avg_pace FROM trainings WHERE result_data_source = 'fit_upload' AND fit_avg_pace IS NOT NULL",
    )
    .all();
  const updateFitPace = db.prepare(
    'UPDATE trainings SET fit_avg_pace = ? WHERE id = ?',
  );
  for (const row of oldFitPaces) {
    const match = /^(\d+)\.(\d{2})$/.exec(String(row.fit_avg_pace));
    if (!match) continue;
    const minutes = Number(match[1]);
    const seconds = Math.round(Number(`0.${match[2]}`) * 60);
    updateFitPace.run(
      `${minutes + Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
      row.id,
    );
  }

  // The original migration covers FIT summaries in the no-source legacy shape.
  // The source-aware corrective migration below handles the source-tagged
  // records that the first implementation left untouched.
  const cadenceMarker = '2026-10-fit-cadence-two-foot-v1';
  const normalizeLegacyCadence = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(cadenceMarker)
    )
      return;
    const rows = db
      .prepare(
        "SELECT id, fit_summary_json FROM trainings WHERE result_data_source = 'fit_upload' AND fit_summary_json IS NOT NULL",
      )
      .all();
    const update = db.prepare(
      'UPDATE trainings SET fit_summary_json = ? WHERE id = ?',
    );
    for (const row of rows) {
      let summary;
      try {
        summary = JSON.parse(row.fit_summary_json);
      } catch {
        continue;
      }
      if (
        summary?.cadenceNormalization ||
        summary?.activity?.sport !== 'running' ||
        !Array.isArray(summary.laps)
      )
        continue;
      const cadenceLaps = summary.laps.filter(
        (lap) =>
          Number.isFinite(lap?.avgCadenceSpm) ||
          Number.isFinite(lap?.maxCadenceSpm),
      );
      if (
        cadenceLaps.length === 0 ||
        cadenceLaps.some(
          (lap) =>
            lap.avgCadenceSource !== undefined ||
            lap.maxCadenceSource !== undefined,
        )
      )
        continue;
      const normalized = {
        ...summary,
        cadenceNormalization: 'two-foot-spm-v1',
        laps: summary.laps.map((lap) => ({
          ...lap,
          avgCadenceSpm: Number.isFinite(lap.avgCadenceSpm)
            ? Math.round(lap.avgCadenceSpm * 2)
            : lap.avgCadenceSpm,
          maxCadenceSpm: Number.isFinite(lap.maxCadenceSpm)
            ? Math.round(lap.maxCadenceSpm * 2)
            : lap.maxCadenceSpm,
        })),
      };
      update.run(JSON.stringify(normalized), row.id);
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      cadenceMarker,
    );
  });
  normalizeLegacyCadence();

  // The first cadence migration intentionally skipped summaries carrying
  // source fields, but the pre-normalization parser wrote those fields beside
  // raw one-foot running cadence. Reconcile those histories independently by
  // metric, even when the first migration marker is already present. Unknown
  // sources remain untouched; per-field units make mixed summaries safe to
  // retry without assigning the summary-wide marker prematurely.
  const cadenceSourceMarker = '2026-10-fit-cadence-source-v2';
  const normalizeSourceTaggedCadence = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(cadenceSourceMarker)
    )
      return;
    const rows = db
      .prepare(
        "SELECT id, fit_summary_json FROM trainings WHERE result_data_source = 'fit_upload' AND fit_summary_json IS NOT NULL",
      )
      .all();
    const update = db.prepare(
      'UPDATE trainings SET fit_summary_json = ? WHERE id = ?',
    );
    const knownSources = {
      avgCadenceSpm: new Set(['avg_cadence_running', 'avg_running_cadence']),
      maxCadenceSpm: new Set(['max_cadence_running', 'max_running_cadence']),
    };
    for (const row of rows) {
      let summary;
      try {
        summary = JSON.parse(row.fit_summary_json);
      } catch {
        continue;
      }
      if (
        summary?.cadenceNormalization ||
        summary?.activity?.sport !== 'running' ||
        !Array.isArray(summary.laps)
      )
        continue;

      let changed = false;
      let hasNumericCadence = false;
      let hasUnnormalizedCadence = false;
      const laps = summary.laps.map((lap) => {
        if (!lap || typeof lap !== 'object' || Array.isArray(lap)) return lap;
        const normalizedLap = { ...lap };
        for (const [valueField, sources] of Object.entries(knownSources)) {
          const value = lap[valueField];
          if (!Number.isFinite(value)) continue;
          hasNumericCadence = true;
          const unitField =
            valueField === 'avgCadenceSpm'
              ? 'avgCadenceUnit'
              : 'maxCadenceUnit';
          if (Object.hasOwn(lap, unitField)) {
            if (lap[unitField] === 'two-foot-spm-v1') continue;
            hasUnnormalizedCadence = true;
            continue;
          }
          const sourceField =
            valueField === 'avgCadenceSpm'
              ? 'avgCadenceSource'
              : 'maxCadenceSource';
          const hasSource = Object.hasOwn(lap, sourceField);
          if (hasSource && !sources.has(lap[sourceField])) {
            hasUnnormalizedCadence = true;
            continue;
          }
          normalizedLap[valueField] = Math.round(value * 2);
          normalizedLap[unitField] = 'two-foot-spm-v1';
          changed = true;
        }
        return normalizedLap;
      });

      // Every retained numeric field was checked independently above. Do not
      // put a summary-wide marker on a mixed record; field markers carry the
      // conversion provenance for values we safely repaired.
      if (!changed) continue;
      const normalized = { ...summary, laps };
      if (hasNumericCadence && !hasUnnormalizedCadence)
        normalized.cadenceNormalization = 'two-foot-spm-v1';
      update.run(JSON.stringify(normalized), row.id);
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      cadenceSourceMarker,
    );
  });
  normalizeSourceTaggedCadence();

  const workoutsTable = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get('workouts');
  if (workoutsTable) {
    db.exec('DROP TABLE workouts');
  }

  const trainingsColumns = db.pragma('table_info(trainings)');
  if (
    trainingsColumns.length > 0 &&
    !trainingsColumns.some((column) => column.name === 'training_cycle_id')
  ) {
    db.exec('DELETE FROM trainings');
    db.exec(
      'ALTER TABLE trainings ADD COLUMN training_cycle_id TEXT REFERENCES training_cycles(id) ON DELETE SET NULL',
    );
  }

  // Administrative account audit trail. Identities are denormalized on purpose:
  // a deletion record must outlive the deleted account, so neither the actor nor
  // the target column may cascade with the users table. Only account
  // identification, action and date are stored — never a password, hash, session
  // token or any training data.
  const auditMarker = '2026-09-admin-account-audit-v1';
  const initializeAdminAudit = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(auditMarker)
    )
      return;
    db.exec(`CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY,
      actor_user_id INTEGER,
      actor_email TEXT NOT NULL DEFAULT '',
      target_user_id INTEGER,
      target_email TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL CHECK (action IN (
        'account_created', 'account_updated', 'account_role_changed', 'account_deleted',
        'account_activity_changed'
      )),
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      auditMarker,
    );
  });
  initializeAdminAudit();

  const feedbackMarker = '2026-09-feedback-v1';
  const initializeFeedback = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(feedbackMarker)
    )
      return;
    db.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY,
      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_email TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('bug', 'suggestion', 'other')),
      description TEXT NOT NULL,
      pathname TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
      internal_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )`);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      feedbackMarker,
    );
  });
  initializeFeedback();

  // Account activity. `users.is_active` is a constrained column whose default is
  // the active state, so adding it to an existing table leaves every account
  // active without rewriting a single row, and every creation path — public
  // registration, the web CRUD and `admin:bootstrap` — yields an active account
  // because none of them writes the column. A repeated migration rewrites
  // nothing. The state is unrelated to `onboarding_status`, cycle status or
  // shoe status: it only decides whether an account may sign in.
  //
  // SQLite cannot alter a CHECK constraint, so the audit trail is rebuilt with
  // the new activity action. The rebuild runs inside the same transaction as
  // the column, inside the marker guard, and copies the existing rows so the
  // earlier trail survives.
  const activityMarker = '2026-09-account-activity-v1';
  const initializeAccountActivity = db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
        .get(activityMarker)
    )
      return;
    if (
      !db
        .pragma('table_info(users)')
        .some((column) => column.name === 'is_active')
    ) {
      db.exec(
        'ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))',
      );
    }
    const auditSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_log'",
      )
      .get().sql;
    if (!auditSql.includes('account_activity_changed')) {
      db.exec(`
        CREATE TABLE admin_audit_log_activity (
          id INTEGER PRIMARY KEY,
          actor_user_id INTEGER,
          actor_email TEXT NOT NULL DEFAULT '',
          target_user_id INTEGER,
          target_email TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL CHECK (action IN (
            'account_created', 'account_updated', 'account_role_changed', 'account_deleted',
            'account_activity_changed'
          )),
          details TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO admin_audit_log_activity
          (id, actor_user_id, actor_email, target_user_id, target_email, action, details, created_at)
        SELECT id, actor_user_id, actor_email, target_user_id, target_email, action, details, created_at
          FROM admin_audit_log;
        DROP TABLE admin_audit_log;
        ALTER TABLE admin_audit_log_activity RENAME TO admin_audit_log;
      `);
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(
      activityMarker,
    );
  });
  initializeAccountActivity();
  require('../ai/schema').migrateAi(db);
  require('../ai/schema').migrateAiDiagnostics(db);
  require('../ai/schema').migrateAiRawOutputs(db);
  require('../ai/schema').migrateWeeklyWorkouts(db);
  require('../ai/schema').migrateWeeklyAvailabilityRevision(db);
  require('../ai/schema').migrateWorkoutAnalysis(db);
  require('../ai/schema').migrateWorkoutInterpretationIdentity(db);
  require('../ai/cycle-plan-migration').migrateCyclePlans(db);
}

function initializeDatabase(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateDatabase(db);
  return db;
}

function createDatabase({ filename } = {}) {
  if (!filename) {
    throw new TypeError(
      'filename is required: pass a file path or ":memory:".',
    );
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return initializeDatabase(new Database(filename));
}

module.exports = {
  SCHEMA,
  resolveDatabaseFile,
  initializeDatabase,
  migrateDatabase,
  createDatabase,
};
