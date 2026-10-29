'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { AiError } = require('../src/ai/memory');
const { buildContext, contextIsCurrent } = require('../src/ai/context');
const { createWorkoutAnalysisAdapter, adaptPrompt, VERSION } = require('../src/ai/workout-analysis-adapter');
const { schema, diagnoseAnalysis, validateAnalysis, requireAnalysisSourcesCurrent } = require('../src/ai/workout-analysis-schema');
const { createExecutionService } = require('../src/ai/executions');
const { readWorkoutAnalyses, changeInterpretation } = require('../src/ai/workout-analysis');
const { memoryOverview } = require('../src/ai/overview');
const { migrateWorkoutAnalysis, migrateWorkoutInterpretationIdentity } = require('../src/ai/schema');
const { renderPrompt } = require('../src/ai/prompt-service');
const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

function fixture() {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES (1,'analysis@example.invalid','synthetic','user','en-US'),(2,'other@example.invalid','synthetic','user','pt-BR')").run();
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('cycle-a',1,'Personal 10k','active','2026-01-01','2027-01-01')").run();
  db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino,detalhes,result_data_source,fit_distance,fit_duration,fit_avg_pace,fit_avg_hr,fit_max_hr,fit_elevation_gain,feedback_rpe,feedback_notas,completed,training_cycle_id)
    VALUES (101,1,'2026-10-24','Corrida','Corrida fácil','Orientação sintética','manual',5,'30:00','6:00',142,155,30,3,'Sensação estável',1,'cycle-a'),
    (201,2,'2026-10-24','Corrida','Treino privado','', 'manual',5,'30:00','6:00',142,155,30,3,'privado',1,NULL)`).run();
  return { db, config: readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-key', AI_RETRIES: '0' }) };
}

const refs = (context) => [`${context.resource.source.type}:${context.resource.source.id}`];
function result(context, text = 'A sessão ficou próxima do planejado com os dados registrados.') {
  const evidence = refs(context);
  return {
    schemaVersion: 'workout-analysis-v1', language: context.preferences.language,
    summary: { text, evidence }, comparison: { text: 'O resultado manual confirma distância, duração e RPE relatados.', evidence },
    contextualReading: [{ text: 'O registro anterior permite comparar apenas a sessão documentada.', evidence }],
    attention: [], recommendations: [{ text: 'Mantenha o plano e avalie a próxima sessão com novos dados.', evidence }],
    classification: { value: 'adequate', evidence }, limitations: ['Não há voltas FIT nesta sessão manual.'],
    reusableInterpretations: [{ kind: 'pattern', text: 'A sessão documentada foi percebida como estável.', evidence }],
  };
}

async function waitFor(service, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = service.get(1, id);
    if (!['queued', 'running'].includes(execution.state)) return execution;
    await delay(2);
  }
  throw new Error('synthetic execution remained pending');
}

test('analysis delivery adapter preserves external coaching intent while deterministically moving session data into shared context', () => {
  const { db } = fixture();
  const prompt = renderPrompt(db, 1, { purpose: 'analysis', resourceId: 101 });
  const adapted = adaptPrompt(prompt);
  assert.match(prompt, /PLANNED WORKOUT DATA/);
  assert.match(prompt, /INSTRUCTIONS FOR ANALYSIS/);
  assert.doesNotMatch(adapted, /DADOS DO TREINO PLANEJADO|DADOS DO TREINO REALIZADO|DADOS DETALHADOS/);
  assert.match(adapted, /KINESIS STRUCTURED CONTEXT/);
  assert.match(adapted, /Compare the realized workout with the planned workout/);
  assert.throws(() => adaptPrompt('invalid'), (error) => error instanceof AiError && error.code === 'promptAdapterMismatch');
  const pt = require('../src/ai/external-analysis-prompt.js').templateFor('pt-BR');
  const en = require('../src/ai/external-analysis-prompt.js').templateFor('en-US');
  const portuguese = adaptPrompt(renderPrompt(db, 2, { purpose: 'analysis', resourceId: 201 }));
  assert.match(pt, /^Analise o treino de corrida abaixo/);
  assert.match(en, /^Analyze the running workout below/);
  assert.match(portuguese, /CONTEXTO ESTRUTURADO KINESIS/);
  assert.doesNotMatch(portuguese, /DADOS DO TREINO PLANEJADO|DADOS DO TREINO REALIZADO/);
  const publicPrompt = readFileSync(require.resolve('../src/public/shared/analysis-prompts.js'), 'utf8');
  assert.doesNotMatch(publicPrompt, /PROMPT_TEMPLATE|INSTRUCTIONS FOR ANALYSIS|INSTRUÇÕES PARA A ANÁLISE/);
  db.close();
});

test('analysis response contract rejects unsupported fields, technical references, invalid RPE and foreign evidence with diagnostic paths', () => {
  const { db, config } = fixture();
  const context = buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config, freshnessExecutionId: 'synthetic-execution' });
  const good = result(context);
  assert.deepEqual(schema.required, Object.keys(good));
  assert.equal(validateAnalysis(good, context), true);
  assert.equal(diagnoseAnalysis({ ...good, summary: { ...good.summary, text: 'RPE 4/5 e RPE 3', evidence: good.summary.evidence } }, context), null, 'the explicit 1–5 scale is valid with and without a denominator');
  assert.equal(diagnoseAnalysis({ ...good, private: true }, context).code, 'shape_type');
  assert.equal(diagnoseAnalysis(null, context).path, '$');
  assert.equal(diagnoseAnalysis({ ...good, schemaVersion: 'old' }, context).path, '$.schemaVersion');
  assert.equal(diagnoseAnalysis({ ...good, language: 'fr' }, context).path, '$.language');
  assert.equal(diagnoseAnalysis({ ...good, summary: { ...good.summary, text: 'RPE 8/10', evidence: good.summary.evidence } }, context).code, 'analysis_rpe_scale');
  assert.equal(diagnoseAnalysis({ ...good, summary: { ...good.summary, text: 'RPE 4/10', evidence: good.summary.evidence } }, context).code, 'analysis_rpe_scale');
  for (const text of ['RPE: 8/10', 'RPE 3–4/10', 'RPE 8/10', 'Esforço percebido 4/10', 'Perceived effort: 2-3/10']) {
    const diagnostic = diagnoseAnalysis({ ...good, summary: { ...good.summary, text, evidence: good.summary.evidence } }, context);
    assert.equal(diagnostic.code, 'analysis_rpe_scale', `${text} must use Kinesis 1–5 scale`);
    assert.equal(diagnostic.path, '$.summary.text');
  }
  for (const text of ['RPE: 1–5', 'RPE 3–4/5', 'RPE 2/5', '5 km in 30 min']) {
    assert.equal(diagnoseAnalysis({ ...good, summary: { ...good.summary, text, evidence: good.summary.evidence } }, context), null, `${text} remains valid`);
  }
  assert.equal(diagnoseAnalysis({ ...good, limitations: ['RPE 8/10'] }, context).path, '$.limitations[0]');
  assert.equal(diagnoseAnalysis({ ...good, limitations: Array(7).fill('Limitação informada') }, context).path, '$.limitations');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ ...good.reusableInterpretations[0], text: 'RPE 3–4/10' }] }, context).path, '$.reusableInterpretations[0].text');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: 'Conta training:999 para ver', evidence: refs(context) } }, context).code, 'analysis_technical_reference');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: 'Uma conclusão', evidence: ['training:999'] } }, context).path, '$.summary.evidence[0]');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: 'Uma conclusão', evidence: 'training:101' } }, context).path, '$.summary.evidence');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: 'Uma conclusão', evidence: Array(9).fill('training:101') } }, context).path, '$.summary.evidence');
  assert.equal(diagnoseAnalysis(good, null).code, 'analysis_evidence', 'missing source context cannot authorize evidence');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: '', evidence: refs(context) } }, context).code, 'analysis_text');
  assert.equal(diagnoseAnalysis({ ...good, summary: { text: 'ok', evidence: refs(context), unexpected: true } }, context).code, 'analysis_shape');
  assert.equal(diagnoseAnalysis({ ...good, contextualReading: 'no' }, context).path, '$.contextualReading');
  assert.equal(diagnoseAnalysis({ ...good, contextualReading: [{ text: '', evidence: refs(context) }] }, context).path, '$.contextualReading[0].text');
  assert.equal(diagnoseAnalysis({ ...good, attention: Array(6).fill(good.summary) }, context).path, '$.attention');
  assert.equal(diagnoseAnalysis({ ...good, classification: { value: 'unknown', evidence: refs(context) } }, context).path, '$.classification.value');
  assert.equal(diagnoseAnalysis({ ...good, classification: { value: 'good', evidence: ['training:999'] } }, context).code, 'analysis_evidence');
  assert.equal(diagnoseAnalysis({ ...good, classification: { value: 'good', evidence: 'training:101' } }, context).code, 'analysis_evidence');
  assert.equal(diagnoseAnalysis({ ...good, classification: { value: 'good', evidence: Array(9).fill('training:101') } }, context).code, 'analysis_evidence');
  assert.equal(diagnoseAnalysis({ ...good, limitations: ['cycle:private'] }, context).code, 'analysis_shape');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ kind: 'other', text: 'Text', evidence: refs(context) }] }, context).code, 'analysis_interpretation');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: 'not-an-array' }, context).path, '$.reusableInterpretations');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: Array(6).fill(good.reusableInterpretations[0]) }, context).path, '$.reusableInterpretations');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ kind: 'pattern', text: 'Text', evidence: refs(context), unexpected: true }] }, context).code, 'analysis_shape');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ kind: 'pattern', text: '', evidence: refs(context) }] }, context).code, 'analysis_text');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ kind: 'pattern', text: 'Text', evidence: [] }] }, context).code, 'analysis_evidence');
  assert.equal(diagnoseAnalysis({ ...good, reusableInterpretations: [{ kind: 'pattern', text: 'Interpretação cycle:private', evidence: refs(context) }] }, context).code, 'analysis_text');
  db.close();
});

test('analysis requires a concluded owned result and a realized Kinesis RPE from one to five, without requiring a cycle plan or FIT', () => {
  const { db, config } = fixture();
  const context = buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config });
  assert.doesNotThrow(() => requireAnalysisSourcesCurrent(context));
  assert.equal(context.associatedCycle.id, 'cycle-a');
  assert.equal(context.appliedPlan, undefined);
  assert.equal(context.resource.actual.result_data_source, 'manual');
  assert.equal(context.resource.actual.fitLaps, undefined);
  assert.throws(() => buildContext(db, 2, { purpose: 'analysis', resourceId: 101, config }), (e) => e.code === 'resourceNotFound');
  const noCycleContext = buildContext(db, 2, { purpose: 'analysis', resourceId: 201, asOf: '2026-10-26', config });
  assert.equal(noCycleContext.cycle, null);
  assert.doesNotThrow(() => requireAnalysisSourcesCurrent(noCycleContext), 'a valid owned result needs neither an active cycle nor FIT');
  const legacyWithoutProvenance = structuredClone(context);
  legacyWithoutProvenance.resource.actual.result_data_source = 'none';
  legacyWithoutProvenance.resource.actual.fit_distance = 5;
  legacyWithoutProvenance.resource.actual.fit_duration = '30:00';
  assert.doesNotThrow(() => requireAnalysisSourcesCurrent(legacyWithoutProvenance), 'a complete legacy result remains analyzable without FIT provenance');
  db.prepare("UPDATE trainings SET result_data_source='fit_upload',fit_summary_json=? WHERE id=101")
    .run(JSON.stringify({ laps: [{ lap: 1, stepType: 'Run', duration: '30:00', distanceKm: 5 }] }));
  const fitContext = buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config });
  assert.deepEqual(fitContext.resource.actual.fitLaps, [{
    lap: 1, stepType: 'Run', duration: '30:00', distanceKm: 5,
    avgPaceSecondsPerKm: undefined, avgHeartRate: undefined, maxHeartRate: undefined,
    ascentMeters: undefined, avgCadenceSpm: undefined, maxCadenceSpm: undefined,
  }]);
  db.prepare('UPDATE trainings SET fit_summary_json=? WHERE id=101').run('{broken');
  assert.deepEqual(buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config }).resource.actual.fitLaps, []);
  db.prepare('UPDATE trainings SET fit_summary_json=NULL WHERE id=101').run();
  assert.equal(Object.hasOwn(buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config }).resource.actual, 'fitLaps'), false, 'a missing historical FIT summary does not invent lap data');
  db.prepare('UPDATE trainings SET fit_summary_json=? WHERE id=101').run('{"laps":"invalid"}');
  assert.equal(Object.hasOwn(buildContext(db, 1, { purpose: 'analysis', resourceId: 101, asOf: '2026-10-26', config }).resource.actual, 'fitLaps'), false);
  for (const update of [
    "UPDATE trainings SET completed=0 WHERE id=101",
    "UPDATE trainings SET completed=1,feedback_rpe=NULL WHERE id=101",
    "UPDATE trainings SET completed=1,feedback_rpe=6 WHERE id=101",
  ]) {
    db.prepare(update).run();
    const invalid = buildContext(db, 1, { purpose: 'analysis', resourceId: 101, config });
    assert.throws(() => requireAnalysisSourcesCurrent(invalid), (e) => e.code === 'analysisRequiresCompletedResult');
  }
  db.prepare("UPDATE trainings SET completed=1,feedback_rpe=3,result_data_source='none',fit_distance=NULL WHERE id=101").run();
  const noResult = buildContext(db, 1, { purpose: 'analysis', resourceId: 101, config });
  assert.throws(() => requireAnalysisSourcesCurrent(noResult), (e) => e.code === 'analysisRequiresCompletedResult');
  db.close();
});

test('analysis execution persists after canonical save, validates before storing interpretations, recovers owner-scoped versions and freshness', async () => {
  const f = fixture();
  let providerCalls = 0;
  let invalidNext = false;
  const adapter = createWorkoutAnalysisAdapter(f.db, () => '2026-10-26T12:00:00.000Z');
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: adapter },
    now: () => '2026-10-26T12:00:00.000Z',
    client: async (payload) => {
      providerCalls += 1;
      const input = JSON.parse(payload.input[0].content[0].text);
      assert.equal(input.context.resource.report.feedback_rpe, 3, 'provider sees the persisted canonical feedback');
      if (invalidNext) {
        const invalid = result(input.context);
        invalid.reusableInterpretations[0].text = 'RPE 3–4/10';
        return { value: invalid, usage: { input: 500, output: 100, cached: 0 }, error: null };
      }
      return { value: result(input.context), usage: { input: 700, output: 240, cached: 0 }, error: null };
    },
  });
  const queued = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-first-01' });
  const done = await waitFor(service, queued.id);
  assert.equal(done.state, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workout_analysis_versions').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretations').get().n, 1);
  const recovered = readWorkoutAnalyses(f.db, 1, '101', f.config);
  assert.equal(recovered.latest.id, queued.id);
  assert.equal(recovered.latest.outdated, false, 'an analysis does not stale itself with its own interpretation output');
  assert.equal(recovered.latest.result.summary.text, 'A sessão ficou próxima do planejado com os dados registrados.');
  assert.equal('evidence' in recovered.latest.result.summary, false, 'technical evidence IDs stay out of product response');
  const memoryBeforeDecision = memoryOverview(f.db, 1, f.config, '2026-10-26').interpretations[0];
  assert.equal(memoryBeforeDecision.current, true);
  assert.equal(memoryBeforeDecision.text, memoryBeforeDecision.originalText);
  assert.equal(memoryBeforeDecision.href, '/training-result.html?id=101');
  const nextContext = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config });
  assert.equal(nextContext.interpretations[0].authority, 'ai_interpretation');
  assert.equal(nextContext.interpretations[0].statusMeaning, 'unconfirmed_hypothesis');
  const weekContext = buildContext(f.db, 1, { purpose: 'workouts', taskDate: '2026-10-26', asOf: '2026-10-26', config: f.config });
  assert.equal(weekContext.interpretations[0].authority, 'ai_interpretation', 'current interpretations continue into weekly context');
  const item = recovered.latest.interpretations[0];
  for (const key of ['evidence_json', 'evidence', 'evidence_key', 'evidence_hash', 'content_hash']) assert.equal(Object.hasOwn(item, key), false, `read projection excludes ${key}`);
  const originalEvidence = f.db.prepare('SELECT evidence_json FROM ai_interpretations WHERE id=?').get(item.id).evidence_json;
  f.db.prepare('UPDATE ai_interpretations SET evidence_json=? WHERE id=?').run(JSON.stringify([{ type: 'training', id: '999', version: 'stale' }]), item.id);
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations?.length || 0, 0, 'an interpretation whose source version is stale is omitted');
  f.db.prepare("UPDATE ai_interpretations SET evidence_json=?,disposition='corrected',correction_text=NULL WHERE id=?").run(originalEvidence, item.id);
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations?.length || 0, 0, 'a legacy corrected row without text is not promoted to current context');
  f.db.prepare("UPDATE ai_interpretations SET disposition='pending',correction_text=NULL WHERE id=?").run(item.id);
  const confirmed = changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: item.version }, () => '2026-10-26T13:00:00.000Z');
  assert.equal(confirmed.interpretation.disposition, 'confirmed');
  assert.equal(Object.hasOwn(confirmed.interpretation, 'evidence_json'), false);
  assert.equal(confirmed.interpretation.correction, null);
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations[0].disposition, 'confirmed');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'discard', { expected_version: item.version }), (e) => e.code === 'interpretationConflict');
  const corrected = changeInterpretation(f.db, 1, item.id, 'correct', { expected_version: confirmed.interpretation.version, text: 'A pessoa relata esforço estável.' }, () => '2026-10-26T14:00:00.000Z');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: corrected.interpretation.version }), (e) => e.code === 'interpretationConflict', 'a correction cannot be confirmed back to the original model text');
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations[0].text, 'A pessoa relata esforço estável.');
  const correctedContext = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations[0];
  assert.equal(correctedContext.authority, 'user_report');
  assert.equal(correctedContext.text, 'A pessoa relata esforço estável.');
  const correctedMemory = memoryOverview(f.db, 1, f.config, '2026-10-26').interpretations[0];
  assert.equal(correctedMemory.current, true);
  assert.equal(correctedMemory.text, 'A pessoa relata esforço estável.');
  assert.notEqual(correctedMemory.originalText, correctedMemory.text);
  changeInterpretation(f.db, 1, item.id, 'discard', { expected_version: corrected.interpretation.version });
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations?.length || 0, 0);
  assert.equal(memoryOverview(f.db, 1, f.config, '2026-10-26').interpretations[0].current, false, 'dismissal remains in history without returning to current context');
  invalidNext = true;
  const later = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-later-02' });
  const laterFailure = await waitFor(service, later.id);
  assert.equal(laterFailure.state, 'failed');
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.id, queued.id, 'a failed newer analysis preserves the previous result');
  assert.throws(() => readWorkoutAnalyses(f.db, 2, '101', f.config), (error) => error.code === 'resourceNotFound');
  assert.throws(() => changeInterpretation(f.db, 2, item.id, 'confirm', { expected_version: item.version }), (e) => e.code === 'resourceNotFound');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'restore', { expected_version: item.version }), (e) => e.code === 'invalidFields');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: 0 }), (e) => e.code === 'invalidVersion');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'correct', { expected_version: item.version, text: '  ' }), (e) => e.code === 'invalidText');
  const dismissedVersion = f.db.prepare('SELECT version FROM ai_interpretations WHERE id=?').get(item.id).version;
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: dismissedVersion }), (e) => e.code === 'interpretationConflict', 'dismissed interpretations cannot be resurrected');
  f.db.prepare('UPDATE trainings SET feedback_notas=? WHERE id=101').run('Updated source');
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, true);
  assert.equal(providerCalls, 2, 'reads and disposition changes never call the model');
  await service.stop();
  f.db.close();
});

test('persisted interpretation dependencies enter later cycle, week and analysis contexts in exact-version order', async () => {
  const f = fixture();
  let calls = 0;
  const service = createExecutionService({
    db: f.db, config: f.config,
    operations: { analysis: createWorkoutAnalysisAdapter(f.db, () => '2026-10-26T12:00:00.000Z') },
    client: async (payload) => {
      const context = JSON.parse(payload.input[0].content[0].text).context;
      calls += 1;
      const output = result(context, `Synthetic analysis ${calls}.`);
      if (calls === 1) output.reusableInterpretations[0].text = 'A supported by the training.';
      else {
        const prior = context.interpretations.find((item) => item.text === 'A supported by the training.');
        assert.ok(prior, 'the second simulated provider request receives A in its context');
        output.reusableInterpretations[0] = {
          kind: 'recommendation', text: 'B supported by A.', evidence: [`interpretation:${prior.source.id}`],
        };
      }
      return { value: output, usage: { input: 400, output: 100, cached: 0 }, error: null };
    },
  });
  const first = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'dependency-analysis-a' });
  assert.equal((await waitFor(service, first.id)).state, 'completed');
  const a = f.db.prepare("SELECT id FROM ai_interpretations WHERE disposition='pending' ORDER BY created_at,id LIMIT 1").get();
  assert.ok(a);
  const second = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'dependency-analysis-b' });
  assert.equal((await waitFor(service, second.id)).state, 'completed');
  assert.equal(calls, 2);
  for (const options of [
    { purpose: 'cycle', resourceId: 'cycle-a' },
    { purpose: 'workouts', taskDate: '2026-10-26' },
    { purpose: 'analysis', resourceId: 101 },
  ]) {
    const context = buildContext(f.db, 1, { ...options, asOf: '2026-10-26', config: f.config });
    assert.deepEqual(context.interpretations.map((item) => item.text), ['A supported by the training.', 'B supported by A.']);
  }
  const memory = memoryOverview(f.db, 1, f.config, '2026-10-26');
  assert.deepEqual(new Set(memory.interpretations.filter((item) => item.current).map((item) => item.text)), new Set(['A supported by the training.', 'B supported by A.']));
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, false, 'persisting B does not stale the analysis that consumed A');
  await service.stop();
  f.db.close();
});

test('analysis execution cancels a queued record locally and reuses one active run per owned session', async () => {
  const f = fixture();
  let providerCalls = 0;
  let providerContext;
  let releaseProvider;
  const providerResult = new Promise((resolve) => { releaseProvider = resolve; });
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    client: async (payload) => {
      providerCalls += 1;
      providerContext = JSON.parse(payload.input[0].content[0].text).context;
      return providerResult;
    },
  });
  const cancelled = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-cancel-01' });
  assert.equal(service.cancel(1, cancelled.id).state, 'cancelled');
  assert.equal(f.db.prepare('SELECT state FROM workout_analysis_versions WHERE id=?').get(cancelled.id).state, 'cancelled');
  const active = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-active-02' });
  for (let attempt = 0; attempt < 100 && providerCalls === 0; attempt += 1) await delay(2);
  assert.equal(providerCalls, 1);
  const duplicate = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-active-03' });
  assert.equal(duplicate.id, active.id, 'a second action while this session is processing reads the same run');
  releaseProvider({ value: result(providerContext), usage: { input: 300, output: 120, cached: 0 }, error: null });
  assert.equal((await waitFor(service, active.id)).state, 'completed');
  assert.equal(providerCalls, 1);
  await service.stop();
  let releaseCancelled;
  const cancelledResponse = new Promise((resolve) => { releaseCancelled = resolve; });
  const cancellationService = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    client: async () => cancelledResponse,
  });
  const running = cancellationService.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-running-cancel-04' });
  for (let attempt = 0; attempt < 100 && cancellationService.get(1, running.id).state !== 'running'; attempt += 1) await delay(2);
  assert.equal(cancellationService.get(1, running.id).state, 'running');
  cancellationService.cancel(1, running.id);
  releaseCancelled({ value: result(providerContext), usage: { input: 200, output: 50, cached: 0 }, error: null });
  assert.equal((await waitFor(cancellationService, running.id)).state, 'cancelled', 'late provider completion settles the cancelled execution without persisting analysis');
  assert.equal(f.db.prepare('SELECT response_json FROM workout_analysis_versions WHERE id=?').get(running.id).response_json, null);
  await cancellationService.stop();
  f.db.close();
});

test('context reports reusable interpretations omitted at the optional evidence budget', () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('prior-analysis',1,101,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z')`).run();
  const base = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config });
  const evidence = JSON.stringify([{ type: 'training', id: '101', version: base.sources.find((ref) => ref.type === 'training' && ref.id === '101').version }]);
  const insert = f.db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`);
  for (let index = 0; index < 24; index += 1) {
    const text = `Synthetic recurring interpretation ${index}: ` + 'steady effort '.repeat(24);
    const id = `interpretation-${index}`;
    const hash = `evidence-${index}`;
    insert.run(id, 1, 101, 'prior-analysis', 'pattern', text, evidence, evidence, hash, `content-${index}`, `2026-10-26T00:${String(index).padStart(2, '0')}:00.000Z`, `2026-10-26T00:${String(index).padStart(2, '0')}:00.000Z`);
  }
  let omitted = false;
  for (let budget = 1500; budget <= 12000 && !omitted; budget += 100) {
    const config = structuredClone(f.config);
    config.limits.AI_CONTEXT_TOKENS = budget;
    try {
      omitted = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config }).omissions
        .some((item) => item.type === 'interpretation' && item.reason === 'context_budget');
    } catch (error) {
      if (!['contextTooLarge', 'criticalContextTooLarge'].includes(error.code)) throw error;
    }
  }
  assert.equal(omitted, true, 'the bounded selector explicitly records omitted reusable interpretations');
  f.db.close();
});

test('invalid model output retains sanitized validation diagnostics and does not persist partial analysis', async () => {
  const f = fixture();
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    now: () => '2026-10-26T12:00:00.000Z',
    client: async (payload) => {
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const value = result(context);
      value.reusableInterpretations[0].text = 'RPE 3–4/10';
      return { value, usage: { input: 100, output: 40, cached: 0 }, error: null };
    },
  });
  const queued = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-invalid-01' });
  const failed = await waitFor(service, queued.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.response, null);
  assert.equal(f.db.prepare('SELECT response_json FROM workout_analysis_versions WHERE id=?').get(queued.id).response_json, null);
  const diagnostic = JSON.parse(f.db.prepare('SELECT diagnostics_json FROM ai_executions WHERE id=?').get(queued.id).diagnostics_json).at(-1);
  assert.equal(diagnostic.validation.code, 'analysis_rpe_scale');
  assert.equal(diagnostic.validation.path, '$.reusableInterpretations[0].text');
  const debug = service.get(1, queued.id);
  assert.equal(debug.response, null);
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest, null);
  await service.stop();
  f.db.close();
});

test('interpretation identity retains sibling conclusions, exact repeats, replacement history, and the freshness snapshot', async () => {
  const f = fixture();
  let providerCalls = 0;
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  const outputs = [
    [
      { kind: 'pattern', text: 'A conclusão inicial descreve estabilidade.', evidence: ['training:101'] },
      { kind: 'pattern', text: 'Outra leitura da mesma sessão aponta variação.', evidence: ['training:101'] },
      { kind: 'pattern', text: 'Uma terceira leitura ainda é distinta.', evidence: ['training:101'] },
    ],
    [{ kind: 'pattern', text: 'A análise revisada identifica variação maior.', evidence: ['training:101'] }],
    [{ kind: 'pattern', text: 'A análise revisada identifica variação maior.', evidence: ['training:101'] }],
    [{ kind: 'pattern', text: 'Uma nova revisão descreve progresso consistente.', evidence: ['training:101'] }],
  ];
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    now: () => new Date(++clock).toISOString(),
    client: async (payload) => {
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const value = result(context);
      value.reusableInterpretations = outputs[providerCalls++];
      return { value, usage: { input: 500, output: 150, cached: 0 }, error: null };
    },
  });
  const run = async (key) => {
    const queued = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: key });
    return { queued, done: await waitFor(service, queued.id) };
  };
  const first = await run('identity-first-01');
  assert.equal(first.done.state, 'completed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretations').get().n, 3, 'same evidence does not collapse distinct texts from one answer');
  const originals = f.db.prepare("SELECT * FROM ai_interpretations WHERE analysis_id=? ORDER BY id").all(first.queued.id);
  changeInterpretation(f.db, 1, originals[1].id, 'correct', { expected_version: 1, text: 'Relato corrigido pelo usuário.' });
  changeInterpretation(f.db, 1, originals[2].id, 'discard', { expected_version: 1 });
  const second = await run('identity-second-02');
  assert.equal(second.done.state, 'completed');
  const revised = f.db.prepare('SELECT * FROM ai_interpretations WHERE analysis_id=?').get(second.queued.id);
  assert.ok(revised);
  assert.equal(f.db.prepare('SELECT disposition FROM ai_interpretations WHERE id=?').get(originals[0].id).disposition, 'superseded');
  const supersededVersion = f.db.prepare('SELECT version FROM ai_interpretations WHERE id=?').get(originals[0].id).version;
  assert.throws(() => changeInterpretation(f.db, 1, originals[0].id, 'confirm', { expected_version: supersededVersion }), (error) => error.code === 'interpretationConflict');
  assert.equal(f.db.prepare('SELECT disposition FROM ai_interpretations WHERE id=?').get(originals[1].id).disposition, 'corrected');
  assert.equal(f.db.prepare('SELECT disposition FROM ai_interpretations WHERE id=?').get(originals[2].id).disposition, 'dismissed');
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, false, 'the replacement output does not stale itself after replacing consumed context');
  f.db.prepare("UPDATE ai_interpretations SET disposition='confirmed',version=version+1 WHERE id=?").run(revised.id);
  const third = await run('identity-third-03');
  assert.equal(third.done.state, 'completed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretations').get().n, 4, 'an exact later repeat is not duplicated');
  assert.equal(f.db.prepare('SELECT disposition FROM ai_interpretations WHERE id=?').get(revised.id).disposition, 'confirmed', 'an exact repeat does not reactivate or reset a user decision');
  const fourth = await run('identity-fourth-04');
  assert.equal(fourth.done.state, 'completed');
  assert.equal(f.db.prepare('SELECT disposition FROM ai_interpretations WHERE id=?').get(revised.id).disposition, 'superseded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretation_replacements').get().n, 2);
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, false);
  const context = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config });
  assert.ok(context.interpretations.some((item) => item.text === 'Relato corrigido pelo usuário.'));
  assert.ok(context.interpretations.some((item) => item.text === 'Uma nova revisão descreve progresso consistente.'));
  assert.equal(context.interpretations.some((item) => item.text === 'Uma terceira leitura ainda é distinta.'), false);
  assert.equal(providerCalls, 4);
  await service.stop();
  f.db.close();
});

for (const reaffirmationFirst of [true, false])
test(`a repeated active interpretation is preserved before replacement as one response set (${reaffirmationFirst ? 'A then C' : 'C then A'})`, async () => {
  const f = fixture();
  const a = { kind: 'pattern', text: 'A: consistent documented effort.', evidence: ['training:101'] };
  const b = { kind: 'pattern', text: 'B: an earlier distinct conclusion.', evidence: ['training:101'] };
  const c = { kind: 'pattern', text: 'C: a new distinct conclusion.', evidence: ['training:101'] };
  let providerCalls = 0;
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  const outputs = [[a, b], reaffirmationFirst ? [a, c] : [c, a]];
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    now: () => new Date(++clock).toISOString(),
    client: async (payload) => {
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const value = result(context);
      value.reusableInterpretations = outputs[providerCalls++];
      return { value, usage: { input: 100, output: 50, cached: 0 }, error: null };
    },
  });
  const run = async (key) => {
    const queued = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: key });
    return { queued, done: await waitFor(service, queued.id) };
  };
  const first = await run('set-reaffirm-first-01');
  const initial = new Map(f.db.prepare('SELECT id,text FROM ai_interpretations WHERE analysis_id=?').all(first.queued.id).map((row) => [row.text, row.id]));
  const interpretationA = f.db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get(initial.get(a.text));
  changeInterpretation(f.db, 1, interpretationA.id, 'confirm', { expected_version: interpretationA.version });
  const second = await run('set-reaffirm-second-02');
  const final = new Map(f.db.prepare('SELECT id,text,disposition FROM ai_interpretations WHERE user_id=1').all().map((row) => [row.text, row]));
  assert.equal(final.get(a.text).disposition, 'confirmed', 'the repeated item keeps its existing user decision');
  assert.equal(final.get(b.text).disposition, 'superseded', 'only the conclusion omitted from the complete new set is replaced');
  assert.equal(final.get(c.text).disposition, 'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretations WHERE user_id=1').get().n, 3, 'the repeated item is not duplicated');
  const replacement = f.db.prepare(`SELECT replaced_interpretation_id,replacement_interpretation_id,replacement_analysis_id
    FROM ai_interpretation_replacements WHERE user_id=1`).get();
  assert.deepEqual(replacement, {
    replaced_interpretation_id: initial.get(b.text),
    replacement_interpretation_id: final.get(c.text).id,
    replacement_analysis_id: second.queued.id,
  });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretation_replacements WHERE replaced_interpretation_id=?').get(initial.get(a.text)).n, 0,
    'a reaffirmed interpretation receives no replacement link');
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, false, 'set-level replacement does not stale its own analysis');
  const context = buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config });
  const selected = new Set((context.interpretations || []).map((item) => item.text));
  assert.equal(selected.has(a.text), true, 'the affirmed conclusion remains selected in future context');
  assert.equal(selected.has(c.text), true, 'the new conclusion is selected in future context');
  assert.equal(selected.has(b.text), false, 'the replaced conclusion is not selected in future context');
  await service.stop();
  f.db.close();
});

test('an exact repeated response keeps corrected, dismissed, and superseded interpretations unchanged', async () => {
  const f = fixture();
  const items = [
    { kind: 'pattern', text: 'A: stable pattern.', evidence: ['training:101'] },
    { kind: 'pattern', text: 'B: varied pattern.', evidence: ['training:101'] },
    { kind: 'pattern', text: 'C: third pattern.', evidence: ['training:101'] },
  ];
  let providerCalls = 0;
  let clock = Date.parse('2026-10-26T13:00:00.000Z');
  const service = createExecutionService({
    db: f.db, config: f.config, operations: { analysis: createWorkoutAnalysisAdapter(f.db) },
    now: () => new Date(++clock).toISOString(),
    client: async (payload) => {
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const value = result(context); value.reusableInterpretations = items; providerCalls += 1;
      return { value, usage: { input: 100, output: 50, cached: 0 }, error: null };
    },
  });
  const run = async (key) => { const row = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: key }); return waitFor(service, row.id); };
  const first = await run('same-response-first-01');
  const rows = f.db.prepare('SELECT * FROM ai_interpretations WHERE analysis_id=? ORDER BY text').all(first.id);
  changeInterpretation(f.db, 1, rows[0].id, 'correct', { expected_version: rows[0].version, text: 'User corrected A.' });
  changeInterpretation(f.db, 1, rows[1].id, 'discard', { expected_version: rows[1].version });
  f.db.prepare("UPDATE ai_interpretations SET disposition='superseded' WHERE id=?").run(rows[2].id);
  const second = await run('same-response-second-02');
  assert.equal(second.state, 'completed');
  const after = f.db.prepare('SELECT * FROM ai_interpretations WHERE id IN (?,?,?) ORDER BY id').all(...rows.map((item) => item.id));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretations WHERE user_id=1').get().n, 3);
  assert.deepEqual(new Map(after.map((item) => [item.id, item.disposition])), new Map([
    [rows[0].id, 'corrected'], [rows[1].id, 'dismissed'], [rows[2].id, 'superseded'],
  ]));
  assert.equal(after.find((item) => item.id === rows[0].id).correction_text, 'User corrected A.');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_interpretation_replacements WHERE replacement_analysis_id=?').get(second.id).n, 0,
    'an exact repeat does not create replacement history or reactivate a prior decision');
  await service.stop(); f.db.close();
});

test('analysis history migration is idempotent and preserves an existing pre-analysis training and legacy memory archive', () => {
  const { db } = fixture();
  db.prepare("INSERT INTO ai_memory(id,user_id,kind,authority,text,observed_on,state,source_json,updated_at) VALUES ('legacy-ai',1,'interpretation','ai_interpretation','archived','2026-01-01','unconfirmed','{}','2026-01-01')").run();
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-workout-analysis-v1'").run();
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2'").run();
  db.exec('DROP TABLE ai_interpretation_replacements;');
  db.exec('DROP TABLE ai_interpretations; DROP TABLE workout_analysis_versions;');
  migrateWorkoutAnalysis(db);
  migrateWorkoutInterpretationIdentity(db);
  migrateWorkoutAnalysis(db);
  migrateWorkoutInterpretationIdentity(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trainings WHERE id=101').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_memory WHERE id='legacy-ai'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-workout-analysis-v1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2'").get().n, 1);
  db.close();
});

test('interpretation identity migration upgrades an already deployed v1 table without losing history', () => {
  const { db } = fixture();
  db.prepare(`INSERT INTO workout_analysis_versions(id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES ('v1-existing',1,101,1,'workout-analysis-v1','{}','completed','en-US','2026-10-25T10:00:00.000Z')`).run();
  db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,correction_text,version,created_at,updated_at)
    VALUES ('v1-item',1,101,'v1-existing','pattern','preserved text','[]','[]','old-evidence','existing-content-hash','corrected','saved user correction',4,'2026-10-25T10:00:00.000Z','2026-10-26T10:00:00.000Z')`).run();
  // Recreate the exact v1 table shape and marker: this models a database that
  // already ran the PR's first analysis migration before receiving this patch.
  db.exec(`DROP TABLE ai_interpretation_replacements;
    ALTER TABLE ai_interpretations RENAME TO ai_interpretations_v2_test;
    CREATE TABLE ai_interpretations (
      id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      analysis_id TEXT NOT NULL REFERENCES workout_analysis_versions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('pattern','recommendation','attention')),
      text TEXT NOT NULL,evidence_json TEXT NOT NULL,evidence_key TEXT NOT NULL,evidence_hash TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('pending','confirmed','corrected','dismissed','superseded')),
      correction_text TEXT,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(user_id,kind,evidence_hash));
    INSERT INTO ai_interpretations(id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,disposition,correction_text,version,created_at,updated_at)
      SELECT id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,disposition,correction_text,version,created_at,updated_at FROM ai_interpretations_v2_test;
    DROP TABLE ai_interpretations_v2_test;
    DELETE FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2';`);
  migrateWorkoutInterpretationIdentity(db);
  migrateWorkoutInterpretationIdentity(db);
  const saved = db.prepare('SELECT * FROM ai_interpretations WHERE id=?').get('v1-item');
  assert.equal(saved.text, 'preserved text');
  assert.equal(saved.correction_text, 'saved user correction');
  assert.equal(saved.disposition, 'corrected');
  assert.equal(saved.version, 4);
  assert.match(saved.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_interpretation_replacements').get().n, 0);
  db.close();
});

test('interpretation identity migration is safe when its table exists without the marker and refuses a missing v1 table', () => {
  const { db } = fixture();
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2'").run();
  db.exec('DROP TABLE ai_interpretation_replacements;');
  migrateWorkoutInterpretationIdentity(db);
  assert.ok(db.pragma('table_info(ai_interpretations)').some((column) => column.name === 'content_hash'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2'").get().n, 1);
  db.exec('DROP TABLE ai_interpretation_replacements; DROP TABLE ai_interpretations;');
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-workout-interpretation-identity-v2'").run();
  assert.throws(() => migrateWorkoutInterpretationIdentity(db), /workout-analysis-v1 must be installed first/);
  db.close();
});
