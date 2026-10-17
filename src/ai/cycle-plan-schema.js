'use strict';
const { date, AiError } = require('./memory');
const VERSION = 'cycle-plan-v1';
const text = { type: 'string', minLength: 1, maxLength: 1600 };
const texts = { type: 'array', items: text, maxItems: 12 };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const phaseFields = ['name','objective','volume','longRuns','quality','intensity','easyRuns','strength','risks','advanceCriteria','rationale'];
const phase = object({ start: text, end: text, ...Object.fromEntries(phaseFields.map((key) => [key,text])), evidence: texts });
const schema = object({
  schemaVersion: { type:'string', enum:[VERSION] },
  cycleId: text, start: text, end: text,
  assessment: text, continuity: text, feasibility: text,
  confidence: { type:'string', enum:['low','moderate','high','insufficient_data'] },
  phases: { type:'array', items:phase, minItems:1, maxItems:12 },
  indicators: { type:'array', items:text, minItems:5, maxItems:10 },
  adaptations: object(Object.fromEntries(['increase','maintain','reduce','replaceQuality','reduceLongRun'].map((key)=>[key,text]))),
  uncertainties: texts, assumptions: texts, questions: texts,
});
function validShape(value, spec) {
  if (spec.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === spec.required.length && spec.required.every((key)=>Object.hasOwn(value,key) && validShape(value[key],spec.properties[key]));
  if (spec.type === 'array') return Array.isArray(value) && value.length >= (spec.minItems || 0) && value.length <= spec.maxItems && value.every((item)=>validShape(item,spec.items));
  return typeof value === 'string' && (spec.enum ? spec.enum.includes(value) : value.trim().length >= spec.minLength && value.length <= spec.maxLength);
}
function planningDate(value, code) {
  try { return date(value); } catch { throw new AiError(code); }
}
function planningWindow(context) {
  const cycle = context.resource;
  if (!cycle || cycle.status !== 'active') throw new AiError('cycleNotActive');
  if (cycle.target_date == null || cycle.target_date === '') throw new AiError('planningTargetDateRequired');
  const end = planningDate(cycle.target_date, 'planningTargetDateInvalid');
  const reference = date(context.asOf);
  const start = cycle.start_date == null || cycle.start_date === '' ? null
    : planningDate(cycle.start_date, 'planningStartDateInvalid');
  if (start !== null && end < start) throw new AiError('planningTargetBeforeStart');
  const effectiveStart = start !== null && start > reference ? start : reference;
  if (end < effectiveStart) throw new AiError('planningTargetBeforeReference');
  return { start:effectiveStart, end };
}
function validatePlan(value, context) {
  if (!validShape(value,schema)) return false;
  try {
    const window = planningWindow(context);
    if (value.cycleId !== context.resource.id || value.start !== window.start || value.end !== window.end) return false;
    let next = value.start;
    const allowed = new Set(context.sources.map((ref)=>`${ref.type}:${ref.id}`));
    for (const phase of value.phases) {
      date(phase.start); date(phase.end);
      if (phase.start !== next || phase.end < phase.start || phase.end > value.end || !phase.evidence.length || phase.evidence.some((ref)=>!allowed.has(ref))) return false;
      next = new Date(Date.parse(phase.end)+86400000).toISOString().slice(0,10);
    }
    return value.phases.at(-1).end === value.end;
  } catch { return false; }
}
module.exports = { VERSION, schema, phaseFields, validShape, planningWindow, validatePlan };
