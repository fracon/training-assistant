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
  canonicalizeCountry,
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

test('buildGeoUrl targets Open-Meteo with enough candidates to validate locality context', () => {
  const url = buildGeoUrl('Fânzeres');
  assert.ok(url.startsWith(`${GEOCODING_URL}?`));
  assert.ok(url.includes(`name=${encodeURIComponent('Fânzeres')}`));
  assert.ok(url.includes('count=10'));
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

test('geocodeLocation accepts an exact matching locality and stops at the first reliable query', async () => {
  let calls = 0;
  const fetchImpl = routeFetch([
    [
      GEOCODING_URL,
      ({ url }) => {
        calls += 1;
        assert.equal(new URL(url).searchParams.get('name'), 'Fânzeres, Gondomar, Porto, Portugal');
        return ({
        ok: true,
        json: async () => ({
          results: [
            { name: 'Fânzeres', admin1: 'Porto District', admin2: 'Gondomar Municipality', country: 'Portugal', country_code: 'PT', latitude: 41.16754, longitude: -8.52981 },
            { name: 'Fânzeres', admin1: 'Other', country: 'Elsewhere', latitude: 1, longitude: 2 },
          ],
        }),
      });
      },
    ],
  ]);
  const geo = await geocodeLocation('Fânzeres, Gondomar, Porto, Portugal', fetchImpl);
  assert.deepEqual(geo, { name: 'Fânzeres', latitude: 41.16754, longitude: -8.52981 });
  assert.equal(calls, 1);
});

test('geocodeLocation skips coordinate-less entries and retains only a matching locality', async () => {
  const fetchImpl = routeFetch([
    [
      GEOCODING_URL,
      () => ({
        ok: true,
        json: async () => ({
          results: [
            { name: 'Fallback place' },
            { name: 'Fallback place', latitude: 9, longitude: -7 },
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

  const textCountryFallback = await geocodeLocation('Fallback place, Portugal', jsonFetch({ results: [
    { name: 'Fallback place', country: 'Portugal', latitude: 9, longitude: -7 },
  ] }));
  assert.deepEqual(textCountryFallback, { name: 'Fallback place', latitude: 9, longitude: -7 });
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
  assert.equal(await geocodeLocation(null, jsonFetch({ results: [] })), null);
  assert.equal(await geocodeLocation('', jsonFetch({ results: [] })), null);
});

test('geocodeLocation falls back from full text to locality and validates administrative context', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    calls.push(url.searchParams.get('name'));
    const results = url.searchParams.get('name') === 'Fânzeres'
      ? [{ name: 'Fânzeres', admin1: 'Porto District', admin2: 'Gondomar Municipality', country: 'Portugal', country_code: 'PT', latitude: 41.16754, longitude: -8.52981 }]
      : [];
    return { ok: true, json: async () => ({ results }) };
  };
  assert.deepEqual(await geocodeLocation('Fânzeres, Gondomar', fetchImpl), {
    name: 'Fânzeres', latitude: 41.16754, longitude: -8.52981,
  });
  assert.deepEqual(calls, ['Fânzeres, Gondomar', 'Fânzeres']);
});

test('geocodeLocation retries without diacritics and refuses ambiguous or incompatible countries', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const query = new URL(rawUrl).searchParams.get('name');
    calls.push(query);
    const results = query === 'Fânzeres, Gondomar'
      ? [{ name: 'Fânzeres', admin2: 'Elsewhere', country: 'Portugal', latitude: 1, longitude: 2 }, { name: 'Fânzeres', admin2: 'Elsewhere', country: 'Brazil', latitude: 3, longitude: 4 }]
      : query === 'Fânzeres'
        ? []
      : query === 'Fanzeres, Gondomar'
        ? [{ name: 'Fanzeres', admin1: 'Porto', admin2: 'Gondomar', country: 'Portugal', latitude: 41, longitude: -8 }]
        : [];
    return { ok: true, json: async () => ({ results }) };
  };
  assert.deepEqual(await geocodeLocation('Fânzeres, Gondomar', fetchImpl), {
    name: 'Fanzeres', latitude: 41, longitude: -8,
  });
  assert.deepEqual(calls, ['Fânzeres, Gondomar', 'Fânzeres', 'Fanzeres, Gondomar']);

  const ambiguous = await geocodeLocation('Fânzeres', async () => ({
    ok: true,
    json: async () => ({ results: [
      { name: 'Fânzeres', country: 'Portugal', latitude: 1, longitude: 2 },
      { name: 'Fânzeres', country: 'Brazil', latitude: 3, longitude: 4 },
    ] }),
  }));
  assert.equal(ambiguous, null, 'do not silently choose between incompatible places');
});

test('country context canonicalizes ISO codes and Portuguese or English country names', async () => {
  for (const country of ['Brasil', 'Brazil', 'BR', 'bRaSiL']) {
    const fetchImpl = async (rawUrl) => {
      assert.equal(new URL(rawUrl).searchParams.get('name'), 'São Paulo, ' + country);
      return { ok: true, json: async () => ({ results: [
        { name: 'São Paulo', country: 'Brazil', country_code: 'BR', latitude: -23.55, longitude: -46.63 },
      ] }) };
    };
    assert.deepEqual(await geocodeLocation(`São Paulo, ${country}`, fetchImpl), {
      name: 'São Paulo', latitude: -23.55, longitude: -46.63,
    }, `${country} matches the Open-Meteo Brazil/BR candidate`);
  }

  for (const country of ['Portugal', 'PT', 'portugal']) {
    assert.deepEqual(await geocodeLocation(`Porto, ${country}`, async () => ({
      ok: true,
      json: async () => ({ results: [
        { name: 'Porto', country: 'Portugal', country_code: 'PT', latitude: 41.15, longitude: -8.61 },
      ] }),
    })), { name: 'Porto', latitude: 41.15, longitude: -8.61 });
  }

  assert.equal(canonicalizeCountry('México', 'MX'), 'MX');
  assert.equal(canonicalizeCountry('Mexico', 'MX'), 'MX');
  assert.equal(canonicalizeCountry('mx', 'MX'), 'MX');
  assert.equal(canonicalizeCountry('Gondomar', 'PT'), null, 'administrative context is not canonicalized as a country');
  assert.equal(canonicalizeCountry('Brasil', null), null);
  assert.equal(canonicalizeCountry('', 'BR'), null);
  assert.equal(canonicalizeCountry('ZZ', 'ZZ'), null, 'unknown codes are not accepted as ISO countries');
});

test('country aliases do not weaken administrative matching or candidate ambiguity checks', async () => {
  const incompatible = await geocodeLocation('São Paulo, Gondomar', async () => ({
    ok: true,
    json: async () => ({ results: [
      { name: 'São Paulo', country: 'Brazil', country_code: 'BR', latitude: -23.55, longitude: -46.63 },
    ] }),
  }));
  assert.equal(incompatible, null, 'a non-country context must still match an administrative field');

  const inconsistentCountry = await geocodeLocation('São Paulo, Brasil', async () => ({
    ok: true,
    json: async () => ({ results: [
      { name: 'São Paulo', country: 'Brazil', country_code: 'PT', latitude: -23.55, longitude: -46.63 },
    ] }),
  }));
  assert.equal(inconsistentCountry, null, 'localized country text cannot override an incompatible ISO candidate code');

  const ambiguous = await geocodeLocation('São Paulo, Brasil', async () => ({
    ok: true,
    json: async () => ({ results: [
      { name: 'São Paulo', country: 'Brazil', country_code: 'BR', latitude: -23.55, longitude: -46.63 },
      { name: 'São Paulo', country: 'Brazil', country_code: 'BR', latitude: -22.9, longitude: -47.06 },
    ] }),
  }));
  assert.equal(ambiguous, null, 'multiple otherwise-compatible coordinates remain ambiguous');
});

test('geocodeLocation accepts recognized administrative abbreviations in country context', async () => {
  const brazil = { name: 'São Paulo', admin1: 'São Paulo', country: 'Brazil', country_code: 'BR', latitude: -23.55, longitude: -46.63 };
  const portland = { name: 'Portland', admin1: 'Oregon', country: 'United States', country_code: 'US', latitude: 45.52, longitude: -122.68 };
  const resolve = (location, candidate) => geocodeLocation(location, jsonFetch({ results: [candidate] }));

  for (const location of ['São Paulo, SP, Brasil', 'São Paulo, SP, BR', 'São Paulo, São Paulo, Brasil', '  são paulo , sp , brAsil ']) {
    assert.deepEqual(await resolve(location, brazil), { name: 'São Paulo', latitude: -23.55, longitude: -46.63 }, location);
  }
  for (const location of ['Portland, OR, US', 'Portland, Oregon, United States']) {
    assert.deepEqual(await resolve(location, portland), { name: 'Portland', latitude: 45.52, longitude: -122.68 }, location);
  }

  assert.equal(await resolve('Portland, CA, US', portland), null, 'California code does not match Oregon');
  assert.equal(await resolve('São Paulo, SP, Portugal', brazil), null, 'country context remains mandatory');
  assert.equal(await resolve('São Paulo, OR, Brasil', brazil), null, 'US abbreviation is not reused in Brazil');
  assert.equal(await resolve('São Paulo, ZZ, Brasil', brazil), null, 'unknown administrative codes are rejected');
  assert.deepEqual(await resolve('São Paulo, SP, Brasil', brazil), {
    name: 'São Paulo', latitude: -23.55, longitude: -46.63,
  });
  assert.equal(await geocodeLocation('São Paulo, SP, Brasil', jsonFetch({ results: [
    brazil,
    { ...brazil, latitude: -22.9, longitude: -47.06 },
  ] })), null, 'multiple matching candidates remain ambiguous');
});

test('Fanzeres and Fânzeres with Gondomar context resolve the same mocked locality', async () => {
  for (const location of ['Fânzeres, Gondomar', 'Fanzeres, Gondomar']) {
    const geo = await geocodeLocation(location, async (rawUrl) => {
      const query = new URL(rawUrl).searchParams.get('name');
      const results = query === location ? [] : query === 'Fanzeres'
        ? [{ name: 'Fânzeres', admin1: 'Porto District', admin2: 'Gondomar Municipality', country: 'Portugal', country_code: 'PT', latitude: 41.16754, longitude: -8.52981 }]
        : [];
      return { ok: true, json: async () => ({ results }) };
    });
    assert.deepEqual(geo, { name: 'Fânzeres', latitude: 41.16754, longitude: -8.52981 });
  }
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
