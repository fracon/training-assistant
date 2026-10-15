'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase, initializeDatabase } = require('../src/db/database');
const { readAiConfig, LIMITS, MODELS } = require('../src/ai/config');
const {
  AiError,
  activeOwner,
  exactKeys,
  date,
  readMemory,
  saveProfile,
  saveEntry,
  deleteEntry,
  hash,
} = require('../src/ai/memory');
const {
  buildContext,
  contextIsCurrent,
  duration,
} = require('../src/ai/context');
const { createExecutionService } = require('../src/ai/executions');
const { renderPrompt } = require('../src/ai/prompt-service');
const { createResponsesClient, buildPayload } = require('../src/ai/client');
const baseline = require('./fixtures/ai/prompt-baseline.json');
const weekly = require('../src/public/shared/workout-prompts.js');
const analysis = require('../src/public/shared/analysis-prompts.js');
const macro = require('../src/prompts');
const markdown = require('../src/markdownGenerator');
const { setTimeout: delay } = require('node:timers/promises');
function setup(extra = {}) {
  const db = createDatabase({ filename: ':memory:' });
  for (let i = 1; i <= 3; i++)
    db.prepare(
      "INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES (?,?,'synthetic',?,'en-US')",
    ).run(i, `synthetic-${i}@example.invalid`, i === 1 ? 'admin' : 'user');
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective) VALUES ('cycle',1,'Synthetic cycle'),('other',2,'Other cycle')",
  ).run();
  db.prepare(
    "INSERT INTO trainings(id,user_id,dia,tipo,treino,result_data_source,fit_distance,fit_duration,feedback_rpe,completed) VALUES (1,1,'2026-10-12','Run','Synthetic session','manual',5,'30:00',3,1),(2,2,'2026-10-12','Run','Private synthetic session','manual',5,'30:00',3,1)",
  ).run();
  const config = readAiConfig({
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key',
    ...extra,
  });
  return { db, config };
}
const operation = {
  version: 'evaluation-fixture-v1',
  adaptPrompt: (prompt) => prompt,
  instructions: 'Return a synthetic test result only.',
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
const body = {
  purpose: 'analysis',
  resource_id: 1,
  idempotency_key: 'synthetic-123',
};
function service(fixture, options = {}) {
  return createExecutionService({
    ...fixture,
    operations: { analysis: operation },
    client: async () => ({
      value: { ok: true },
      usage: { input: 100, output: 10, cached: 20 },
      error: null,
    }),
    now: () => '2026-10-14T12:00:00.000Z',
    ...options,
  });
}
function failure(fn, code) {
  assert.throws(fn, (e) => e instanceof AiError && e.code === code);
}
async function wait(s, user, id) {
  for (let i = 0; i < 100; i++) {
    const r = s.get(user, id);
    if (!['queued', 'running'].includes(r.state)) return r;
    await delay(5);
  }
  throw Error('execution did not finish');
}

test('all captured external PT/EN prompt variants remain byte-identical to main', () => {
  for (const item of baseline.outputs) {
    const {
      lang,
      unit,
      variant,
      training,
      laps,
      cycle,
      availability,
      summary,
    } = item;
    const messages = require(
      `../src/public/locales/${lang === 'pt-BR' ? 'pt' : 'en'}.json`,
    );
    const preferences = {
      distance_unit: unit,
      temperature_unit: unit === 'mi' ? 'F' : 'C',
    };
    const form = analysis.buildCanonicalPromptForm(training, {
      language: lang,
      messages,
    });
    assert.equal(
      analysis.buildAnalysisPrompt(
        analysis.templateFor(lang),
        analysis.collectPromptValues({
          training,
          form,
          fitData: { ...training, laps },
          preferences,
          messages,
        }),
      ),
      item.analysis,
      `${lang}/${unit}/${variant} analysis`,
    );
    assert.equal(
      weekly.buildPrompt({
        targetDate: new Date(2026, 9, 19),
        disponibilidade: availability,
        contexto: 'Synthetic context',
        cycle,
        previousWeek: {
          totalDistanceKm: 5,
          totalTimeMinutes: 30,
          completedTrainingsCount: 1,
        },
        shoes: [
          {
            brand: 'Synthetic',
            model: 'Shoe',
            status: 'active',
            mileage: 50,
            target_mileage: 500,
          },
        ],
        lang,
        messages,
        preferences,
      }),
      item.weekly,
    );
    assert.equal(macro.buildMacrocyclePrompt(cycle, lang), item.macro);
    assert.equal(markdown.generateMarkdown(summary, {}, lang), item.markdown);
  }
});
test('configuration bounds models, switch, numeric settings and absence without exposing secrets', () => {
  assert.equal(readAiConfig({}).enabled, false);
  assert.equal(
    readAiConfig({ AI_ENABLED: 'false', OPENAI_API_KEY: 'synthetic' }).enabled,
    false,
  );
  assert.ok(readAiConfig({ AI_ENABLED: 'yes' }).errors.includes('AI_ENABLED'));
  for (const [key, [fallback, min, max]] of Object.entries(LIMITS)) {
    assert.equal(readAiConfig({ [key]: '' }).limits[key], fallback);
    for (const bad of [min - 1, max + 1, 'bad', 1.5])
      assert.ok(readAiConfig({ [key]: String(bad) }).errors.includes(key));
  }
  for (const purpose of ['CYCLE', 'WORKOUTS', 'ANALYSIS']) {
    assert.ok(
      readAiConfig({ [`AI_MODEL_${purpose}`]: 'arbitrary' }).errors.includes(
        `AI_MODEL_${purpose}`,
      ),
    );
    for (const model of MODELS)
      assert.equal(
        readAiConfig({ [`AI_MODEL_${purpose}`]: model }).models[
          purpose.toLowerCase()
        ],
        model,
      );
  }
  for (const key of ['AI_DAILY_USD_USER', 'AI_DAILY_USD_GLOBAL'])
    for (const bad of ['bad', '0', '1001'])
      assert.ok(readAiConfig({ [key]: bad }).errors.includes(key));
});
test('idempotent migration preserves data; account deletion removes private AI data', () => {
  const { db } = setup();
  initializeDatabase(db);
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-ai-foundation-v1'",
      )
      .get().n,
    1,
  );
  saveProfile(db, 1, { fields: { goals: 'Synthetic' }, expected_version: 0 });
  saveEntry(db, 1, {
    kind: 'restriction',
    text: 'Synthetic',
    observed_on: '2026-01-01',
    state: 'current',
    expected_version: 0,
  });
  db.prepare('DELETE FROM users WHERE id=1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_profiles').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_memory').get().n, 0);
  db.close();
});
test('profile and observations validate ownership, concurrency, dates, source and states', () => {
  const { db } = setup();
  assert.equal(readMemory(db, 1).profile.version, 0);
  assert.deepEqual(readMemory(db, 1).entries, []);
  failure(() => activeOwner(db, 99), 'accountUnavailable');
  db.prepare('UPDATE users SET is_active=0 WHERE id=3').run();
  failure(() => activeOwner(db, 3), 'accountUnavailable');
  for (const value of [null, [], { bad: 1 }])
    failure(() => exactKeys(value, []), 'invalidFields');
  for (const value of [null, '2026-02-30', 'bad'])
    failure(() => date(value), 'invalidDate');
  failure(
    () => saveProfile(db, 1, { fields: { goals: 'x' }, expected_version: -1 }),
    'invalidVersion',
  );
  failure(
    () =>
      saveProfile(db, 1, { fields: { arbitrary: 'x' }, expected_version: 0 }),
    'invalidFields',
  );
  for (const value of [3, 'x'.repeat(2001)])
    failure(
      () =>
        saveProfile(db, 1, { fields: { goals: value }, expected_version: 0 }),
      'invalidText',
    );
  const saved = saveProfile(
    db,
    1,
    {
      fields: { experience: ' Synthetic experience ', goals: '' },
      expected_version: 0,
    },
    '2026-10-01T00:00:00Z',
  );
  assert.equal(saved.profile.fields.experience.value, 'Synthetic experience');
  assert.equal(saved.profile.fields.goals.value, '');
  failure(
    () =>
      saveProfile(db, 1, { fields: { goals: 'changed' }, expected_version: 0 }),
    'memoryConflict',
  );
  saveProfile(db, 1, { fields: { goals: 'Updated' }, expected_version: 1 });
  const entry = {
    kind: 'restriction',
    text: 'Synthetic discomfort',
    observed_on: '2026-01-01',
    state: 'current',
    expected_version: 0,
  };
  for (const changed of [
    { kind: 'recommendation' },
    { state: 'invented' },
    { expected_version: -1 },
  ])
    failure(() => saveEntry(db, 1, { ...entry, ...changed }), 'invalidEntry');
  failure(() => saveEntry(db, 1, { ...entry, text: ' ' }), 'invalidText');
  saveEntry(db, 1, entry, 'entry', '2026-01-01T00:00:00Z');
  failure(() => saveEntry(db, 2, entry, 'entry'), 'memoryNotFound');
  failure(
    () => saveEntry(db, 1, { ...entry, expected_version: 1 }, 'missing'),
    'memoryNotFound',
  );
  failure(() => saveEntry(db, 1, entry, 'entry'), 'memoryConflict');
  const updated = saveEntry(
    db,
    1,
    { ...entry, state: 'resolved', expected_version: 1 },
    'entry',
    '2026-10-01T00:00:00Z',
  );
  assert.equal(updated.entries[0].version, 2);
  assert.equal(updated.entries[0].source.originalObservedOn, '2026-01-01');
  saveEntry(db, 1, { ...entry, kind: 'action' }, 'action');
  assert.equal(
    readMemory(db, 1).entries.find((e) => e.id === 'action').authority,
    'user_action',
  );
  failure(() => deleteEntry(db, 2, 'entry'), 'memoryNotFound');
  deleteEntry(db, 1, 'entry');
  db.close();
});
test('context preserves temporal authority, canonical aggregates, gaps and comparable source references', () => {
  const { db, config } = setup();
  const args = {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config,
  };
  const first = buildContext(db, 1, args);
  assert.equal(first.recent.length, 1);
  assert.ok(first.gaps.includes('Athlete profile has not been supplied.'));
  assert.equal(first.resource.actual.fit_distance, 5);
  assert.equal(first.resource.report.authority, 'user_report');
  assert.equal(contextIsCurrent(db, 1, first, config), true);
  failure(
    () => buildContext(db, 1, { ...args, purpose: 'arbitrary' }),
    'invalidPurpose',
  );
  failure(
    () => buildContext(db, 1, { ...args, resourceId: 2 }),
    'resourceNotFound',
  );
  db.prepare(
    "INSERT INTO trainings(user_id,dia,tipo,completed,fit_distance,fit_duration,feedback_rpe) VALUES (1,'2026-09-10','Run',1,12,'1:10:00',4),(1,'2026-09-11','Run',1,NULL,'bad',NULL),(1,'2026-09-12','Run',0,NULL,NULL,NULL),(1,'2025-01-01','Long run',1,15,'1:30:00',3)",
  ).run();
  saveEntry(
    db,
    1,
    {
      kind: 'restriction',
      text: 'Synthetic current restriction',
      observed_on: '2026-01-01',
      state: 'current',
      expected_version: 0,
    },
    'current',
  );
  saveEntry(
    db,
    1,
    {
      kind: 'restriction',
      text: 'Synthetic resolved restriction',
      observed_on: '2026-01-02',
      state: 'resolved',
      expected_version: 0,
    },
    'resolved',
  );
  saveEntry(
    db,
    1,
    {
      kind: 'milestone',
      text: 'Synthetic target',
      observed_on: '2026-12-01',
      state: 'current',
      expected_version: 0,
    },
    'milestone',
  );
  const context = buildContext(db, 1, args);
  assert.equal(context.currentRestrictions.length, 1);
  assert.equal(context.historicalEntries.length, 1);
  assert.equal(context.events.length, 1);
  assert.equal(context.weekly[0].distanceKm, 12);
  assert.equal(context.weekly[0].planned, 3);
  assert.equal(context.weekly[0].completed, 2);
  assert.equal(context.weekly[0].missingResults, 1);
  assert.equal(context.weekly[0].averageRpe, 4);
  assert.equal(context.comparables[0].includedInAggregates, true);
  assert.ok(
    context.omissions.some(
      (item) => item.reason === 'historical_cutoff_except_comparables',
    ),
  );
  assert.equal(contextIsCurrent(db, 1, first, config), false);
  assert.equal(
    buildContext(db, 2, { ...args, resourceId: 2 }).currentRestrictions.length,
    0,
  );
  assert.notEqual(
    context.hash,
    buildContext(db, 2, { ...args, resourceId: 2 }).hash,
  );
  assert.equal(
    buildContext(db, 1, { ...args, purpose: 'workouts', resourceId: null })
      .comparables[0].selectionReason,
    'previous_long_run',
  );
  assert.equal(
    buildContext(db, 1, { ...args, purpose: 'cycle', resourceId: 'cycle' })
      .resource.objective,
    'Synthetic cycle',
  );
  db.prepare('DELETE FROM trainings WHERE user_id=3').run();
  const empty = buildContext(db, 3, {
    purpose: 'cycle',
    asOf: '2026-10-14',
    config,
  });
  assert.ok(empty.gaps.includes('No recorded training history.'));
  assert.ok(
    empty.gaps.includes('No active cycle or applied AI planning version.'),
  );
  for (const value of [null, 'bad', '1:60', ''])
    assert.equal(duration(value), null);
  assert.equal(duration('1:02:03'), 3723);
  db.prepare('DELETE FROM trainings WHERE id=1').run();
  assert.equal(contextIsCurrent(db, 1, context, config), false);
  db.close();
});
test('context selection has explicit omissions and fails rather than truncating critical restrictions', () => {
  const { db, config } = setup();
  config.limits.AI_CONTEXT_TOKENS = 5000;
  for (let i = 0; i < 25; i++)
    saveEntry(
      db,
      1,
      {
        kind: 'milestone',
        text: 'Synthetic '.repeat(100),
        observed_on: '2026-01-01',
        state: 'current',
        expected_version: 0,
      },
      `event-${i}`,
    );
  const ctx = buildContext(db, 1, {
    purpose: 'cycle',
    asOf: '2026-10-14',
    config,
  });
  assert.ok(ctx.omissions.length);
  assert.ok(ctx.omissions.some((o) => o.reason === 'selection_omissions'));
  config.limits.AI_CONTEXT_TOKENS = 100;
  failure(
    () => buildContext(db, 1, { purpose: 'cycle', asOf: '2026-10-14', config }),
    'criticalContextTooLarge',
  );
  db.close();
});
test('client uses store:false server-only key, bounded output, no tools, and sanitized errors', async () => {
  const fixture = setup();
  const context = buildContext(fixture.db, 1, {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config: fixture.config,
  });
  const payload = buildPayload({
    model: 'gpt-6.1-sol',
    context,
    prompt: 'Synthetic prompt',
    adapter: operation,
    maxOutputTokens: 1000,
  });
  assert.equal(payload.store, false);
  assert.deepEqual(payload.tools, []);
  assert.equal(payload.background, false);
  const success = {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: '{"ok":true}' }],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 20 },
    },
  };
  const client = (raw, status = 200) =>
    createResponsesClient({
      apiKey: 'synthetic-test-key',
      timeoutMs: 1000,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(
          options.headers.Authorization,
          'Bearer synthetic-test-key',
        );
        assert.equal(
          JSON.stringify(payload).includes('synthetic-test-key'),
          false,
        );
        return {
          status,
          ok: status === 200,
          text: async () =>
            typeof raw === 'string' ? raw : JSON.stringify(raw),
        };
      },
    });
  assert.deepEqual((await client(success)(payload)).value, { ok: true });
  assert.deepEqual((await client(success)(payload)).usage, {
    input: 100,
    output: 10,
    cached: 20,
  });
  for (const [status, code] of [
    [429, 'providerRateLimited'],
    [500, 'providerOutcomeUncertain'],
    [400, 'providerRejected'],
  ])
    await assert.rejects(
      client(success, status)(payload),
      (e) => e.code === code,
    );
  for (const raw of ['bad', 'x'.repeat(1048577)])
    await assert.rejects(
      client(raw)(payload),
      (e) => e.code === 'providerOutcomeUncertain',
    );
  await assert.rejects(
    createResponsesClient({
      apiKey: 'synthetic',
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw Error('secret in provider exception');
      },
    })(payload),
    (e) =>
      e.code === 'providerOutcomeUncertain' && !e.message.includes('secret'),
  );
  for (const raw of [
    { ...success, status: 'incomplete' },
    {
      ...success,
      output: [
        {
          type: 'message',
          content: [{ type: 'refusal', refusal: 'synthetic' }],
        },
      ],
    },
    { ...success, output: [] },
    { ...success, output: null },
    { ...success, output: [{ type: 'reasoning' }] },
    { ...success, output: [{ type: 'message', content: null }] },
    {
      ...success,
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'bad' }] },
      ],
    },
  ])
    assert.ok((await client(raw)(payload)).error);
  assert.equal(
    (await client({ ...success, usage: null })(payload)).usage,
    null,
  );
  assert.deepEqual(
    (
      await client({
        ...success,
        usage: { input_tokens: 100, output_tokens: 10 },
      })(payload)
    ).usage,
    { input: 100, output: 10, cached: 0 },
  );
  fixture.db.close();
});
test('execution persistence, idempotency, private debug, usage reconciliation and retention', async () => {
  const fixture = setup();
  const s = service(fixture);
  const queued = s.enqueue(1, body);
  assert.equal(queued.state, 'queued');
  assert.equal(s.enqueue(1, body).id, queued.id);
  failure(
    () => s.enqueue(1, { ...body, purpose: 'cycle' }),
    'idempotencyConflict',
  );
  failure(() => s.get(2, queued.id), 'executionNotFound');
  failure(() => s.get(2, queued.id, true), 'adminRequired');
  assert.equal(s.list(1).length, 1);
  const result = await wait(s, 1, queued.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.usage, undefined);
  assert.equal(s.get(1, queued.id, true).usage.input, 100);
  assert.equal(s.usage(1)[0].tokens, 110);
  const debug = s.get(1, queued.id, true);
  assert.equal(debug.payload.store, false);
  assert.equal(JSON.stringify(debug).includes('synthetic-test-key'), false);
  assert.equal(debug.configuration.model, 'gpt-6.1-sol');
  assert.equal(s.cancel(1, queued.id).state, 'completed');
  assert.ok(
    s
      .preview(1, { purpose: 'analysis', resource_id: 1 })
      .prompt.includes('Synthetic session'),
  );
  assert.equal(
    s.preview(1, { purpose: 'cycle', resource_id: 'cycle' }).paid,
    false,
  );
  failure(
    () => s.preview(2, { purpose: 'analysis', resource_id: 2 }),
    'adminRequired',
  );
  fixture.db
    .prepare("UPDATE ai_executions SET updated_at='2025-01-01T00:00:00Z'")
    .run();
  s.cleanup();
  assert.equal(s.list(1).length, 0);
  await s.stop();
  fixture.db.close();
});
test('queue rejects disabled or unregistered phases, malformed requests and every quota dimension', async () => {
  const fixture = setup();
  const s = service(fixture);
  failure(
    () => s.enqueue(1, { ...body, idempotency_key: 'bad' }),
    'invalidIdempotencyKey',
  );
  failure(
    () => s.enqueue(1, { ...body, idempotency_key: 3 }),
    'invalidIdempotencyKey',
  );
  failure(
    () => s.enqueue(1, { ...body, purpose: 'arbitrary' }),
    'invalidPurpose',
  );
  fixture.config.enabled = false;
  failure(() => s.enqueue(1, body), 'aiUnavailable');
  fixture.config.enabled = true;
  const unavailable = service(fixture, { operations: {} });
  failure(() => unavailable.enqueue(1, body), 'phaseNotAvailable');
  await unavailable.stop();
  for (const key of [
    'AI_DAILY_TOKENS_USER',
    'AI_DAILY_TOKENS_GLOBAL',
    'AI_DAILY_USD_USER',
    'AI_DAILY_USD_GLOBAL',
    'AI_DAILY_CALLS_USER',
    'AI_DAILY_CALLS_GLOBAL',
    'AI_CONCURRENCY_GLOBAL',
    'AI_CONCURRENCY_USER',
  ]) {
    const old = fixture.config.limits[key];
    fixture.config.limits[key] = 0;
    failure(
      () => s.enqueue(1, body),
      key.startsWith('AI_CONCURRENCY') ? 'executionLimit' : 'usageLimit',
    );
    fixture.config.limits[key] = old;
  }
  const row = s.enqueue(1, body);
  assert.equal(s.cancel(1, row.id).state, 'cancelled');
  assert.equal(s.usage(1)[0].tokens, 0);
  await s.stop();
  fixture.db.close();
});
test('dispatch revalidates source versions, current activity and registered adapter', async () => {
  for (const change of ['inactive', 'deletedResource', 'adapter']) {
    const fixture = setup();
    const operations = { analysis: operation };
    const s = service(fixture, { operations });
    const row = s.enqueue(1, body);
    if (change === 'inactive')
      fixture.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    else if (change === 'deletedResource')
      fixture.db.prepare('DELETE FROM trainings WHERE id=1').run();
    else operations.analysis = { ...operation, version: 'changed' };
    await s.dispatch(row.id);
    assert.equal(
      fixture.db.prepare('SELECT state FROM ai_executions').get().state,
      change === 'inactive'
        ? 'cancelled'
        : change === 'deletedResource'
          ? 'outdated'
          : 'failed',
    );
    assert.equal(
      fixture.db.prepare('SELECT tokens FROM ai_usage').get().tokens,
      0,
    );
    await s.stop();
    fixture.db.close();
  }
});
test('held network calls do not hold write locks and changes/deletion/cancellation discard stale results', async () => {
  for (const change of ['feedback', 'delete', 'inactive', 'cancel']) {
    const fixture = setup();
    let resolve;
    const held = new Promise((r) => (resolve = r));
    const s = service(fixture, { client: () => held });
    const row = s.enqueue(1, body);
    const dispatch = s.dispatch(row.id);
    assert.equal(fixture.db.inTransaction, false);
    if (change === 'feedback')
      fixture.db
        .prepare(
          "UPDATE trainings SET feedback_notas='Changed synthetic report' WHERE id=1",
        )
        .run();
    if (change === 'delete')
      fixture.db.prepare('DELETE FROM users WHERE id=1').run();
    if (change === 'inactive')
      fixture.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    if (change === 'cancel')
      assert.equal(s.cancel(1, row.id).state, 'cancelled');
    resolve({
      value: { ok: true },
      usage: { input: 100, output: 10, cached: 0 },
      error: null,
    });
    await dispatch;
    const persisted = fixture.db.prepare('SELECT * FROM ai_executions').get();
    if (change === 'delete') assert.equal(persisted, undefined);
    else {
      assert.equal(
        persisted.state,
        change === 'cancel' ? 'cancelled' : 'outdated',
      );
      assert.equal(persisted.response_json, null);
    }
    await s.stop();
    fixture.db.close();
  }
});
test('rate limit retry is bounded; uncertain outcomes and invalid responses are never replayed', async () => {
  for (const code of [
    'providerRateLimited',
    'providerOutcomeUncertain',
    'providerRejected',
    'unknown',
    'refusal',
    'invalid',
    'throwValidator',
  ]) {
    const fixture = setup();
    let calls = 0;
    const s = service(fixture, {
      operations: {
        analysis:
          code === 'throwValidator'
            ? {
                ...operation,
                validate: () => {
                  throw Error('synthetic');
                },
              }
            : operation,
      },
      client: async () => {
        calls++;
        if (['refusal', 'invalid', 'throwValidator'].includes(code))
          return {
            value: { ok: code === 'throwValidator' },
            usage: null,
            error: code === 'refusal' ? 'providerRefused' : null,
          };
        if (code === 'unknown') throw Error('sensitive message');
        throw new AiError(code, 502);
      },
    });
    const row = s.enqueue(1, body);
    const result = await wait(s, 1, row.id);
    assert.equal(calls, code === 'providerRateLimited' ? 2 : 1);
    assert.equal(
      result.state,
      ['providerOutcomeUncertain', 'unknown'].includes(code)
        ? 'uncertain'
        : 'failed',
    );
    assert.equal(result.response, null);
    assert.equal(
      JSON.stringify(s.get(1, row.id, true)).includes('sensitive message'),
      false,
    );
    await s.stop();
    fixture.db.close();
  }
});
test('restart marks dispatched calls uncertain, resumes safe queue, keeps conservative usage and never recreates deleted accounts', async () => {
  const fixture = setup();
  const s = service(fixture);
  const row = s.enqueue(1, body);
  await s.stop();
  fixture.db
    .prepare("UPDATE ai_executions SET state='running',attempts=1 WHERE id=?")
    .run(row.id);
  const recovered = service(fixture);
  recovered.recover();
  assert.equal(recovered.get(1, row.id).state, 'uncertain');
  assert.ok(recovered.usage(1)[0].tokens > 0);
  recovered.recover();
  assert.ok(recovered.usage(1)[0].tokens > 0);
  fixture.db.prepare('DELETE FROM users WHERE id=1').run();
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n,
    0,
  );
  assert.ok(
    fixture.db.prepare('SELECT tokens FROM ai_global_usage').get().tokens > 0,
  );
  await recovered.stop();
  fixture.db.close();
});
test('weekly preview reuses saved availability and rejects incomplete legacy configuration', () => {
  const { db } = setup();
  failure(
    () => renderPrompt(db, 1, { purpose: 'cycle', resourceId: 'other' }),
    'resourceNotFound',
  );
  failure(
    () => renderPrompt(db, 1, { purpose: 'analysis', resourceId: 2 }),
    'resourceNotFound',
  );
  failure(() => renderPrompt(db, 1, { purpose: 'invalid' }), 'invalidPurpose');
  for (const targetDate of [null, 'bad', '2026-10-13', '2026-02-30'])
    failure(
      () => renderPrompt(db, 1, { purpose: 'workouts', targetDate }),
      'invalidDate',
    );
  failure(
    () =>
      renderPrompt(db, 3, { purpose: 'workouts', targetDate: '2026-10-19' }),
    'resourceNotFound',
  );
  failure(
    () =>
      renderPrompt(db, 1, { purpose: 'workouts', targetDate: '2026-10-19' }),
    'availabilityNeedsReview',
  );
  for (const day of [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ])
    db.prepare(
      "INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES (1,?,0,'[]',NULL,'')",
    ).run(day);
  assert.ok(
    renderPrompt(db, 1, {
      purpose: 'workouts',
      targetDate: '2026-10-19',
    }).includes('19/10/2026'),
  );
  db.prepare(
    "UPDATE ai_coach_availability SET can_train=1,available_periods='[\"before_08\",\"08_12\"]',available_minutes=60,location='Synthetic' WHERE day_key='monday'",
  ).run();
  failure(
    () =>
      renderPrompt(db, 1, { purpose: 'workouts', targetDate: '2026-10-19' }),
    'availabilityNeedsReview',
  );
  db.close();
});

test('context includes saved availability, shoes and unknown RPE without inventing history', () => {
  const { db, config } = setup();
  for (const day of [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ])
    db.prepare(
      "INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods) VALUES (1,?,0,'[]')",
    ).run(day);
  db.prepare(
    "INSERT INTO shoes(id,user_id,brand,model) VALUES ('shoe',1,'Synthetic','Fixture')",
  ).run();
  db.prepare(
    "INSERT INTO trainings(user_id,dia,tipo,completed,fit_distance,fit_duration) VALUES (1,'2026-08-10','Run',1,5,'30:00')",
  ).run();
  const args = {
    purpose: 'cycle',
    resourceId: 'cycle',
    asOf: '2026-10-14',
    config,
  };
  const context = buildContext(db, 1, args);
  assert.equal(context.availability.length, 7);
  assert.equal(context.shoes[0].brand, 'Synthetic');
  assert.equal(context.weekly[0].averageRpe, null);
  assert.equal(contextIsCurrent(db, 1, context, config), true);
  const without = buildContext(db, 1, {
    ...args,
    purpose: 'analysis',
    resourceId: null,
  });
  assert.equal(without.comparables.length, 0);
  assert.equal(contextIsCurrent(db, 1, without, config), true);
  const bare = buildContext(db, 3, {
    purpose: 'cycle',
    asOf: '2026-10-14',
    config,
  });
  assert.equal(contextIsCurrent(db, 3, bare, config), true);
  db.prepare('DROP TABLE ai_profiles').run();
  assert.throws(
    () => contextIsCurrent(db, 1, context, config),
    /no such table/,
  );
  db.close();
});

test('context refuses a budget exhausted by omission metadata rather than dropping critical provenance', () => {
  const { db, config } = setup();
  for (let i = 0; i < 3; i++)
    saveEntry(
      db,
      1,
      {
        kind: 'milestone',
        text: 'Synthetic '.repeat(200),
        observed_on: '2026-01-01',
        state: 'current',
        expected_version: 0,
      },
      `large-${i}`,
    );
  let refused = false;
  for (let budget = 1000; budget < 2500; budget += 10) {
    config.limits.AI_CONTEXT_TOKENS = budget;
    try {
      buildContext(db, 1, { purpose: 'cycle', asOf: '2026-10-14', config });
    } catch (e) {
      if (e.code === 'contextTooLarge') {
        refused = true;
        break;
      }
    }
  }
  assert.equal(refused, true);
  db.close();
});

test('weekly executions have no resource ID, use stable idempotency and immutable paid adapter versions', async () => {
  const fixture = setup();
  for (const day of [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ])
    fixture.db
      .prepare(
        "INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods) VALUES (1,?,0,'[]')",
      )
      .run(day);
  const operations = { workouts: operation };
  const s = service(fixture, { operations });
  const request = {
    purpose: 'workouts',
    target_date: '2026-10-19',
    idempotency_key: 'synthetic-week',
  };
  const queued = s.enqueue(1, request);
  assert.equal(s.enqueue(1, request).id, queued.id);
  assert.equal(
    s.preview(1, { purpose: 'workouts', target_date: '2026-10-19' }).paid,
    false,
  );
  assert.equal((await wait(s, 1, queued.id)).state, 'completed');
  await s.dispatch('missing');
  await s.dispatch(queued.id);
  const next = s.enqueue(1, {
    ...request,
    idempotency_key: 'synthetic-week-two',
  });
  delete operations.workouts;
  await s.dispatch(next.id);
  assert.equal(s.get(1, next.id).error, 'adapterUnavailable');
  await s.stop();
  fixture.db.close();
});

test('oversized paid request is rejected before quota reservation or network activity', async () => {
  const fixture = setup();
  const s = service(fixture, {
    operations: {
      analysis: { ...operation, instructions: 'Synthetic '.repeat(6000) },
    },
  });
  failure(() => s.enqueue(1, body), 'inputTooLarge');
  assert.equal(s.usage(1).length, 0);
  await s.stop();
  fixture.db.close();
});

test('restart resumes untouched queue under reduced global concurrency', async () => {
  const fixture = setup();
  let resolve;
  const held = new Promise((r) => (resolve = r));
  const first = service(fixture);
  const a = first.enqueue(1, body);
  const b = first.enqueue(2, {
    ...body,
    resource_id: 2,
    idempotency_key: 'synthetic-second',
  });
  await first.stop();
  fixture.config.limits.AI_CONCURRENCY_GLOBAL = 1;
  const resumed = service(fixture, {
    client: async () => {
      await held;
      return {
        value: { ok: true },
        usage: { input: 20, output: 5, cached: 0 },
        error: null,
      };
    },
  });
  resumed.recover();
  await delay(10);
  assert.equal(
    fixture.db
      .prepare("SELECT COUNT(*) AS n FROM ai_executions WHERE state='running'")
      .get().n,
    1,
  );
  assert.equal(
    fixture.db
      .prepare("SELECT COUNT(*) AS n FROM ai_executions WHERE state='queued'")
      .get().n,
    1,
  );
  resolve();
  assert.equal((await wait(resumed, 1, a.id)).state, 'completed');
  assert.equal((await wait(resumed, 2, b.id)).state, 'completed');
  await resumed.stop();
  fixture.db.close();
});

test('dispatch lost claim cannot call provider or overwrite another worker', async () => {
  const fixture = setup();
  let calls = 0;
  const s = service(fixture, {
    client: async () => {
      calls++;
      throw Error();
    },
  });
  const row = s.enqueue(1, body);
  fixture.db.exec(
    "CREATE TRIGGER synthetic_lost_claim BEFORE UPDATE OF state ON ai_executions WHEN NEW.state='running' BEGIN SELECT RAISE(IGNORE); END",
  );
  await s.dispatch(row.id);
  assert.equal(calls, 0);
  assert.equal(s.get(1, row.id).state, 'queued');
  s.cancel(1, row.id);
  await s.stop();
  fixture.db.close();
});

test('prompt service uses English defaults and saved FIT laps, with PT ownership preserved', () => {
  const { db } = setup();
  db.prepare(
    "UPDATE trainings SET result_data_source='fit_upload',fit_summary_json=? WHERE id=1",
  ).run(
    JSON.stringify({
      laps: [
        {
          lap: 1,
          stepType: 'Run',
          distanceLabel: '5.00',
          durationLabel: '30:00',
          avgPaceLabel: '6:00',
          avgHeartRate: 150,
          avgCadenceSpm: 170,
          ascentMeters: 10,
        },
      ],
    }),
  );
  assert.ok(
    renderPrompt(db, 1, { purpose: 'analysis', resourceId: 1 }).includes('170'),
  );
  db.prepare("UPDATE users SET preferred_lang='pt-BR' WHERE id=1").run();
  assert.ok(
    renderPrompt(db, 1, { purpose: 'cycle', resourceId: 'cycle' }).includes(
      'Synthetic cycle',
    ),
  );
  failure(() => renderPrompt(db, 1, { purpose: 'cycle' }), 'resourceNotFound');
  db.close();
});

test('queued reservation expires across UTC days and disabled configuration blocks dispatch', async () => {
  for (const mode of ['expired', 'disabled']) {
    const fixture = setup();
    let calls = 0;
    const s = service(fixture, {
      client: async () => {
        calls++;
        throw Error();
      },
    });
    const row = s.enqueue(1, body);
    if (mode === 'expired')
      fixture.db
        .prepare(
          "UPDATE ai_executions SET created_at='2026-10-13T12:00:00Z' WHERE id=?",
        )
        .run(row.id);
    else fixture.config.enabled = false;
    await s.dispatch(row.id);
    assert.equal(calls, 0);
    assert.equal(
      s.get(1, row.id).error,
      mode === 'expired' ? 'reservationExpired' : 'aiUnavailable',
    );
    await s.stop();
    fixture.db.close();
  }
});

test('configuration rejects multiline credentials and profile limitations remain unconfirmed reports', () => {
  assert.ok(
    readAiConfig({
      AI_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic\ninvalid',
    }).errors.includes('OPENAI_API_KEY'),
  );
  const { db } = setup();
  const memory = saveProfile(db, 1, {
    fields: { restrictions: 'Synthetic reported limitation' },
    expected_version: 0,
  });
  assert.equal(memory.profile.fields.restrictions.state, 'unconfirmed');
  assert.equal(
    macro.translateDistance('en-US', 'custom synthetic distance'),
    'custom synthetic distance',
  );
  db.close();
});

test('concurrent owners atomically compete for the same global allowance and idempotency does not reserve twice', async () => {
  const fixture = setup();
  let resolve;
  const held = new Promise((r) => (resolve = r));
  const a = service(fixture, { client: () => held });
  const b = service(fixture, { client: () => held });
  const first = a.enqueue(1, body);
  const reserved = fixture.db
    .prepare('SELECT reserved_tokens FROM ai_executions WHERE id=?')
    .get(first.id).reserved_tokens;
  fixture.config.limits.AI_DAILY_TOKENS_GLOBAL = Math.floor(reserved * 1.5);
  failure(
    () =>
      b.enqueue(2, {
        ...body,
        resource_id: 2,
        idempotency_key: 'synthetic-concurrent',
      }),
    'usageLimit',
  );
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n,
    1,
  );
  assert.equal(
    fixture.db.prepare('SELECT tokens FROM ai_global_usage').get().tokens,
    reserved,
  );
  assert.equal(b.enqueue(1, body).id, first.id);
  assert.equal(
    fixture.db.prepare('SELECT tokens FROM ai_global_usage').get().tokens,
    reserved,
  );
  a.cancel(1, first.id);
  resolve({
    value: { ok: true },
    usage: { input: 20, output: 5, cached: 0 },
    error: null,
  });
  await a.stop();
  await b.stop();
  fixture.db.close();
});

test('registered delivery adaptation preserves original external prompt separately from exact model input', async () => {
  const fixture = setup();
  const adapter = {
    ...operation,
    version: 'synthetic-delivery-v1',
    adaptPrompt: (prompt) =>
      prompt.replace('Synthetic session', 'Synthetic delivery'),
  };
  const s = service(fixture, { operations: { analysis: adapter } });
  const row = s.enqueue(1, body);
  const debug = s.get(1, row.id, true);
  assert.ok(debug.externalPrompt.includes('Synthetic session'));
  assert.equal(debug.externalPrompt.includes('Synthetic delivery'), false);
  const input = JSON.parse(debug.payload.input[0].content[0].text);
  assert.ok(input.trainingPrompt.includes('Synthetic delivery'));
  assert.equal(input.trainingPrompt.includes('Synthetic session'), false);
  assert.equal(debug.configuration.adapterVersion, 'synthetic-delivery-v1');
  s.cancel(1, row.id);
  await s.stop();
  fixture.db.close();
});

test('evaluation corpus yields different traceable evidence for the same session under different histories', () => {
  const corpus = require('./fixtures/ai/context-evaluation.json');
  const fixture = setup();
  for (const [id, name] of [
    [1, 'same-workout-low-load'],
    [2, 'same-workout-high-load'],
  ]) {
    const scenario = corpus.cases.find((item) => item.id === name);
    fixture.db
      .prepare(
        "INSERT INTO trainings(user_id,dia,tipo,completed,fit_distance,fit_duration,feedback_rpe) VALUES (?,'2026-09-01','Run',1,?,'1:00:00',3)",
      )
      .run(id, scenario.history.weeklyDistanceKm);
  }
  const low = buildContext(fixture.db, 1, {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config: fixture.config,
  });
  const high = buildContext(fixture.db, 2, {
    purpose: 'analysis',
    resourceId: 2,
    asOf: '2026-10-14',
    config: fixture.config,
  });
  assert.equal(
    low.resource.actual.fit_distance,
    high.resource.actual.fit_distance,
  );
  assert.notEqual(low.weekly[0].distanceKm, high.weekly[0].distanceKm);
  assert.equal(low.weekly[0].sources.length, 1);
  assert.equal(high.weekly[0].sources.length, 1);
  fixture.db
    .prepare(
      "INSERT INTO ai_memory(id,user_id,kind,authority,text,observed_on,state,source_json,updated_at) VALUES ('recommendation',1,'recommendation','recommendation','Synthetic rest suggestion','2026-10-10','current',?, '2026-10-10T00:00:00Z')",
    )
    .run(
      JSON.stringify({
        origin: 'synthetic_evaluation',
        trainingSource: low.resource.source,
      }),
    );
  const context = buildContext(fixture.db, 1, {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config: fixture.config,
  });
  assert.equal(context.events[0].authority, 'recommendation');
  assert.equal(context.resource.actual.completed, true);
  assert.equal(context.resource.actual.fit_distance, 5);
  assert.ok(corpus.rubric.authority);
  fixture.db.close();
});

test('weekly paid requests cannot name a different cycle resource than the active-cycle prompt', async () => {
  const f = setup();
  const s = service(f);
  failure(
    () => s.enqueue(1, { ...body, purpose: 'workouts', resource_id: 'cycle' }),
    'invalidFields',
  );
  await s.stop();
  f.db.close();
});

test('source versions cover FIT laps and shoe labels without transmitting raw summaries or GPS', () => {
  const f = setup();
  const before = buildContext(f.db, 1, {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config: f.config,
  });
  f.db
    .prepare('UPDATE trainings SET fit_summary_json=?,tenis=? WHERE id=1')
    .run(
      JSON.stringify({ laps: [], rawGps: 'synthetic-private-track' }),
      'Synthetic updated shoe',
    );
  assert.equal(contextIsCurrent(f.db, 1, before, f.config), false);
  const after = buildContext(f.db, 1, {
    purpose: 'analysis',
    resourceId: 1,
    asOf: '2026-10-14',
    config: f.config,
  });
  assert.equal(
    JSON.stringify(after).includes('synthetic-private-track'),
    false,
  );
  assert.equal(JSON.stringify(after).includes('fit_summary_json'), false);
  assert.equal(after.resource.planned.tenis, 'Synthetic updated shoe');
  f.db.close();
});

test('current planning includes owned upcoming calendar sessions without inventing their execution', () => {
  const f = setup();
  f.db
    .prepare(
      "INSERT INTO trainings(user_id,dia,tipo,treino) VALUES (1,'2026-10-20','Long run','Synthetic planned session'),(2,'2026-10-20','Run','Synthetic other account')",
    )
    .run();
  const context = buildContext(f.db, 1, {
    purpose: 'cycle',
    asOf: '2026-10-14',
    config: f.config,
  });
  assert.equal(context.upcoming.length, 1);
  assert.equal(context.upcoming[0].planned.treino, 'Synthetic planned session');
  assert.equal(context.upcoming[0].actual.completed, false);
  assert.equal(context.upcoming[0].actual.fit_distance, null);
  assert.equal(contextIsCurrent(f.db, 1, context, f.config), true);
  f.db.close();
});

test('provider timeout is uncertain and does not expose transport error text', async () => {
  const call = createResponsesClient({
    apiKey: 'synthetic-test-key',
    timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => {
      await delay(5);
      signal.throwIfAborted();
      throw Error('unexpected mock completion');
    },
  });
  await assert.rejects(
    call({ store: false }),
    (error) => error.code === 'providerOutcomeUncertain',
  );
});

test('disk restart preserves snapshots and resumes an untouched queue without storing the key', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-ai-restart-'));
  const filename = path.join(dir, 'synthetic.sqlite');
  let db = createDatabase({ filename });
  const config = readAiConfig({
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key',
  });
  try {
    db.prepare(
      "INSERT INTO users(id,email,password_hash,role) VALUES (1,'synthetic@example.invalid','synthetic','admin')",
    ).run();
    db.prepare(
      "INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES (1,1,'2026-10-12','Run','Synthetic disk session')",
    ).run();
    const first = service({ db, config });
    const queued = first.enqueue(1, body);
    await first.stop();
    db.close();
    assert.equal(
      fs.readFileSync(filename).includes(Buffer.from('synthetic-test-key')),
      false,
    );
    db = createDatabase({ filename });
    const resumed = service({ db, config });
    resumed.recover();
    assert.equal((await wait(resumed, 1, queued.id)).state, 'completed');
    assert.ok(
      resumed
        .get(1, queued.id, true)
        .externalPrompt.includes('Synthetic disk session'),
    );
    await resumed.stop();
  } finally {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
