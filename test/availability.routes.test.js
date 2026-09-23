'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

async function setup() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  const users = [
    { email: 'availability-one@example.test', password: 'runner-secret-1', first_name: 'Runner', last_name: 'One' },
    { email: 'availability-two@example.test', password: 'runner-secret-2', first_name: 'Runner', last_name: 'Two' },
  ];
  const cookies = [];
  for (const user of users) {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: user });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: user });
    cookies.push([].concat(login.headers['set-cookie'] || [])[0].split(';')[0]);
  }
  return { db, app, cookies };
}

function payload() {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return days.map((day, index) => ({
    day, can_train: index < 2,
    available_periods: index === 0 ? ['12_14', 'after_18', '12_14'] : index === 1 ? ['before_08'] : [],
    available_minutes: index === 0 ? 60 : index === 1 ? 45 : null,
    location: index === 0 ? 'Fânzeres, Gondomar' : index === 1 ? 'Porto' : '',
  }));
}

test('availability endpoints require authentication', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ method: 'GET', url: '/api/ai-coach/availability' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/ai-coach/availability', payload: { days: payload() } })).statusCode, 401);
  await app.close();
});

test('GET returns unconfigured values without inventing availability', async () => {
  const { app, cookies } = await setup();
  const response = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: cookies[0] } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().availability.needsReview, true);
  assert.equal(response.json().availability.days[0].can_train, null);
  assert.deepEqual(response.json().availability.days[0].available_periods, []);
  await app.close();
});

test('PUT validates and saves structured days while isolating users', async () => {
  const { app, cookies, db } = await setup();
  const days = payload();
  const response = await app.inject({ method: 'PUT', url: '/api/ai-coach/availability', headers: { cookie: cookies[0] }, payload: { days } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().availability.needsReview, false);
  assert.deepEqual(response.json().availability.days[0].available_periods, ['12_14', 'after_18']);
  assert.equal(response.json().availability.days[0].available_minutes, 60);
  assert.equal(response.json().availability.days[0].location, 'Fânzeres, Gondomar');
  assert.deepEqual(response.json().availability.days[2], {
    day: 'wednesday', can_train: false, available_periods: [], available_minutes: null, location: '',
  });
  const other = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: cookies[1] } });
  assert.equal(other.json().availability.needsReview, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_coach_availability').get().count, 7);
  await app.close();
});

test('PUT rejects malformed payloads and values outside the domain contract', async () => {
  const { app, cookies } = await setup();
  const post = (body) => app.inject({ method: 'PUT', url: '/api/ai-coach/availability', headers: { cookie: cookies[0] }, payload: body });
  assert.equal((await post({})).statusCode, 400);
  const zero = payload(); zero[0].available_minutes = 0;
  assert.equal((await post({ days: zero })).statusCode, 400);
  const tooLong = payload(); tooLong[0].available_minutes = 721;
  assert.equal((await post({ days: tooLong })).statusCode, 400);
  const unknownPeriod = payload(); unknownPeriod[0].available_periods = ['lunch'];
  assert.equal((await post({ days: unknownPeriod })).statusCode, 400);
  const missingLocation = payload(); missingLocation[0].location = '';
  assert.equal((await post({ days: missingLocation })).statusCode, 400);
  await app.close();
});
