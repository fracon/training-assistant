'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'Session@Example.com',
  password: 'super-secret-1',
  first_name: 'Ses',
  last_name: 'Sion',
};

function makeFitSummary(overrides = {}) {
  return {
    totals: {
      durationSeconds: 3600,
      distanceKm: 10,
      avgPaceSecondsPerKm: 360,
      avgHeartRate: 155,
      maxHeartRate: 175,
      ascentMeters: 120,
    },
    activity: {
      sport: 'running',
      startTime: '2026-08-24T07:00:00Z',
      endTime: '2026-08-24T08:00:00Z',
    },
    laps: [{ lap: 1, duration: 3600, stepType: 'Run', durationLabel: '1:00:00', cumulativeSeconds: 3600, cumulativeLabel: '1:00:00', distanceKm: 10, distanceLabel: '10.00', avgPaceSecondsPerKm: 360, avgPaceLabel: '6:00', bestPaceSecondsPerKm: null, bestPaceLabel: '--:--', avgHeartRate: 155, maxHeartRate: 175, ascentMeters: 120, descentMeters: null, avgCadenceSpm: null, maxCadenceSpm: null, strideMeters: null, calories: null }],
    ...overrides,
  };
}

function stubParse(summary = makeFitSummary()) {
  return async (buffer) => {
    stubParse.lastBuffer = buffer;
    return summary;
  };
}

function failingParse() {
  return async () => {
    throw new Error('unreadable fit');
  };
}

function multipart(parts) {
  const boundary = '----fitupload';
  const chunks = [];
  for (const part of parts) {
    const filename = part.fileName ? `; filename="${part.fileName}"` : '';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: ${part.contentType || 'text/plain'}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function postFitParts(app, cookie, parts) {
  const body = multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/trainings/1/fit',
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
}

async function setup(overrides = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const serverOpts = { db, sessionCookieSecure: false, ...overrides };
  const app = await buildServer(serverOpts);

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: REGISTER_PAYLOAD,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];

  const userId = db
    .prepare('SELECT id FROM users WHERE lower(email) = lower(?)')
    .get(REGISTER_PAYLOAD.email).id;

  return { db, app, cookie, userId };
}

function seedTraining(db, overrides = {}) {
  const row = {
    user_id: 1,
    dia: '2026-08-24',
    periodo: 'Manhã',
    tipo: 'Corrida',
    treino: '6 × 1 km forte',
    detalhes: 'Aquecer 15 min + 6 tiros',
    fc_alvo: '150-160 bpm',
    rpe: '4',
    tenis: 'Nimbus 26',
    previsao: '22°C nublado',
    observacoes: 'Planilha semana 3',
    feedback_rpe: null,
    feedback_notas: null,
    completed: 0,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO trainings (
        user_id, dia, periodo, tipo, treino, detalhes,
        fc_alvo, rpe, tenis, previsao, observacoes,
        feedback_rpe, feedback_notas, completed
      ) VALUES (
        @user_id, @dia, @periodo, @tipo, @treino, @detalhes,
        @fc_alvo, @rpe, @tenis, @previsao, @observacoes,
        @feedback_rpe, @feedback_notas, @completed
      )`
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

test('GET /api/trainings/:id requires authentication', async () => {
  const { app } = await setup();
  const response = await app.inject({ method: 'GET', url: '/api/trainings/1' });
  assert.equal(response.statusCode, 401);
});

test('GET /api/trainings/:id rejects malformed ids', async () => {
  const { app, cookie } = await setup();
  for (const id of ['abc', '0', '-3']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/trainings/${id}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 400, `id=${id}`);
    assert.deepEqual(response.json(), { error: 'Invalid training id.' });
  }
});

test('GET /api/trainings/:id answers 404 when the session does not exist', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'GET',
    url: '/api/trainings/999',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'Training not found.' });
});

test("GET /api/trainings/:id never leaks other users' sessions", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('peer@example.com', 'hash')"
  ).run();
  const peerId = db.prepare("SELECT id FROM users WHERE email = 'peer@example.com'").get().id;
  const foreignId = seedTraining(db, { user_id: peerId });

  const response = await app.inject({
    method: 'GET',
    url: `/api/trainings/${foreignId}`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 404);
});

test('GET /api/trainings/:id returns the planned session with its feedback state', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedTraining(db, { user_id: userId });

  const response = await app.inject({
    method: 'GET',
    url: `/api/trainings/${id}`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const { training } = response.json();
  assert.equal(training.id, id);
  assert.equal(training.dia, '2026-08-24');
  assert.equal(training.tipo, 'Corrida');
  assert.equal(training.treino, '6 × 1 km forte');
  assert.equal(training.detalhes, 'Aquecer 15 min + 6 tiros');
  assert.equal(training.fc_alvo, '150-160 bpm');
  assert.equal(training.rpe, '4');
  assert.equal(training.tenis, 'Nimbus 26');
  assert.equal(training.feedback_rpe, null);
  assert.equal(training.feedback_notas, null);
  assert.equal(training.completed, 0);
  assert.equal(training.has_smartwatch, 1, 'smartwatch defaults to yes');
  assert.equal(training.feedback_shoe, null);
  assert.equal(training.feedback_hr_source, null);
  assert.equal(training.feedback_weather, null);
  assert.equal(training.feedback_terrain, null);
  assert.equal(training.feedback_breathing, null);
  assert.equal(training.feedback_muscle, null);
  assert.equal(training.feedback_energy, null);
  assert.equal(training.feedback_has_pain, null);
  assert.equal(training.feedback_pain, null);
});

test('PATCH /api/trainings/:id requires authentication', async () => {
  const { app } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    payload: { completed: true },
  });
  assert.equal(response.statusCode, 401);
});

test('PATCH /api/trainings/:id rejects malformed ids', async () => {
  const { app, cookie } = await setup();
  for (const id of ['abc', '0']) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/trainings/${id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    assert.equal(response.statusCode, 400, `id=${id}`);
    assert.deepEqual(response.json(), { error: 'Invalid training id.' });
  }
});

test('PATCH /api/trainings/:id rejects payloads without feedback fields', async () => {
  const { app, cookie } = await setup();

  const emptyBody = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
    payload: {},
  });
  assert.equal(emptyBody.statusCode, 400);
  assert.deepEqual(emptyBody.json(), { error: 'No feedback fields provided.' });

  const noBody = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
  });
  assert.equal(noBody.statusCode, 400);
  assert.deepEqual(noBody.json(), { error: 'No feedback fields provided.' });
});

test('PATCH /api/trainings/:id validates the realized RPE', async () => {
  const { app, cookie } = await setup();
  for (const feedback_rpe of ['abc', 6, 2.5]) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/trainings/1',
      headers: { cookie },
      payload: { feedback_rpe },
    });
    assert.equal(response.statusCode, 400, `feedback_rpe=${feedback_rpe}`);
    assert.deepEqual(response.json(), {
      error: 'rpe must be an integer between 1 and 5.',
    });
  }
});

test('PATCH /api/trainings/:id rejects non-string notes', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
    payload: { feedback_notas: 42 },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'feedback_notas must be a string.' });
});

test('PATCH /api/trainings/:id rejects non-boolean completed flags', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
    payload: { completed: 'yes' },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'completed must be a boolean.' });
});

test('PATCH /api/trainings/:id answers 404 when the session does not exist', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/999',
    headers: { cookie },
    payload: { feedback_rpe: 3 },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'Training not found.' });
});

test('PATCH /api/trainings/:id rejects non-string feedback text fields', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
    payload: { feedback_shoe: 5 },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'feedback_shoe must be a string.' });
});

test('PATCH /api/trainings/:id rejects non-boolean smartwatch flags', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/trainings/1',
    headers: { cookie },
    payload: { has_smartwatch: 'yes' },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'has_smartwatch must be a boolean.' });
});

test('PATCH /api/trainings/:id rejects unsupported pain answers', async () => {
  const { app, cookie } = await setup();
  for (const feedback_has_pain of ['maybe', true, 1]) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/trainings/1',
      headers: { cookie },
      payload: { feedback_has_pain },
    });
    assert.equal(response.statusCode, 400, `feedback_has_pain=${String(feedback_has_pain)}`);
    assert.deepEqual(response.json(), {
      error: 'feedback_has_pain must be "yes", "no", or null.',
    });
  }
});

test('PATCH /api/trainings/:id saves trimmed notes and persists every field', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedTraining(db, { user_id: userId });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/trainings/${id}`,
    headers: { cookie },
    payload: {
      feedback_rpe: 3,
      feedback_notas: '  Boa sensação, pernas leves  ',
      completed: true,
      has_smartwatch: true,
      feedback_shoe: '  Nimbus 26  ',
      feedback_hr_source: 'chest_strap',
      feedback_weather: '22°C nublado',
      feedback_terrain: '  trail  ',
      feedback_breathing: '  controlled  ',
      feedback_muscle: 'light',
      feedback_energy: 'surplus',
      feedback_has_pain: 'yes',
      feedback_pain: 'pontada leve no Aquiles direito',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().training.completed, 1);

  const row = db
    .prepare(
      `SELECT feedback_rpe, feedback_notas, completed, has_smartwatch,
        feedback_shoe, feedback_hr_source, feedback_weather, feedback_terrain,
        feedback_breathing, feedback_muscle, feedback_energy,
        feedback_has_pain, feedback_pain
      FROM trainings WHERE id = ?`
    )
    .get(id);
  assert.equal(row.feedback_rpe, 3);
  assert.equal(row.feedback_notas, 'Boa sensação, pernas leves');
  assert.equal(row.completed, 1);
  assert.equal(row.has_smartwatch, 1);
  assert.equal(row.feedback_shoe, 'Nimbus 26');
  assert.equal(row.feedback_hr_source, 'chest_strap');
  assert.equal(row.feedback_weather, '22°C nublado');
  assert.equal(row.feedback_terrain, 'trail');
  assert.equal(row.feedback_breathing, 'controlled', 'dropdown tokens are trimmed');
  assert.equal(row.feedback_muscle, 'light');
  assert.equal(row.feedback_energy, 'surplus');
  assert.equal(row.feedback_has_pain, 'yes');
  assert.equal(row.feedback_pain, 'pontada leve no Aquiles direito');

  const fetched = await app.inject({
    method: 'GET',
    url: `/api/trainings/${id}`,
    headers: { cookie },
  });
  const training = fetched.json().training;
  assert.equal(training.feedback_notas, 'Boa sensação, pernas leves');
  assert.equal(training.has_smartwatch, 1);
  assert.equal(training.feedback_pain, 'pontada leve no Aquiles direito');
});

test('PATCH /api/trainings/:id performs partial updates without touching other columns', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedTraining(db, { user_id: userId, feedback_rpe: 2, feedback_notas: 'Pesado' });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/trainings/${id}`,
    headers: { cookie },
    payload: { completed: true },
  });
  assert.equal(response.statusCode, 200);

  const row = db
    .prepare('SELECT feedback_rpe, feedback_notas, completed FROM trainings WHERE id = ?')
    .get(id);
  assert.equal(row.feedback_rpe, 2, 'previous RPE untouched');
  assert.equal(row.feedback_notas, 'Pesado', 'previous notes untouched');
  assert.equal(row.completed, 1);
});

test('PATCH /api/trainings/:id accepts explicit clears of the feedback fields', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedTraining(db, {
    user_id: userId,
    feedback_rpe: 5,
    feedback_notas: 'Muito forte',
    feedback_hr_source: 'optical_watch',
    feedback_has_pain: 'yes',
    feedback_pain: 'Panturrilha direita',
    completed: 1,
  });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/trainings/${id}`,
    headers: { cookie },
    payload: {
      feedback_rpe: '',
      feedback_notas: null,
      feedback_hr_source: null,
      feedback_has_pain: null,
      feedback_pain: null,
      completed: false,
    },
  });
  assert.equal(response.statusCode, 200);

  const row = db
    .prepare(
      `SELECT feedback_rpe, feedback_notas, feedback_hr_source,
        feedback_has_pain, feedback_pain, completed FROM trainings WHERE id = ?`
    )
    .get(id);
  assert.equal(row.feedback_rpe, null);
  assert.equal(row.feedback_notas, null);
  assert.equal(row.feedback_hr_source, null);
  assert.equal(row.feedback_has_pain, null, 'the pain answer clears back to unanswered');
  assert.equal(row.feedback_pain, null);
  assert.equal(row.completed, 0);
});

test('PATCH /api/trainings/:id toggles the smartwatch flag without touching other columns', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedTraining(db, {
    user_id: userId,
    has_smartwatch: 1,
    feedback_rpe: 2,
    feedback_notas: 'Pesado',
  });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/trainings/${id}`,
    headers: { cookie },
    payload: { has_smartwatch: false },
  });
  assert.equal(response.statusCode, 200);

  const row = db
    .prepare('SELECT has_smartwatch, feedback_rpe, feedback_notas FROM trainings WHERE id = ?')
    .get(id);
  assert.equal(row.has_smartwatch, 0, 'smartwatch flag flipped to no');
  assert.equal(row.feedback_rpe, 2, 'previous RPE untouched');
  assert.equal(row.feedback_notas, 'Pesado', 'previous notes untouched');
});

// ── POST /api/trainings/:id/fit ─────────────────────────────────

test('POST /api/trainings/:id/fit requires authentication', async () => {
  const { app } = await setup();
  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'data' }]);
  const response = await app.inject({
    method: 'POST',
    url: '/api/trainings/1/fit',
    headers: body.headers,
    payload: body.payload,
  });
  assert.equal(response.statusCode, 401);
});

test('POST /api/trainings/:id/fit rejects malformed ids', async () => {
  const { app, cookie } = await setup({ parseFitFile: stubParse() });
  for (const id of ['abc', '0', '-3']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/trainings/${id}/fit`,
      headers: { cookie },
      payload: {},
    });
    assert.equal(response.statusCode, 400, `id=${id}`);
    assert.deepEqual(response.json(), { error: 'Invalid training id.' });
  }
});

test('POST /api/trainings/:id/fit returns 404 when training not found', async () => {
  const { app, cookie } = await setup({ parseFitFile: stubParse() });
  const response = await postFitParts(app, cookie, [
    { name: 'file', fileName: 'run.fit', value: 'data' },
  ]);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'Training not found.' });
});

test('POST /api/trainings/:id/fit rejects non-multipart requests', async () => {
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse() });
  seedTraining(db, { user_id: userId });
  const response = await app.inject({
    method: 'POST',
    url: '/api/trainings/1/fit',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Expected multipart/form-data upload.' });
});

test('POST /api/trainings/:id/fit requires a file field', async () => {
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse() });
  seedTraining(db, { user_id: userId });
  const response = await postFitParts(app, cookie, [
    { name: 'other', value: 'no file here' },
  ]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Missing .FIT file field.' });
});

test('POST /api/trainings/:id/fit reports parse errors as 422', async () => {
  const { db, app, cookie, userId } = await setup({ parseFitFile: failingParse() });
  const id = seedTraining(db, { user_id: userId });
  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'data' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    error: 'Could not parse the .FIT file.',
    detail: 'unreadable fit',
  });
});

test('POST /api/trainings/:id/fit persists FIT metrics and returns them', async () => {
  const summary = makeFitSummary({
    totals: { durationSeconds: 5400, distanceKm: 12.5, avgPaceSecondsPerKm: 432, avgHeartRate: 160, maxHeartRate: 182, ascentMeters: 200 },
    activity: { sport: 'running', startTime: '2026-08-24T07:00:00Z', endTime: '2026-08-24T08:30:00Z' },
    laps: [{ lap: 1, duration: 5400, stepType: 'Run', durationLabel: '1:30:00', cumulativeSeconds: 5400, cumulativeLabel: '1:30:00', distanceKm: 12.5, distanceLabel: '12.50', avgPaceSecondsPerKm: 432, avgPaceLabel: '7:12', bestPaceSecondsPerKm: null, bestPaceLabel: '--:--', avgHeartRate: 160, maxHeartRate: 182, ascentMeters: 200, descentMeters: null, avgCadenceSpm: null, maxCadenceSpm: null, strideMeters: null, calories: null }],
  });
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse(summary) });
  const id = seedTraining(db, { user_id: userId });

  const body = multipart([{ name: 'file', fileName: 'morning_run.fit', value: 'binary-data' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 200);

  const payload = response.json();
  assert.equal(payload.fit_duration, '1:30:00');
  assert.equal(payload.fit_distance, 12.5);
  assert.equal(payload.fit_avg_pace, '7.20');
  assert.equal(payload.fit_avg_hr, 160);
  assert.equal(payload.fit_max_hr, 182);
  assert.equal(payload.fit_elevation_gain, 200);
  assert.ok(Array.isArray(payload.laps));

  const row = db
    .prepare('SELECT fit_duration, fit_distance, fit_avg_pace, fit_avg_hr, fit_max_hr, fit_elevation_gain, fit_summary_json FROM trainings WHERE id = ?')
    .get(id);
  assert.equal(row.fit_duration, '1:30:00');
  assert.equal(row.fit_distance, 12.5);
  assert.equal(row.fit_avg_pace, '7.20');
  assert.equal(row.fit_avg_hr, 160);
  assert.equal(row.fit_max_hr, 182);
  assert.equal(row.fit_elevation_gain, 200);
  const parsed = JSON.parse(row.fit_summary_json);
  assert.ok(parsed.activity);
  assert.ok(parsed.totals);
  assert.ok(parsed.laps);
});

test('POST /api/trainings/:id/fit formats minutes-only duration when under one hour', async () => {
  const summary = makeFitSummary({
    totals: { durationSeconds: 1800, distanceKm: 5, avgPaceSecondsPerKm: 360, avgHeartRate: 150, maxHeartRate: 168, ascentMeters: 60 },
    activity: { sport: 'running', startTime: '2026-08-24T07:00:00Z', endTime: '2026-08-24T07:30:00Z' },
    laps: [],
  });
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse(summary) });
  const id = seedTraining(db, { user_id: userId });

  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'x' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().fit_duration, '30:00');
});

test('POST /api/trainings/:id/fit extracts metrics from totals produced by summarize()', async () => {
  const summary = {
    totals: {
      durationSeconds: 2400,
      distanceKm: 7,
      avgPaceSecondsPerKm: 342.9,
      avgHeartRate: 145,
      maxHeartRate: 170,
      ascentMeters: 80,
    },
    activity: { sport: 'running', startTime: null, endTime: null },
    laps: [],
  };
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse(summary) });
  const id = seedTraining(db, { user_id: userId });

  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'x' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.fit_duration, '40:00');
  assert.equal(payload.fit_distance, 7);
  assert.equal(payload.fit_avg_hr, 145);
  assert.equal(payload.fit_max_hr, 170);
  assert.equal(payload.fit_elevation_gain, 80);
});

test('POST /api/trainings/:id/fit returns nulls when optional totals fields are absent', async () => {
  const summary = {
    totals: { durationSeconds: 600, distanceKm: 2 },
    activity: {},
    laps: [],
  };
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse(summary) });
  const id = seedTraining(db, { user_id: userId });

  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'x' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.fit_duration, '10:00');
  assert.equal(payload.fit_distance, 2);
  assert.equal(payload.fit_avg_pace, null);
  assert.equal(payload.fit_avg_hr, null);
  assert.equal(payload.fit_max_hr, null);
  assert.equal(payload.fit_elevation_gain, null);
});

test('POST /api/trainings/:id/fit enforces the configured size limit with 413', async () => {
  const { db, app, cookie, userId } = await setup({
    parseFitFile: stubParse(),
    maxFileSizeBytes: 8,
  });
  const id = seedTraining(db, { user_id: userId });
  const body = multipart([{ name: 'file', fileName: 'run.fit', value: Buffer.alloc(64, 1) }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), { error: 'File exceeds the size limit.' });
});

test('POST /api/trainings/:id/fit defaults duration and distance to zero when all sources are absent', async () => {
  const summary = { totals: {}, activity: {}, laps: [] };
  const { db, app, cookie, userId } = await setup({ parseFitFile: stubParse(summary) });
  const id = seedTraining(db, { user_id: userId });

  const body = multipart([{ name: 'file', fileName: 'run.fit', value: 'x' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/trainings/${id}/fit`,
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.fit_duration, '0:00');
  assert.equal(payload.fit_distance, 0);
});
