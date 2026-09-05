'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'home@example.com',
  password: 'super-secret-1',
  first_name: 'Rafael',
  last_name: 'Vilaça',
};

function setCookies(response) {
  return [].concat(response.headers['set-cookie'] ?? []);
}

async function registerAndLogin(app, payload = REGISTER_PAYLOAD) {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: payload.email, password: payload.password },
  });
  assert.equal(login.statusCode, 200);
  const cookiePair = setCookies(login)[0].split(';')[0];
  return { login, cookiePair };
}

function seedTraining(db, userId, { dia, tipo, fitDistance, fitDuration }) {
  db.prepare(
    'INSERT INTO trainings (user_id, dia, tipo, fit_distance, fit_duration) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, dia, tipo, fitDistance, fitDuration);
}

test('GET /api/calendar/trainings filters by the dashboard week window', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });
  const { login, cookiePair } = await registerAndLogin(app);
  const userId = login.json().user.id;

  seedTraining(db, userId, { dia: '2026-08-10', tipo: 'Regen', fitDistance: 5, fitDuration: '30:00' });
  seedTraining(db, userId, { dia: '2026-08-17', tipo: 'Corrida', fitDistance: 12.5, fitDuration: '1:15:00' });
  seedTraining(db, userId, { dia: '2026-08-20', tipo: 'Corrida', fitDistance: 7, fitDuration: '40:00' });
  seedTraining(db, userId, { dia: '2026-08-23', tipo: 'Intervals', fitDistance: 9, fitDuration: '0:55:00' });
  seedTraining(db, userId, { dia: '2026-08-24', tipo: 'Recovery', fitDistance: 4, fitDuration: '25:00' });

  const week = await app.inject({
    method: 'GET',
    url: '/api/calendar/trainings?from=2026-08-17&to=2026-08-23',
    headers: { cookie: cookiePair },
  });
  assert.equal(week.statusCode, 200);
  const inWeek = week.json().trainings;
  assert.deepEqual(
    inWeek.map((t) => t.dia),
    ['2026-08-17', '2026-08-20', '2026-08-23']
  );
  assert.equal(inWeek[0].fit_distance, 12.5);
  assert.equal(inWeek[0].fit_duration, '1:15:00');

  const onlyFrom = await app.inject({
    method: 'GET',
    url: '/api/calendar/trainings?from=2026-08-17',
    headers: { cookie: cookiePair },
  });
  assert.deepEqual(
    onlyFrom.json().trainings.map((t) => t.dia),
    ['2026-08-17', '2026-08-20', '2026-08-23', '2026-08-24']
  );

  const onlyTo = await app.inject({
    method: 'GET',
    url: '/api/calendar/trainings?to=2026-08-23',
    headers: { cookie: cookiePair },
  });
  assert.deepEqual(
    onlyTo.json().trainings.map((t) => t.dia),
    ['2026-08-10', '2026-08-17', '2026-08-20', '2026-08-23']
  );

  const blank = await app.inject({
    method: 'GET',
    url: '/api/calendar/trainings?from=&to=',
    headers: { cookie: cookiePair },
  });
  assert.deepEqual(
    blank.json().trainings.map((t) => t.dia),
    ['2026-08-10', '2026-08-17', '2026-08-20', '2026-08-23', '2026-08-24'],
    'blank filters behave like no filters'
  );

  await app.close();
  db.close();
});

test('GET /api/calendar/trainings lists trainings across users and keeps fit fields', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db });

  const first = await registerAndLogin(app, REGISTER_PAYLOAD);
  const userId = first.login.json().user.id;
  seedTraining(db, userId, { dia: '2026-08-17', tipo: 'Corrida', fitDistance: 12.5, fitDuration: '1:15:00' });

  const second = await registerAndLogin(app, {
    email: 'Other@Example.com',
    password: 'super-secret-2',
    first_name: 'Ana',
    last_name: 'Souza',
  });
  seedTraining(db, second.login.json().user.id, {
    dia: '2026-08-18',
    tipo: 'Tempo',
    fitDistance: 6,
    fitDuration: '35:00',
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/calendar/trainings',
    headers: { cookie: first.cookiePair },
  });
  assert.equal(response.statusCode, 200);
  const trainings = response.json().trainings;
  assert.deepEqual(trainings.map((t) => t.dia), ['2026-08-17']);
  assert.equal(trainings[0].fit_distance, 12.5);
  assert.equal(trainings[0].fit_duration, '1:15:00');

  await app.close();
  db.close();
});