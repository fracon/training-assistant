'use strict';
// Issue #111: a database whose raw-output marker exists without the
// raw_output_capture_version column crashed the server on the first AI
// dispatch. The column is repaired idempotently, and no dispatch failure may
// stop the process, loop, or replay a paid request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, planFor, complete } = require('./fixtures/ai/cycle-planning.cjs');
const { createExecutionService } = require('../src/ai/executions');
const { readAiConfig } = require('../src/ai/config');
const { createCyclePlanAdapter } = require('../src/ai/cycle-plan-adapter');
const { initializeDatabase } = require('../src/db/database');
const { repairAiRawOutputCaptureVersion } = require('../src/ai/schema');

const REPAIR = '2026-11-ai-raw-output-capture-repair-v1';
const hasColumn = (db) => db.pragma('table_info(ai_executions)').some((column) => column.name === 'raw_output_capture_version');
const request = (key) => ({ purpose: 'cycle', resource_id: 'cycle', idempotency_key: key });
function setup(db, call) {
  const config = readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-key' });
  return createExecutionService({ db, config, operations: { cycle: createCyclePlanAdapter(db) }, client: call });
}
async function until(check, message) {
  for (let i = 0; i < 400; i += 1) { if (check()) return; await delay(5); }
  throw new Error(`Timed out: ${message}`);
}
const logged = (mock) => mock.mock.calls.map((call) => String(call.arguments[0]));

test('the capture-version repair restores the column behind an existing marker, preserves rows and is idempotent', () => {
  const db = fixture();
  const service = setup(db, async () => { throw new Error('not called'); });
  const execution = service.enqueue(1, request('repair-snapshot'));
  void service.stop();
  db.prepare("UPDATE ai_executions SET state='failed',settled=1 WHERE id=?").run(execution.id);
  const snapshot = db.prepare('SELECT * FROM ai_executions WHERE id=?').get(execution.id);
  // Reproduce the drifted database: v1 marker present, column absent.
  db.exec('ALTER TABLE ai_executions DROP COLUMN raw_output_capture_version');
  db.prepare('DELETE FROM schema_migrations WHERE name=?').run(REPAIR);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-ai-raw-output-v1'").get());
  assert.equal(hasColumn(db), false);
  initializeDatabase(db);
  assert.equal(hasColumn(db), true);
  assert.deepEqual(db.prepare('SELECT * FROM ai_executions WHERE id=?').get(execution.id), { ...snapshot, raw_output_capture_version: 0 });
  // Re-running with the column present and with the marker present changes nothing.
  const before = db.prepare('SELECT * FROM ai_executions').all();
  repairAiRawOutputCaptureVersion(db);
  db.prepare('DELETE FROM schema_migrations WHERE name=?').run(REPAIR);
  repairAiRawOutputCaptureVersion(db);
  assert.deepEqual(db.prepare('SELECT * FROM ai_executions').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?').get(REPAIR).n, 1);
  db.close();
});

test('a claim that fails before any request settles the execution unbilled instead of stopping the server', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const db = fixture();
  let calls = 0;
  const service = setup(db, async () => { calls += 1; throw new Error('not called'); });
  t.after(async () => { await service.stop(); db.close(); });
  // The exact production failure: the claim writes the missing column.
  db.exec('ALTER TABLE ai_executions DROP COLUMN raw_output_capture_version');
  const row = service.enqueue(1, request('missing-column'));
  const result = await complete(service, row.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'aiUnavailable');
  assert.equal(calls, 0, 'no provider request is made');
  const stored = db.prepare('SELECT settled,charged_tokens,charged_cost FROM ai_executions WHERE id=?').get(row.id);
  assert.deepEqual(stored, { settled: 1, charged_tokens: 0, charged_cost: 0 }, 'the reservation is released as known unbilled');
  assert.equal(service.get(1, row.id, true).diagnostics.at(-1).code, 'aiUnavailable');
  const lines = logged(errors);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0].replace('[Kinesis] ', ''));
  assert.deepEqual([entry.event, entry.stage, entry.errorName], ['ai_dispatch_unexpected_error', 'claim', 'SqliteError']);
  assert.ok(entry.frames.length > 0 && entry.frames.length <= 7);
  assert.doesNotMatch(lines[0], /no such column|raw_output_capture_version|UPDATE|synthetic|planner@/,
    'the log keeps code locations only, never messages, SQL or identifiers');
});

test('a claim whose settlement also fails is isolated in this process without a polling loop', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const db = fixture();
  let calls = 0;
  const service = setup(db, async () => { calls += 1; throw new Error('not called'); });
  t.after(async () => { await service.stop(); db.close(); });
  const row = service.enqueue(1, request('broken-configuration'));
  // Corrupt the stored configuration before the queued dispatch runs, so both
  // the claim and the settlement fail.
  db.prepare("UPDATE ai_executions SET configuration_json='null' WHERE id=?").run(row.id);
  await until(() => errors.mock.calls.length >= 2, 'claim and settlement logs');
  // Another execution keeps scheduling the pump; the isolated one is skipped.
  const other = service.enqueue(2, { purpose: 'cycle', resource_id: 'private', idempotency_key: 'other-execution' });
  db.prepare("UPDATE ai_executions SET configuration_json='null' WHERE id=?").run(other.id);
  await until(() => errors.mock.calls.length >= 4, 'second execution logs');
  await delay(60);
  assert.deepEqual(logged(errors).map((line) => JSON.parse(line.replace('[Kinesis] ', '')).stage), ['claim', 'settle', 'claim', 'settle'],
    'each failing execution is attempted once, then never polled again');
  assert.equal(db.prepare('SELECT state FROM ai_executions WHERE id=?').get(row.id).state, 'queued');
  assert.equal(calls, 0);
});

test('a failure after the provider request is logged and never replayed', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const db = fixture();
  let calls = 0;
  const service = setup(db, async () => {
    calls += 1;
    // A rejection whose diagnostic cannot be read breaks the error handler
    // itself, after the request may have reached the provider.
    const failure = new Error('synthetic provider failure');
    // The second rejection is a bare value without name or stack.
    Object.defineProperty(failure, 'diagnostic', { get() { throw calls === 1 ? new TypeError('unreadable diagnostic') : { private: 'value' }; } });
    throw failure;
  });
  t.after(async () => { await service.stop(); db.close(); });
  const row = service.enqueue(1, request('post-request-failure'));
  await until(() => errors.mock.calls.length === 1, 'dispatch log');
  await delay(60);
  assert.equal(calls, 1, 'no automatic replay of a possibly billed request');
  assert.equal(db.prepare('SELECT state FROM ai_executions WHERE id=?').get(row.id).state, 'running',
    'the persisted state is left for restart recovery to classify as uncertain');
  const entry = JSON.parse(logged(errors)[0].replace('[Kinesis] ', ''));
  assert.deepEqual([entry.event, entry.stage, entry.errorName], ['ai_dispatch_unexpected_error', 'dispatch', 'TypeError']);
  assert.doesNotMatch(logged(errors)[0], /unreadable diagnostic|synthetic provider failure/);
  // A bare thrown value is logged with a generic name and no frames.
  db.prepare("UPDATE ai_executions SET state='failed',settled=1 WHERE id=?").run(row.id);
  service.enqueue(1, request('bare-rejection'));
  await until(() => errors.mock.calls.length === 2, 'bare rejection log');
  const bare = JSON.parse(logged(errors)[1].replace('[Kinesis] ', ''));
  assert.deepEqual([bare.errorName, bare.frames], ['Error', []]);
  assert.doesNotMatch(logged(errors)[1], /private|value/);
  // The service keeps working for later executions. The failing service is
  // stopped first: its pump scans every queued row, so it could otherwise
  // claim the next execution and leave it running.
  await service.stop();
  const healthy = setup(db, async (payload) => ({ value: planFor(JSON.parse(payload.input[0].content[0].text).context), usage: { input: 10, output: 20, cached: 0 }, error: null }));
  t.after(() => healthy.stop());
  db.prepare("UPDATE ai_executions SET state='failed',settled=1 WHERE state='running'").run();
  const next = healthy.enqueue(1, request('after-failure'));
  assert.equal((await complete(healthy, next.id)).state, 'completed');
});
