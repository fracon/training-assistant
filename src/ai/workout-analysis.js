'use strict';

const { AiError, activeOwner, exactKeys, hash } = require('./memory');
const { contextIsCurrent } = require('./context');
const { incompatibleRpe } = require('./cycle-plan-rpe');

function presentInterpretation(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    disposition: row.disposition,
    correction: row.correction_text ?? null,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function readWorkoutAnalyses(db, userId, trainingId, config) {
  activeOwner(db, userId);
  const training = db.prepare('SELECT id FROM trainings WHERE id=? AND user_id=?').get(trainingId, userId);
  if (!training) throw new AiError('resourceNotFound', 404);
  const rows = db.prepare(`SELECT * FROM workout_analysis_versions
    WHERE user_id=? AND training_id=? ORDER BY sequence DESC`).all(userId, trainingId);
  const analyses = rows.map((row) => {
    const context = JSON.parse(row.context_json);
    const response = row.response_json ? JSON.parse(row.response_json) : null;
    const items = db.prepare(`SELECT id,kind,text,evidence_json,disposition,correction_text,version,updated_at
      FROM ai_interpretations WHERE user_id=? AND analysis_id=? ORDER BY created_at,id`).all(userId, row.id);
    return {
      id: row.id,
      sequence: row.sequence,
      state: row.state,
      createdAt: row.created_at,
      language: row.language,
      adapterVersion: row.adapter_version,
      outdated: !contextIsCurrent(db, userId, context, config),
      result: response ? {
        schemaVersion: response.schemaVersion,
        language: response.language,
        summary: { text: response.summary.text },
        comparison: { text: response.comparison.text },
        contextualReading: response.contextualReading.map(({ text }) => ({ text })),
        attention: response.attention.map(({ text }) => ({ text })),
        recommendations: response.recommendations.map(({ text }) => ({ text })),
        classification: { value: response.classification.value },
        limitations: response.limitations,
      } : null,
      interpretations: items.map(presentInterpretation),
      errorCode: publicAnalysisError(row.error_code),
    };
  });
  return {
    analyses,
    active: analyses.find((item) => item.state === 'queued' || item.state === 'running') || null,
    latest: analyses.find((item) => item.result !== null) || null,
  };
}

const PUBLIC_ANALYSIS_ERRORS = new Set([
  'aiUnavailable', 'accountUnavailable', 'executionLimit', 'usageLimit',
  'providerRateLimited', 'providerRejected', 'providerOutcomeUncertain', 'providerTimeout', 'providerOutputLimit',
  'providerIncomplete', 'providerInvalidResponse', 'providerRefused',
  'providerContentFiltered', 'providerFailed', 'sourceChanged',
  'contextTooLarge', 'criticalContextTooLarge', 'inputTooLarge',
  'analysisRequiresCompletedResult', 'adapterUnavailable', 'reservationExpired',
  'restartOutcomeUncertain', 'resultPersistenceFailed',
]);
function publicAnalysisError(code) {
  if (code === 'invalidDomainResponse') return 'invalidDomainResponse';
  return PUBLIC_ANALYSIS_ERRORS.has(code) ? code : null;
}

function changeInterpretation(db, userId, id, action, body, now = () => new Date().toISOString()) {
  if (!['confirm', 'correct', 'discard'].includes(action)) throw new AiError('invalidFields');
  exactKeys(body, action === 'correct' ? ['expected_version', 'text'] : ['expected_version']);
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1)
    throw new AiError('invalidVersion');
  if (action === 'correct' && (typeof body.text !== 'string' || body.text.trim().length < 1 || body.text.trim().length > 400))
    throw new AiError('invalidText');
  if (action === 'correct' && incompatibleRpe(body.text))
    throw new AiError('incompatibleRpeScale');
  return db.transaction(() => {
    activeOwner(db, userId);
    const row = db.prepare('SELECT * FROM ai_interpretations WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new AiError('resourceNotFound', 404);
    if (row.version !== body.expected_version) throw new AiError('interpretationConflict', 409);
    if (row.disposition === 'dismissed' || row.disposition === 'superseded')
      throw new AiError('interpretationConflict', 409);
    if (action === 'confirm' && row.disposition !== 'pending')
      throw new AiError('interpretationConflict', 409);
    const disposition = action === 'confirm' ? 'confirmed' : action === 'correct' ? 'corrected' : 'dismissed';
    const correction = action === 'correct' ? body.text.trim() : row.correction_text;
    db.prepare(`UPDATE ai_interpretations SET disposition=?,correction_text=?,version=version+1,updated_at=?
      WHERE id=? AND user_id=? AND version=?`).run(disposition, correction, now(), id, userId, body.expected_version);
    const updated = db.prepare(`SELECT id,kind,text,disposition,correction_text,version,updated_at
      FROM ai_interpretations WHERE id=? AND user_id=?`).get(id, userId);
    return { interpretation: presentInterpretation(updated) };
  }).immediate();
}

module.exports = { readWorkoutAnalyses, changeInterpretation, presentInterpretation };
