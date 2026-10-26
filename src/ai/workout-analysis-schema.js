'use strict';

const { AiError } = require('./memory');
const { incompatibleRpe } = require('./cycle-plan-rpe');

const evidence = { type: 'string', minLength: 1, maxLength: 180 };
const claim = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 800 },
    evidence: { type: 'array', items: evidence, maxItems: 8 },
  },
  required: ['text', 'evidence'],
  additionalProperties: false,
};
const schema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', enum: ['workout-analysis-v1'] },
    language: { type: 'string', enum: ['pt-BR', 'en-US'] },
    summary: claim,
    comparison: claim,
    contextualReading: { type: 'array', items: claim, maxItems: 6 },
    attention: { type: 'array', items: claim, maxItems: 5 },
    recommendations: { type: 'array', items: claim, maxItems: 6 },
    classification: {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          enum: ['below_expectations', 'adequate', 'good', 'very_good', 'excellent', 'insufficient_data'],
        },
        evidence: { type: 'array', items: evidence, maxItems: 8 },
      },
      required: ['value', 'evidence'],
      additionalProperties: false,
    },
    limitations: { type: 'array', items: { type: 'string', maxLength: 400 }, maxItems: 6 },
    reusableInterpretations: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['pattern', 'recommendation', 'attention'] },
          text: { type: 'string', minLength: 1, maxLength: 400 },
          evidence: { type: 'array', items: evidence, minItems: 1, maxItems: 5 },
        },
        required: ['kind', 'text', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'schemaVersion', 'language', 'summary', 'comparison', 'contextualReading',
    'attention', 'recommendations', 'classification', 'limitations', 'reusableInterpretations',
  ],
  additionalProperties: false,
};

const TECHNICAL = /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:training|cycle|shoe|availability|profile|preferences|cycle_plan|interpretation):[^\s,;]+)/i;
function exactObject(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function diagnoseAnalysis(value, context) {
  if (!exactObject(value, ['schemaVersion','language','summary','comparison','contextualReading','attention','recommendations','classification','limitations','reusableInterpretations']))
    return { code: 'shape_type', path: '$' };
  const allowed = new Set(context?.sources?.map((item) => `${item.type}:${item.id}`) || []);
  const visitClaim = (item, path) => {
    if (!exactObject(item, ['text', 'evidence'])) return { code: 'analysis_shape', path };
    if (!item || typeof item.text !== 'string' || item.text.trim() === '' || item.text.length > 800)
      return { code: 'analysis_text', path: `${path}.text` };
    if (TECHNICAL.test(item.text)) return { code: 'analysis_technical_reference', path: `${path}.text` };
    if (incompatibleRpe(item.text)) return { code: 'analysis_rpe_scale', path: `${path}.text` };
    if (!Array.isArray(item.evidence) || item.evidence.length > 8)
      return { code: 'analysis_evidence', path: `${path}.evidence` };
    for (let i = 0; i < item.evidence.length; i++) {
      if (!allowed.has(item.evidence[i])) return { code: 'analysis_evidence', path: `${path}.evidence[${i}]` };
    }
    return null;
  };
  if (value.schemaVersion !== 'workout-analysis-v1') return { code: 'analysis_version', path: '$.schemaVersion' };
  if (!['pt-BR', 'en-US'].includes(value.language)) return { code: 'analysis_language', path: '$.language' };
  for (const key of ['summary', 'comparison']) {
    const invalid = visitClaim(value[key], `$.${key}`);
    if (invalid) return invalid;
  }
  for (const key of ['contextualReading', 'attention', 'recommendations']) {
    const maximum = key === 'attention' ? 5 : 6;
    if (!Array.isArray(value[key]) || value[key].length > maximum) return { code: 'analysis_shape', path: `$.${key}` };
    for (let i = 0; i < value[key].length; i++) {
      const invalid = visitClaim(value[key][i], `$.${key}[${i}]`);
      if (invalid) return invalid;
    }
  }
  if (!exactObject(value.classification, ['value','evidence']) || !['below_expectations', 'adequate', 'good', 'very_good', 'excellent', 'insufficient_data'].includes(value.classification.value))
    return { code: 'analysis_classification', path: '$.classification.value' };
  if (!Array.isArray(value.classification.evidence) || value.classification.evidence.length > 8 || value.classification.evidence.some((ref) => !allowed.has(ref)))
    return { code: 'analysis_evidence', path: '$.classification.evidence' };
  if (!Array.isArray(value.limitations) || value.limitations.length > 6) return { code: 'analysis_shape', path: '$.limitations' };
  for (let i = 0; i < value.limitations.length; i++) {
    const text = value.limitations[i];
    if (typeof text !== 'string' || text.length > 400 || TECHNICAL.test(text)) return { code: 'analysis_shape', path: `$.limitations[${i}]` };
    if (incompatibleRpe(text)) return { code: 'analysis_rpe_scale', path: `$.limitations[${i}]` };
  }
  if (!Array.isArray(value.reusableInterpretations) || value.reusableInterpretations.length > 5)
    return { code: 'analysis_shape', path: '$.reusableInterpretations' };
  for (let i = 0; i < value.reusableInterpretations.length; i++) {
    const item = value.reusableInterpretations[i];
    if (!exactObject(item, ['kind','text','evidence'])) return { code: 'analysis_shape', path: `$.reusableInterpretations[${i}]` };
    if (!['pattern', 'recommendation', 'attention'].includes(item?.kind)) return { code: 'analysis_interpretation', path: `$.reusableInterpretations[${i}].kind` };
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 400 || TECHNICAL.test(item.text)) return { code: 'analysis_text', path: `$.reusableInterpretations[${i}].text` };
    if (incompatibleRpe(item.text)) return { code: 'analysis_rpe_scale', path: `$.reusableInterpretations[${i}].text` };
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 5 || item.evidence.some((ref) => !allowed.has(ref))) return { code: 'analysis_evidence', path: `$.reusableInterpretations[${i}].evidence` };
  }
  return null;
}

function validateAnalysis(value, context) {
  return diagnoseAnalysis(value, context) === null;
}

function requireAnalysisSourcesCurrent(context) {
  if (!context?.resource?.source?.id || context.resource.actual?.completed !== true ||
      !Number.isInteger(context.resource.report?.feedback_rpe) ||
      context.resource.report.feedback_rpe < 1 || context.resource.report.feedback_rpe > 5) {
    throw new AiError('analysisRequiresCompletedResult', 400);
  }
  const actual = context.resource.actual;
  if (actual.result_data_source === 'none' &&
      (typeof actual.fit_distance !== 'number' || typeof actual.fit_duration !== 'string')) {
    throw new AiError('analysisRequiresCompletedResult', 400);
  }
}

module.exports = { schema, diagnoseAnalysis, validateAnalysis, requireAnalysisSourcesCurrent, TECHNICAL };
