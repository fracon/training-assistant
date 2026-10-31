'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { parseFitFile } = require('../src/fitParser');
const { resolveFitBuffer } = require('../src/fitUpload');
const { buildFitFile } = require('./helpers/buildFitFile');
const { buildStoredZip } = require('./helpers/buildStoredZip');
const pilot = require('../scripts/garmin-pilot');

function response(status, body = {}, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('importing the pilot module does not start an interactive command', () => {
  assert.equal(typeof pilot.main, 'function');
});

test('owner validation re-reads current activity state and permits local cleanup for deleted accounts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-garmin-cli-'));
  const databaseFile = path.join(directory, 'pilot.sqlite');
  const db = new Database(databaseFile);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL)');
  db.prepare('INSERT INTO users (id, is_active) VALUES (?, ?)').run(31, 1);
  db.close();
  const original = { ...process.env };
  process.env.GARMIN_PILOT_ENABLED = 'true';
  process.env.GARMIN_PILOT_USER_ID = '31';
  process.env.KINESIS_GARMIN_SERVICE_TOKEN = 'test-key';
  process.env.DATABASE_FILE = databaseFile;
  try {
    assert.equal(pilot.validatePilot().id, 31);
    const changed = new Database(databaseFile);
    changed.prepare('UPDATE users SET is_active = 0 WHERE id = 31').run();
    changed.close();
    assert.throws(() => pilot.validatePilot(), /inactive/);
    assert.equal(pilot.validatePilot({ allowInactive: true }).is_active, 0);
    const removed = new Database(databaseFile);
    removed.prepare('DELETE FROM users WHERE id = 31').run();
    removed.close();
    assert.equal(pilot.validatePilot({ allowInactive: true }), null);
  } finally {
    for (const key of ['GARMIN_PILOT_ENABLED', 'GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN', 'DATABASE_FILE']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('request checks owner eligibility before dispatch and after a held operation, then invalidates tokens', async () => {
  let checks = 0;
  let fetches = 0;
  let invalidations = 0;
  const result = await pilot.request('/workouts', { method: 'POST', mutation: true }, {
    validate() {
      checks += 1;
      if (checks === 2) throw new Error('inactive');
    },
    async fetchImpl(url) {
      fetches += 1;
      assert.match(url, /workouts$/);
      return response(200, { workout_id: 3 });
    },
    async invalidate() { invalidations += 1; },
  }).catch((error) => error);
  assert.equal(result.message, 'outcome_unknown');
  assert.equal(checks, 2);
  assert.equal(fetches, 1);
  assert.equal(invalidations, 1);
});

test('request refuses an operation after revocation observed before dispatch', async () => {
  let fetches = 0;
  let invalidations = 0;
  await assert.rejects(pilot.request('/workouts', { method: 'POST', mutation: true }, {
    validate() { throw new Error('inactive'); },
    async fetchImpl() { fetches += 1; return response(200); },
    async invalidate() { invalidations += 1; },
  }), /account_inactive/);
  assert.equal(fetches, 0);
  assert.equal(invalidations, 1);
});

test('a dispatched mutation with a lost response is always reported as outcome_unknown', async () => {
  await assert.rejects(pilot.request('/workouts', { method: 'POST', mutation: true }, {
    validate() {},
    async fetchImpl() { throw new Error('socket closed after dispatch'); },
    async invalidate() {},
  }), /outcome_unknown/);
});

test('request revalidates ownership after the response body finishes before accepting it', async () => {
  let validations = 0;
  let invalidations = 0;
  await assert.rejects(pilot.request('/workouts', { method: 'POST', mutation: true }, {
    validate() {
      validations += 1;
      if (validations === 3) throw new Error('account deleted while reading response');
    },
    async fetchImpl() {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        async json() { return { workout_id: 42 }; },
      };
    },
    async invalidate() { invalidations += 1; },
  }), /outcome_unknown/);
  assert.equal(validations, 3);
  assert.equal(invalidations, 1);
});

test('request preserves normalized connector errors and handles cleanup-only calls while inactive', async () => {
  let validates = 0;
  const denied = await pilot.request('/status', {}, {
    validate() { validates += 1; },
    async fetchImpl() { return response(401, { detail: { code: 'auth_required' } }); },
  }).catch((error) => error);
  assert.equal(denied.message, 'auth_required');
  assert.equal(validates, 3);

  let cleanupFetches = 0;
  const cleaned = await pilot.request('/auth/cancel', { method: 'POST', allowInactive: true }, {
    validate() { throw new Error('must not validate a cleanup request'); },
    async fetchImpl() { cleanupFetches += 1; return response(200, { status: 'disconnected' }); },
  });
  assert.equal(cleaned.status, 'disconnected');
  assert.equal(cleanupFetches, 1);

  const nonJson = await pilot.request('/status', { allowInactive: true }, {
    async fetchImpl() { return new Response('ok', { status: 200 }); },
  });
  assert.deepEqual(nonJson, {});
  await assert.rejects(pilot.request('/status', { allowInactive: true }, {
    async fetchImpl() { return response(503, {}); },
  }), /unavailable/);
  await assert.rejects(pilot.request('/status', { allowInactive: true }, {
    async fetchImpl() { throw new Error('network down'); },
  }), /network down/);
  await assert.rejects(pilot.request('/status', {}, {
    validate() {}, async fetchImpl() { throw new Error('network down'); },
  }), /network down/);
});

test('original download streams into the existing ZIP resolver and FIT parser', async () => {
  const fit = buildFitFile();
  const archive = buildStoredZip([{ name: 'activity.fit', data: fit }]);
  let validations = 0;
  const previousOwner = process.env.GARMIN_PILOT_USER_ID;
  process.env.GARMIN_PILOT_USER_ID = '31';
  const output = [];
  let parseCalls = 0;
  try {
    await pilot.main({
      action: 'download',
      prompts: promptStub(['77']),
      validate() { validations += 1; },
      fetchImpl: async (url) => {
        assert.match(url, /\/v1\/connections\/31\/pilot\/activities\/77\/original$/);
        return new Response(archive, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-kinesis-diagnostic-id': 'a'.repeat(32),
          },
        });
      },
      parseFitFile: async (resolved) => {
        parseCalls += 1;
        return parseFitFile(resolved);
      },
      writeOut(value) { output.push(value); },
      writeError() {},
    });
  } finally {
    if (previousOwner === undefined) delete process.env.GARMIN_PILOT_USER_ID;
    else process.env.GARMIN_PILOT_USER_ID = previousOwner;
  }
  const report = JSON.parse(output[0]);
  assert.equal(report.activity.sport, 'running');
  assert.equal(report.totals.distanceKm, 5);
  assert.equal(report.totals.avgPaceSecondsPerKm, 360.1);
  assert.equal(report.laps, 2);
  assert.equal(report.bytes, archive.length);
  assert.equal(report.diagnostic_id, 'a'.repeat(32));
  assert.equal(parseCalls, 1);

  // Keep a direct stream-boundary assertion separate from the CLI composition.
  validations = 0;
  const bytes = await pilot.requestOriginal('/activities/77/original', {
    validate() { validations += 1; },
    async fetchImpl() { return new Response(archive, { status: 200 }); },
  });
  const resolved = await resolveFitBuffer({ buffer: bytes, filename: 'garmin-original.zip' });
  const summary = await parseFitFile(resolved);
  assert.equal(summary.activity.sport, 'running');
  assert.equal(summary.totals.distanceKm, 5);
  assert.equal(summary.totals.avgPaceSecondsPerKm, 360.1);
  assert.equal(summary.laps.length, 2);
  assert.equal(validations, 3);
});

test('download parser failures report only a safe stage/code and diagnostic correlation ID', async () => {
  const cli = pilotOptions('download', ['77']);
  cli.options.requestOriginal = async (_path, dependencies) => {
    dependencies.onDiagnostic('b'.repeat(32));
    return Buffer.from('synthetic-zip');
  };
  cli.options.resolveFitBuffer = async () => Buffer.from('synthetic-fit');
  cli.options.parseFitFile = async () => { throw new Error('private parser detail'); };
  assert.equal(await pilot.runMain(cli.options), 1);
  assert.match(cli.errors[0], /parse_fit.*unavailable.*diagnostic ID b{32}/);
  assert.doesNotMatch(cli.errors[0], /private parser detail/);
});

test('original download enforces actual streamed bytes when length is missing or false and cancels the stream', async () => {
  const maxBytes = 25 * 1024 * 1024;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(maxBytes + 1));
    },
    cancel() { cancelled = true; },
  });
  const tooLarge = new Response(body, { status: 200, headers: { 'content-length': '1' } });
  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {}, async fetchImpl() { return tooLarge; },
  }), /invalid_payload/);
  assert.equal(cancelled, true);

  const declaredLarge = new Response(new Uint8Array([1]), {
    status: 200, headers: { 'content-length': String(maxBytes + 1) },
  });
  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {}, async fetchImpl() { return declaredLarge; },
  }), /invalid_payload/);

  const noBody = new Response(null, { status: 200 });
  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {}, async fetchImpl() { return noBody; },
  }), /invalid_payload/);

  const remoteError = response(429, { detail: { code: 'rate_limited' } });
  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {}, async fetchImpl() { return remoteError; },
  }), /rate_limited/);

  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {}, async fetchImpl() { throw new Error('download timeout'); },
  }), /download timeout/);

  const ineligible = response(200, {});
  let validationCalls = 0;
  let cleanupCalls = 0;
  await assert.rejects(pilot.requestOriginal('/activities/1/original', {
    validate() {
      validationCalls += 1;
      if (validationCalls === 2) throw new Error('account removed');
    },
    async fetchImpl() { return ineligible; },
    async invalidate() { cleanupCalls += 1; },
  }), /account_inactive/);
  assert.equal(cleanupCalls, 1);
});

function promptStub(answers = [], secrets = []) {
  const asked = [];
  return {
    asked,
    assertInteractive() {},
    async question(label) { asked.push(label); return answers.shift() ?? ''; },
    async secret(label) { asked.push(label); return secrets.shift() ?? ''; },
  };
}

function pilotOptions(action, answers = [], secrets = [], replies = []) {
  const output = [];
  const errors = [];
  const sent = [];
  const prompts = promptStub(answers, secrets);
  return {
    options: {
      action, prompts, validate() {}, invalidate: async () => {},
      request: async (url, opts = {}) => {
        sent.push({ url, opts });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next || { status: 'ok' };
      },
      requestOriginal: async () => Buffer.from('synthetic'),
      resolveFitBuffer: async ({ buffer }) => buffer,
      parseFitFile: async () => ({ activity: { sport: 'running' }, totals: { distanceKm: 1 }, laps: [1] }),
      writeOut: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    },
    output, errors, sent, prompts,
  };
}

test('TTY pilot covers status, disconnect confirmation, and cancellation without dispatch', async () => {
  const status = pilotOptions('status', [], [], [{ status: 'connected' }]);
  await pilot.main(status.options);
  assert.deepEqual(status.output, ['connected\n']);

  const denied = pilotOptions('disconnect', ['no']);
  await assert.rejects(pilot.main(denied.options), /cancelled/);
  assert.equal(denied.sent.length, 0);

  const disconnect = pilotOptions('disconnect', ['disconnect'], [], [{
    status: 'disconnected', remote_revocation: 'not_proven',
  }]);
  await pilot.main(disconnect.options);
  assert.equal(disconnect.sent[0].opts.allowInactive, true);
  assert.match(disconnect.output[0], /remote revocation: not_proven/);

  const inactiveCleanup = pilotOptions('disconnect', ['disconnect'], [], [{
    status: 'disconnected', remote_revocation: 'not_proven',
  }]);
  inactiveCleanup.options.validate = ({ allowInactive }) => assert.equal(allowInactive, true);
  await pilot.main(inactiveCleanup.options);
  assert.equal(inactiveCleanup.sent[0].opts.allowInactive, true);
});

test('TTY pilot prints only the bounded device capabilities response', async () => {
  const capabilities = pilotOptions('capabilities', [], [], [{
    running_supported: true, devices: [{ device_id: '55', name: 'Synthetic watch' }],
  }]);
  await pilot.main(capabilities.options);
  assert.deepEqual(JSON.parse(capabilities.output[0]), {
    running_supported: true, devices: [{ device_id: '55', name: 'Synthetic watch' }],
  });

  const unknown = pilotOptions('capabilities', [], [], [{
    running_supported: null, running_catalog_status: 'unknown', devices: [],
  }]);
  await pilot.main(unknown.options);
  assert.deepEqual(JSON.parse(unknown.output[0]), {
    running_supported: null, running_catalog_status: 'unknown', devices: [],
  });
});

test('catalog diagnostic prints only allowlisted catalog data and preserves unknown', async () => {
  const diagnostic = pilotOptions('capabilities-diagnose', [], [], [{
    response_type: 'dict', top_level_keys: ['workoutSportTypes'],
    sport_types_type: 'list', sport_type_count: 1,
    sport_types: [{ sport_type_id: 1, sport_type_key: 'running', display_order: 1 }],
    status: 'available',
  }]);
  await pilot.main(diagnostic.options);
  assert.match(diagnostic.sent[0].url, /workout-catalog$/);
  const printed = JSON.parse(diagnostic.output[0]);
  assert.equal(printed.status, 'available');
  assert.equal(printed.sport_types[0].sport_type_key, 'running');
  assert.equal(JSON.stringify(printed).includes('device'), false);

  const unknown = pilotOptions('capabilities-diagnose', [], [], [{
    response_type: 'dict', top_level_keys: [], sport_types_type: 'missing',
    sport_type_count: null, sport_types: [], status: 'unknown',
  }]);
  await pilot.main(unknown.options);
  assert.equal(JSON.parse(unknown.output[0]).status, 'unknown');
});

test('connector refusal is actionable while HTTP/auth errors remain distinct', async () => {
  let invalidations = 0;
  await assert.rejects(pilot.request('/status', {}, {
    validate() {}, async invalidate() { invalidations += 1; },
    async fetchImpl() {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    },
  }), /connector_unavailable/);
  assert.equal(invalidations, 0);
  assert.equal(pilot.connectorFailure(new DOMException('deadline', 'TimeoutError')).message, 'connector_timeout');
  assert.match(pilot.displayPilotError(new Error('connector_unavailable')), /npm run garmin:connector/);
  assert.equal(pilot.displayPilotError(new Error('auth_required')), 'auth_required');
  const cli = pilotOptions('status');
  cli.options.request = async () => { throw new Error('connector_unavailable'); };
  assert.equal(await pilot.runMain(cli.options), 1);
  assert.match(cli.errors[0], /Conector Garmin indisponível.*npm run garmin:connector/);
  await assert.rejects(pilot.request('/status', {}, {
    validate() {}, async invalidate() {},
    async fetchImpl() { return response(401, { detail: { code: 'auth_required' } }); },
  }), /auth_required/);
});

test('TTY pilot validates operation IDs and confirms simple and interval mutations', async () => {
  const invalid = pilotOptions('publish-simple', ['not-a-uuid']);
  await assert.rejects(pilot.main(invalid.options), /UUID/);
  assert.equal(invalid.sent.length, 0);

  const simple = pilotOptions('publish-simple', ['', 'publish'], [], [{ workout_id: 12 }]);
  await pilot.main(simple.options);
  assert.equal(simple.sent[0].opts.mutation, true);
  assert.equal(JSON.parse(simple.sent[0].opts.body).interval_seconds, 900);

  const declinedSimple = pilotOptions('publish-simple', ['', 'no']);
  await assert.rejects(pilot.main(declinedSimple.options), /cancelled/);
  assert.equal(declinedSimple.sent.length, 0);

  const declinedInterval = pilotOptions('publish-interval', ['', 'no']);
  await assert.rejects(pilot.main(declinedInterval.options), /cancelled/);
  assert.equal(declinedInterval.sent.length, 0);

  const interval = pilotOptions('publish-interval', [
    'f51db93c-9fb5-44ea-9a4c-79758a3b10c0', 'publish',
  ], [], [{ workout_id: 13 }]);
  await pilot.main(interval.options);
  const body = JSON.parse(interval.sent[0].opts.body);
  assert.equal(body.repetitions, 4);
  assert.equal(body.recovery_seconds, 60);
});

test('TTY pilot validates civil schedule inputs and preserves the date string', async () => {
  const invalid = pilotOptions('schedule', ['42', '2026-2-03']);
  await assert.rejects(pilot.main(invalid.options), /civil calendar date/);
  assert.equal(invalid.sent.length, 0);

  const declined = pilotOptions('schedule', ['42', '2026-11-12', 'no']);
  await assert.rejects(pilot.main(declined.options), /cancelled/);
  assert.equal(declined.sent.length, 0);

  const accepted = pilotOptions('schedule', ['42', '2026-11-12', 'schedule'], [], [{ scheduled: true }]);
  await pilot.main(accepted.options);
  assert.deepEqual(JSON.parse(accepted.sent[0].opts.body), { workout_id: 42, date: '2026-11-12' });
  assert.equal(accepted.sent[0].opts.mutation, true);
});

test('TTY pilot lists, downloads/parses local files, and cancels MFA challenges', async () => {
  const activities = pilotOptions('activities', ['2026-11-01', '2026-11-20'], [], [{ items: [] }]);
  await pilot.main(activities.options);
  assert.deepEqual(JSON.parse(activities.sent[0].opts.body), {
    start: '2026-11-01', end: '2026-11-20', limit: 10,
  });

  const download = pilotOptions('download', ['77']);
  await pilot.main(download.options);
  assert.match(download.output[0], /"laps":1/);

  const badDownload = pilotOptions('download', ['not-an-id']);
  await assert.rejects(pilot.main(badDownload.options), /numeric/);

  const cancel = pilotOptions('cancel', ['opaque-challenge-id']);
  await pilot.main(cancel.options);
  assert.equal(cancel.sent[0].opts.allowInactive, true);
});

test('TTY pilot completes no-MFA and MFA auth, retries bad codes, and cancels abandoned challenges', async () => {
  const noMfa = pilotOptions('auth', ['owner@example.test'], ['hidden-password'], [{ status: 'connected' }]);
  await pilot.main(noMfa.options);
  assert.match(noMfa.sent[0].opts.body, /hidden-password/);
  assert.equal(noMfa.output[0], 'connected\n');

  const mfa = pilotOptions('auth', ['owner@example.test'], ['password', '111111', '222222'], [
    { status: 'mfa_required', challenge_id: 'opaque-id' },
    new Error('auth_required'),
    { status: 'connected' },
  ]);
  await pilot.main(mfa.options);
  assert.equal(mfa.sent[1].url.endsWith('/auth/finish'), true);
  assert.equal(mfa.errors.length, 1);

  const cancelledPrompts = promptStub(['owner@example.test'], ['password']);
  let secretCalls = 0;
  cancelledPrompts.secret = async () => {
    secretCalls += 1;
    if (secretCalls === 1) return 'password';
    throw new Error('prompt cancelled');
  };
  const cancelled = pilotOptions('auth');
  cancelled.options.prompts = cancelledPrompts;
  cancelled.options.request = async (url) => {
    cancelled.sent.push({ url });
    return { status: 'mfa_required', challenge_id: 'opaque-id' };
  };
  await assert.rejects(pilot.main(cancelled.options), /prompt cancelled/);
  assert.equal(cancelled.sent.some((entry) => entry.url.endsWith('/auth/cancel')), true);
});

test('runMain sanitizes no-TTY and unknown-action errors and import remains inert', async () => {
  const noTty = await pilot.runMain({
    action: 'auth', prompts: { assertInteractive() { throw new Error('TTY required'); } },
    validate() {}, invalidate: async () => {}, writeError() {},
  });
  assert.equal(noTty, 1);
  const unknown = pilotOptions('not-a-command');
  assert.equal(await pilot.runMain(unknown.options), 1);
  assert.match(unknown.errors[0], /Use auth/);

  const validation = pilotOptions('status');
  let invalidated = 0;
  validation.options.validate = () => { throw new Error('account inactive'); };
  validation.options.invalidate = async () => { invalidated += 1; };
  assert.equal(await pilot.runMain(validation.options), 1);
  assert.equal(invalidated, 1);

  const originalArgs = process.argv;
  try {
    process.argv = [process.execPath, '/tmp/garmin-pilot.js', 'status', 'leaked'];
    await assert.rejects(pilot.main({ validate() {}, prompts: promptStub() }), /Arguments are not accepted/);
  } finally {
    process.argv = originalArgs;
  }

  const actualRequest = pilotOptions('status', [], [], [{ status: 'connected' }]);
  delete actualRequest.options.request;
  actualRequest.options.fetchImpl = async () => response(200, { status: 'connected' });
  await pilot.main(actualRequest.options);
  assert.deepEqual(actualRequest.output, ['connected\n']);
});
