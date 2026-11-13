'use strict';

// AI-suggested structured workouts (issue #78). A suggestion is a reviewable
// draft bound to the exact generation that produced it; it never replaces the
// canonical garmin_workout_prescriptions row on its own. Only an explicit save
// that names the pending suggestion accepts it, and only an explicit dismiss
// discards it. Every read and write is scoped to the owning account.
const { createHash } = require('node:crypto');
const { convertSessionStructure } = require('./workout-structure');
const { prescriptionFingerprint, previewPrescription } = require('../garmin-workout-contract');

function detailsHash(details) {
  return createHash('sha256').update(String(details ?? '')).digest('hex');
}

// Called inside the weekly application transaction. Supersedes an older
// pending suggestion for the same session instead of overwriting it, and
// never touches the canonical prescription.
function recordSuggestion(db, {
  userId, trainingId, executionId, sessionIndex, responseHash, version, session, name, details, now,
}) {
  const converted = convertSessionStructure(session, { name, version });
  const previous = db.prepare(
    "SELECT id FROM training_structure_suggestions WHERE user_id=? AND training_id=? AND status='pending_review'",
  ).get(userId, trainingId);
  if (previous)
    db.prepare(
      "UPDATE training_structure_suggestions SET status='superseded',revision=revision+1,decided_at=? WHERE id=? AND user_id=?",
    ).run(now, previous.id, userId);
  const hasPrescription = Boolean(db.prepare(
    'SELECT 1 FROM garmin_workout_prescriptions WHERE user_id=? AND training_id=?',
  ).get(userId, trainingId));
  db.prepare(`INSERT INTO training_structure_suggestions
    (user_id,training_id,execution_id,session_index,response_hash,adapter_version,converter_version,status,compatibility,prescription_json,fingerprint,issues_json,details_hash,created_at)
    VALUES (?,?,?,?,?,?,?,'pending_review',?,?,?,?,?,?)`).run(
    userId, trainingId, executionId, sessionIndex, responseHash, version, converted.converterVersion,
    converted.status,
    converted.prescription ? JSON.stringify(converted.prescription) : null,
    converted.prescription ? prescriptionFingerprint(converted.prescription) : null,
    JSON.stringify(converted.issues), detailsHash(details), now,
  );
  return { compatibility: converted.status, conflict: Boolean(previous) || hasPrescription };
}

function readSuggestion(db, userId, trainingId) {
  const row = db.prepare(
    "SELECT * FROM training_structure_suggestions WHERE user_id=? AND training_id=? AND status='pending_review'",
  ).get(userId, trainingId);
  if (!row) return null;
  const training = db.prepare('SELECT detalhes FROM trainings WHERE id=? AND user_id=?').get(trainingId, userId);
  const saved = db.prepare(
    'SELECT fingerprint FROM garmin_workout_prescriptions WHERE user_id=? AND training_id=?',
  ).get(userId, trainingId);
  const value = row.prescription_json ? JSON.parse(row.prescription_json) : null;
  return {
    id: row.id,
    revision: row.revision,
    compatibility: row.compatibility,
    value,
    fingerprint: row.fingerprint,
    preview: value ? previewPrescription(value) : null,
    issues: JSON.parse(row.issues_json),
    origin: {
      execution_id: row.execution_id,
      adapter_version: row.adapter_version,
      converter_version: row.converter_version,
      created_at: row.created_at,
    },
    // The guidance text was edited after the suggestion was bound to it.
    details_changed: detailsHash(training.detalhes) !== row.details_hash,
    // A canonical structure already exists: keeping it or reviewing this one
    // is an explicit choice. An identical saved structure is not a conflict.
    conflict: Boolean(saved) && saved.fingerprint !== row.fingerprint,
  };
}

// Moves the exact pending suggestion at the expected revision to a decided
// status. Returns false for a stale, foreign, decided or unknown suggestion.
function decide(db, userId, trainingId, suggestionId, expectedRevision, status, now) {
  if (!Number.isSafeInteger(suggestionId) || !Number.isSafeInteger(expectedRevision)) return false;
  return db.prepare(
    `UPDATE training_structure_suggestions SET status=?,revision=revision+1,decided_at=?
     WHERE id=? AND user_id=? AND training_id=? AND status='pending_review' AND revision=?`,
  ).run(status, now, suggestionId, userId, trainingId, expectedRevision).changes === 1;
}

// Runs inside the caller's prescription-save transaction.
function acceptSuggestion(db, userId, trainingId, suggestionId, expectedRevision, now) {
  return decide(db, userId, trainingId, suggestionId, expectedRevision, 'accepted', now);
}

// Returns null for a malformed body, false for a stale decision, true when dismissed.
function dismissSuggestion(db, userId, trainingId, body, now) {
  const keys = Object.keys(body || {});
  if (keys.length !== 2 || !keys.includes('suggestion_id') || !keys.includes('expected_revision')) return null;
  return db.transaction(() => decide(
    db, userId, trainingId, body.suggestion_id, body.expected_revision, 'dismissed', now,
  )).immediate();
}

module.exports = {
  detailsHash,
  recordSuggestion,
  readSuggestion,
  acceptSuggestion,
  dismissSuggestion,
};
