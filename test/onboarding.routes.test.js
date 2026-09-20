'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

async function userSession(app, email, firstName = 'Runner') {
  await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email, password: 'onboarding-secret', first_name: firstName, last_name: 'Test' },
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email, password: 'onboarding-secret' },
  });
  return [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];
}

test('onboarding is derived from owned data and presentation preferences', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const cookie = await userSession(app, 'new-onboarding@example.com');

  assert.equal((await app.inject({ method: 'GET', url: '/api/onboarding' })).statusCode, 401);
  let response = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie } });
  assert.deepEqual(response.json().onboarding, {
    status: 'new', guideHidden: false,
    steps: { shoes: false, cycle: false, trainings: false },
    completed: 0, total: 3, complete: false,
    firstTrainingId: null,
  });

  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: {} });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie } });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: { welcome_dismissed: 'yes' } });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: { guide_hidden: 'yes' } });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: { other: true } });
  assert.equal(response.statusCode, 400);

  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: { welcome_dismissed: true, guide_hidden: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().onboarding.status, 'active');
  assert.equal(response.json().onboarding.guideHidden, true);
  response = await app.inject({ method: 'PATCH', url: '/api/onboarding/presentation', headers: { cookie }, payload: { guide_hidden: false } });
  assert.equal(response.json().onboarding.guideHidden, false);

  response = await app.inject({ method: 'POST', url: '/api/shoes', headers: { cookie }, payload: { brand: 'Kinesis', model: 'One' } });
  assert.equal(response.statusCode, 201);
  response = await app.inject({ method: 'POST', url: '/api/cycles', headers: { cookie }, payload: { objective: 'First race', target_date: '2026-12-01' } });
  assert.equal(response.statusCode, 201);
  db.prepare('INSERT INTO trainings (user_id, dia, tipo, treino) VALUES (?, ?, ?, ?)').run(1, '2026-09-18', 'Run', 'Easy run');

  response = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie } });
  assert.equal(response.json().onboarding.complete, true);
  assert.equal(response.json().onboarding.completed, 3);
  assert.equal(response.json().onboarding.firstTrainingId, 1);
  await app.close();
  db.close();
});

test('legacy accounts stay out of the first-visit welcome and cannot see another user data', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const firstCookie = await userSession(app, 'legacy-onboarding@example.com', 'Legacy');
  db.prepare("UPDATE users SET onboarding_status = 'legacy' WHERE email = ?").run('legacy-onboarding@example.com');
  const secondCookie = await userSession(app, 'other-onboarding@example.com', 'Other');
  db.prepare('INSERT INTO shoes (id, user_id, brand, model) VALUES (?, ?, ?, ?)').run('own-shoe', 1, 'Own', 'Shoe');

  let response = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: firstCookie } });
  assert.equal(response.json().onboarding.status, 'legacy');
  assert.equal(response.json().onboarding.steps.shoes, true);
  response = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: secondCookie } });
  assert.equal(response.json().onboarding.steps.shoes, false);
  await app.close();
  db.close();
});
