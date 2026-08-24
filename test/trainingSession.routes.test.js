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

async function setup() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });

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
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().training.completed, 1);

  const row = db
    .prepare('SELECT feedback_rpe, feedback_notas, completed FROM trainings WHERE id = ?')
    .get(id);
  assert.equal(row.feedback_rpe, 3);
  assert.equal(row.feedback_notas, 'Boa sensação, pernas leves');
  assert.equal(row.completed, 1);

  const fetched = await app.inject({
    method: 'GET',
    url: `/api/trainings/${id}`,
    headers: { cookie },
  });
  assert.equal(fetched.json().training.feedback_notas, 'Boa sensação, pernas leves');
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
    completed: 1,
  });

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/trainings/${id}`,
    headers: { cookie },
    payload: { feedback_rpe: '', feedback_notas: null, completed: false },
  });
  assert.equal(response.statusCode, 200);

  const row = db
    .prepare('SELECT feedback_rpe, feedback_notas, completed FROM trainings WHERE id = ?')
    .get(id);
  assert.equal(row.feedback_rpe, null);
  assert.equal(row.feedback_notas, null);
  assert.equal(row.completed, 0);
});
