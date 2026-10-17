'use strict';
const { schema, validatePlan, planningWindow } = require('./cycle-plan-schema');
const { AiError } = require('./memory');
const DELIVERY = {
  pt: ['Planeje detalhadamente apenas a semana atual/próxima.', 'Nesta primeira resposta, entregue nesta ordem:', 'Inclua uma tabela resumida com: Fase, Semanas aproximadas, Objetivo, Longo, Qualidade, Volume.'],
  en: ['Plan in detail only the current/next week.', 'In this first response, deliver in this order:', 'Include a summary table with: Phase, Approximate weeks, Objective, Long run, Quality, Volume.'],
};
const GOAL_CONDITIONS = {
  pt: [
    ['Não introduza equipamento novo perto da prova sem oportunidade adequada de adaptação.', 'Somente quando uma prova fizer parte explicitamente do objetivo cadastrado, não introduza equipamento novo perto dela sem oportunidade adequada de adaptação.'],
    ['Use os longos do ciclo para desenvolver e validar a estratégia nutricional da prova.', 'Use os longos, quando relevantes ao objetivo, para desenvolver e validar a estratégia nutricional; estratégia de prova somente quando uma prova fizer parte explicitamente do objetivo cadastrado.'],
    ['17. TAPER\n', '17. TAPER\nA orientação de prova a seguir aplica-se somente quando uma prova fizer parte explicitamente do objetivo cadastrado. Sem prova, ajuste a recuperação ao objetivo e à resposta observada, sem impor taper competitivo.\n'],
  ],
  en: [
    ['Do not introduce new equipment near the race without adequate adaptation opportunity.', 'Only when a race is explicitly part of the registered goal, do not introduce new equipment near it without adequate adaptation opportunity.'],
    ["Use the cycle's long runs to develop and validate the race nutrition strategy.", "Use long runs, when relevant to the goal, to develop and validate nutrition strategy; race strategy only when a race is explicitly part of the registered goal."],
    ['17. TAPER\n', '17. TAPER\nThe following race guidance applies only when a race is explicitly part of the registered goal. Without a race, adjust recovery to the goal and observed response, without imposing a competitive taper.\n'],
  ],
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
  for (const [original, replacement] of GOAL_CONDITIONS[language]) {
    const offset=prompt.lastIndexOf(original);
    if (offset<0) throw new AiError('promptAdapterMismatch',500);
    prompt=prompt.slice(0,offset)+replacement+prompt.slice(offset+original.length);
  }
  return prompt;
}
function createCyclePlanAdapter(db) {
  return {
    version: 'cycle-delivery-v2', adaptPrompt,
    instructions: 'Return cycle-plan-v1 JSON matching the schema, in the athlete language. Map A assessment, B continuity, C feasibility/confidence, D phases, E indicators, F adaptations. Assessment is a tentative plan-local evaluation, never a diagnosis or a reusable athlete profile. Do not invent history, recovery or prior volume. List uncertainties, conservative assumptions and questions explicitly. No weekly sessions, calendar, weather lookup or tools. A race is optional: the objective may be a personal distance or another training goal. The target date is the deadline for that objective, not evidence of a race. Never invent an event, registration, race date or participation. Competition-specific guidance applies only when explicitly supported by the registered objective/context. The date window is max(asOf, saved cycle start) through the saved target date inclusive. Phases must cover that window exactly, ordered and contiguous. Evidence entries are selected context source references formatted type:id. Keep explanations concise; evidence must support each phase rationale. Conditions not supported by data remain uncertainties. Missing data may yield insufficient_data confidence. Dates and cycleId must match context.resource. Do not prescribe exact distant weekly mileage.',
    format: { type:'json_schema', name:'cycle_plan', strict:true, schema },
    validate: validatePlan,
    prepare(context) {
      planningWindow(context);
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
module.exports = { createCyclePlanAdapter, adaptPrompt, DELIVERY, GOAL_CONDITIONS };
