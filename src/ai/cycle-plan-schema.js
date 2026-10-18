'use strict';
const { date, AiError } = require('./memory');
const { incompatibleRpe } = require('./cycle-plan-rpe');
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
function validShape(value,spec) { return shapeIssue(value,spec)===null; }
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
function shapeIssue(value,spec,path='$') {
  const issue=(code)=>({code,path});
  if(spec.type==='object') {
    if(value===null || typeof value!=='object' || Array.isArray(value))return issue('shape_type');
    if(Object.keys(value).length!==spec.required.length || spec.required.some(key=>!Object.hasOwn(value,key)))return issue('shape_fields');
    for(const key of spec.required){const found=shapeIssue(value[key],spec.properties[key],`${path}.${key}`);if(found)return found;}
    return null;
  }
  if(spec.type==='array') {
    if(!Array.isArray(value))return issue('shape_type');
    if(value.length<(spec.minItems || 0) || value.length>spec.maxItems)return issue('shape_length');
    for(let i=0;i<value.length;i++){const found=shapeIssue(value[i],spec.items,`${path}[${i}]`);if(found)return found;}
    return null;
  }
  if(typeof value!=='string')return issue('shape_type');
  if(spec.enum)return spec.enum.includes(value)?null:issue('shape_enum');
  return value.trim().length<spec.minLength || value.length>spec.maxLength?issue('shape_length'):null;
}
// Scale checks inspect narrative fields only after validating the stored shape.
// Evidence IDs, identity, enums and calendar fields are not generated effort prose.
function rpeIssue(plan) {
  if (shapeIssue(plan,schema)) return null;
  const fields = [
    ...['assessment','continuity','feasibility'].map(key=>[plan[key],`$.${key}`]),
    ...plan.phases.flatMap((phase,i)=>phaseFields.map(key=>[phase[key],`$.phases[${i}].${key}`])),
    ...['indicators','uncertainties','assumptions','questions'].flatMap(key=>plan[key].map((text,i)=>[text,`$.${key}[${i}]`])),
    ...Object.entries(plan.adaptations).map(([key,text])=>[text,`$.adaptations.${key}`]),
  ];
  for (const [text,path] of fields) if (incompatibleRpe(text)) return {code:'rpe_scale',path};
  return null;
}
function diagnosePlan(value, context) {
  const shape=shapeIssue(value,schema);if(shape)return shape;
  const effort=rpeIssue(value);if(effort)return effort;
  let window;
  try { window=planningWindow(context); } catch { return {code:'context_window',path:'$'}; }
  if(value.cycleId!==context.resource.id)return {code:'cycle_identity',path:'$.cycleId'};
  if(value.start!==window.start)return {code:'window_start',path:'$.start'};
  if(value.end!==window.end)return {code:'window_end',path:'$.end'};
  let next=value.start;
  const allowed=new Set(context.sources.map(ref=>`${ref.type}:${ref.id}`));
  for(let i=0;i<value.phases.length;i++) {
    const phase=value.phases[i],path=`$.phases[${i}]`;
    for(const key of ['start','end'])try { date(phase[key]); } catch { return {code:'phase_date',path:`${path}.${key}`}; }
    if(phase.start!==next)return {code:'phase_continuity',path:`${path}.start`};
    if(phase.end<phase.start || phase.end>value.end)return {code:'phase_interval',path:`${path}.end`};
    if(!phase.evidence.length || phase.evidence.some(ref=>!allowed.has(ref)))return {code:'phase_evidence',path:`${path}.evidence`};
    next=new Date(Date.parse(phase.end)+86400000).toISOString().slice(0,10);
  }
  return value.phases.at(-1).end===value.end?null:{code:'phase_coverage',path:'$.phases'};
}
function validatePlan(value,context) { try { return diagnosePlan(value,context)===null; } catch { return false; } }
module.exports = { VERSION, schema, phaseFields, validShape, planningWindow, validatePlan, diagnosePlan, shapeIssue, rpeIssue };
