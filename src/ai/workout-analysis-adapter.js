'use strict';

const { randomUUID } = require('node:crypto');
const { schema, validateAnalysis, diagnoseAnalysis, requireAnalysisSourcesCurrent } = require('./workout-analysis-schema');
const { AiError, hash } = require('./memory');

const VERSION = 'workout-analysis-v1';
const INSTRUCTIONS = `Return only the registered workout-analysis-v1 schema, in the language recorded in context.preferences.language. Use the shared context as the sole source of workout and athlete data; the adapted external prompt below supplies coaching intent, not additional facts. The requested session and its reported feedback are mandatory context. Preserve the distinction between planned values, recorded measurements, user reports, prior AI interpretations, recommendations, and actions. Cite supporting context sources exactly as type:id in structured evidence arrays only; never put identifiers or UUIDs in prose. If evidence is insufficient, say so and use empty lists or insufficient_data; never fill a section with invented facts. Do not infer rest, recovery, completed actions, causality, permanent limitations, or a race from missing data. No medical diagnosis. Do not infer a heart-rate zone/target from observed average or maximum heart rate. Use pace, distance, ascent and cadence as already normalized by Kinesis; cadence is two-foot steps per minute (spm/ppm), and ascent is positive gain. Do not recalculate canonical values. Kinesis realized RPE uses only the explicit 1–5 scale; distinguish prescribed per-stage RPE from reported realized RPE and never convert other scales. Training-day context after the workout date is information available at analysis time, not knowledge available during that workout. Recommendations may suggest an adjustment but must not claim that calendar, cycle, results or training were changed. Keep conclusions proportional to evidence. Reusable interpretations are optional, concise, evidence-linked hypotheses or recommendations; do not duplicate measured metrics or treat them as facts.`;

function adaptPrompt(prompt) {
  const pt = prompt.startsWith('Analise o treino');
  const dataHeading = pt ? 'DADOS DO TREINO PLANEJADO\n' : 'PLANNED WORKOUT DATA\n';
  const instructionsHeading = pt ? 'INSTRUÇÕES PARA A ANÁLISE\n' : 'INSTRUCTIONS FOR ANALYSIS\n';
  const start = prompt.indexOf(dataHeading);
  const end = prompt.indexOf(instructionsHeading);
  if (start < 0 || end < 0 || end <= start) throw new AiError('promptAdapterMismatch', 500);
  return `${prompt.slice(0, start)}${pt ? 'CONTEXTO ESTRUTURADO KINESIS\n' : 'KINESIS STRUCTURED CONTEXT\n'}${prompt.slice(end)}`;
}

function createWorkoutAnalysisAdapter(db) {
  return {
    version: VERSION,
    instructions: INSTRUCTIONS,
    adaptPrompt,
    format: { type: 'json_schema', name: 'workout_analysis', strict: true, schema },
    prepare(context) { requireAnalysisSourcesCurrent(context); },
    validate: validateAnalysis,
    diagnose: diagnoseAnalysis,
    onEnqueued(row, context) {
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM workout_analysis_versions WHERE user_id=? AND training_id=?').get(row.user_id, row.resource_id).value;
      db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
        VALUES (?,?,?,?,?,?, 'queued',?,?)`).run(row.id, row.user_id, row.resource_id, sequence, VERSION, row.context_json, context.preferences.language, row.created_at);
    },
    onCompleted(row, value) {
      const trainingId = row.resource_id;
      db.prepare('UPDATE workout_analysis_versions SET response_json=? WHERE id=? AND user_id=?').run(JSON.stringify(value), row.id, row.user_id);
      for (const item of value.reusableInterpretations) {
        const refs = [...new Set(item.evidence)].sort().map((ref) => {
          const [type, ...parts] = ref.split(':');
          const id = parts.join(':');
          const source = JSON.parse(row.context_json).sources.find((candidate) => candidate.type === type && candidate.id === id);
          return { type, id, version: source.version };
        });
        const evidenceJson = JSON.stringify(refs);
        const evidenceKey = JSON.stringify(refs.map(({ type, id }) => ({ type, id })));
        const evidenceHash = hash({ kind: item.kind, refs });
        db.prepare(`UPDATE ai_interpretations SET disposition='superseded',version=version+1,updated_at=?
          WHERE user_id=? AND kind=? AND evidence_key=? AND evidence_hash<>? AND disposition IN ('pending','confirmed')`)
          .run(row.created_at, row.user_id, item.kind, evidenceKey, evidenceHash);
        db.prepare(`INSERT OR IGNORE INTO ai_interpretations
          (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,disposition,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`)
          .run(randomUUID(), row.user_id, trainingId, row.id, item.kind, item.text, evidenceJson, evidenceKey, evidenceHash, row.created_at, row.created_at);
      }
    },
    onSettled(row, state, errorCode) {
      db.prepare('UPDATE workout_analysis_versions SET state=?,error_code=? WHERE id=? AND user_id=?').run(state, errorCode, row.id, row.user_id);
    },
  };
}

module.exports = { VERSION, INSTRUCTIONS, adaptPrompt, createWorkoutAnalysisAdapter };
