'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { AiError, hash } = require('../src/ai/memory');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, tokenBound, projectContextForModel } = require('../src/ai/context');
const { buildPayload } = require('../src/ai/client');
const { buildServer } = require('../src/server');
const weekly = require('../src/ai/weekly-workouts');
const { DAY_KEYS } = require('../src/availability');
const { saveAvailabilityWeek } = require('../src/availability');
const { trainingSignature } = require('../src/trainingImport');

test('weekly structured schema exposes the same numeric bounds as domain validation', () => {
  const step = weekly.schema.properties.sessions.items.properties.prescription.items;
  const integerBounds = (field) => {
    const spec = step.properties[field];
    const integer = spec.anyOf?.find((part) => part.type === 'integer') || spec;
    return [integer.minimum, integer.maximum];
  };
  assert.deepEqual(integerBounds('repetitions'), [1, 30]);
  assert.deepEqual(integerBounds('minutes'), [1, 720]);
  assert.deepEqual(integerBounds('distanceMeters'), [50, 100000]);
  assert.deepEqual(integerBounds('paceSecondsPerKm'), [120, 1800]);
  assert.deepEqual(integerBounds('paceTargetSecondsPerKm'), [120, 1800]);
  assert.deepEqual(integerBounds('recoveryMinutes'), [0, 30]);
  assert.deepEqual(integerBounds('rpe'), [1, 5]);
  assert.deepEqual(integerBounds('recoveryRpe'), [1, 5]);
  assert.equal(
    weekly.schema.properties.sessions.items.properties.weather.maxLength,
    1000,
  );
});

test('weekly model projection handles absent evidence and keeps full execution-only fields out of provider context', () => {
  assert.equal(projectContextForModel(null), null);
  const cycle = { purpose: 'cycle', hash: 'kept' };
  assert.equal(projectContextForModel(cycle), cycle);
  const noWeather = projectContextForModel({
    purpose: 'workouts', weather: 'not-an-array', hash: 'internal',
    sources: [{ type: 'weather', id: 'monday:2026-10-26', version: 'internal' }],
  });
  assert.equal(noWeather.hash, undefined);
  assert.equal(noWeather.weather, 'not-an-array');
  assert.deepEqual(noWeather.sources, [{ type: 'weather', id: 'monday:2026-10-26' }]);
  assert.equal(noWeather.weatherLimitations, undefined);
  const input = {
    purpose: 'workouts',
    weather: [null, { weekday: 'monday', limitations: ['shared limit', 42], userId: 1 }],
    refs: [null, 7, { type: 'training', id: 'one', version: 'internal', label: 'run' }, { type: 'training', id: 'two', label: 'run' }],
  };
  const projected = projectContextForModel(input);
  assert.deepEqual(projected.weather, [{}, { weekday: 'monday' }]);
  assert.deepEqual(projected.weatherLimitations, ['shared limit']);
  assert.deepEqual(projected.refs, [null, 7, { type: 'training', id: 'one' }, { type: 'training', id: 'two', label: 'run' }]);
  assert.equal(input.weather[1].userId, 1);
});

test('weekly forecast snapshot stays complete while model context fits its budget', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'budget@example.invalid','synthetic','user','pt-BR')").run();
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,distance,run_count,primary_goal,start_date,status) VALUES('cycle',1,'Build consistent endurance','10 km',4,'Consistency','2026-08-01','active')").run();
  saveAvailabilityWeek(db, 1, DAY_KEYS.map((day, index) => ({
    day,
    can_train: index < 6,
    available_periods: index < 6 ? [index === 5 ? '08_12' : 'before_08'] : [],
    available_minutes: index < 6 ? (index === 5 ? 90 : 60) : null,
    location: index < 6 ? 'Fanzeres' : '',
  })));
  db.prepare("INSERT INTO shoes(id,user_id,brand,model,status) VALUES('shoe',1,'Synthetic','Daily','active')").run();
  const training = db.prepare("INSERT INTO trainings(user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,completed,feedback_rpe,result_data_source,fit_distance,fit_duration,feedback_notas,feedback_terrain,feedback_breathing,feedback_energy,feedback_has_pain) VALUES(1,'cycle',?,'before_08','Corrida','Synthetic session','Completed synthetic run',1,?,'manual',5,'00:30:00','Dated synthetic feedback','Plano','conversational','normal','no')");
  for (const [day, rpe] of [['2026-09-28',3],['2026-10-01',4],['2026-10-04',3],['2026-10-07',2],['2026-10-10',4],['2026-10-14',3],['2026-10-18',3],['2026-10-21',4]]) training.run(day,rpe);
  const config = readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic', AI_CONTEXT_TOKENS: '12000' });
  const weather = DAY_KEYS.slice(0,6).map((weekday, index) => ({
    weekday, date: weekly.addIsoDays('2026-10-26',index), period: index === 5 ? '08_12' : 'before_08',
    source:'Open-Meteo',sourceUrl:'https://open-meteo.com',lookedUpAt:'2026-10-25T12:00:00.000Z',
    timezone:'Europe/Lisbon',resolvedTimezone:'Europe/Lisbon',status:'verified',coverage:{expectedHours:index===5?4:8,verifiedHours:index===5?4:8},window:{minC:10,maxC:12.5},
    hours:Array.from({length:index===5?4:8},(_,hour)=>[1792998000+hour*3600,`${String(hour).padStart(2,'0')}:00+00:00`,10+hour/2,3]),
    latitude:41.16754,longitude:-8.52981,url:`https://api.open-meteo.com/v1/forecast?start_date=${weekly.addIsoDays('2026-10-26',index)}`,
    sourceBinding:{userId:1,weekday,date:weekly.addIsoDays('2026-10-26',index),period:index===5?'08_12':'before_08',location:'Fanzeres',availabilityRevision:1},
    limitations:['No authorized independent second hourly source is configured; only Open-Meteo evidence is available.'],
  }));
  const context = buildContext(db,1,{purpose:'workouts',config,taskDate:'2026-10-26',weather});
  assert.deepEqual(context.weather,weather);
  assert.ok(tokenBound(context) <= 12000);
  const adapter = weekly.createWeeklyWorkoutAdapter(db);
  const payload = buildPayload({model:'gpt-6.1-sol',context,prompt:'Synthetic prompt',adapter:{...adapter,adaptPrompt:()=> 'Adapted synthetic prompt'},maxOutputTokens:8192});
  const sent = JSON.parse(payload.input[0].content[0].text).context;
  assert.equal(sent.weather.length,6);
  assert.equal(sent.weather[0].hours.length,8);
  assert.equal(sent.weather[0].sourceBinding,undefined);
  assert.equal(sent.weather[0].url,undefined);
  assert.equal(sent.weather[0].latitude,undefined);
  assert.ok(sent.weatherLimitations.includes(weather[0].limitations[0]));
  assert.ok(sent.sources.every((source) => !Object.hasOwn(source,'version')));
  assert.equal(context.weather[0].sourceBinding.userId,1);
  assert.equal(context.weather[0].url,weather[0].url);
  db.close();
});

function forecastFetcher({
  day = '2026-10-25',
  timezone = 'Europe/Lisbon',
  geocoderTimezone = 'Europe/Lisbon',
  omitHour = null,
  duplicateHour = null,
  outOfOrder = false,
  ambiguous = false,
} = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
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
                  timezone: geocoderTimezone,
                  country: 'Portugal',
                  admin1: 'Porto',
                },
                {
                  name: 'Porto',
                  latitude: 41.2,
                  longitude: -8.7,
                  country_code: 'PT',
                  timezone: geocoderTimezone,
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
                  timezone: geocoderTimezone,
                  country: 'Portugal',
                  admin1: 'Porto',
                },
              ],
        }),
      };
    const times = [];
    const temps = [];
    const codes = [];
    const base = Date.parse(`${day}T00:00:00Z`) - 36 * 3600000;
    const end = base + 96 * 3600000;
    for (let instant = base; instant <= end; instant += 3600000) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(instant))
          .map((part) => [part.type, part.value]),
      );
      const localDate = `${parts.year}-${parts.month}-${parts.day}`;
      const hour = Number(parts.hour);
      if (localDate !== day || hour === omitHour) continue;
      const epoch = instant / 1000;
      times.push(epoch);
      temps.push(hour === 15 ? 38 : hour + 10);
      codes.push(hour === 15 ? 0 : 3);
      if (hour === duplicateHour) {
        times.push(epoch);
        temps.push(hour + 10);
        codes.push(3);
      }
    }
    if (outOfOrder && times.length > 3) {
      [times[1], times[2]] = [times[2], times[1]];
      [temps[1], temps[2]] = [temps[2], temps[1]];
      [codes[1], codes[2]] = [codes[2], codes[1]];
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
  const { durationMinutes = 60, targetHr: _targetHr, rpe: _rpe, ...fields } = overrides;
  const mainMinutes = Math.max(1, durationMinutes - 20);
  const components = fields.prescription || [
    {
      phase: 'warmup',
      repetitions: 1,
      minutes: 10,
      distanceMeters: null,
      paceSecondsPerKm: null,
      recoveryMinutes: null,
    },
    {
      phase: 'main',
      repetitions: 1,
      minutes: mainMinutes,
      distanceMeters: null,
      paceSecondsPerKm: null,
      recoveryMinutes: null,
    },
    {
      phase: 'cooldown',
      repetitions: 1,
      minutes: 10,
      distanceMeters: null,
      paceSecondsPerKm: null,
      recoveryMinutes: null,
    },
  ];
  const prescription = components.map((component) => ({
    instruction: 'Run relaxed with a smooth, controlled form.',
    effort: 'Conversational effort with calm breathing.',
    rpe: null,
    targetHr: '',
    paceTargetSecondsPerKm: null,
    recoveryGuidance:
      component.repetitions > 1 && component.recoveryMinutes !== null
        ? 'Jog easily between repetitions.'
        : null,
    recoveryRpe: null,
    ...component,
  }));
  return {
    date: '2026-10-26',
    weekday: 'monday',
    period: '08_12',
    sessionKind: 'easy',
    prescription,
    shoeId: null,
    location: 'Porto, Portugal',
    weather: 'Open-Meteo verified',
    notes: '',
    justification:
      'A progressão acompanha o plano aplicado e os treinos registados.',
    evidence: ['cycle:cycle'],
    ...fields,
    prescription,
  };
}
function sessionStep(overrides, index = 1) {
  const value = session();
  value.prescription[index] = { ...value.prescription[index], ...overrides };
  return value;
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

test('weekly adapter retains training guidance and replaces context duplication and conflicting delivery sections deterministically', () => {
  for (const language of ['pt-BR', 'en-US']) {
    const source =
      language === 'pt-BR'
        ? 'INTRO\nVERIFICAÇÃO OBRIGATÓRIA DA PREVISÃO DO TEMPO\nRESEARCH\nCONTEXTO ADICIONAL DESTA SEMANA\nMIDDLE\nINSTRUÇÕES PARA MONTAR A SEMANA\nTRAINING GUIDANCE\nFORMATO DA PLANILHA\nEXCEL'
        : 'INTRO\nMANDATORY WEATHER FORECAST VERIFICATION\nRESEARCH\nADDITIONAL CONTEXT FOR THIS WEEK\nMIDDLE\nINSTRUCTIONS FOR PLANNING THE WEEK\nTRAINING GUIDANCE\nSPREADSHEET FORMAT\nEXCEL';
    const first = weekly.adaptPrompt(source, language);
    assert.equal(weekly.adaptPrompt(source, language), first);
    assert.doesNotMatch(first, /INTRO|MIDDLE/);
    assert.match(first, /TRAINING GUIDANCE/);
    assert.match(first, /structured|estruturada/i);
    assert.match(first, /effort\/breathing|esforço\/respiração/i);
    assert.match(first, /paceSecondsPerKm/);
    assert.match(first, /paceTargetSecondsPerKm/);
    assert.match(first, /weekly-workouts-v3/);
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
  const componentKeys = weekly.schema.properties.sessions.items.properties
    .prescription.items.required;
  for (const key of [
    'instruction',
    'effort',
    'rpe',
    'targetHr',
    'paceTargetSecondsPerKm',
    'recoveryGuidance',
    'recoveryRpe',
  ])
    assert.ok(componentKeys.includes(key), `${key} is part of the component contract`);
  assert.equal(
    weekly.schema.properties.sessions.items.properties.rpe,
    undefined,
    'session RPE is derived only when component targets are uniform',
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
    weekly.validateWeeklyProposal(proposal([sessionStep({ rpe: 6 })]), context)
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
      proposal([sessionStep({ targetHr: 'easy' })]),
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
      proposal([sessionStep({ instruction: 'RPE 8/10' })]),
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
    weekly.validateWeeklyProposal(proposal([sessionStep({ rpe: 1.5 })]), context)
      .code,
    'shape',
  );
});

test('weekly identity treats only null and empty details as the same imported value', () => {
  assert.equal(
    trainingSignature({ dia: '2026-10-26', treino: 'Run', detalhes: null }),
    trainingSignature({ dia: '2026-10-26', treino: 'Run', detalhes: '' }),
  );
  assert.notEqual(
    trainingSignature({ dia: '2026-10-26', treino: 'Run', detalhes: ' ' }),
    trainingSignature({ dia: '2026-10-26', treino: 'Run', detalhes: null }),
  );
});

test('existing NULL and empty details share a dedup signature without rewriting completed results', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash) VALUES(1,'canonical@example.invalid','synthetic')",
  ).run();
  db.prepare(`INSERT INTO trainings
    (id,user_id,dia,tipo,treino,detalhes,completed,feedback_rpe,result_data_source)
    VALUES (1,1,'2026-10-26','Run','Easy run',NULL,1,3,'manual'),
           (2,1,'2026-10-26','Run','Easy run','',1,4,'fit_upload')`).run();
  const rows = db
    .prepare('SELECT dia,treino,detalhes,completed,feedback_rpe,result_data_source FROM trainings ORDER BY id')
    .all();
  assert.equal(new Set(rows.map(trainingSignature)).size, 1);
  assert.equal(rows[0].detalhes, null);
  assert.equal(rows[1].detalhes, '');
  assert.deepEqual(
    rows.map((row) => [row.completed, row.feedback_rpe, row.result_data_source]),
    [
      [1, 3, 'manual'],
      [1, 4, 'fit_upload'],
    ],
  );
  db.close();
});

test('weekly duration is derived from structured components and rejects a second free-text total', () => {
  const valid = proposal([session({ durationMinutes: 30 })]);
  assert.equal(weekly.validateWeeklyProposal(valid, validationContext()), null);
  assert.equal(weekly.materializePrescription(valid.sessions[0]).value.durationMinutes, 30);
  const inconsistent = {
    ...valid,
    sessions: [
      { ...valid.sessions[0], durationMinutes: 30, details: 'Main set lasts 60 minutes.' },
    ],
  };
  assert.equal(
    weekly.validateWeeklyProposal(inconsistent, validationContext())?.code,
    'shape',
  );
});

test('weekly prescription counts repeated work, between-repeat recovery and distance estimates', () => {
  const value = session({
    prescription: [
      { phase: 'warmup', repetitions: 1, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'main', repetitions: 4, minutes: null, distanceMeters: 400, paceSecondsPerKm: 300, recoveryMinutes: 3 },
      { phase: 'cooldown', repetitions: 1, minutes: 5, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    ],
  });
  const materialized = weekly.materializePrescription(value, 'en-US');
  assert.equal(materialized.value.durationMinutes, 32);
  assert.equal(materialized.value.durationEstimated, true);
  assert.match(materialized.value.details, /4 × 400 m \(estimated 2 min per repetition/);
  assert.match(materialized.value.details, /this is not a target/);
  assert.match(materialized.value.details, /3 min; Jog easily between repetitions/);
  const noRecoveryBetweenFinalRep = {
    ...value,
    prescription: value.prescription.map((step) =>
      step.phase === 'main' ? { ...step, recoveryMinutes: null } : step,
    ),
  };
  assert.equal(
    weekly.materializePrescription(noRecoveryBetweenFinalRep).error,
    'prescription_recovery',
  );
  const contradictoryUnits = {
    ...value,
    prescription: value.prescription.map((step) =>
      step.phase === 'main' ? { ...step, minutes: 10 } : step,
    ),
  };
  assert.equal(weekly.materializePrescription(contradictoryUnits).error, 'prescription_units');
});

test('weekly prescription localizes Portuguese labels and rejects invalid structured durations', () => {
  const distance = session({
    prescription: [
      { phase: 'warmup', repetitions: 1, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'main', repetitions: 4, minutes: null, distanceMeters: 400, paceSecondsPerKm: 300, recoveryMinutes: 3 },
      { phase: 'cooldown', repetitions: 1, minutes: 5, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    ],
  });
  distance.prescription = distance.prescription.map((step) => ({
    ...step,
    instruction:
      step.phase === 'warmup'
        ? 'Comece em trote leve e confortável.'
        : step.phase === 'cooldown'
          ? 'Reduza o ritmo gradualmente.'
          : 'Corra cada repetição com técnica estável.',
    effort:
      step.phase === 'main'
        ? 'Forte e controlado, com respiração ritmada.'
        : 'Leve, mantendo respiração confortável.',
    recoveryGuidance:
      step.phase === 'main'
        ? 'Trote muito leve até recuperar a respiração.'
        : null,
    targetHr: step.phase === 'main' ? '150-160 bpm' : '',
    paceTargetSecondsPerKm: step.phase === 'main' ? 300 : null,
  }));
  const portuguese = weekly.materializePrescription(distance, 'pt-BR');
  assert.match(portuguese.value.workout, /Corrida/);
  assert.match(portuguese.value.details, /Principal: 4 × 400 m/);
  assert.match(portuguese.value.details, /Recuperação entre repetições: 3 min/);
  assert.match(portuguese.value.details, /Duração estimada/);
  assert.match(portuguese.value.details, /estimativa de 2 min por repetição/);
  assert.match(portuguese.value.details, /ritmo não é meta/);
  assert.match(portuguese.value.details, /FC alvo: 150-160 bpm/);
  assert.match(portuguese.value.details, /ritmo-alvo 5:00 min\/km/);
  assert.doesNotMatch(portuguese.value.details, /min each at|recovery between repeats|Execution:|Effort:/);
  assert.match(portuguese.value.details, /respiração ritmada/);
  assert.match(portuguese.value.details, /Trote muito leve/);
  assert.match(
    weekly.materializePrescription(session(), 'pt-BR').value.details,
    /Duração calculada/,
  );
  assert.equal(
    weekly.materializePrescription({ ...distance, sessionKind: 'unknown' }).error,
    'session_kind',
  );

  const invalidSteps = [
    { phase: 'warmup', repetitions: 2, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    { phase: 'main', repetitions: 31, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    { phase: 'warmup', repetitions: 1, minutes: 721, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    { phase: 'main', repetitions: 1, minutes: null, distanceMeters: 100001, paceSecondsPerKm: 300, recoveryMinutes: null },
    { phase: 'main', repetitions: 2, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: 31 },
  ];
  for (const step of invalidSteps) {
    const steps = [
      { phase: 'warmup', repetitions: 1, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'main', repetitions: 1, minutes: 10, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'cooldown', repetitions: 1, minutes: 5, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    ];
    steps[step.phase === 'warmup' ? 0 : 1] = step;
    const result = weekly.materializePrescription(
      session({ ...distance, prescription: steps }),
    );
    assert.ok(result.error, JSON.stringify(step));
  }
  const tooLong = {
    ...distance,
    prescription: [
      { phase: 'warmup', repetitions: 1, minutes: 241, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'main', repetitions: 1, minutes: 241, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'cooldown', repetitions: 1, minutes: 241, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    ],
  };
  assert.equal(
    weekly.materializePrescription(session(tooLong)).error,
    'prescription_value',
  );
  assert.equal(
    weekly.materializePrescription(
      session({
        prescription: distance.prescription.map((step) =>
          step.phase === 'warmup' ? { ...step, instruction: '' } : step,
        ),
      }),
    ).error,
    'prescription_guidance',
  );
  assert.equal(
    weekly.materializePrescription(
      session({
        prescription: distance.prescription.map((step) =>
          step.phase === 'main'
            ? { ...step, paceTargetSecondsPerKm: 1 }
            : step,
        ),
      }),
    ).error,
    'prescription_pace_target',
  );
  assert.equal(
    weekly.materializePrescription(
      session({
        prescription: distance.prescription.map((step) =>
          step.phase === 'warmup'
            ? { ...step, recoveryGuidance: 'Rest' }
            : step,
        ),
      }),
    ).error,
    'prescription_recovery',
  );
});

test('weekly interval, progression and fartlek keep stage-specific execution and recovery guidance', () => {
  const part = (phase, minutes, overrides = {}) => ({
    phase,
    repetitions: 1,
    minutes,
    distanceMeters: null,
    paceSecondsPerKm: null,
    recoveryMinutes: null,
    ...overrides,
  });
  const interval = session({
    sessionKind: 'intervals',
    prescription: [
      part('warmup', 8, {
        instruction: 'Start with easy jogging and dynamic mobility.',
        effort: 'Easy breathing, RPE 2.',
        rpe: 2,
      }),
      part('main', 3, {
        repetitions: 6,
        recoveryMinutes: 2,
        recoveryGuidance: 'Jog gently until breathing is controlled.',
        recoveryRpe: 2,
        instruction: 'Run each repetition strongly with relaxed form.',
        effort: 'Hard but controlled, breathing deep; RPE 4.',
        rpe: 4,
      }),
      part('cooldown', 5, {
        instruction: 'Ease down and finish with relaxed jogging.',
        effort: 'Very easy breathing.',
        rpe: 1,
      }),
    ],
  });
  const intervalResult = weekly.materializePrescription(interval).value;
  assert.equal(intervalResult.durationMinutes, 41);
  assert.equal(intervalResult.rpe, null);
  assert.equal(intervalResult.targetHr, '');
  assert.match(intervalResult.details, /6 × 3 min/);
  assert.match(intervalResult.details, /RPE 4\/5/);
  assert.match(intervalResult.details, /2 min; Jog gently until breathing is controlled/);
  assert.match(intervalResult.details, /RPE 2\/5/);
  assert.match(intervalResult.details, /Start with easy jogging/);
  assert.match(intervalResult.details, /Ease down and finish/);

  const progression = session({
    sessionKind: 'progression',
    targetHr: '',
    rpe: null,
    prescription: [
      part('warmup', 10, { instruction: 'Warm up with easy running.', effort: 'Conversational breathing.' }),
      part('main', 8, { instruction: 'Settle into the first block.', effort: 'Easy aerobic effort.', rpe: 2 }),
      part('main', 8, { instruction: 'Increase effort smoothly.', effort: 'Steady effort; breathing becomes purposeful.', rpe: 3 }),
      part('main', 8, { instruction: 'Finish the final block strong and controlled.', effort: 'Comfortably hard; keep form relaxed.', rpe: 4 }),
      part('cooldown', 5, { instruction: 'Jog easily to cool down.', effort: 'Easy breathing.' }),
    ],
  });
  assert.equal(weekly.validateWeeklyProposal(proposal([progression]), validationContext()), null);
  const progressionDetails = weekly.materializePrescription(progression).value.details;
  assert.match(progressionDetails, /Settle into the first block/);
  assert.match(progressionDetails, /Increase effort smoothly/);
  assert.match(progressionDetails, /Finish the final block strong and controlled/);
  assert.doesNotMatch(progressionDetails, /Target HR|target pace/);

  const fartlek = session({
    sessionKind: 'fartlek',
    prescription: [
      part('warmup', 8, { instruction: 'Start easy.', effort: 'Conversational breathing.' }),
      part('main', 2, { repetitions: 5, recoveryMinutes: 2, recoveryGuidance: 'Float easily until breathing settles.', instruction: 'Alternate a playful strong surge with an easy float.', effort: 'Surges are controlled, never sprinting.', rpe: 4, recoveryRpe: 2 }),
      part('cooldown', 5, { instruction: 'Finish with easy jogging.', effort: 'Relaxed breathing.' }),
    ],
  });
  const fartlekDetails = weekly.materializePrescription(fartlek).value.details;
  assert.match(fartlekDetails, /Alternate a playful strong surge/);
  assert.match(fartlekDetails, /Float easily until breathing settles/);
  assert.equal(weekly.materializePrescription(fartlek).value.durationMinutes, 31);
});

test('weekly component RPE stays on 1–5 and distance estimate never becomes a pace target', () => {
  const distance = session({
    prescription: [
      { phase: 'warmup', repetitions: 1, minutes: 5, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
      { phase: 'main', repetitions: 1, minutes: null, distanceMeters: 1000, paceSecondsPerKm: 360, recoveryMinutes: null },
      { phase: 'cooldown', repetitions: 1, minutes: 5, distanceMeters: null, paceSecondsPerKm: null, recoveryMinutes: null },
    ],
  });
  const estimate = weekly.materializePrescription(distance).value.details;
  assert.match(estimate, /estimate.*6 min per repetition/);
  assert.match(estimate, /this is not a target/);
  assert.doesNotMatch(estimate, /target pace/);
  const withTarget = session({
    ...distance,
    prescription: distance.prescription.map((step) =>
      step.phase === 'main'
        ? { ...step, paceTargetSecondsPerKm: 330 }
        : step,
    ),
  });
  assert.match(
    weekly.materializePrescription(withTarget).value.details,
    /target pace 5:30 min\/km/,
  );
  const uniform = session();
  uniform.prescription = uniform.prescription.map((step) => ({
    ...step,
    rpe: 3,
    targetHr: '120-140 bpm',
  }));
  const summary = weekly.materializePrescription(uniform).value;
  assert.equal(summary.rpe, 3);
  assert.equal(summary.targetHr, '120-140 bpm');
  const context = validationContext();
  for (const invalidStep of [
    { ...distance.prescription[0], instruction: 'RPE 8/10 in the warmup.' },
    {
      ...distance.prescription[1],
      repetitions: 2,
      recoveryMinutes: 2,
      recoveryGuidance: 'Recover at RPE 8/10.',
    },
    { ...distance.prescription[1], rpe: 6 },
  ]) {
    const steps = distance.prescription.map((step) => ({ ...step }));
    steps[steps.findIndex((step) => step.phase === invalidStep.phase)] = invalidStep;
    assert.notEqual(
      weekly.validateWeeklyProposal(
        proposal([session({ ...distance, prescription: steps })]),
        context,
      ),
      null,
    );
  }
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
    [proposal([session({ sessionKind: 'unknown' })]), base, 'session_kind'],
    [proposal([session({ sessionKind: '' })]), base, 'session_kind'],
    [proposal([session({ justification: '' })]), base, 'required'],
    [proposal([sessionStep({ targetHr: '1'.repeat(81) })]), base, 'text_length'],
    [proposal([session({ weather: 'w'.repeat(1001) })]), base, 'text_length'],
    [proposal([session({ notes: 'n'.repeat(2001) })]), base, 'text_length'],
    [
      proposal([session({ justification: 'j'.repeat(2001) })]),
      base,
      'text_length',
    ],
    [proposal([sessionStep({ targetHr: 'easy' })]), base, 'unit'],
    [proposal([session({ type: 'RPE 8/10' })]), base, 'shape'],
    [proposal([session({ details: 'RPE 8/10' })]), base, 'shape'],
    [proposal([sessionStep({ instruction: 'RPE 8/10' })]), base, 'incompatible_rpe'],
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
    assert.equal(
      weekly.validateWeeklyProposal(value, context)?.code,
      code,
      `expected ${code} for ${JSON.stringify(value.sessions?.[0])}`,
    );
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
    adapter.diagnose(proposal([sessionStep({ rpe: 6 })]), base).code,
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
  const unchangedEvidence = { status: 'unavailable' };
  assert.equal(
    weekly.compactWeatherEvidence(unchangedEvidence),
    unchangedEvidence,
  );
  assert.deepEqual(evidence, [
    {
      status: 'unavailable',
      reason: 'availability_needs_review',
      weekday: 'monday',
      date: '2026-10-26',
      period: null,
      location: 'Porto',
      sourceBinding: {
        userId: 1,
        weekday: 'monday',
        date: '2026-10-26',
        period: null,
        location: 'Porto',
        availabilityRevision: 1,
      },
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
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,'read-week-key','workouts','x','v','prompt',?,'{}',?,'completed',1,0,?,?)`,
  ).run(
    id,
    JSON.stringify(savedContext),
    JSON.stringify({ adapterVersion: weekly.VERSION }),
    timestamp,
    timestamp,
  );
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
  db.prepare('UPDATE ai_executions SET configuration_json=? WHERE id=?').run(
    JSON.stringify({ adapterVersion: 'weekly-workouts-v1' }),
    id,
  );
  assert.throws(
    () => weekly.readWeeklyProposal(db, 1, id, fullService),
    (error) =>
      error instanceof AiError && error.code === 'weeklySchemaIncompatible',
  );
  assert.throws(
    () => weekly.readWeeklyProposal(db, 2, id, emptyService),
    (error) => error instanceof AiError && error.code === 'proposalNotFound',
  );
  db.prepare('UPDATE ai_executions SET configuration_json=? WHERE id=?').run(
    JSON.stringify({ adapterVersion: weekly.VERSION }),
    id,
  );
  assert.throws(
    () =>
      weekly.readWeeklyProposal(db, 1, id, {
        get: () => ({
          id,
          purpose: 'workouts',
          response: proposal([session({ prescription: [] })]),
        }),
      }),
    (error) =>
      error instanceof AiError && error.code === 'weeklyProposalInvalid',
  );
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM ai_executions WHERE id=?').run(id);
  assert.throws(
    () => weekly.readWeeklyProposal(db, 1, id, emptyService),
    (error) => error instanceof AiError && error.code === 'proposalNotFound',
  );
  db.close();
});

test('weekly weather collector uses its default clock only after a valid availability snapshot', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash,role,preferred_lang) VALUES(1,'weather-clock@example.invalid','synthetic','user','en-US')",
  ).run();
  db.prepare(
    `INSERT INTO ai_coach_availability
      (user_id,day_key,can_train,available_periods,available_minutes,location)
      VALUES(1,'monday',1,'[\"08_12\"]',120,'Porto, Portugal')`,
  ).run();
  const evidence = await weekly.collectWeeklyWeather(
    db,
    1,
    '2026-10-26',
    forecastFetcher({ day: '2026-10-26' }),
  );
  assert.equal(evidence[0].status, 'verified');
  assert.ok(Number.isFinite(Date.parse(evidence[0].lookedUpAt)));
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
  assert.equal(
    result.hours.filter((hour) => hour.localTime.startsWith('2026-10-25T01:00'))
      .length,
    2,
    'two distinct UTC instants preserve the legitimate autumn repeated hour',
  );
  const spring = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-03-29',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ day: '2026-03-29' }),
    new Date('2026-03-28T12:00:00Z'),
  );
  assert.equal(spring.status, 'verified');
  assert.deepEqual(spring.coverage, { verifiedHours: 7, expectedHours: 7 });
  assert.equal(result.window.maxC, 17);
  assert.ok(result.window.maxC < 38);
  assert.equal(
    result.hours.some((hour) => hour.localTime.includes('T08:00')),
    false,
  );
  assert.equal(weekly.weatherValue(result, 'F', 'pt-BR').includes('°F'), true);
  const utc = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-26',
    { weekday: 'monday', period: '08_12' },
    forecastFetcher({
      day: '2026-10-26',
      timezone: 'UTC',
      geocoderTimezone: 'UTC',
    }),
    new Date('2026-10-25T12:00:00Z'),
  );
  assert.equal(utc.status, 'verified');
  assert.ok(utc.hours.every((hour) => hour.localTime.endsWith('Z')));
  assert.throws(
    () => weekly.expectedWindowInstants('2026-10-26', 12, 8, 'Europe/Lisbon'),
    /Unresolvable hourly window/,
  );
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
  const missingHourlyValue = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    async (url) => {
      const result = await forecastFetcher()(url);
      if (url.includes('geocoding-api')) return result;
      const payload = await result.json();
      payload.hourly.weather_code[0] = null;
      return { ok: true, json: async () => payload };
    },
    now,
  );
  assert.equal(missingHourlyValue.status, 'partial');
  assert.equal(missingHourlyValue.coverage.verifiedHours, 8);
  const duplicateReplacesMissing = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ omitHour: 6, duplicateHour: 5 }),
    now,
  );
  assert.notEqual(
    duplicateReplacesMissing.status,
    'verified',
    'a repeated timestamp cannot compensate for a missing hour',
  );
  const unordered = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-26',
    { weekday: 'monday', period: '08_12' },
    forecastFetcher({ day: '2026-10-26', outOfOrder: true }),
    now,
  );
  assert.equal(unordered.reason, 'hourly_timestamps_invalid');
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
    async (url) => {
      const response = await forecastFetcher()(url);
      if (url.includes('geocoding-api')) return response;
      const result = await response.json();
      result.timezone = 'Mars/Phobos';
      return { ok: true, json: async () => result };
    },
    now,
  );
  assert.equal(timezone.reason, 'invalid_timezone');
  const mismatchedTimezone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ timezone: 'Asia/Tokyo' }),
    now,
  );
  assert.equal(mismatchedTimezone.status, 'unavailable');
  assert.equal(mismatchedTimezone.reason, 'timezone_mismatch');
  assert.equal(mismatchedTimezone.resolvedTimezone, 'Europe/Lisbon');
  assert.equal(mismatchedTimezone.timezone, 'Asia/Tokyo');
  const sameOffsetDifferentZone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    forecastFetcher({ timezone: 'Europe/London' }),
    now,
  );
  assert.equal(sameOffsetDifferentZone.reason, 'timezone_mismatch');
  const aliasZone = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-26',
    { weekday: 'monday', period: '08_12' },
    forecastFetcher({
      day: '2026-10-26',
      timezone: 'Europe/London',
      geocoderTimezone: 'Europe/Belfast',
    }),
    now,
  );
  assert.equal(aliasZone.status, 'verified');
  assert.equal(aliasZone.resolvedTimezone, 'Europe/London');
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
              hourly: { time: [], temperature_2m: [], weather_code: [] },
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
  assert.equal(timezoneDrift.reason, 'timezone_mismatch');
  const unavailable = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'before_08' },
    async (url) => {
      if (url.includes('geocoding-api')) return forecastFetcher()(url);
      throw Error('network');
    },
    now,
  );
  assert.equal(unavailable.reason, 'forecast_connection_error');
  assert.deepEqual(unavailable.failure, { stage: 'forecast_transport', reason: 'forecast_connection_error' });
  assert.equal(unavailable.resolvedTimezone, 'Europe/Lisbon');
  assert.match(unavailable.url, /timezone=Europe%2FLisbon/);
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
  assert.equal(missingGeocoderTimezone.reason, 'resolved_timezone_missing');
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
  assert.equal(refuse.reason, 'forecast_http_error');
  assert.equal(refuse.failure.httpStatus, undefined); // this fixture has no HTTP response
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
    '2026-10-26',
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
                  (_, hour) =>
                    Date.parse(`2026-10-26T${String(hour).padStart(2, '0')}:00:00Z`) /
                    1000,
                ),
                temperature_2m: Array(24).fill(14),
              },
            }),
          },
    now,
  );
  assert.equal(noWeatherCodes.status, 'unavailable');
  assert.equal(noWeatherCodes.reason, 'timezone_or_hourly_data_missing');
  const misaligned = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-26',
    { weekday: 'monday', period: '08_12' },
    async (url) => {
      const result = await forecastFetcher({ day: '2026-10-26' })(url);
      if (url.includes('geocoding-api')) return result;
      const payload = await result.json();
      payload.hourly.weather_code.pop();
      return { ok: true, json: async () => payload };
    },
    now,
  );
  assert.equal(misaligned.reason, 'hourly_values_misaligned');
  const evening = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'after_18' },
    forecastFetcher(),
    now,
  );
  assert.equal(evening.coverage.expectedHours, 6);
  assert.equal(
    weekly.hoursInLocalWindow('2026-10-25', 18, 24, 'Europe/Lisbon'),
    6,
  );
  assert.equal(
    weekly.hoursInLocalWindow('2026-10-26', 8, 12, 'Europe/Lisbon'),
    4,
  );
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

test('Open-Meteo invalid request, HTTP, JSON and transport failures remain distinguishable', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const run = (forecast) =>
    weekly.readHourlyForecast(
      'Porto, Portugal',
      '2026-10-25',
      { weekday: 'sunday', period: '08_12' },
      async (url) => {
        if (url.includes('geocoding-api')) return forecastFetcher()(url);
        return typeof forecast === 'function' ? forecast(url) : forecast;
      },
      now,
    );
  const badRequest = await run({
    ok: false,
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: true }),
  });
  assert.equal(badRequest.reason, 'forecast_invalid_request');
  assert.deepEqual(badRequest.failure, {
    stage: 'forecast_http',
    reason: 'forecast_invalid_request',
    httpStatus: 400,
    contentType: 'json',
  });
  const serverError = await run({
    ok: false,
    status: 503,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => ({}),
  });
  assert.equal(serverError.reason, 'forecast_http_server_error');
  assert.equal(serverError.failure.contentType, 'text');
  const rateLimited = await run({
    ok: false,
    status: 429,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    json: async () => ({}),
  });
  assert.equal(rateLimited.reason, 'forecast_rate_limited');
  assert.equal(rateLimited.failure.contentType, 'other');
  const genericHttp = await run({
    ok: false,
    status: 404,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    json: async () => ({}),
  });
  assert.equal(genericHttp.reason, 'forecast_http_error');
  const malformed = await run({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      throw Error('private provider body');
    },
  });
  assert.equal(malformed.reason, 'forecast_invalid_json');
  assert.equal(malformed.failure.stage, 'forecast_json');
  const malformedWithoutStatus = await run({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      throw Error('private provider body');
    },
  });
  assert.equal(malformedWithoutStatus.reason, 'forecast_invalid_json');
  assert.equal(Object.hasOwn(malformedWithoutStatus.failure, 'httpStatus'), false);
  const transport = await run(async () => {
    const error = Error('private');
    error.cause = { code: 'ENOTFOUND' };
    throw error;
  });
  assert.equal(transport.reason, 'forecast_dns_error');
  assert.equal(transport.failure.stage, 'forecast_transport');
  const tls = await run(async () => {
    const error = Error('private');
    error.code = 'CERT_HAS_EXPIRED';
    throw error;
  });
  assert.equal(tls.reason, 'forecast_tls_error');
  const timeout = await run(async () => {
    const error = Error('private');
    error.name = 'TimeoutError';
    throw error;
  });
  assert.equal(timeout.reason, 'forecast_timeout');
  const abort = await run(async () => {
    const error = Error('private');
    error.name = 'AbortError';
    throw error;
  });
  assert.equal(abort.reason, 'forecast_timeout');
  const validation = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: 'invalid' },
    forecastFetcher(),
    now,
  );
  assert.equal(validation.reason, 'forecast_validation_error');
  assert.deepEqual(validation.failure, {
    stage: 'forecast_validation',
    reason: 'forecast_validation_error',
  });
  const geocodingValidation = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-25',
    { weekday: 'sunday', period: '08_12' },
    async (url) =>
      url.includes('geocoding-api')
        ? {
            ok: true,
            json: async () => ({
              results: new Proxy([], {
                get(target, key, receiver) {
                  if (key === 'filter')
                    throw Error('private invalid provider value');
                  return Reflect.get(target, key, receiver);
                },
              }),
            }),
          }
        : forecastFetcher()(url),
    now,
  );
  assert.equal(geocodingValidation.reason, 'geocoding_invalid_response');
  assert.deepEqual(geocodingValidation.failure, {
    stage: 'geocoding_validation',
    reason: 'geocoding_invalid_response',
  });
  assert.doesNotMatch(
    JSON.stringify([
      badRequest,
      serverError,
      rateLimited,
      genericHttp,
      malformed,
      malformedWithoutStatus,
      transport,
      tls,
      timeout,
      abort,
    ]),
    /private provider body|private/,
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
  assert.equal(url.searchParams.has('forecast_days'), false);
  assert.equal(url.searchParams.get('start_date'), '2026-10-26');
  assert.equal(url.searchParams.get('end_date'), '2026-10-26');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(
    new URL(weekly.hourlyUrl(41.1, -8.6, '2026-10-26', 'Europe/Lisbon'))
      .searchParams.get('timezone'),
    'Europe/Lisbon',
  );
  assert.equal(DAY_KEYS.length, 7);
  assert.equal(hash({ a: 1 }).length, 64);
});

test('weekly forecast accepts the first and sixteenth local dates, then refuses day seventeen', async () => {
  const now = new Date('2026-10-24T12:00:00.000Z');
  const first = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-10-24',
    { weekday: 'saturday', period: '08_12' },
    forecastFetcher({ day: '2026-10-24' }),
    now,
  );
  assert.equal(first.status, 'verified');
  const sixteenth = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-11-08',
    { weekday: 'sunday', period: '08_12' },
    forecastFetcher({ day: '2026-11-08' }),
    now,
  );
  assert.equal(sixteenth.status, 'verified');
  const seventeenth = await weekly.readHourlyForecast(
    'Porto, Portugal',
    '2026-11-09',
    { weekday: 'monday', period: '08_12' },
    forecastFetcher({ day: '2026-11-09' }),
    now,
  );
  assert.equal(seventeenth.reason, 'outside_forecast_horizon');
  assert.equal(seventeenth.lookupAttempted, false);
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
    sessionKind: 'progression',
  });
  const third = session({
    sessionKind: 'long',
    targetHr: '',
    rpe: null,
    shoeId: 'active-shoe',
    notes: '',
    prescription: session().prescription.map((step) => ({ ...step, rpe: 3 })),
  });
  const firstMaterialized = weekly.materializePrescription(first).value;
  const secondMaterialized = weekly.materializePrescription(second).value;
  const result = proposal([first, second, second, third]);
  db.prepare(
    "INSERT INTO shoes(id,user_id,brand,model) VALUES('active-shoe',1,'Sample','Daily')",
  ).run();
  db.prepare(
    "INSERT INTO trainings(id,user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,completed,feedback_rpe,result_data_source) VALUES(1,1,'cycle',?,?,?,?,?,1,3,'manual')",
  ).run(
    first.date,
    first.period,
    firstMaterialized.type,
    firstMaterialized.workout,
    firstMaterialized.details,
  );
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
    `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES(?,1,'week-idempotency','workouts','x','v','prompt',?,'{}',?,'completed',1,0,?,?)`,
  ).run(
    id,
    JSON.stringify(context),
    JSON.stringify({ adapterVersion: weekly.VERSION }),
    timestamp,
    timestamp,
  );
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
  const invalidProposal = proposal([
    { ...session(), prescription: [{ phase: 'main', repetitions: 1 }] },
  ]);
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
  const configJson = db
    .prepare('SELECT configuration_json FROM ai_executions WHERE id=?')
    .get(id).configuration_json;
  db.prepare('UPDATE ai_executions SET configuration_json=? WHERE id=?').run(
    JSON.stringify({ adapterVersion: 'weekly-workouts-v2' }),
    id,
  );
  expectCode(
    { expected_response_hash: hash(result) },
    service,
    'weeklySchemaIncompatible',
  );
  db.prepare('UPDATE ai_executions SET configuration_json=? WHERE id=?').run(
    configJson,
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
    { added: 2, ignored: 2, alreadyApplied: false },
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
  assert.equal(applied.proposal.sessions[3].shoeLabel, 'Sample Daily');
  assert.equal(
    db.prepare("SELECT detalhes FROM trainings WHERE treino='Progression run'").get()
      .detalhes,
    secondMaterialized.details,
    'application persists the exact materialized component text exposed by review',
  );
  assert.equal(
    db
      .prepare(
        "SELECT tenis,detalhes,fc_alvo,rpe,observacoes,location,previsao FROM trainings WHERE treino='Long run'",
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
  let holdForecast = false;
  let markForecastRequested;
  let releaseForecast;
  const forecastRequested = new Promise((resolve) => {
    markForecastRequested = resolve;
  });
  const forecastGate = new Promise((resolve) => {
    releaseForecast = resolve;
  });
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
      if (holdForecast) {
        markForecastRequested();
        await forecastGate;
      }
      const day = parsed.searchParams.get('start_date');
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Lisbon',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      });
      const times = [],
        temperatures = [],
        codes = [];
      const from = Date.parse(`${day}T00:00:00Z`) - 36 * 3600000;
      for (let instant = from; instant <= from + 96 * 3600000; instant += 3600000) {
        const parts = Object.fromEntries(
          formatter
            .formatToParts(new Date(instant))
            .map((part) => [part.type, part.value]),
        );
        if (`${parts.year}-${parts.month}-${parts.day}` !== day) continue;
        times.push(instant / 1000);
        temperatures.push(10 + Number(parts.hour));
        codes.push(2);
      }
      return {
        ok: true,
        json: async () => ({
          timezone: 'Europe/Lisbon',
          hourly: {
            time: times,
            temperature_2m: temperatures,
            weather_code: codes,
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
  const sentContext = JSON.parse(
    calls[0].input[0].content[0].text,
  ).context;
  assert.equal(sentContext.weather[0].sourceBinding, undefined);
  assert.equal(sentContext.weather[0].url, undefined);
  assert.ok(sentContext.weather[0].hours.length > 0);
  const storedContext = JSON.parse(
    db.prepare('SELECT context_json FROM ai_executions WHERE id=?').get(executionId).context_json,
  );
  assert.deepEqual(storedContext.weather[0].sourceBinding, {
    userId: owner,
    weekday: 'monday',
    date: '2026-10-26',
    period: '08_12',
    location: 'Porto, Portugal',
    availabilityRevision: 1,
  });
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
  const savedAvailability = (await app.inject({
    method: 'GET',
    url: '/api/ai-coach/availability',
    headers: { cookie },
  })).json().availability.days;
  const saveAvailability = (days) =>
    app.inject({
      method: 'PUT',
      url: '/api/ai-coach/availability',
      headers: { cookie },
      payload: { days },
    });
  holdForecast = true;
  const racingRequest = request('weekly-race-location-001');
  await forecastRequested;
  const changedLocation = savedAvailability.map((day) =>
    day.day === 'monday' ? { ...day, location: 'Lisbon, Portugal' } : day,
  );
  assert.equal((await saveAvailability(changedLocation)).statusCode, 200);
  assert.equal((await saveAvailability(savedAvailability)).statusCode, 200);
  holdForecast = false;
  releaseForecast();
  const racedResponse = await racingRequest;
  assert.equal(racedResponse.statusCode, 409, racedResponse.body);
  assert.ok(
    ['availabilityChanged', 'weeklyAvailabilityConflict'].includes(
      racedResponse.json().errors[0],
    ),
  );
  assert.equal(calls.length, 1, 'changed weather inputs never dispatch AI');
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM ai_executions WHERE user_id=? AND idempotency_key='weekly-race-location-001'",
      )
      .get(owner).n,
    0,
  );
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

test('weekly forecast revalidates an owner deactivated or deleted while weather is pending', async () => {
  for (const state of ['deactivate', 'delete']) {
    const db = createDatabase({ filename: ':memory:' });
    let signalForecast;
    let releaseForecast;
    const forecastStarted = new Promise((resolve) => {
      signalForecast = resolve;
    });
    const forecastGate = new Promise((resolve) => {
      releaseForecast = resolve;
    });
    let providerCalls = 0;
    const fetcher = forecastFetcher({ day: '2026-10-26' });
    const app = await buildServer({
      db,
      sessionCookieSecure: false,
      aiConfig: readAiConfig({
        AI_ENABLED: 'true',
        OPENAI_API_KEY: 'synthetic-test-key',
        AI_RETRIES: '0',
      }),
      weatherFetch: async (url) => {
        if (url.includes('geocoding-api')) return fetcher(url);
        signalForecast();
        await forecastGate;
        return fetcher(url);
      },
      aiClient: async () => {
        providerCalls++;
        return { error: null, usage: { input: 1, output: 1 }, value: {} };
      },
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `pending-${state}@example.invalid`,
          password: 'weekly-secret-123',
          first_name: 'Weekly',
          last_name: 'Runner',
        },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: `pending-${state}@example.invalid`,
          password: 'weekly-secret-123',
        },
      });
      const cookie = [].concat(login.headers['set-cookie'] || [])[0].split(';')[0];
      const userId = db.prepare('SELECT id FROM users').get().id;
      db.prepare(
        "INSERT INTO training_cycles(id,user_id,objective,status) VALUES('pending-cycle',?,'Base','active')",
      ).run(userId);
      for (const day of DAY_KEYS) {
        const monday = day === 'monday';
        db.prepare(`INSERT INTO ai_coach_availability
          (user_id,day_key,can_train,available_periods,available_minutes,location)
          VALUES(?,?,?,?,?,?)`).run(
          userId,
          day,
          monday ? 1 : 0,
          JSON.stringify(monday ? ['08_12'] : []),
          monday ? 60 : null,
          monday ? 'Porto, Portugal' : '',
        );
      }
      const pending = app.inject({
        method: 'POST',
        url: '/api/ai/executions',
        headers: { cookie },
        payload: {
          purpose: 'workouts',
          target_date: '2026-10-26',
          idempotency_key: `pending-${state}-forecast`,
        },
      });
      await forecastStarted;
      if (state === 'deactivate') {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
      } else {
        db.prepare('DELETE FROM users WHERE id=?').run(userId);
      }
      releaseForecast();
      const response = await pending;
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.json().errors[0], 'accountUnavailable');
      assert.equal(providerCalls, 0);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM ai_executions').get().n,
        0,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 0);
    } finally {
      releaseForecast();
      await app.close();
      db.close();
    }
  }
});
