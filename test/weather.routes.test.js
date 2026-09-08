'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'Weather@Example.com',
  password: 'super-secret-1',
  first_name: 'Wea',
  last_name: 'Ther',
};

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const GEO_DAILY = (temperature = 22, code = 3) => ({
  daily: { temperature_2m_max: [temperature], weather_code: [code] },
});

function routeFetch(routes) {
  return async (url) => {
    const hit = routes.find(([needle]) => String(url).startsWith(needle));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return hit[1]();
  };
}

async function setup(weatherFetch) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, weatherFetch });

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

  return { db, app, cookie };
}

test('GET /api/weather requires an authenticated session', async () => {
  const { app } = await setup();
  const response = await app.inject({ method: 'GET', url: '/api/weather?location=Porto&date=2026-08-24' });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET /api/weather rejects a missing location', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?date=2026-08-24',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'location is required.' });
  await app.close();
});

test('GET /api/weather rejects an invalid training date', async () => {
  const { app, cookie } = await setup();
  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?location=Porto&date=not-a-date',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'date must be a valid date in YYYY-MM-DD format.',
  });
  await app.close();
});

test('GET /api/weather answers 404 for unknown locations', async () => {
  const { app, cookie } = await setup(jsonFetch({ results: [] }));
  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?location=Atlantis&date=2026-08-24',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'Location not found.' });
  await app.close();
});

function jsonFetch(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

test('GET /api/weather returns the archive weather readout for a planned location', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => jsonFetch({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] })()],
    [ARCHIVE_URL, () => jsonFetch(GEO_DAILY(22.1, 3))()],
    [FORECAST_URL, () => { throw new Error('forecast must not be called'); }],
  ]);
  const { app, cookie } = await setup(fetchImpl);

  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?location=Porto&date=2026-08-24',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    location: 'Porto',
    latitude: 41.15,
    longitude: -8.61,
    date: '2026-08-24',
    temperature_c: 22.1,
    weather_code: 3,
    source: 'archive',
  });
  await app.close();
});

test('GET /api/weather falls back to the forecast endpoint when the archive is empty', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => jsonFetch({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] })()],
    [ARCHIVE_URL, () => jsonFetch({ daily: {} })()],
    [FORECAST_URL, () => jsonFetch(GEO_DAILY(19, 61))()],
  ]);
  const { app, cookie } = await setup(fetchImpl);

  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?location=Porto&date=2026-09-08',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.source, 'forecast');
  assert.equal(payload.temperature_c, 19);
  assert.equal(payload.weather_code, 61);
  await app.close();
});

test('GET /api/weather answers 502 when both Open-Meteo feeds fail', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => jsonFetch({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] })()],
    [ARCHIVE_URL, () => ({ ok: false, status: 502, json: async () => ({}) })],
    [FORECAST_URL, () => ({ ok: false, status: 502, json: async () => ({}) })],
  ]);
  const { app, cookie } = await setup(fetchImpl);

  const response = await app.inject({
    method: 'GET',
    url: '/api/weather?location=Porto&date=2026-09-08',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: 'Weather service unavailable.' });
  await app.close();
});