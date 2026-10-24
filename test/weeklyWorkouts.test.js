'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { AiError, hash } = require('../src/ai/memory');
const { readAiConfig } = require('../src/ai/config');
const { buildServer } = require('../src/server');
const weekly = require('../src/ai/weekly-workouts');
const { DAY_KEYS } = require('../src/availability');

function forecastFetcher({
  day = '2026-10-25',
  timezone = 'Europe/Lisbon',
  omitHour = null,
  ambiguous = false,
} = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'geocoding-api.open-meteo.com')
      return {
        ok: true,
        json: async () => ({
          results: ambiguous
            ? [
                {
                  name: 'Porto',
                  latitude: 41.1,
                  longitude: -8.6,
                  country_code: 'PT',
                  timezone: 'Europe/Lisbon',
                  country: 'Portugal',
                  admin1: 'Porto',
                },
                {
                  name: 'Porto',
                  latitude: 41.2,
                  longitude: -8.7,
                  country_code: 'PT',
                  timezone: 'Europe/Lisbon',
                  country: 'Portugal',
                  admin1: 'Porto',
                },
              ]
            : [
                {
                  name: 'Porto',
                  latitude: 41.1,
                  longitude: -8.6,
                  country_code: 'PT',
                  timezone: 'Europe/Lisbon',
                  country: 'Portugal',
                  admin1: 'Porto',
                },
              ],
        }),
      };
    const times = [];
    const temps = [];
    const codes = [];
    for (let hour = 0; hour < 24; hour++) {
      if (hour === omitHour) continue;
      const suffix = String(hour).padStart(2, '0');
      times.push(`${day}T${suffix}:00`);
      temps.push(hour === 15 ? 38 : hour + 10);
      codes.push(hour === 15 ? 0 : 3);
      if (day === '2026-10-25' && hour === 2) {
        times.push(`${day}T02:00`);
        temps.push(12);
        codes.push(3);
      }
    }
    return {
      ok: true,
      json: async () => ({
        timezone,
        hourly: { time: times, temperature_2m: temps, weather_code: codes },
      }),
    };
  };
}
function availability(
  day = 'monday',
  period = '08_12',
  minutes = 120,
  location = 'Porto, Portugal',
) {
  return {
    day_key: day,
    can_train: 1,
    available_periods: JSON.stringify([period]),
    available_minutes: minutes,
    location,
    updated_at: '2026-10-24',
  };
}
function session(overrides = {}) {
  return {
    date: '2026-10-26',
    weekday: 'monday',
    period: '08_12',
    type: 'Corrida',
    workout: 'Corrida fácil',
    details: 'Aquecimento e desaquecimento incluídos',
    targetHr: '120-140 bpm',
    rpe: 3,
    shoeId: null,
    location: 'Porto, Portugal',
    weather: 'Open-Meteo verified',
    notes: '',
    durationMinutes: 60,
    justification:
      'A progressão acompanha o plano aplicado e os treinos registados.',
    evidence: ['cycle:cycle'],
    ...overrides,
  };
}
function proposal(sessions = [session()]) {
  return { schemaVersion: weekly.VERSION, weekStart: '2026-10-26', sessions };
}
function validationContext(overrides = {}) {
  return {
    resource: { weekStart: '2026-10-26' },
    availability: [availability()],
    shoes: [],
    sources: [{ type: 'cycle', id: 'cycle' }],
    weather: [{ weekday: 'monday', status: 'verified' }],
    ...overrides,
  };
}

test('weekly adapter replaces only conflicting delivery sections and is deterministic in PT/EN', () => {
  for (const language of ['pt-BR', 'en-US']) {
    const source =
      language === 'pt-BR'
        ? 'INTRO\nVERIFICAÇÃO OBRIGATÓRIA DA PREVISÃO DO TEMPO\nRESEARCH\nCONTEXTO ADICIONAL DESTA SEMANA\nMIDDLE\nINSTRUÇÕES PARA MONTAR A SEMANA\nTRAINING GUIDANCE\nFORMATO DA PLANILHA\nEXCEL'
        : 'INTRO\nMANDATORY WEATHER FORECAST VERIFICATION\nRESEARCH\nADDITIONAL CONTEXT FOR THIS WEEK\nMIDDLE\nINSTRUCTIONS FOR PLANNING THE WEEK\nTRAINING GUIDANCE\nSPREADSHEET FORMAT\nEXCEL';
    const first = weekly.adaptPrompt(source, language);
    assert.equal(weekly.adaptPrompt(source, language), first);
    assert.match(first, /INTRO/);
    assert.match(first, /TRAINING GUIDANCE/);
    assert.match(first, /structured|estruturada/i);
    assert.doesNotMatch(
      first,
      /\bRESEARCH\b|\bEXCEL\b|SPREADSHEET FORMAT|FORMATO DA PLANILHA/,
    );
  }
  assert.throws(
    () => weekly.adaptPrompt('wrong', 'en-US'),
    (error) =>
      error instanceof AiError && error.code === 'weeklyPromptAdapterMismatch',
  );
});

test('weekly proposal validates dates from weekday, one preferred period, cumulative minutes, RPE, shoes and evidence', () => {
  const context = validationContext({
    shoes: [{ id: 'shoe', status: 'active' }],
  });
  assert.equal(weekly.validateWeeklyProposal(proposal(), context), null);
  assert.equal(
    weekly.validateWeeklyProposal(
      { ...proposal(), weekStart: '2026-10-27' },
      context,
    ).code,
    'week',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ date: '2026-10-27' })]),
      context,
    ).code,
    'session_date',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ period: '12_14' })]),
      context,
    ).code,
    'availability',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ durationMinutes: 121 })]),
      context,
    ).code,
    'duration',
  );
  assert.equal(
    weekly.validateWeeklyProposal(proposal([session({ rpe: 6 })]), context)
      .code,
    'rpe',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ shoeId: 'foreign' })]),
      context,
    ).code,
    'shoe',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ location: 'Porto' })]),
      context,
    ).code,
    'location',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ justification: '' })]),
      context,
    ).code,
    'required',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ targetHr: 'easy' })]),
      context,
    ).code,
    'unit',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ evidence: ['training:foreign'] })]),
      context,
    ).code,
    'evidence',
  );
  assert.equal(
    weekly.validateWeeklyProposal(proposal([session({ weather: '' })]), context)
      .code,
    'weather_evidence',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([
        session({ durationMinutes: 70 }),
        session({ durationMinutes: 60 }),
      ]),
      context,
    ).code,
    'daily_budget',
  );
  const legacy = validationContext({
    availability: [
      { ...availability(), available_periods: '["08_12","12_14"]' },
    ],
  });
  assert.equal(
    weekly.validateWeeklyProposal(proposal(), legacy).code,
    'availability',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ targetHr: 'RPE 8/10' })]),
      context,
    ).code,
    'incompatible_rpe',
  );
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ notes: 'x'.repeat(2001) })]),
      context,
    ).code,
    'text_length',
  );
  assert.equal(weekly.validateWeeklyProposal(null, context).code, 'shape');
  assert.equal(
    weekly.validateWeeklyProposal(
      proposal([session({ weekday: 'tuesday' })]),
      context,
    ).code,
    'session_date',
  );
  assert.equal(
    weekly.validateWeeklyProposal(proposal([session({ rpe: 1.5 })]), context)
      .code,
    'shape',
  );
});

test('weekly validation covers every invariant failure and optional context branch', () => {
  const base = validationContext();
  const rejected = [
    [proposal(), { ...base, resource: { weekStart: 'bad' } }, 'week'],
    [proposal([session({ weekday: 'noday' })]), base, 'session_date'],
    [proposal(), { ...base, availability: [] }, 'availability'],
    [
      proposal(),
      { ...base, availability: [{ ...availability(), can_train: 0 }] },
      'availability',
    ],
    [
      proposal([session({ shoeId: 'retired' })]),
      { ...base, shoes: [{ id: 'retired', status: 'retired' }] },
      'shoe',
    ],
    [proposal([session({ type: '' })]), base, 'required'],
    [proposal([session({ workout: '' })]), base, 'required'],
    [proposal([session({ justification: '' })]), base, 'required'],
    [proposal([session({ type: 't'.repeat(101) })]), base, 'text_length'],
    [proposal([session({ workout: 'w'.repeat(201) })]), base, 'text_length'],
    [proposal([session({ details: 'd'.repeat(2001) })]), base, 'text_length'],
    [proposal([session({ targetHr: 'h'.repeat(81) })]), base, 'text_length'],
    [proposal([session({ weather: 'w'.repeat(1001) })]), base, 'text_length'],
    [proposal([session({ notes: 'n'.repeat(2001) })]), base, 'text_length'],
    [
      proposal([session({ justification: 'j'.repeat(2001) })]),
      base,
      'text_length',
    ],
    [proposal([session({ targetHr: 'easy' })]), base, 'unit'],
    [proposal([session({ type: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [proposal([session({ workout: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [proposal([session({ details: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [proposal([session({ targetHr: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [proposal([session({ weather: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [proposal([session({ notes: 'RPE 8/10' })]), base, 'incompatible_rpe'],
    [
      proposal([session({ justification: 'RPE 8/10' })]),
      base,
      'incompatible_rpe',
    ],
    [proposal(), { ...base, sources: undefined }, 'evidence'],
    [proposal([session({ evidence: [] })]), base, 'evidence'],
    [
      proposal([
        session({ durationMinutes: 70 }),
        session({ durationMinutes: 60 }),
      ]),
      base,
      'daily_budget',
    ],
    [
      proposal([session({ weather: '' })]),
      { ...base, weather: [{ weekday: 'monday', status: 'verified' }] },
      'weather_evidence',
    ],
  ];
  for (const [value, context, code] of rejected)
    assert.equal(weekly.validateWeeklyProposal(value, context)?.code, code);
  const noForecast = { ...base, weather: undefined };
  assert.equal(weekly.validateWeeklyProposal(proposal(), noForecast), null);
  assert.equal(
    weekly.validateWeeklyProposal(proposal(), { ...base, shoes: undefined }),
    null,
  );
  const adapter = weekly.createWeeklyWorkoutAdapter(
    createDatabase({ filename: ':memory:' }),
  );
  assert.equal(adapter.validate(proposal(), base), true);
  assert.equal(
    adapter.diagnose(proposal([session({ rpe: 6 })]), base).code,
    'rpe',
  );
});

test('weekly adapter preparation, legacy availability weather and proposal reads handle missing optional evidence', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'prepare@example.invalid','synthetic','user','en-US')",
  ).run();
  db.prepare(
    "INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES(1,'monday',1,'[\"08_12\",\"12_14\"]',120,'Porto')",
  ).run();
  const evidence = await weekly.collectWeeklyWeather(
    db,
    1,
    '2026-10-26',
    forecastFetcher(),
  );
  assert.deepEqual(evidence, [
    {
      status: 'unavailable',
      reason: 'availability_needs_review',
      weekday: 'monday',
    },
  ]);
  const adapter = weekly.createWeeklyWorkoutAdapter(db);
  const context = { asOf: '2026-10-26' };
  adapter.prepare(context, { userId: 1, weather: 'not-an-array' });
  assert.equal(context.resource.weekStart, '2026-10-26');
  assert.deepEqual(context.weather, []);
  assert.equal(context.availability.length, 1);
  assert.deepEqual(context.shoes, []);
  const timestamp = '2026-10-24T12:00:00.000Z';
  const id = 'read-week-execution';
  const savedContext = {
    preferences: { language: 'en-US', temperature: 'C' },
    resource: { weekStart: '2026-10-26' },
  };
  db.prepare(
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,'read-week-key','workouts','x','v','prompt',?,'{}','{}','completed',1,0,?,?)`,
  ).run(id, JSON.stringify(savedContext), timestamp, timestamp);
  db.prepare(
    'INSERT INTO weekly_workout_proposals(execution_id,user_id,week_start,created_at) VALUES(?,1,?,?)',
  ).run(id, '2026-10-26', timestamp);
  const emptyService = {
    get: () => ({ id, purpose: 'workouts', state: 'queued', response: null }),
  };
  const empty = weekly.readWeeklyProposal(db, 1, id, emptyService);
  assert.equal(empty.responseHash, null);
  assert.equal(empty.proposal, null);
  assert.deepEqual(empty.justifications, []);
  assert.deepEqual(empty.weatherEvidence, []);
  assert.equal(empty.application, null);
  const fullService = {
    get: () => ({
      id,
      purpose: 'workouts',
      state: 'completed',
      response: proposal([session({ shoeId: 'shoe' })]),
    }),
  };
  const full = weekly.readWeeklyProposal(db, 1, id, fullService);
  assert.equal(full.proposal.sessions[0].shoeLabel, null);
  assert.match(full.proposal.sessions[0].weather, /unavailable/i);
  assert.equal(full.justifications.length, 1);
  savedContext.shoes = [
    { id: 'shoe', brand: 'Sample', model: 'Run', status: 'active' },
  ];
  db.prepare('UPDATE ai_executions SET context_json=? WHERE id=?').run(
    JSON.stringify(savedContext),
    id,
  );
  assert.equal(
    weekly.readWeeklyProposal(db, 1, id, fullService).proposal.sessions[0]
      .shoeLabel,
    'Sample Run',
  );
  assert.throws(
    () => weekly.readWeeklyProposal(db, 2, id, emptyService),
    (error) => error instanceof AiError && error.code === 'proposalNotFound',
  );
  db.close();
});

test('hourly forecast uses local half-open windows, excludes daily highs and respects DST', async () => {
  const result = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher(),
    new Date('2026-10-24T12:00:00Z'),
  );
  assert.equal(result.status, 'verified');
  assert.ok(
    result.limitations.some((item) =>
      item.includes('No authorized independent second hourly source'),
    ),
  );
  assert.equal(result.timezone, 'Europe/Lisbon');
  assert.equal(result.coverage.expectedHours, 9);
  assert.equal(result.coverage.verifiedHours, 9);
  assert.equal(result.window.maxC, 17);
  assert.ok(result.window.maxC < 38);
  assert.equal(
    result.hours.some((hour) => hour.localTime.includes('T08:00')),
    false,
  );
  assert.equal(weekly.weatherValue(result, 'F', 'pt-BR').includes('°F'), true);
});

test('hourly forecast reports partial, ambiguity, invalid timezone, missing fields, horizon and outage explicitly', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const partial = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ omitHour: 6 }),
    now,
  );
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coverage.verifiedHours, 8);
  const ambiguous = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ ambiguous: true }),
    now,
  );
  assert.equal(ambiguous.reason, 'ambiguous_or_unresolved_location');
  const timezone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ timezone: 'Mars/Phobos' }),
    now,
  );
  assert.equal(timezone.reason, 'invalid_timezone');
  const missing = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    async (url) =>
      url.includes('geocoding-api')
        ? forecastFetcher()(url)
        : {
            ok: true,
            json: async () => ({
              timezone: 'Europe/Lisbon',
              hourly: { time: [], temperature_2m: [] },
            }),
          },
    now,
  );
  assert.equal(missing.reason, 'hourly_coverage_incomplete');
  const old = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-23',
    { weekday: 'friday', period: '08_12' },
    forecastFetcher(),
    now,
  );
  assert.equal(old.reason, 'outside_forecast_horizon');
  const localDayPassed = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-24',
    { weekday: 'saturday', period: '08_12' },
    forecastFetcher(),
    new Date('2026-10-24T23:30:00.000Z'),
  );
  assert.equal(localDayPassed.reason, 'outside_forecast_horizon');
  assert.equal(localDayPassed.lookupAttempted, false);
  const future = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-11-10',
    { weekday: 'tuesday', period: '08_12' },
    forecastFetcher(),
    now,
  );
  assert.equal(future.reason, 'outside_forecast_horizon');
  const timezoneDrift = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-24',
    { weekday: 'saturday', period: '08_12' },
    async (url) => {
      if (url.includes('geocoding-api'))
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: 'Porto',
                latitude: 41.1,
                longitude: -8.6,
                country_code: 'PT',
                timezone: 'UTC',
                country: 'Portugal',
                admin1: 'Porto',
              },
            ],
          }),
        };
      const forecast = await forecastFetcher({
        day: '2026-10-24',
        timezone: 'Pacific/Kiritimati',
      })(url);
      return forecast;
    },
    new Date('2026-10-24T23:30:00.000Z'),
  );
  assert.equal(timezoneDrift.reason, 'outside_forecast_horizon');
  const unavailable = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    async () => {
      throw Error('network');
    },
    now,
  );
  assert.equal(unavailable.reason, 'forecast_service_unavailable');
  assert.match(weekly.weatherValue(partial, 'C', 'en-US'), /partial/i);
  assert.match(weekly.weatherValue(null, 'C', 'pt-BR'), /indisponível/i);
});

test('hourly weather rejects provider gaps and uses the half-open evening window', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const missingGeocoderTimezone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? {
            ok: true,
            json: async () => ({
              results: [
                {
                  name: 'Porto',
                  latitude: 41.1,
                  longitude: -8.6,
                  country: 'Portugal',
                  country_code: 'PT',
                  admin1: 'Porto',
                },
              ],
            }),
          }
        : forecastFetcher()(url),
    now,
  );
  assert.equal(missingGeocoderTimezone.status, 'verified');
  const invalidGeocoderTimezone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) => {
      const response = await forecastFetcher()(url);
      if (url.includes('geocoding-api'))
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: 'Porto',
                latitude: 41.1,
                longitude: -8.6,
                country: 'Portugal',
                country_code: 'PT',
                admin1: 'Porto',
                timezone: 'Mars/Phobos',
              },
            ],
          }),
        };
      return response;
    },
    now,
  );
  assert.equal(invalidGeocoderTimezone.reason, 'invalid_timezone');
  const refuse = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api') ? forecastFetcher()(url) : { ok: false },
    now,
  );
  assert.equal(refuse.reason, 'forecast_service_unavailable');
  const noTimezone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? forecastFetcher()(url)
        : {
            ok: true,
            json: async () => ({ hourly: { time: [], temperature_2m: [] } }),
          },
    now,
  );
  assert.equal(noTimezone.reason, 'timezone_or_hourly_data_missing');
  const badCoordinates = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? {
            ok: true,
            json: async () => ({
              results: [
                {
                  name: 'Porto',
                  latitude: 91,
                  longitude: -8.6,
                  country_code: 'PT',
                  timezone: 'Europe/Lisbon',
                  country: 'Portugal',
                  admin1: 'Porto',
                },
              ],
            }),
          }
        : { ok: false },
    now,
  );
  assert.equal(badCoordinates.reason, 'invalid_coordinates');
  const noTemps = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? forecastFetcher()(url)
        : {
            ok: true,
            json: async () => ({
              timezone: 'Europe/Lisbon',
              hourly: { time: [] },
            }),
          },
    now,
  );
  assert.equal(noTemps.reason, 'timezone_or_hourly_data_missing');
  const noWeatherCodes = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? forecastFetcher()(url)
        : {
            ok: true,
            json: async () => ({
              timezone: 'Europe/Lisbon',
              hourly: {
                time: Array.from(
                  { length: 24 },
                  (_, hour) => `2026-10-25T${String(hour).padStart(2, '0')}:00`,
                ),
                temperature_2m: Array(24).fill(14),
              },
            }),
          },
    now,
  );
  assert.equal(noWeatherCodes.status, 'verified');
  assert.equal(noWeatherCodes.hours[0].weatherCode, null);
  const evening = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'after_18' },
    forecastFetcher(),
    now,
  );
  assert.equal(evening.coverage.expectedHours, 6);
  assert.throws(
    () => weekly.hoursInLocalWindow('2011-12-30', 8, 12, 'Pacific/Apia'),
    /Unresolvable local boundary/,
  );
  assert.throws(
    () => weekly.hoursInLocalWindow('2026-10-25', 0, 0, 'Europe/Lisbon'),
    /Unresolvable local window/,
  );
  assert.equal(
    weekly.weatherValue({ status: 'partial' }, 'C', 'pt-BR'),
    'Previsão parcial; cobertura horária incompleta.',
  );
  assert.equal(
    weekly.weatherValue({ status: 'unavailable' }, 'C', 'en-US'),
    'Forecast unavailable; no verified hourly data.',
  );
  assert.match(
    weekly.weatherValue(
      {
        status: 'verified',
        source: 'Open-Meteo',
        sourceUrl: 'https://open-meteo.com',
        date: '2026-10-25',
        timezone: 'Europe/Lisbon',
        coverage: { verifiedHours: 4, expectedHours: 4 },
        window: { minC: 10, maxC: 12 },
        lookedUpAt: '2026-10-24T12:00:00.000Z',
      },
      'C',
      'en-US',
    ),
    /window high 12 °C/,
  );
});

test('weekly Open-Meteo URL and Monday/date validation are bounded and canonical', () => {
  assert.equal(weekly.monday('2026-10-26'), '2026-10-26');
  assert.throws(
    () => weekly.monday('2026-10-25'),
    (error) => error instanceof AiError && error.code === 'invalidDate',
  );
  assert.equal(weekly.addIsoDays('2026-10-26', 6), '2026-11-01');
  const url = new URL(weekly.hourlyUrl(41.1, -8.6, '2026-10-26'));
  assert.equal(url.searchParams.get('hourly'), 'temperature_2m,weather_code');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(DAY_KEYS.length, 7);
  assert.equal(hash({ a: 1 }).length, 64);
});

test('proposal application preserves existing results, deduplicates within the week and is idempotent', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'week@example.invalid','synthetic','user','en-US')",
  ).run();
  db.prepare(
    "INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(2,'other-week@example.invalid','synthetic','user','en-US')",
  ).run();
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective,status) VALUES('cycle',1,'Base','active')",
  ).run();
  const row = availability('monday', '08_12', 240);
  db.prepare(
    'INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location,updated_at) VALUES(1,?,?,?,?,?,?)',
  ).run(
    row.day_key,
    row.can_train,
    row.available_periods,
    row.available_minutes,
    row.location,
    row.updated_at,
  );
  const first = session();
  const second = session({
    workout: 'Corrida progressiva',
    details: 'Sessão adicional',
    durationMinutes: 60,
  });
  const third = session({
    workout: 'Rodagem leve sem detalhes',
    details: '',
    targetHr: '',
    rpe: null,
    shoeId: 'active-shoe',
    notes: '',
    durationMinutes: 60,
  });
  const result = proposal([first, second, third]);
  db.prepare(
    "INSERT INTO shoes(id,user_id,brand,model) VALUES('active-shoe',1,'Sample','Daily')",
  ).run();
  db.prepare(
    "INSERT INTO trainings(id,user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,completed,feedback_rpe,result_data_source) VALUES(1,1,'cycle',?,?,?,?,?,1,3,'manual')",
  ).run(first.date, first.period, first.type, first.workout, first.details);
  const context = {
    resource: { weekStart: '2026-10-26' },
    availability: [row],
    shoes: [
      { id: 'active-shoe', brand: 'Sample', model: 'Daily', status: 'active' },
    ],
    sources: [{ type: 'cycle', id: 'cycle' }],
    preferences: { temperature: 'C', language: 'en-US' },
  };
  const id = 'week-execution';
  const timestamp = '2026-10-24T12:00:00.000Z';
  db.prepare(
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,'week-idempotency','workouts','x','v','prompt',?,'{}','{}','completed',1,0,?,?)`,
  ).run(id, JSON.stringify(context), timestamp, timestamp);
  db.prepare(
    'INSERT INTO weekly_workout_proposals(execution_id,user_id,week_start,created_at) VALUES(?,1,?,?)',
  ).run(id, '2026-10-26', timestamp);
  const service = {
    get: (userId, executionId) => ({
      id: executionId,
      purpose: 'workouts',
      state: 'completed',
      outdated: false,
      response: result,
    }),
  };
  const expectCode = (body, executionService, code) =>
    assert.throws(
      () => weekly.applyWeeklyProposal(db, 1, id, body, executionService),
      (error) => error instanceof AiError && error.code === code,
    );
  expectCode({ expected_response_hash: 12 }, service, 'invalidVersion');
  expectCode(
    { expected_response_hash: hash(result) },
    { get: () => ({ purpose: 'cycle', response: result }) },
    'weeklyProposalConflict',
  );
  expectCode(
    { expected_response_hash: hash(result) },
    { get: () => ({ purpose: 'workouts', response: null }) },
    'weeklyProposalConflict',
  );
  expectCode(
    { expected_response_hash: hash(result) },
    {
      get: () => ({ purpose: 'workouts', state: 'running', response: result }),
    },
    'weeklyProposalOutdated',
  );
  expectCode(
    { expected_response_hash: hash(result) },
    {
      get: () => ({
        purpose: 'workouts',
        state: 'completed',
        outdated: true,
        response: result,
      }),
    },
    'weeklyProposalOutdated',
  );
  expectCode(
    { expected_response_hash: hash(result) },
    {
      get: () => {
        db.prepare('DELETE FROM ai_executions WHERE id=?').run(id);
        return { purpose: 'workouts', state: 'completed', response: result };
      },
    },
    'proposalNotFound',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM ai_executions WHERE id=?').get(id).n,
    1,
    'a failed concurrent deletion is rolled back with the transaction',
  );
  const invalidProposal = proposal([session({ workout: '' })]);
  expectCode(
    { expected_response_hash: hash(invalidProposal) },
    {
      get: () => ({
        purpose: 'workouts',
        state: 'completed',
        response: invalidProposal,
      }),
    },
    'weeklyProposalInvalid',
  );
  const savedContext = db
    .prepare('SELECT context_json FROM ai_executions WHERE id=?')
    .get(id).context_json;
  const staleContext = JSON.parse(savedContext);
  staleContext.resource = { weekStart: '2026-11-02' };
  db.prepare('UPDATE ai_executions SET context_json=? WHERE id=?').run(
    JSON.stringify(staleContext),
    id,
  );
  expectCode(
    { expected_response_hash: hash(result) },
    service,
    'weeklyProposalInvalid',
  );
  db.prepare('UPDATE ai_executions SET context_json=? WHERE id=?').run(
    savedContext,
    id,
  );
  db.prepare(
    "UPDATE training_cycles SET status='completed' WHERE id='cycle'",
  ).run();
  expectCode(
    { expected_response_hash: hash(result) },
    service,
    'resourceNotFound',
  );
  db.prepare(
    "UPDATE training_cycles SET status='active' WHERE id='cycle'",
  ).run();
  const firstApply = weekly.applyWeeklyProposal(
    db,
    1,
    id,
    { expected_response_hash: hash(result) },
    service,
    () => timestamp,
  );
  assert.deepEqual(
    {
      added: firstApply.added,
      ignored: firstApply.ignored,
      alreadyApplied: firstApply.alreadyApplied,
    },
    { added: 2, ignored: 1, alreadyApplied: false },
  );
  assert.deepEqual(
    db
      .prepare(
        'SELECT completed,feedback_rpe,result_data_source FROM trainings WHERE id=1',
      )
      .get(),
    { completed: 1, feedback_rpe: 3, result_data_source: 'manual' },
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM trainings WHERE user_id=1 AND dia='2026-10-26'",
      )
      .get().n,
    3,
  );
  const applied = weekly.readWeeklyProposal(db, 1, id, service);
  assert.equal(applied.application.added, 2);
  assert.equal(applied.proposal.sessions[2].shoeLabel, 'Sample Daily');
  assert.equal(
    db
      .prepare(
        "SELECT tenis,detalhes,fc_alvo,rpe,observacoes,location,previsao FROM trainings WHERE treino='Rodagem leve sem detalhes'",
      )
      .get().tenis,
    'Sample Daily',
  );
  const repeated = weekly.applyWeeklyProposal(
    db,
    1,
    id,
    { expected_response_hash: hash(result) },
    service,
    () => timestamp,
  );
  assert.equal(repeated.alreadyApplied, true);
  assert.equal(repeated.added, 2);
  assert.throws(
    () =>
      weekly.applyWeeklyProposal(
        db,
        2,
        id,
        { expected_response_hash: hash(result) },
        service,
      ),
    (error) => error instanceof AiError && error.code === 'proposalNotFound',
  );
  assert.throws(
    () =>
      weekly.applyWeeklyProposal(
        db,
        1,
        id,
        { expected_response_hash: '0'.repeat(64) },
        service,
      ),
    (error) =>
      error instanceof AiError && error.code === 'weeklyProposalConflict',
  );
  db.close();
});

test('authenticated weekly execution recovers the same owner proposal and applies it without provider replay', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const calls = [];
  const aiConfig = readAiConfig({
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key',
    AI_RETRIES: '0',
  });
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    aiConfig,
    weatherFetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'geocoding-api.open-meteo.com')
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: 'Porto',
                latitude: 41.1,
                longitude: -8.6,
                country_code: 'PT',
                timezone: 'Europe/Lisbon',
                country: 'Portugal',
                admin1: 'Porto',
              },
            ],
          }),
        };
      const day = parsed.searchParams.get('start_date');
      return {
        ok: true,
        json: async () => ({
          timezone: 'Europe/Lisbon',
          hourly: {
            time: Array.from(
              { length: 24 },
              (_, hour) => `${day}T${String(hour).padStart(2, '0')}:00`,
            ),
            temperature_2m: Array.from({ length: 24 }, (_, hour) => 10 + hour),
            weather_code: Array(24).fill(2),
          },
        }),
      };
    },
    aiClient: async (payload) => {
      calls.push(payload);
      const context = JSON.parse(payload.input[0].content[0].text).context;
      const row = context.availability.find(
        (item) => item.day_key === 'monday',
      );
      const source = context.sources.find((item) => item.type === 'cycle');
      return {
        value: proposal([
          session({
            date: weekly.addIsoDays(context.resource.weekStart, 0),
            location: row.location,
            period: JSON.parse(row.available_periods)[0],
            durationMinutes: 45,
            evidence: [`${source.type}:${source.id}`],
          }),
        ]),
        usage: { input: 5, output: 5, cached: 0 },
        error: null,
      };
    },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'weekly-route@example.invalid',
      password: 'weekly-secret-123',
      first_name: 'Weekly',
      last_name: 'Runner',
      preferred_lang: 'en-US',
    },
  });
  assert.equal(registered.statusCode, 201);
  const owner = db
    .prepare("SELECT id FROM users WHERE email='weekly-route@example.invalid'")
    .get().id;
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective,status) VALUES('weekly-route-cycle',?,'Base fitness','active')",
  ).run(owner);
  for (const day of DAY_KEYS) {
    const canTrain = day === 'monday';
    db.prepare(
      'INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES(?,?,?,?,?,?)',
    ).run(
      owner,
      day,
      canTrain ? 1 : 0,
      JSON.stringify(canTrain ? ['08_12'] : []),
      canTrain ? 90 : null,
      canTrain ? 'Porto, Portugal' : '',
    );
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'weekly-route@example.invalid',
      password: 'weekly-secret-123',
    },
  });
  const cookie = [].concat(login.headers['set-cookie'] || [])[0].split(';')[0];
  const start = await app.inject({
    method: 'POST',
    url: '/api/ai/executions',
    headers: { cookie },
    payload: {
      purpose: 'workouts',
      target_date: '2026-10-26',
      idempotency_key: 'weekly-route-001',
    },
  });
  assert.equal(start.statusCode, 202, start.body);
  const executionId = start.json().id;
  let execution;
  for (let attempt = 0; attempt < 100; attempt++) {
    const read = await app.inject({
      method: 'GET',
      url: `/api/ai/executions/${executionId}`,
      headers: { cookie },
    });
    execution = read.json();
    if (!['queued', 'running'].includes(execution.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(execution.state, 'completed');
  assert.equal(calls.length, 1);
  const read = await app.inject({
    method: 'GET',
    url: `/api/ai/workouts/${executionId}/proposal`,
    headers: { cookie },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().proposal.sessions[0].date, '2026-10-26');
  assert.equal(read.json().weatherEvidence[0].status, 'verified');
  assert.ok(read.json().responseHash);
  const applied = await app.inject({
    method: 'POST',
    url: `/api/ai/workouts/${executionId}/apply`,
    headers: { cookie },
    payload: { expected_response_hash: read.json().responseHash },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().added, 1);
  assert.equal(calls.length, 1);
  const replay = await app.inject({
    method: 'POST',
    url: `/api/ai/workouts/${executionId}/apply`,
    headers: { cookie },
    payload: { expected_response_hash: read.json().responseHash },
  });
  assert.equal(replay.json().alreadyApplied, true);
  assert.equal(calls.length, 1);
  const noDebug = await app.inject({
    method: 'POST',
    url: '/api/ai/admin/preview',
    headers: { cookie },
    payload: { purpose: 'workouts', target_date: '2026-10-26' },
  });
  assert.equal(noDebug.statusCode, 403);
  const request = (key) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/executions',
      headers: { cookie },
      payload: {
        purpose: 'workouts',
        target_date: '2026-10-26',
        idempotency_key: key,
      },
    });
  aiConfig.enabled = false;
  assert.equal(
    (await request('weekly-disabled-001')).json().errors[0],
    'aiUnavailable',
  );
  aiConfig.enabled = true;
  db.prepare(
    "UPDATE training_cycles SET status='completed' WHERE id='weekly-route-cycle'",
  ).run();
  assert.equal(
    (await request('weekly-no-cycle-001')).json().errors[0],
    'resourceNotFound',
  );
  db.prepare(
    "UPDATE training_cycles SET status='active' WHERE id='weekly-route-cycle'",
  ).run();
  db.prepare(
    "UPDATE ai_coach_availability SET location=? WHERE user_id=? AND day_key='monday'",
  ).run('x'.repeat(201), owner);
  assert.equal(
    (await request('weekly-invalid-day-001')).json().errors[0],
    'availabilityNeedsReview',
  );
  db.prepare(
    "UPDATE ai_coach_availability SET location='Porto, Portugal' WHERE user_id=? AND day_key='monday'",
  ).run(owner);
  db.prepare(
    'UPDATE ai_coach_availability SET available_periods=\'["08_12","12_14"]\' WHERE user_id=? AND day_key=\'monday\'',
  ).run(owner);
  assert.equal(
    (await request('weekly-legacy-period-001')).json().errors[0],
    'availabilityNeedsReview',
  );
});
