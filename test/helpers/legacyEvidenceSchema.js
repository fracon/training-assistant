'use strict';

// Recreates the persisted v1 shape found during the read-only schema inspection:
// source exists, while the table UNIQUE constraint omits it.
function installLegacyEvidenceSchema(db, { includeLegacyUnique = true, includeCurrentIndex = true, includeForeignKeys = true } = {}) {
  const legacyUnique = includeLegacyUnique ? ',\n      UNIQUE(user_id,training_id,evidence_type,evidence_value)' : '';
  const currentIndex = includeCurrentIndex ? `CREATE UNIQUE INDEX idx_training_result_evidence_current_identity
      ON training_result_evidence(user_id,evidence_type,evidence_value) WHERE is_current=1;` : '';
  const userForeignKey = includeForeignKeys ? ' REFERENCES users(id) ON DELETE CASCADE' : '';
  const trainingForeignKey = includeForeignKeys ? ' REFERENCES trainings(id) ON DELETE CASCADE' : '';
  db.exec(`DROP INDEX IF EXISTS idx_training_result_evidence_training;
    DROP INDEX IF EXISTS idx_training_result_evidence_current_identity;
    ALTER TABLE training_result_evidence RENAME TO training_result_evidence_new;
    CREATE TABLE training_result_evidence (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL${userForeignKey},
      training_id INTEGER NOT NULL${trainingForeignKey},
      evidence_type TEXT NOT NULL CHECK (evidence_type IN ('fit_sha256','fit_file_id','garmin_activity')),
      evidence_value TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('fit_upload','garmin_connect')),
      is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))${legacyUnique}
    );
    INSERT INTO training_result_evidence
      SELECT id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at
      FROM training_result_evidence_new;
    DROP TABLE training_result_evidence_new;
    CREATE INDEX idx_training_result_evidence_training
      ON training_result_evidence(user_id,training_id,is_current);
    ${currentIndex}`);
  db.prepare("DELETE FROM schema_migrations WHERE name IN ('2026-11-training-result-evidence-v2','2026-11-training-result-evidence-v3')").run();
}

module.exports = { installLegacyEvidenceSchema };
