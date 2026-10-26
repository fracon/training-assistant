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
const { migrateWorkoutAnalysis } = require('../src/ai/schema');
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
      if (invalidNext) return { value: result(input.context, 'RPE 8/10'), usage: { input: 500, output: 100, cached: 0 }, error: null };
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
  const originalEvidence = f.db.prepare('SELECT evidence_json FROM ai_interpretations WHERE id=?').get(item.id).evidence_json;
  f.db.prepare('UPDATE ai_interpretations SET evidence_json=? WHERE id=?').run(JSON.stringify([{ type: 'training', id: '999', version: 'stale' }]), item.id);
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations?.length || 0, 0, 'an interpretation whose source version is stale is omitted');
  f.db.prepare("UPDATE ai_interpretations SET evidence_json=?,disposition='corrected',correction_text=NULL WHERE id=?").run(originalEvidence, item.id);
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations?.length || 0, 0, 'a legacy corrected row without text is not promoted to current context');
  f.db.prepare("UPDATE ai_interpretations SET disposition='pending',correction_text=NULL WHERE id=?").run(item.id);
  const confirmed = changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: item.version }, () => '2026-10-26T13:00:00.000Z');
  assert.equal(confirmed.interpretation.disposition, 'confirmed');
  assert.equal(buildContext(f.db, 1, { purpose: 'cycle', resourceId: 'cycle-a', asOf: '2026-10-26', config: f.config }).interpretations[0].disposition, 'confirmed');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'discard', { expected_version: item.version }), (e) => e.code === 'interpretationConflict');
  const corrected = changeInterpretation(f.db, 1, item.id, 'correct', { expected_version: confirmed.interpretation.version, text: 'A pessoa relata esforço estável.' }, () => '2026-10-26T14:00:00.000Z');
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
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: 0 }), (e) => e.code === 'invalidVersion');
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'correct', { expected_version: item.version, text: '  ' }), (e) => e.code === 'invalidText');
  const dismissedVersion = f.db.prepare('SELECT version FROM ai_interpretations WHERE id=?').get(item.id).version;
  assert.throws(() => changeInterpretation(f.db, 1, item.id, 'confirm', { expected_version: dismissedVersion }), (e) => e.code === 'interpretationUnavailable', 'dismissed interpretations cannot be resurrected');
  f.db.prepare('UPDATE trainings SET feedback_notas=? WHERE id=101').run('Updated source');
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest.outdated, true);
  assert.equal(providerCalls, 2, 'reads and disposition changes never call the model');
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
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,disposition,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`);
  for (let index = 0; index < 24; index += 1) {
    const text = `Synthetic recurring interpretation ${index}: ` + 'steady effort '.repeat(24);
    const id = `interpretation-${index}`;
    const hash = `evidence-${index}`;
    insert.run(id, 1, 101, 'prior-analysis', 'pattern', text, evidence, evidence, hash, `2026-10-26T00:${String(index).padStart(2, '0')}:00.000Z`, `2026-10-26T00:${String(index).padStart(2, '0')}:00.000Z`);
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
      return { value: result(context, 'RPE 8/10'), usage: { input: 100, output: 40, cached: 0 }, error: null };
    },
  });
  const queued = service.enqueue(1, { purpose: 'analysis', resource_id: '101', idempotency_key: 'analysis-invalid-01' });
  const failed = await waitFor(service, queued.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.response, null);
  assert.equal(f.db.prepare('SELECT response_json FROM workout_analysis_versions WHERE id=?').get(queued.id).response_json, null);
  const diagnostic = JSON.parse(f.db.prepare('SELECT diagnostics_json FROM ai_executions WHERE id=?').get(queued.id).diagnostics_json).at(-1);
  assert.equal(diagnostic.validation.code, 'analysis_rpe_scale');
  assert.equal(diagnostic.validation.path, '$.summary.text');
  const debug = service.get(1, queued.id);
  assert.equal(debug.response, null);
  assert.equal(readWorkoutAnalyses(f.db, 1, '101', f.config).latest, null);
  await service.stop();
  f.db.close();
});

test('analysis history migration is idempotent and preserves an existing pre-analysis training and legacy memory archive', () => {
  const { db } = fixture();
  db.prepare("INSERT INTO ai_memory(id,user_id,kind,authority,text,observed_on,state,source_json,updated_at) VALUES ('legacy-ai',1,'interpretation','ai_interpretation','archived','2026-01-01','unconfirmed','{}','2026-01-01')").run();
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-workout-analysis-v1'").run();
  db.exec('DROP TABLE ai_interpretations; DROP TABLE workout_analysis_versions;');
  migrateWorkoutAnalysis(db);
  migrateWorkoutAnalysis(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trainings WHERE id=101').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_memory WHERE id='legacy-ai'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-workout-analysis-v1'").get().n, 1);
  db.close();
});
