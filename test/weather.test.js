'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GEOCODING_URL,
  ARCHIVE_URL,
  FORECAST_URL,
  buildGeoUrl,
  buildDailyUrl,
  httpJson,
  geocodeLocation,
  extractDaily,
  readEndpoint,
  resolveTrainingWeather,
} = require('../src/weather');

const GEO_DAILY = (temperature = 22.1, code = 3) => ({
  daily: { temperature_2m_max: [temperature], weather_code: [code] },
});

function jsonFetch(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

function failingFetch() {
  return async () => ({ ok: false, status: 502, json: async () => ({}) });
}

function routeFetch(routes) {
  return async (url) => {
    const hit = routes.find(([needle]) => String(url).startsWith(needle));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const [needle, handler] = hit;
    return handler({ url, stripped: String(url).slice(needle.length) });
  };
}

test('buildGeoUrl targets the Open-Meteo geocoding search with a single result', () => {
  const url = buildGeoUrl('Fânzeres');
  assert.ok(url.startsWith(`${GEOCODING_URL}?`));
  assert.ok(url.includes(`name=${encodeURIComponent('Fânzeres')}`));
  assert.ok(url.includes('count=1'));
  assert.ok(url.includes('format=json'));
});

test('buildDailyUrl selects max temperature, weather code and auto timezone', () => {
  const url = buildDailyUrl(ARCHIVE_URL, {
    latitude: 41.15,
    longitude: -8.61,
    date: '2026-08-24',
  });
  assert.ok(url.startsWith(`${ARCHIVE_URL}?`));
  assert.ok(url.includes('latitude=41.15'));
  assert.ok(url.includes('longitude=-8.61'));
  assert.ok(url.includes('start_date=2026-08-24&end_date=2026-08-24'));
  assert.ok(url.includes(`daily=${encodeURIComponent('temperature_2m_max,weather_code')}`));
  assert.ok(url.includes('timezone=auto'));
});

test('httpJson returns the parsed payload on ok responses', async () => {
  const payload = { results: [{ latitude: 1, longitude: 2 }] };
  assert.deepEqual(
    await httpJson('https://example.test/x', jsonFetch(payload)),
    payload
  );
});

test('httpJson rejects non-ok responses so callers can fall back or surface errors', async () => {
  await assert.rejects(() => httpJson('https://example.test/x', failingFetch()), /failed \(502\)/);
});

test('geocodeLocation returns the first result carrying usable coordinates', async () => {
  const fetchImpl = routeFetch([
    [
      GEOCODING_URL,
      () => ({
        ok: true,
        json: async () => ({
          results: [
            { name: 'Fânzeres', latitude: 41.15, longitude: -8.61 },
            { name: 'Elsewhere', latitude: 1, longitude: 2 },
          ],
        }),
      }),
    ],
  ]);
  const geo = await geocodeLocation('Fânzeres', fetchImpl);
  assert.deepEqual(geo, { name: 'Fânzeres', latitude: 41.15, longitude: -8.61 });
});

test('geocodeLocation skips coordinate-less entries and falls back to the input name', async () => {
  const fetchImpl = routeFetch([
    [
      GEOCODING_URL,
      () => ({
        ok: true,
        json: async () => ({
          results: [
            { name: 'No coords yet' },
            { name: '', latitude: 9, longitude: -7 },
          ],
        }),
      }),
    ],
  ]);
  assert.deepEqual(await geocodeLocation('Fallback place', fetchImpl), {
    name: 'Fallback place',
    latitude: 9,
    longitude: -7,
  });
});

test('geocodeLocation returns null when no usable result exists', async () => {
  const empty = await geocodeLocation('Nowhere', jsonFetch({ results: [] }));
  assert.equal(empty, null);

  const payloadless = await geocodeLocation('Nowhere', jsonFetch({}));
  assert.equal(payloadless, null);

  const coordinateLess = await geocodeLocation(
    'Nowhere',
    jsonFetch({ results: [{ name: 'X' }] })
  );
  assert.equal(coordinateLess, null);
});

test('extractDaily reads the temperature and weather code from a daily payload', () => {
  assert.deepEqual(extractDaily(GEO_DAILY(22.1, 3)), {
    temperature_c: 22.1,
    weather_code: 3,
  });
});

test('extractDaily treats missing or non-numeric temperature/code as unusable', () => {
  assert.equal(extractDaily({ daily: { weather_code: [3] } }), null, 'no temperature');
  assert.equal(extractDaily({ daily: { temperature_2m_max: [22.1] } }), null, 'no code');
  assert.equal(extractDaily({ daily: {} }), null, 'empty daily');
  assert.equal(extractDaily({}), null, 'no daily block');
  assert.equal(extractDaily(null), null, 'null payload');
  assert.equal(extractDaily({ daily: { temperature_2m_max: [null], weather_code: ['3'] } }), null);
});

test('readEndpoint normalizes a daily payload through extractDaily', async () => {
  const geo = { latitude: 41.15, longitude: -8.61 };
  const data = await readEndpoint(ARCHIVE_URL, geo, '2026-08-24', jsonFetch(GEO_DAILY(18, 61)));
  assert.deepEqual(data, { temperature_c: 18, weather_code: 61 });
});

test('resolveTrainingWeather serves the archive readout when available', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => ({ ok: true, json: async () => ({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] }) })],
    [ARCHIVE_URL, () => ({ ok: true, json: async () => GEO_DAILY(22, 3) })],
    [FORECAST_URL, () => { throw new Error('forecast must not be called'); }],
  ]);
  const result = await resolveTrainingWeather('Porto', '2026-08-24', fetchImpl);
  assert.deepEqual(result, {
    ok: true,
    source: 'archive',
    location: 'Porto',
    latitude: 41.15,
    longitude: -8.61,
    date: '2026-08-24',
    temperature_c: 22,
    weather_code: 3,
  });
});

test('resolveTrainingWeather falls back to the forecast endpoint for recent dates', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => ({ ok: true, json: async () => ({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] }) })],
    [ARCHIVE_URL, () => ({ ok: true, json: async () => ({ daily: {} }) })],
    [FORECAST_URL, () => ({ ok: true, json: async () => GEO_DAILY(19, 61) })],
  ]);
  const result = await resolveTrainingWeather('Porto', '2026-09-08', fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'forecast');
  assert.equal(result.temperature_c, 19);
  assert.equal(result.weather_code, 61);
});

test('resolveTrainingWeather falls back when the archive request fails outright', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => ({ ok: true, json: async () => ({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] }) })],
    [ARCHIVE_URL, failingFetch],
    [FORECAST_URL, () => ({ ok: true, json: async () => GEO_DAILY(20, 2) })],
  ]);
  const result = await resolveTrainingWeather('Porto', '2026-09-08', fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'forecast');
});

test('resolveTrainingWeather answers 502 when every Open-Meteo request fails', async () => {
  const fetchImpl = routeFetch([
    [GEOCODING_URL, () => ({ ok: true, json: async () => ({ results: [{ name: 'Porto', latitude: 41.15, longitude: -8.61 }] }) })],
    [ARCHIVE_URL, failingFetch],
    [FORECAST_URL, failingFetch],
  ]);
  assert.deepEqual(await resolveTrainingWeather('Porto', '2026-09-08', fetchImpl), {
    ok: false,
    status: 502,
    error: 'Weather service unavailable.',
  });
});

test('resolveTrainingWeather answers 502 when the geocoding request fails', async () => {
  assert.deepEqual(await resolveTrainingWeather('Porto', '2026-09-08', failingFetch), {
    ok: false,
    status: 502,
    error: 'Weather service unavailable.',
  });
});

test('resolveTrainingWeather answers 404 when the location cannot be found', async () => {
  assert.deepEqual(
    await resolveTrainingWeather('Atlantis', '2026-09-08', jsonFetch({ results: [] })),
    {
      ok: false,
      status: 404,
      error: 'Location not found.',
    }
  );
});