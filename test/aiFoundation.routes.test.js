'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');
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
      { fields: { goals: 'Synthetic' }, expected_version: 0 },
    ],
    [
      'POST',
      '/api/ai/memory',
      {
        kind: 'restriction',
        text: 'Synthetic',
        observed_on: '2026-10-01',
        state: 'current',
        expected_version: 0,
      },
    ],
    ['GET', '/api/ai/executions'],
    ['GET', '/api/ai/context?purpose=cycle'],
    ['GET', '/api/ai/admin/usage'],
  ])
    assert.equal((await send(method, url, payload, 0)).statusCode, 401);
  assert.equal((await send('GET', '/api/ai/memory')).json().profile.version, 0);
  const profile = { fields: { goals: 'Synthetic goal' }, expected_version: 0 };
  assert.equal((await send('PUT', '/api/ai/profile', profile)).statusCode, 200);
  assert.equal((await send('PUT', '/api/ai/profile', profile)).statusCode, 409);
  assert.equal(
    (await send('GET', '/api/ai/memory', undefined, 2)).json().profile.version,
    0,
  );
  const entry = {
    kind: 'restriction',
    text: 'Synthetic limitation',
    observed_on: '2026-10-01',
    state: 'current',
    expected_version: 0,
  };
  const saved = (await send('POST', '/api/ai/memory', entry)).json();
  const id = saved.entries[0].id;
  assert.equal(
    (await send('PUT', `/api/ai/memory/${id}`, entry)).statusCode,
    400,
  );
  assert.equal(
    (
      await send(
        'PUT',
        `/api/ai/memory/${id}`,
        { ...entry, state: 'resolved', expected_version: 1 },
        2,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await send('PUT', `/api/ai/memory/${id}`, {
        ...entry,
        state: 'resolved',
        expected_version: 1,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await send('DELETE', `/api/ai/memory/${id}`, undefined, 2)).statusCode,
    404,
  );
  assert.equal((await send('DELETE', `/api/ai/memory/${id}`)).statusCode, 204);
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
  const failed = await send('GET', '/api/ai/memory');
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error, 'aiInternalError');
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
