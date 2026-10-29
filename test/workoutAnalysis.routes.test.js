'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');

function seedPersistedLegacyAnalysis(db) {
  db.prepare(`INSERT INTO trainings
    (id,user_id,dia,tipo,treino,completed,feedback_rpe,result_data_source,fit_distance,fit_duration)
    VALUES (27,1,'2026-10-27','Corrida','Treino sintético',1,3,'manual',5,'30:00')`).run();
  const response = {
    schemaVersion: 'workout-analysis-v1', language: 'pt-BR',
    summary: { text: 'Resumo sintético persistido.', evidence: ['training:27'] },
    comparison: { text: 'Comparação sintética persistida.', evidence: ['training:27'] },
    contextualReading: [{ text: 'Leitura sintética persistida.', evidence: ['training:27'] }],
    attention: [], recommendations: [],
    classification: { value: 'adequate', evidence: ['training:27'] },
    limitations: ['Fixture sintética de compatibilidade.'], reusableInterpretations: [],
  };
  db.prepare(`INSERT INTO workout_analysis_versions
    (id,user_id,training_id,sequence,adapter_version,context_json,response_json,state,language,created_at)
    VALUES ('legacy-analysis-27',1,27,1,'workout-analysis-v1',?,?, 'completed','pt-BR','2026-10-27T10:00:00.000Z')`)
    .run(JSON.stringify({ purpose: 'analysis', policyVersion: 'training-analysis-context-v0', asOf: '2026-10-27' }), JSON.stringify(response));
}

test('analysis history HTTP reads an old persisted analysis after process restart and returns uncached owner-scoped state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'kinesis-analysis-read-'));
  const filename = join(directory, 'isolated.sqlite');
  let db = createDatabase({ filename });
  db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES (1,'synthetic-owner@example.invalid','synthetic','user'),(2,'synthetic-other@example.invalid','synthetic','admin')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES (28,1,'2026-10-28','Corrida','Sem feedback nem análise'),(29,1,'2026-10-28','Corrida','Somente feedback')").run();
  db.prepare('UPDATE trainings SET feedback_rpe=4,feedback_notas=? WHERE id=29').run('Feedback sintético sem análise.');
  seedPersistedLegacyAnalysis(db);
  const config = readAiConfig({ AI_ENABLED: 'false' });
  let app = await buildServer({ db, aiConfig: config, sessionCookieSecure: false });
  let ownerCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 1).token}`;
  let otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 2).token}`;
  const read = (id, cookie = ownerCookie) => app.inject({ method: 'GET', url: `/api/trainings/${id}/analyses`, headers: { cookie } });
  t.after(async () => {
    if (app) await app.close();
    if (db?.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const empty = await read(28);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers['cache-control'], 'no-store');
  assert.deepEqual(empty.json(), { analyses: [], active: null, latest: null }, 'no feedback, analysis or execution is a valid empty result');
  const feedbackOnly = await read(29);
  assert.equal(feedbackOnly.statusCode, 200);
  assert.deepEqual(feedbackOnly.json(), { analyses: [], active: null, latest: null }, 'feedback alone does not create analysis history');

  const beforeRestart = await read(27);
  assert.equal(beforeRestart.statusCode, 200);
  assert.equal(beforeRestart.json().latest.id, 'legacy-analysis-27');
  assert.equal(beforeRestart.json().latest.result.summary.text, 'Resumo sintético persistido.');
  assert.equal(beforeRestart.json().latest.adapterVersion, 'workout-analysis-v1');
  assert.equal((await read(27, otherCookie)).statusCode, 404, 'admin role does not grant cross-owner analysis access');

  await app.close();
  app = null;
  db.close();
  db = createDatabase({ filename });
  app = await buildServer({ db, aiConfig: config, sessionCookieSecure: false });
  ownerCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 1).token}`;
  otherCookie = `${SESSION_COOKIE_NAME}=${createSession(db, 2).token}`;
  const afterRestart = await read(27);
  assert.equal(afterRestart.statusCode, 200);
  assert.equal(afterRestart.json().latest.result.summary.text, 'Resumo sintético persistido.', 'the stored response is recovered from the same SQLite file after a fresh server/database initialization');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workout_analysis_versions WHERE id=?').get('legacy-analysis-27').count, 1, 'recovery does not rewrite or duplicate history');
});

test('public analysis execution routes redact provider responses consistently and keep debug owner-scoped', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES (1,'public-owner@example.invalid','synthetic','user'),(2,'public-admin@example.invalid','synthetic','admin'),(3,'public-other@example.invalid','synthetic','user')").run();
  db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino,result_data_source,fit_distance,fit_duration,fit_avg_pace,feedback_rpe,completed)
    VALUES (101,1,'2026-10-27','Run','Synthetic result','manual',5,'30:00','6:00',3,1),
           (202,2,'2026-10-27','Run','Synthetic admin result','manual',5,'30:00','6:00',4,1)`).run();
  const config = readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-only', AI_RETRIES: '0' });
  let providerCalls = 0;
  const app = await buildServer({
    db,
    aiConfig: config,
    sessionCookieSecure: false,
    aiClient: async (payload) => {
      providerCalls += 1;
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const evidence = [`${context.resource.source.type}:${context.resource.source.id}`];
      return {
        value: {
          schemaVersion: 'workout-analysis-v1', language: context.preferences.language,
          summary: { text: 'Synthetic finding.', evidence },
          comparison: { text: 'Synthetic comparison.', evidence },
          contextualReading: [{ text: 'Synthetic contextual reading.', evidence }],
          attention: [], recommendations: [],
          classification: { value: 'adequate', evidence },
          limitations: ['Synthetic provider fixture.'],
          reusableInterpretations: [{ kind: 'pattern', text: 'Synthetic interpretation.', evidence }],
        },
        usage: { input: 20, output: 10, cached: 0 }, error: null,
      };
    },
  });
  const cookie = (id) => `${SESSION_COOKIE_NAME}=${createSession(db, id).token}`;
  const headers = (id) => ({ cookie: cookie(id) });
  const keyFor = (id) => `public-analysis-${id}-key`;
  const start = async (userId, resourceId) => {
    const body = { purpose: 'analysis', resource_id: String(resourceId), idempotency_key: keyFor(userId) };
    const response = await app.inject({ method: 'POST', url: '/api/ai/executions', headers: headers(userId), payload: body });
    assert.equal(response.statusCode, 202);
    return { body, id: response.json().id };
  };
  const waitForCompletion = async (userId, id) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/ai/executions/${id}`, headers: headers(userId) });
      if (response.json().state === 'completed') return response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('synthetic analysis execution did not complete');
  };
  t.after(async () => { await app.close(); db.close(); });

  for (const [userId, resourceId] of [[1, 101], [2, 202]]) {
    const first = await start(userId, resourceId);
    const completedRead = await waitForCompletion(userId, first.id);
    assert.equal(completedRead.json().response, null, 'polling never exposes analysis evidence');
    const repeated = await app.inject({ method: 'POST', url: '/api/ai/executions', headers: headers(userId), payload: first.body });
    assert.equal(repeated.statusCode, 202);
    assert.equal(repeated.json().id, first.id);
    assert.equal(repeated.json().response, null, 'idempotent replay uses the same public projection');
    const cancelled = await app.inject({ method: 'POST', url: `/api/ai/executions/${first.id}/cancel`, headers: headers(userId), payload: {} });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().state, 'completed');
    assert.equal(cancelled.json().response, null, 'terminal cancellation also uses the public projection');
    assert.equal(providerCalls, userId, 'replay and terminal cancellation make no additional provider call');

    const adminDebug = await app.inject({ method: 'GET', url: `/api/ai/admin/executions/${first.id}`, headers: headers(userId) });
    if (userId === 1) assert.equal(adminDebug.statusCode, 403, 'a regular owner cannot read administrative diagnostics');
    else {
      assert.equal(adminDebug.statusCode, 200);
      assert.ok(adminDebug.json().response.summary.evidence.length, 'authorized owner-admin debug retains exact evidence');
    }
    const crossOwner = await app.inject({ method: 'GET', url: `/api/ai/executions/${first.id}`, headers: headers(userId === 1 ? 2 : 1) });
    assert.equal(crossOwner.statusCode, 404, 'analysis execution access remains owner-scoped, including admins');
  }
});
