'use strict';

// Issue #80: AI cycle and weekly generation require a completed anamnesis.
// Synthetic accounts that generate get a minimal completed one: no answers
// beyond the status (every item reaches the model as "not_informed") and no
// sensitive consent. With no IDs, every existing account is completed.
const STAMP = '2026-01-01T00:00:00.000Z';

function completeAnamnesis(db, ...userIds) {
  const ids = userIds.length ? userIds : db.prepare('SELECT id FROM users').all().map((row) => row.id);
  const insert = db.prepare(`INSERT OR REPLACE INTO athlete_anamnesis
    (user_id, questionnaire_version, status, answers_json, sensitive_ai_consent, sensitive_ai_consent_at, revision, created_at, updated_at, completed_at)
    VALUES (?, 'anamnesis-v1', 'completed', '{}', 0, NULL, 1, ?, ?, ?)`);
  for (const id of ids) insert.run(id, STAMP, STAMP, STAMP);
}

// For suites whose synthetic accounts open application pages or create
// cycles, which require the completed anamnesis since the owner decision of
// 2026-11-14: every account inserted through this connection gets a minimal
// completed one (a TEMP trigger, so nothing persists beyond the connection).
// Suites about the anamnesis itself never use it.
function withCompletedAnamnesis(db) {
  db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS test_complete_anamnesis AFTER INSERT ON users BEGIN
    INSERT OR REPLACE INTO athlete_anamnesis
      (user_id, questionnaire_version, status, answers_json, sensitive_ai_consent, sensitive_ai_consent_at, revision, created_at, updated_at, completed_at)
      VALUES (NEW.id, 'anamnesis-v1', 'completed', '{}', 0, NULL, 1, '${STAMP}', '${STAMP}', '${STAMP}');
  END`);
  return db;
}

module.exports = { completeAnamnesis, withCompletedAnamnesis };
