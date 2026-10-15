'use strict';
const { schema, validatePlan, planningWindow } = require('./cycle-plan-schema');
const { AiError } = require('./memory');
const DELIVERY = {
  pt: ['Planeje detalhadamente apenas a semana atual/próxima.', 'Nesta primeira resposta, entregue nesta ordem:', 'Inclua uma tabela resumida com: Fase, Semanas aproximadas, Objetivo, Longo, Qualidade, Volume.'],
  en: ['Plan in detail only the current/next week.', 'In this first response, deliver in this order:', 'Include a summary table with: Phase, Approximate weeks, Objective, Long run, Quality, Volume.'],
};
function adaptPrompt(prompt) {
  const language = prompt.startsWith('Quero') ? 'pt' : 'en';
  const replacements = language === 'pt' ? [
    'Nesta operação, entregue apenas a arquitetura do ciclo, sem calendário semanal detalhado.',
    'Nesta primeira resposta, entregue as partes A–F, na ordem original, nos campos do schema estruturado:',
    'Represente essa tabela nos campos estruturados de phases: name, start, end, objective, longRuns, quality e volume.',
  ] : [
    'For this operation, deliver only the cycle architecture, without a detailed weekly calendar.',
    'In this first response, deliver parts A–F, in their original order, in the structured schema fields:',
    'Represent this table using the structured phases fields: name, start, end, objective, longRuns, quality and volume.',
  ];
  for (let i=0;i<3;i++) {
    // All user-supplied substitutions precede section 2. Adapt the final fixed
    // template occurrence, never a matching phrase typed in those fields.
    const offset=prompt.lastIndexOf(DELIVERY[language][i]);
    if (offset<0) throw new AiError('promptAdapterMismatch',500);
    prompt = prompt.slice(0,offset)+replacements[i]+prompt.slice(offset+DELIVERY[language][i].length);
  }
  return prompt;
}
function createCyclePlanAdapter(db) {
  return {
    version: 'cycle-delivery-v1', adaptPrompt,
    instructions: 'Return cycle-plan-v1 JSON matching the schema, in the athlete language. Map A assessment, B continuity, C feasibility/confidence, D phases, E indicators, F adaptations. Assessment is a tentative plan-local evaluation, never a diagnosis or a reusable athlete profile. Do not invent history, recovery or prior volume. List uncertainties, conservative assumptions and questions explicitly. No weekly sessions, calendar, weather lookup or tools. The date window is max(asOf, saved cycle start) through the saved target date inclusive. Phases must cover that window exactly, ordered and contiguous. Evidence entries are selected context source references formatted type:id. Keep explanations concise; evidence must support each phase rationale. Conditions not supported by data remain uncertainties. Missing data may yield insufficient_data confidence. Dates and cycleId must match context.resource. Do not prescribe exact distant weekly mileage.',
    format: { type:'json_schema', name:'cycle_plan', strict:true, schema },
    validate: validatePlan,
    prepare(context) {
      try { planningWindow(context); } catch (error) { throw new AiError(error.message === 'cycleNotActive' ? 'cycleNotActive' : 'invalidPlanningDates',400); }
    },
    onEnqueued(row, context) {
      const base = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM cycle_plan_versions WHERE user_id=? AND cycle_id=?').get(row.user_id,row.resource_id).v;
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS v FROM cycle_plan_proposals WHERE user_id=? AND cycle_id=?').get(row.user_id,row.resource_id).v;
      db.prepare('INSERT INTO cycle_plan_proposals(id,user_id,cycle_id,execution_id,sequence,base_version,created_at) VALUES (?,?,?,?,?,?,?)').run(row.id,row.user_id,row.resource_id,row.id,sequence,base,row.created_at);
    },
    cleanup() {
      db.prepare('DELETE FROM cycle_plan_proposals WHERE execution_id IS NULL AND id NOT IN (SELECT id FROM cycle_plan_versions)').run();
    },
    onCompleted(row, value) {
      db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=? AND user_id=?').run(JSON.stringify(value),row.id,row.user_id);
    },
  };
}
module.exports = { createCyclePlanAdapter, adaptPrompt, DELIVERY };
