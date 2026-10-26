'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');
const { logUnexpectedError } = require('../src/ai/routes');
test('unexpected AI error diagnostics bound malformed metadata and never echo error details',()=>{
  const originalConsoleError=console.error;const logs=[];console.error=(...values)=>logs.push(values.join(' '));
  try {
    logUnexpectedError({name:'',code:'',message:'sensitive request payload',stack:null},{method:'POST'});
  } finally { console.error=originalConsoleError; }
  assert.equal(logs.length,1);
  const diagnostic=JSON.parse(logs[0].replace(/^\[Kinesis\] /,''));
  assert.deepEqual(diagnostic,{event:'ai_route_unexpected_error',method:'POST',route:'unknown',errorName:'Error',errorCode:null,frames:[]});
  assert.doesNotMatch(logs[0],/sensitive request payload/);
});
async function fixture(t, extra = {}) {
  const db = createDatabase({ filename: ':memory:' });
  for (let i = 1; i <= 3; i++)
    db.prepare(
      "INSERT INTO users(id,email,password_hash,role) VALUES (?,?,'synthetic',?)",
    ).run(i, `synthetic-${i}@example.invalid`, i === 1 ? 'admin' : 'user');
  const cookies = [
    null,
    ...[1, 2, 3].map(
      (id) => `${SESSION_COOKIE_NAME}=${createSession(db, id).token}`,
    ),
  ];
  const app = await buildServer({ db, sessionCookieSecure: false, ...extra });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { db, app, cookies };
}
test('HTTP memory is owner scoped, locally editable, race safe, and denies invalid/inactive access', async (t) => {
  const { app, db, cookies } = await fixture(t);
  const send = (method, url, payload, user = 1) =>
    app.inject({
      method,
      url,
      payload,
      headers: user ? { cookie: cookies[user] } : {},
    });
  assert.equal(
    (await send('GET', '/training-memory.html', undefined, 0)).headers.location,
    '/login.html',
  );
  assert.equal((await send('GET', '/training-memory.html')).statusCode, 200);
  for (const [method, url, payload] of [
    ['GET', '/api/ai/memory'],
    [
      'PUT',
      '/api/ai/profile',
      { fields: { experience: 'Synthetic' }, expected_version: 0 },
    ],
    ['GET', '/api/ai/executions'],
    ['GET', '/api/ai/context?purpose=cycle'],
    ['GET', '/api/ai/admin/usage'],
  ])
    assert.equal((await send(method, url, payload, 0)).statusCode, 401);
  assert.equal((await send('GET', '/api/ai/memory')).json().profile.version, 0);
  const profile = { fields: { experience: 'Synthetic goal' }, expected_version: 0 };
  assert.equal((await send('PUT', '/api/ai/profile', profile)).statusCode, 200);
  assert.equal((await send('PUT', '/api/ai/profile', profile)).statusCode, 409);
  assert.equal(
    (await send('GET', '/api/ai/memory', undefined, 2)).json().profile.version,
    0,
  );
  for (const [method,url] of [['POST','/api/ai/memory'],['PUT','/api/ai/memory/legacy-id'],['DELETE','/api/ai/memory/legacy-id']])
    assert.equal((await send(method,url,{})).statusCode,404);
  assert.deepEqual((await send('GET','/api/ai/memory/legacy')).json(),{fields:{},entries:[]});
  assert.equal((await send('GET','/api/ai/context?purpose=cycle',undefined,2)).statusCode,403);
  assert.equal((await send('PUT','/api/ai/profile',{fields:{goals:'duplicate'},expected_version:1})).statusCode,400);
  assert.equal(
    (await send('GET', '/api/ai/context?purpose=cycle&as_of=2026-10-14'))
      .statusCode,
    200,
  );
  assert.equal(
    (await send('GET', '/api/ai/context?purpose=invalid')).statusCode,
    400,
  );
  assert.equal(
    (await send('GET', '/api/ai/admin/usage', undefined, 2)).statusCode,
    403,
  );
  assert.equal(
    (await send('GET', '/api/ai/admin/usage')).json().enabled,
    false,
  );
  assert.equal(
    (await send('POST', '/api/ai/admin/preview', { purpose: 'cycle' }, 2))
      .statusCode,
    403,
  );
  assert.equal(
    (await send('GET', '/api/ai/admin/executions/missing', undefined, 2))
      .statusCode,
    403,
  );
  assert.equal(
    (await send('GET', '/api/ai/executions/missing')).statusCode,
    404,
  );
  assert.equal(
    (
      await send('POST', '/api/ai/executions/missing/cancel', {
        anything: true,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await send('POST', '/api/ai/executions/missing/cancel')).statusCode,
    404,
  );
  assert.equal(
    (
      await send('POST', '/api/ai/executions', {
        purpose: 'cycle',
        idempotency_key: 'synthetic-key',
      })
    ).statusCode,
    503,
  );
  db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  assert.equal((await send('GET', '/api/ai/memory')).statusCode, 401);
  assert.equal((await send('GET', '/api/ai/admin/usage')).statusCode, 401);
});
test('HTTP asynchronous contract survives polling/reload with mock-only registered operations', async (t) => {
  let finish;
  const held = new Promise((resolve) => (finish = resolve));
  const config = readAiConfig({
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key',
  });
  const operation = {
    version: 'synthetic-v1',
    adaptPrompt: (prompt) => prompt,
    instructions: 'Synthetic test only',
    format: {
      type: 'json_schema',
      name: 'fixture',
      strict: true,
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    validate: (value) => value?.ok === true,
  };
  const { app, db, cookies } = await fixture(t, {
    aiConfig: config,
    aiOperations: { cycle: operation },
    aiClient: () => held,
  });
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective) VALUES ('cycle',1,'Synthetic cycle')",
  ).run();
  const send = (method, url, payload, user = 1) =>
    app.inject({ method, url, payload, headers: { cookie: cookies[user] } });
  assert.equal(
    (
      await send('POST', '/api/ai/executions', {
        purpose: 'analysis',
        idempotency_key: 'synthetic-key',
      })
    ).statusCode,
    409,
  );
  const created = await send('POST', '/api/ai/executions', {
    purpose: 'cycle',
    resource_id: 'cycle',
    idempotency_key: 'synthetic-cycle',
  });
  assert.equal(created.statusCode, 202);
  const id = created.json().id;
  assert.ok(
    ['queued', 'running'].includes(
      (await send('GET', `/api/ai/executions/${id}`)).json().state,
    ),
  );
  const debug = (await send('GET', `/api/ai/admin/executions/${id}`)).json();
  assert.equal(debug.payload.store, false);
  assert.equal(JSON.stringify(debug).includes('synthetic-test-key'), false);
  assert.equal(
    (await send('GET', `/api/ai/executions/${id}`, undefined, 2)).statusCode,
    404,
  );
  assert.equal(
    (
      await send('POST', '/api/ai/admin/preview', {
        purpose: 'cycle',
        resource_id: 'cycle',
      })
    ).json().paid,
    false,
  );
  assert.equal(
    (await send('POST', `/api/ai/executions/${id}/cancel`, {})).json().state,
    'cancelled',
  );
  finish({
    value: { ok: true },
    usage: { input: 20, output: 5, cached: 0 },
    error: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await send('GET', `/api/ai/executions/${id}`)).json().response,
    null,
  );
  assert.equal(
    (await send('GET', '/api/ai/executions')).json().executions.length,
    1,
  );
  const ordinaryView = (await send('GET', `/api/ai/executions/${id}`)).json();
  for (const field of [
    'usage',
    'estimatedCostUsd',
    'payload',
    'context',
    'externalPrompt',
    'configuration',
  ])
    assert.equal(field in ordinaryView, false);
  db.prepare("UPDATE users SET role='user' WHERE id=1").run();
  assert.equal(
    (await send('GET', `/api/ai/admin/executions/${id}`)).statusCode,
    403,
  );
  assert.equal((await send('GET', '/api/ai/admin/usage')).statusCode, 403);
  // Unexpected internal errors are ordinary HTTP 500s, with no leaked provider/SQL message.
  db.prepare('DROP TABLE ai_profiles').run();
  const originalConsoleError = console.error;
  const diagnosticLogs = [];
  console.error = (...values) => diagnosticLogs.push(values.join(' '));
  let failed;
  try {
    failed = await send('GET', '/api/ai/memory');
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error, 'aiInternalError');
  assert.equal(diagnosticLogs.length, 1);
  assert.match(diagnosticLogs[0], /ai_route_unexpected_error/);
  assert.match(diagnosticLogs[0], /SQLITE_ERROR/);
  assert.doesNotMatch(diagnosticLogs[0], /no such table|SELECT |DROP TABLE|planner@example|synthetic-test-key/i);
});

test('interpretation read and confirm/correct/discard responses expose one owner-scoped product projection', async (t) => {
  const { app, db, cookies } = await fixture(t);
  const send = (method, url, payload, user) => app.inject({ method, url, payload, headers: { cookie: cookies[user] } });
  const create = db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino,completed,feedback_rpe)
    VALUES (?,?, '2026-10-20','Run','Synthetic',1,3)`);
  const addVersion = db.prepare(`INSERT INTO workout_analysis_versions
    (id,user_id,training_id,sequence,adapter_version,context_json,state,language,created_at)
    VALUES (?,?,?,1,'workout-analysis-v2','{}','completed','en-US','2026-10-26T10:00:00Z')`);
  const addItem = db.prepare(`INSERT INTO ai_interpretations
    (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, ?,?,?,'pending','2026-10-26T10:00:00Z','2026-10-26T10:00:00Z')`);
  const ids = {};
  for (const userId of [1, 2]) {
    const trainingId = 900 + userId;
    create.run(trainingId, userId);
    const analysisId = `analysis-${userId}`;
    addVersion.run(analysisId, userId, trainingId);
    for (const [index, action] of ['confirm', 'correct', 'discard'].entries()) {
      const id = `interp-${userId}-${action}`;
      ids[`${userId}:${action}`] = { id, trainingId };
      addItem.run(id, userId, trainingId, analysisId, ['pattern','recommendation','attention'][index], 'Synthetic interpretation', '[{"type":"training","id":"1","version":"private"}]', '[{"type":"training","id":"1"}]', `evidence-${userId}-${index}`, `content-${userId}-${index}`);
    }
  }
  const allowed = ['correction', 'disposition', 'id', 'kind', 'text', 'updatedAt', 'version'];
  const read = await send('GET', `/api/trainings/${ids['2:confirm'].trainingId}/analyses`, undefined, 2);
  assert.deepEqual(Object.keys(read.json().analyses[0].interpretations[0]).sort(), allowed);
  assert.equal(JSON.stringify(read.json()).includes('evidence_json'), false);
  for (const userId of [1, 2]) {
    for (const action of ['confirm', 'correct', 'discard']) {
      const { id, trainingId } = ids[`${userId}:${action}`];
      const payload = action === 'correct' ? { expected_version: 1, text: 'A user correction.' } : { expected_version: 1 };
      if (action === 'correct') {
        const incompatible = await send('POST', `/api/ai/interpretations/${id}/correct`, { expected_version: 1, text: 'RPE 8/10 was prescribed.' }, userId);
        assert.equal(incompatible.statusCode, 400);
        assert.deepEqual(incompatible.json().errors, ['incompatibleRpeScale']);
        assert.equal(db.prepare('SELECT disposition,version FROM ai_interpretations WHERE id=?').get(id).version, 1, 'an invalid correction writes nothing');
      }
      const response = await send('POST', `/api/ai/interpretations/${id}/${action}`, payload, userId);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(Object.keys(response.json().interpretation).sort(), allowed);
      assert.equal(response.json().interpretation.correction, action === 'correct' ? 'A user correction.' : null);
      const stranger = await send('POST', `/api/ai/interpretations/${id}/${action}`, payload, userId === 1 ? 2 : 3);
      assert.equal(stranger.statusCode, 404, 'neither a regular user nor an admin may mutate another account\'s item');
      const ownerRead = await send('GET', `/api/trainings/${trainingId}/analyses`, undefined, userId);
      assert.deepEqual(Object.keys(ownerRead.json().analyses[0].interpretations[0]).sort(), allowed);
    }
  }
  const adminCannotReadOther = await send('GET', `/api/trainings/${ids['2:confirm'].trainingId}/analyses`, undefined, 1);
  assert.equal(adminCannotReadOther.statusCode, 404);
  db.prepare("UPDATE workout_analysis_versions SET error_code='invalidDomainResponse' WHERE id='analysis-2'").run();
  const safeFailure = await send('GET', `/api/trainings/${ids['2:confirm'].trainingId}/analyses`, undefined, 2);
  assert.equal(safeFailure.json().analyses[0].errorCode, 'invalidDomainResponse');
  db.prepare("UPDATE workout_analysis_versions SET error_code='providerTimeout' WHERE id='analysis-2'").run();
  const publicFailure = await send('GET', `/api/trainings/${ids['2:confirm'].trainingId}/analyses`, undefined, 2);
  assert.equal(publicFailure.json().analyses[0].errorCode, 'providerTimeout', 'a known product-safe execution code is available for recovery copy');
  db.prepare("UPDATE workout_analysis_versions SET error_code='unlisted-internal-diagnostic' WHERE id='analysis-2'").run();
  const sanitizedFailure = await send('GET', `/api/trainings/${ids['2:confirm'].trainingId}/analyses`, undefined, 2);
  assert.equal(sanitizedFailure.json().analyses[0].errorCode, null, 'internal diagnostic values are not copied to the product API');
});

test('invalid AI settings disable paid work without breaking startup, memory or cleanup', async (t) => {
  const config = readAiConfig({
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key',
    AI_RETENTION_DAYS: 'bad',
    AI_CONTEXT_TOKENS: 'bad',
    AI_TIMEOUT_MS: 'bad',
  });
  const { app, cookies } = await fixture(t, { aiConfig: config });
  const headers = { cookie: cookies[1] };
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/ai/memory', headers }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/ai/context?purpose=cycle',
        headers,
      })
    ).statusCode,
    200,
  );
  const usage = (
    await app.inject({ method: 'GET', url: '/api/ai/admin/usage', headers })
  ).json();
  assert.equal(usage.enabled, false);
  assert.ok(usage.configurationErrors.includes('AI_RETENTION_DAYS'));
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ai/executions',
        headers,
        payload: { purpose: 'cycle', idempotency_key: 'synthetic-invalid' },
      })
    ).statusCode,
    503,
  );
});

test('existing source APIs update common-user memory and next admin context without paid calls', async (t) => {
  let calls=0;
  const {app,db,cookies}=await fixture(t,{aiClient:async()=>{calls++;throw Error('unexpected model call');}});
  const send=(method,url,payload,user=1)=>app.inject({method,url,payload,headers:{cookie:cookies[user]}});
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES ('source',1,'Original goal','active')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES (50,1,date('now'),'Run','Synthetic source session')").run();
  const before=(await send('GET','/api/ai/context?purpose=cycle')).json();
  assert.equal((await send('PUT','/api/cycles/source',{objective:'Corrected target',primary_goal:'Corrected primary goal'})).statusCode,200);
  const days=require('../src/availability').DAY_KEYS.map((day)=>({day,can_train:day==='monday',available_periods:['before_08'],available_minutes:60,location:'Synthetic corrected locality'}));
  assert.equal((await send('PUT','/api/ai-coach/availability',{days})).statusCode,200);
  assert.equal((await send('PATCH','/api/trainings/50',{feedback_has_pain:'yes',feedback_pain:'Synthetic dated report'})).statusCode,200);
  const overview=(await send('GET','/api/ai/memory')).json();
  const after=(await send('GET','/api/ai/context?purpose=cycle')).json();
  assert.equal(overview.cycle.objective,'Corrected target');
  assert.equal(after.cycle.objective,overview.cycle.objective);
  assert.equal(overview.availability.find((r)=>r.day==='monday').location,'Synthetic corrected locality');
  assert.equal(overview.recent[0].report.feedback_pain,'Synthetic dated report');
  assert.equal(overview.recent[0].date,after.recent[0].date);
  assert.notEqual(after.hash,before.hash);
  assert.deepEqual((await send('GET','/api/ai/memory',undefined,2)).json().recent,[]);
  assert.equal(calls,0);
});
