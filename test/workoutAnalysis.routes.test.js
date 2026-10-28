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
