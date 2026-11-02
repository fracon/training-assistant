'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');

function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.data || '');
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); data.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const summary = {
  activity: { sport: 'running', startTime: '2026-11-02T07:00:00Z', endTime: '2026-11-02T07:58:20Z' },
  totals: { durationSeconds: 3500, durationLabel: '58:20', distanceKm: 10, avgPaceSecondsPerKm: 350,
    avgPaceLabel: '5:50', avgHeartRate: null, maxHeartRate: 181, ascentMeters: 78, calories: 501 },
  laps: [{ lap: 1, duration: 3500, durationLabel: '58:20', distanceKm: 10, avgHeartRate: null }],
};
const original = zip([{ name: 'activity.fit', data: 'synthetic-fit-bytes' }]);

async function setup({ rows = [{ activityId: 42, activityName: 'Morning run', startTimeLocal: '2026-11-02 07:00:00',
  activityType: 'running', duration: 3500, distance: 10000, averageHR: null, maxHR: 181, calories: 501, elevationGain: 78 }], parse = async () => summary,
  originalFile = original, owner = 1, connectorFetch, garminConfig = {}, now } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const calls = [];
  const defaultFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/activities')) return Response.json({ items: rows, offset: 0, limit: 10 });
    if (url.endsWith('/original')) return new Response(originalFile, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    throw new Error('unexpected request');
  };
  const config = typeof garminConfig === 'function' ? garminConfig({ GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner),
    KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-token'.repeat(4), GARMIN_CONNECTOR_URL: 'http://connector.invalid' })
    : { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner),
      KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-token'.repeat(4), GARMIN_CONNECTOR_URL: 'http://connector.invalid', ...garminConfig };
  const app = await buildServer({ db, sessionCookieSecure: false, parseFitFile: parse,
    garminConfig: config,
    garminFetch: connectorFetch || defaultFetch, garminNow: now });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'import@example.test', password: 'pilot-password', first_name: 'Import', last_name: 'Test' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'import@example.test', password: 'pilot-password' } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','free run')`).run();
  db.prepare(`INSERT INTO garmin_pilot_connections(user_id,connection_generation,identity_fingerprint)
    VALUES(1,1,?)`).run('a'.repeat(64));
  return { db, app, cookie, calls, close: async () => { await app.close(); db.close(); } };
}

async function preview(h, id = 42, trainingId = 1) {
  return h.app.inject({ method: 'POST', url: `/api/trainings/${trainingId}/garmin/activity-preview`, headers: { cookie: h.cookie }, payload: { activity_id: id } });
}

test('activity search, original ZIP preview, confirmed import, provenance, feedback and shoe ledger share the canonical pipeline', async () => {
  const h = await setup();
  try {
    h.db.prepare(`INSERT INTO shoes(id,user_id,brand,model,mileage) VALUES('shoe-a',1,'Kinesis','Run',0)`).run();
    h.db.prepare(`UPDATE trainings SET completed=1,feedback_rpe=4,feedback_notas='felt steady',feedback_shoe_id='shoe-a' WHERE id=1`).run();
    const found = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities?offset=0', headers: { cookie: h.cookie } });
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().items[0].suggestion, 'same_local_date_requires_confirmation');
    assert.equal(found.json().items[0].distance_m, 10000);
    assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
    const reviewed = await preview(h);
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.json().metrics.fit_avg_hr, null);
    assert.equal(reviewed.json().feedback_pending, false);
    assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
    const imported = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: {
      preview_id: reviewed.json().preview_id,
    } });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().training.result_data_source, 'garmin_connect');
    assert.equal(imported.json().training.feedback_rpe, 4);
    assert.equal(h.db.prepare('SELECT feedback_notas FROM trainings WHERE id=1').get().feedback_notas, 'felt steady');
    assert.equal(imported.json().training.completed, 1);
    assert.equal(JSON.parse(imported.json().training.fit_summary_json).laps.length, 1);
    assert.equal(h.db.prepare('SELECT mileage FROM shoes WHERE id=?').get('shoe-a').mileage, 10);
    assert.equal(h.db.prepare('SELECT activity_id FROM garmin_activity_imports').get().activity_id, '42');
    const reload = await h.app.inject({ method: 'GET', url: '/api/trainings/1', headers: { cookie: h.cookie } });
    assert.equal(reload.json().training.garmin_activity.activity_id, '42');
    const secondReview = await preview(h);
    const duplicate = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: secondReview.json().preview_id, confirm_replace: true } });
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(h.db.prepare('SELECT mileage FROM shoes WHERE id=?').get('shoe-a').mileage, 10);
    assert.equal(h.calls.filter((call) => call.url.endsWith('/original')).length, 2);
    const noConfirmation = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/manual-results', headers: { cookie: h.cookie }, payload: {
      distance_km: 6, duration_seconds: 2000, feedback_rpe: 4,
    } });
    assert.equal(noConfirmation.statusCode, 409);
    assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'garmin_connect');
    const manualReplace = await h.app.inject({ method: 'PUT', url: '/api/trainings/1/manual-results', headers: { cookie: h.cookie }, payload: {
      distance_km: 6, duration_seconds: 2000, feedback_rpe: 4, confirm_replace_garmin: true,
    } });
    assert.equal(manualReplace.statusCode, 200, manualReplace.body);
    assert.equal(manualReplace.json().training.result_data_source, 'manual');
    assert.equal(h.db.prepare('SELECT is_current FROM garmin_activity_imports').get().is_current, 0);
    assert.equal(h.db.prepare('SELECT mileage FROM shoes WHERE id=?').get('shoe-a').mileage, 6);
    assert.equal(manualReplace.json().training.garmin_activity, null);
  } finally { await h.close(); }
});

test('preview refuses IDs outside the bounded owner activity list and keeps current result after invalid FIT', async () => {
  const h = await setup({ parse: async () => { throw new Error('parser detail must not escape'); } });
  try {
    let response = await preview(h, 99);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'activity_not_found');
    response = await preview(h);
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'invalid_fit');
    assert.equal(response.body.includes('parser detail'), false);
    assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
  } finally { await h.close(); }
});

test('candidate search filters known non-running sports and keeps malformed sport metadata marked unknown', async () => {
  const h = await setup({ rows: [
    { activityId: 1, activityName: 'cycle', startTimeLocal: '2026-11-02T07:00:00', activityType: 'cycling', duration: 3600, distance: 20000 },
    { activityId: 2, activityName: 'unknown', startTimeLocal: '2026-11-02T07:00:00', duration: 3600, distance: 10000 },
    { activityId: 3, activityName: 'trail run', startTimeLocal: '2026-11-02T07:00:00', activityType: 'trail_running', duration: 3600, distance: 10000 },
    { activityId: '4', startTimeLocal: '2026-11-03T07:00:00', activityType: 'running', duration: 0, distance: 0, averageHR: 150 },
    { activityId: 5, startTimeLocal: null, activityType: 'running' },
    { activityId: 6, startTimeLocal: '2026-11-02T07:00:00', activityType: 'running' },
  ] });
  try {
    const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    assert.deepEqual(response.json().items.map((item) => item.activity_id), ['2', '3', '4', '6']);
    assert.equal(response.json().items[0].sport, 'unknown');
    assert.equal(response.json().items[1].approximate_pace_seconds_per_km, 360);
    assert.equal(response.json().items[2].suggestion, 'date_differs_requires_confirmation');
    assert.equal(response.json().items[2].average_hr, 150);
    assert.equal(response.json().items[3].duration_seconds, null);
    assert.equal(response.json().items[3].distance_m, null);
  } finally { await h.close(); }
});

test('candidate paging advances across filtered-out activities without repeating a page', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ activityId: index + 1,
    startTimeLocal: '2026-11-02T07:00:00', activityType: 'cycling' }));
  const h = await setup({ rows });
  try {
    const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    assert.deepEqual(response.json().items, []);
    assert.equal(response.json().has_more, true);
    assert.equal(response.json().next_offset, 10);
  } finally { await h.close(); }
});

test('activity identity is account-qualified and a linked activity cannot move silently between sessions', async () => {
  const h = await setup();
  try {
    h.db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-03','run','second')`).run();
    h.db.prepare(`INSERT INTO garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version)
      VALUES(1,2,?,?,?,1)`).run('a'.repeat(64), '42', 'b'.repeat(64));
    const reviewed = await preview(h, 42, 1);
    assert.equal(reviewed.statusCode, 200);
    assert.equal(reviewed.json().linked_training_id, 2);
    const list = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    assert.equal(list.json().items[0].linked_training_id, 2);
    const imported = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id, confirm_replace: true } });
    assert.equal(imported.statusCode, 409);
    assert.equal(imported.json().code, 'activity_already_linked');
    assert.equal(h.db.prepare('SELECT training_id FROM garmin_activity_imports').get().training_id, 2);
  } finally { await h.close(); }
});

test('FIT replacement of a Garmin result is explicit and retires the current binding in the same write', async () => {
  const h = await setup();
  try {
    h.db.prepare("INSERT INTO shoes(id,user_id,brand,model,mileage) VALUES('shoe-fit',1,'Kinesis','FIT',0)").run();
    h.db.prepare("UPDATE trainings SET completed=1,feedback_rpe=3,feedback_shoe_id='shoe-fit' WHERE id=1").run();
    const reviewed = await preview(h);
    const imported = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(imported.statusCode, 200);
    const form = new FormData(); form.append('file', new Blob(['synthetic direct FIT']), 'replacement.fit'); form.append('feedback_rpe', '3');
    let response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/fit', headers: { cookie: h.cookie }, payload: form });
    assert.equal(response.statusCode, 409);
    form.append('confirm_replace_garmin', 'true');
    response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/fit', headers: { cookie: h.cookie }, payload: form });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'fit_upload');
    assert.equal(h.db.prepare('SELECT is_current FROM garmin_activity_imports').get().is_current, 0);
    assert.equal(h.db.prepare('SELECT completed FROM trainings WHERE id=1').get().completed, 1);
    assert.equal(h.db.prepare('SELECT mileage FROM shoes WHERE id=?').get('shoe-fit').mileage, 10);
  } finally { await h.close(); }
});

test('Garmin import requires the configured active owner and authenticated session ownership', async () => {
  const h = await setup({ owner: 2 });
  try {
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities' })).statusCode, 401);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/trainings/999/garmin/activities', headers: { cookie: h.cookie } })).statusCode, 404);
  } finally { await h.close(); }
});

test('connector list errors stay bounded and eligibility is rechecked after the remote response', async () => {
  for (const [kind, expected] of [
    ['network', 'connector_unavailable'], ['timeout', 'connector_timeout'], ['throw_null', 'connector_unavailable'],
    ['invalid_json', 'connector_invalid_response'], ['rate_limit', 'rate_limited'],
    ['unauthorized', 'auth_required'], ['upstream_unavailable', 'connector_unavailable'], ['bad_gateway', 'connector_unavailable'],
    ['malformed_list', 'connector_invalid_response'],
  ]) {
    const connectorFetch = async () => {
      if (kind === 'network') throw Error('private upstream details');
      if (kind === 'throw_null') throw null;
      if (kind === 'timeout') { const error = Error('private timeout text'); error.name = 'TimeoutError'; throw error; }
      if (kind === 'invalid_json') return new Response('not json');
      if (kind === 'rate_limit') return Response.json({ detail: { code: 'rate_limited' } }, { status: 429 });
      if (kind === 'unauthorized') return Response.json({ detail: { code: 'auth_required' } }, { status: 401 });
      if (kind === 'upstream_unavailable') return Response.json({ detail: { code: 'unavailable' } }, { status: 503 });
      if (kind === 'bad_gateway') return Response.json({ detail: { code: 'ignored-untrusted-code' } }, { status: 502 });
      return Response.json({ items: 'malformed' });
    };
    const h = await setup({ connectorFetch });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
      assert.equal(response.statusCode, ['malformed_list', 'invalid_json'].includes(kind) ? 502 : kind === 'rate_limit' ? 429 : kind === 'unauthorized' ? 401 : 503);
      assert.equal(response.json().code, expected);
      assert.equal(response.body.includes('private'), false);
    } finally { await h.close(); }
  }
  const h = await setup({ connectorFetch: async () => {
    h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    return Response.json({ items: [] });
  } });
  try {
    const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await h.close(); }

  let reads = 0;
  const betweenGuardAndRequest = await setup({ garminConfig: (base) => ({ ...base,
    get GARMIN_PILOT_ENABLED() { reads += 1; return reads === 1 ? 'true' : 'false'; },
  }) });
  try {
    const response = await betweenGuardAndRequest.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: betweenGuardAndRequest.cookie } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await betweenGuardAndRequest.close(); }

  reads = 0;
  const revokeDuringRequest = await setup({ garminConfig: (base) => ({ ...base,
    get GARMIN_PILOT_ENABLED() { reads += 1; return reads < 3 ? 'true' : 'false'; },
  }), connectorFetch: async () => { throw Error('synthetic network failure'); } });
  try {
    const response = await revokeDuringRequest.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: revokeDuringRequest.cookie } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await revokeDuringRequest.close(); }
});

test('connector settings, search bounds, and connection state are validated before requests', async () => {
  let calls = 0;
  const noCall = async () => { calls += 1; return Response.json({ items: [] }); };
  const badSettings = [
    { GARMIN_CONNECTOR_URL: 'not a URL' },
    { GARMIN_CONNECTOR_URL: 'file:///tmp/connector' },
    { KINESIS_GARMIN_SERVICE_TOKEN: '' },
  ];
  for (const config of badSettings) {
    const h = await setup({ garminConfig: config, connectorFetch: noCall });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, 'connector_configuration_error');
    } finally { await h.close(); }
  }
  const fallback = await setup({ garminConfig: { GARMIN_CONNECTOR_URL: '' }, connectorFetch: noCall });
  try {
    assert.equal((await fallback.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: fallback.cookie } })).statusCode, 200);
  } finally { await fallback.close(); }
  calls = 0;
  const h = await setup({ connectorFetch: noCall });
  try {
    h.db.prepare('UPDATE garmin_pilot_connections SET cleanup_pending=1 WHERE user_id=1').run();
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } })).json().code, 'connection_required');
    h.db.prepare('UPDATE garmin_pilot_connections SET cleanup_pending=0 WHERE user_id=1').run();
    for (const offset of ['-1', '10001', 'nope']) {
      const response = await h.app.inject({ method: 'GET', url: `/api/trainings/1/garmin/activities?offset=${offset}`, headers: { cookie: h.cookie } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, 'invalid_payload');
    }
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/trainings/NaN/garmin/activities', headers: { cookie: h.cookie } })).statusCode, 404);
    assert.equal(calls, 0);
  } finally { await h.close(); }

  const duringJson = await setup({ connectorFetch: async () => {
    const response = Response.json({ items: [] });
    response.json = async () => { duringJson.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(); return { items: [] }; };
    return response;
  } });
  try {
    const response = await duringJson.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: duringJson.cookie } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await duringJson.close(); }
});

test('activity search keeps list errors sanitized, rechecks changed sessions/connections, and rejects oversized pages', async () => {
  const oversizedPage = await setup({ rows: Array.from({ length: 11 }, (_, index) => ({ activityId: index + 1, startTimeLocal: '2026-11-02 07:00:00' })) });
  try {
    const response = await oversizedPage.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: oversizedPage.cookie } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 'connector_invalid_response');
  } finally { await oversizedPage.close(); }

  for (const change of ['session', 'connection']) {
    let h;
    h = await setup({ connectorFetch: async () => {
      if (change === 'session') h.db.prepare("UPDATE trainings SET dia='2026-11-03' WHERE id=1").run();
      else h.db.prepare('UPDATE garmin_pilot_connections SET connection_generation=2 WHERE user_id=1').run();
      return Response.json({ items: [] });
    } });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, change === 'session' ? 'session_changed' : 'connection_changed');
    } finally { await h.close(); }
  }

  const invalidDate = await setup();
  try {
    invalidDate.db.prepare("UPDATE trainings SET dia='not-a-date' WHERE id=1").run();
    const response = await invalidDate.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: invalidDate.cookie } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'session_changed');
  } finally { await invalidDate.close(); }

  const internal = await setup();
  try {
    internal.db.exec('DROP TABLE garmin_activity_imports');
    const response = await internal.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: internal.cookie } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'connector_unavailable');
    assert.doesNotMatch(response.body, /garmin_activity_imports|no such table/);
  } finally { await internal.close(); }
});

test('parallel activity searches fail fast without overlapping Garmin requests', async () => {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await setup({ connectorFetch: async () => { markStarted(); await gate; return Response.json({ items: [] }); } });
  try {
    const first = h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    await started;
    const second = await h.app.inject({ method: 'GET', url: '/api/trainings/1/garmin/activities', headers: { cookie: h.cookie } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, 'connector_busy');
    release();
    assert.equal((await first).statusCode, 200);
  } finally { release(); await h.close(); }
});

test('original download rejects unsafe responses and preserves the previous result', async () => {
  const cases = [
    ['html', () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }), 422],
    ['remote_429', () => new Response('unavailable', { status: 429 }), 429],
    ['remote_401', () => new Response('unauthorized', { status: 401 }), 401],
    ['remote_503', () => new Response('unavailable', { status: 503 }), 503],
    ['declared_oversize', () => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-length' ? '26214401' : 'application/zip' }, body: null }), 413],
    ['arraybuffer_oversize', () => ({ ok: true, status: 200, headers: { get: () => 'application/zip' }, body: null, arrayBuffer: async () => Buffer.alloc(25 * 1024 * 1024 + 1) }), 413],
    ['bad_signature', () => ({ ok: true, status: 200, headers: { get: () => 'application/zip' }, body: null, arrayBuffer: async () => Buffer.from('not zip') }), 422],
    ['broken_zip', () => new Response(Buffer.from('PKbroken'), { headers: { 'content-type': 'application/zip' } }), 422],
    ['empty', () => ({ ok: true, status: 200, headers: { get: () => 'application/zip' }, body: null, arrayBuffer: async () => Buffer.alloc(0) }), 422],
  ];
  for (const [name, responseFactory, status] of cases) {
    const h = await setup({ connectorFetch: async (url) => url.endsWith('/activities')
      ? Response.json({ items: [{ activityId: '42', startTimeLocal: '2026-11-02 07:00:00', activityType: 'running' }] })
      : responseFactory() });
    try {
      const response = await preview(h);
      assert.equal(response.statusCode, status, name);
      assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
    } finally { await h.close(); }
  }
  const streamed = await setup({ connectorFetch: async (url) => {
    if (url.endsWith('/activities')) return Response.json({ items: [{ activityId: 42, startTimeLocal: '2026-11-02 07:00:00' }] });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1)); } });
    return new Response(stream, { headers: { 'content-type': 'application/zip' } });
  } });
  try { assert.equal((await preview(streamed)).statusCode, 413); }
  finally { await streamed.close(); }

  let revoked;
  revoked = await setup({ connectorFetch: async (url) => url.endsWith('/activities')
    ? Response.json({ items: [{ activityId: 42, startTimeLocal: '2026-11-02 07:00:00' }] })
    : ({ ok: true, status: 200, headers: { get: () => 'application/zip' }, body: null,
      arrayBuffer: async () => { revoked.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(); return original; } }) });
  try {
    const response = await preview(revoked);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await revoked.close(); }

  const revokedAfterParse = await setup({ parse: async () => {
    revokedAfterParse.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
    return summary;
  } });
  try {
    const response = await preview(revokedAfterParse);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await revokedAfterParse.close(); }
});

test('preview validates its selected candidate, parser output and import confirmation snapshot', async () => {
  const h = await setup({ parse: async () => ({ activity: { sport: 'running' }, totals: {}, laps: [{ lap: 1 }] }) });
  try {
    const notListed = await preview(h, 999);
    assert.equal(notListed.statusCode, 404);
    const malformed = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-preview', headers: { cookie: h.cookie }, payload: { activity_id: 'bad/id' } });
    assert.equal(malformed.statusCode, 400);
    const badOffset = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-preview', headers: { cookie: h.cookie }, payload: { activity_id: 42, search_offset: 10001 } });
    assert.equal(badOffset.statusCode, 400);
    const reviewed = await preview(h);
    assert.equal(reviewed.statusCode, 200);
    assert.equal(reviewed.json().metrics.fit_duration, '0:00');
    assert.equal(reviewed.json().metrics.fit_distance, 0);
    assert.equal(reviewed.json().metrics.fit_avg_pace, null);
    assert.equal(reviewed.json().feedback_pending, true);
    const notConfirmed = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(notConfirmed.statusCode, 200);
    assert.equal(notConfirmed.json().training.completed, 0);
  } finally { await h.close(); }

  const unnamed = await setup({ rows: [{ activityId: '42', startTimeLocal: '2026-11-02 07:00:00', activityType: 'running' }],
    parse: async () => ({ activity: { sport: 'running' }, totals: { durationSeconds: 61, avgPaceSecondsPerKm: 366 }, laps: [{ lap: 1 }] }) });
  try {
    const reviewed = await preview(unnamed, '42');
    assert.equal(reviewed.statusCode, 200);
    assert.equal(reviewed.json().metrics.fit_duration, '01:01');
    assert.equal(reviewed.json().metrics.fit_avg_pace, '6:06');
    assert.equal(reviewed.json().activity.name, '');
  } finally { await unnamed.close(); }
});

test('preview rejects unauthorized, stale, absent and unsupported candidate states', async () => {
  const disabled = await setup({ garminConfig: { GARMIN_PILOT_ENABLED: 'false' } });
  try { assert.equal((await preview(disabled)).statusCode, 404); }
  finally { await disabled.close(); }

  const noSession = await setup();
  try {
    noSession.db.prepare('DELETE FROM trainings WHERE id=1').run();
    assert.equal((await preview(noSession)).statusCode, 404);
  } finally { await noSession.close(); }

  const noConnection = await setup();
  try {
    noConnection.db.prepare('DELETE FROM garmin_pilot_connections WHERE user_id=1').run();
    assert.equal((await preview(noConnection)).json().code, 'connection_required');
  } finally { await noConnection.close(); }

  const malformedCandidates = await setup({ connectorFetch: async () => Response.json({ items: 'invalid-shape' }) });
  try { assert.equal((await preview(malformedCandidates)).json().code, 'activity_not_found'); }
  finally { await malformedCandidates.close(); }

  const invalidType = await setup({ rows: [
    { activityId: 42, startTimeLocal: '2026-11-02T07:00:00', activityType: 'cycling' },
    { activityId: 43, startTimeLocal: '2026-02-31T07:00:00', activityType: 'running' },
  ] });
  try {
    assert.equal((await preview(invalidType, 42)).json().code, 'unsupported_activity');
    assert.equal((await preview(invalidType, 43)).json().code, 'activity_not_found');
  } finally { await invalidType.close(); }

  const unsupported = await setup({ parse: async () => ({ activity: { sport: 'cycling' }, totals: {}, laps: [] }) });
  try { assert.equal((await preview(unsupported)).json().code, 'unsupported_activity'); }
  finally { await unsupported.close(); }

  const emptyLaps = await setup({ parse: async () => ({ activity: { sport: 'running' }, totals: {}, laps: [] }) });
  try { assert.equal((await preview(emptyLaps)).json().code, 'unsupported_activity'); }
  finally { await emptyLaps.close(); }
});

test('preview handles remote list failures and rechecks session, identity and eligibility after waits', async () => {
  const listError = await setup({ connectorFetch: async () => Response.json({ detail: { code: 'rate_limited' } }, { status: 429 }) });
  try { assert.equal((await preview(listError)).json().code, 'rate_limited'); }
  finally { await listError.close(); }

  for (const change of ['session', 'identity', 'eligibility']) {
    let h;
    h = await setup({ connectorFetch: async (url) => {
      if (url.endsWith('/activities')) {
        if (change === 'session') h.db.prepare("UPDATE trainings SET dia='2026-11-03' WHERE id=1").run();
        if (change === 'identity') h.db.prepare("UPDATE garmin_pilot_connections SET identity_fingerprint=? WHERE user_id=1").run('b'.repeat(64));
        if (change === 'eligibility') h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
        return Response.json({ items: [{ activityId: 42, startTimeLocal: '2026-11-02 07:00:00', activityType: 'running' }] });
      }
      return new Response(original);
    } });
    try {
      const response = await preview(h);
      assert.equal(response.statusCode, change === 'eligibility' ? 404 : 409);
      assert.equal(response.json().code, change === 'eligibility' ? 'pilot_unavailable' : change === 'identity' ? 'connection_changed' : 'session_changed');
    } finally { await h.close(); }
  }

  const parserChangesResult = await setup({ parse: async () => {
    parserChangesResult.db.prepare('UPDATE trainings SET fit_distance=1 WHERE id=1').run();
    return summary;
  } });
  try { assert.equal((await preview(parserChangesResult)).json().code, 'session_changed'); }
  finally { await parserChangesResult.close(); }
});

test('preview rechecks connection generation when a connection changes during original download', async () => {
  let h;
  h = await setup({ connectorFetch: async (url) => {
    if (url.endsWith('/activities')) return Response.json({ items: [{ activityId: 42, startTimeLocal: '2026-11-02 07:00:00' }] });
    h.db.prepare('UPDATE garmin_pilot_connections SET connection_generation=connection_generation+1 WHERE user_id=1').run();
    return new Response(original);
  } });
  try { assert.equal((await preview(h)).json().code, 'session_changed'); }
  finally { await h.close(); }
});

test('preview enforces bounded token lifetime and activity IDs remain bound to the login session', async () => {
  let clock = 0;
  const h = await setup({ now: () => clock });
  try {
    const reviewed = await preview(h);
    clock = 300001;
    const importResult = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(importResult.json().code, 'preview_expired');
  } finally { await h.close(); }
});

test('preview cache expires old entries and evicts its oldest token at the memory bound', async () => {
  let clock = 0;
  const h = await setup({ now: () => clock });
  try {
    const first = await preview(h);
    clock = 300001;
    const afterExpiry = await preview(h);
    const expired = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: first.json().preview_id } });
    assert.equal(expired.json().code, 'preview_expired');
    clock = 300002;
    let oldest;
    for (let index = 0; index < 101; index += 1) {
      const result = await preview(h);
      if (index === 0) oldest = result.json().preview_id;
    }
    const evicted = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: afterExpiry.json().preview_id } });
    assert.equal(evicted.json().code, 'preview_expired');
    const capacity = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: oldest } });
    assert.equal(capacity.json().code, 'preview_expired');
  } finally { await h.close(); }
});

test('imports reject missing, foreign-session, foreign-training, stale and unconfirmed previews without writes', async () => {
  const h = await setup();
  try {
    const missing = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: {} });
    assert.equal(missing.json().code, 'preview_expired');
    const reviewed = await preview(h);
    const secondSession = createSession(h.db, 1);
    const foreign = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: `${SESSION_COOKIE_NAME}=${secondSession.token}` }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(foreign.json().code, 'preview_expired');
    h.db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-03','run','other')").run();
    const otherTraining = await h.app.inject({ method: 'POST', url: '/api/trainings/2/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(otherTraining.json().code, 'preview_expired');
    h.db.prepare("UPDATE trainings SET feedback_notas='changed after preview' WHERE id=1").run();
    const feedbackPreserved = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(feedbackPreserved.statusCode, 200);
    assert.equal(h.db.prepare('SELECT feedback_notas FROM trainings WHERE id=1').get().feedback_notas, 'changed after preview');
    const stalePreview = await preview(h);
    h.db.prepare('UPDATE trainings SET fit_distance=99 WHERE id=1').run();
    const stale = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: stalePreview.json().preview_id, confirm_replace: true } });
    assert.equal(stale.json().code, 'session_changed');
    assert.equal(h.db.prepare('SELECT fit_distance FROM trainings WHERE id=1').get().fit_distance, 99);
  } finally { await h.close(); }

  const replacement = await setup();
  try {
    replacement.db.prepare("UPDATE trainings SET result_data_source='manual',fit_duration='30:00',fit_distance=5 WHERE id=1").run();
    const reviewed = await preview(replacement);
    assert.equal(reviewed.json().replacing_result, true);
    const refused = await replacement.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: replacement.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, 'confirm_replace');
    assert.equal(replacement.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'manual');
  } finally { await replacement.close(); }
});

test('activity import refuses a missing session or disabled pilot before reading a preview', async () => {
  const noSession = await setup();
  try {
    noSession.db.prepare('DELETE FROM trainings WHERE id=1').run();
    const response = await noSession.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: noSession.cookie }, payload: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'not_found');
  } finally { await noSession.close(); }
  const disabled = await setup({ garminConfig: { GARMIN_PILOT_ENABLED: 'false' } });
  try {
    const response = await disabled.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: disabled.cookie }, payload: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'pilot_unavailable');
  } finally { await disabled.close(); }
});

test('connection changes and owner revocation immediately before confirmation refuse the import', async () => {
  for (const change of ['generation', 'identity', 'inactive', 'cleanup']) {
    const h = await setup();
    try {
      const reviewed = await preview(h);
      if (change === 'generation') h.db.prepare('UPDATE garmin_pilot_connections SET connection_generation=2 WHERE user_id=1').run();
      if (change === 'identity') h.db.prepare('UPDATE garmin_pilot_connections SET identity_fingerprint=? WHERE user_id=1').run('b'.repeat(64));
      if (change === 'inactive') h.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
      if (change === 'cleanup') h.db.prepare('UPDATE garmin_pilot_connections SET cleanup_pending=1 WHERE user_id=1').run();
      const response = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
      assert.equal(response.statusCode, change === 'inactive' ? 401 : 409);
      assert.equal(response.json().code, change === 'inactive' ? undefined : 'connection_changed');
      assert.equal(h.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
    } finally { await h.close(); }
  }
});

test('the immediate import transaction rechecks connection state and activity ownership after preview', async () => {
  const h = await setup();
  try {
    h.db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-03','run','other')").run();
    const reviewed = await preview(h);
    h.db.prepare(`INSERT INTO garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version)
      VALUES(1,2,?,?,?,1)`).run('a'.repeat(64), '42', 'b'.repeat(64));
    const linked = await h.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: h.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(linked.json().code, 'activity_already_linked');
  } finally { await h.close(); }

  const changed = await setup();
  try {
    const reviewed = await preview(changed);
    const prepare = changed.db.prepare.bind(changed.db);
    let connectionReads = 0;
    changed.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.includes('cleanup_pending') || !sql.includes('garmin_pilot_connections')) return statement;
      return { get(userId) {
        connectionReads += 1;
        const row = statement.get(userId);
        return connectionReads === 2 ? { ...row, cleanup_pending: 1 } : row;
      } };
    };
    const response = await changed.app.inject({ method: 'POST', url: '/api/trainings/1/garmin/activity-import', headers: { cookie: changed.cookie }, payload: { preview_id: reviewed.json().preview_id } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'session_changed');
    assert.equal(changed.db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'none');
  } finally { await changed.close(); }
});
