'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const displayPromise = import('../src/public/shared/weekly-prescription-display.js');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

test('weekly prescription summary retains stage-specific and recovery RPE without averaging', async () => {
  const { summarizePrescription } = await displayPromise;
  const details = [
    'Aquecimento: 5 min',
    'Execução: Solte o corpo.',
    'Esforço: Muito leve; RPE 1/5',
    'Principal: 4 × 3 min',
    'Execução: Aumente progressivamente.',
    'Esforço: Forte controlado; RPE 3/5',
    'Recuperação entre repetições: 2 min; Trote leve; RPE 2/5',
    'Principal: 2 min',
    'Execução: Sustente o ritmo.',
    'Esforço: Moderado; RPE 2/5',
    'Desaquecimento: 5 min',
    'Execução: Reduza gradualmente.',
    'Esforço: Muito leve; RPE 1/5',
  ].join('\n');
  const prescription = [
    { phase: 'warmup', effort: 'Muito leve', rpe: 1, targetHr: '' },
    { phase: 'main', effort: 'Forte controlado', rpe: 3, targetHr: '' },
    { phase: 'main', effort: 'Moderado', rpe: 2, targetHr: '' },
    { phase: 'cooldown', effort: 'Muito leve', rpe: 1, targetHr: '' },
  ];
  const summary = summarizePrescription(details, { language: 'pt-BR', prescription });
  assert.equal(summary.rpe, '2–3/5');
  assert.equal(
    summarizePrescription(details.replace('RPE 2/5', 'RPE 5/5'), { language: 'pt-BR', prescription }).rpe,
    '2–3/5',
  );
  assert.equal(summary.phases.length, 4);
  assert.match(summary.phases[1].recovery, /RPE 2\/5/);
  assert.deepEqual(summary.phases.map((phase) => phase.phase), ['warmup', 'main', 'main', 'cooldown']);
  assert.equal(summary.hr, 'Por esforço e respiração; sem referência de FC disponível.');
});

test('weekly prescription summary preserves uniform and varying HR targets, without inferring targets from measurements', async () => {
  const { summarizePrescription } = await displayPromise;
  const details = [
    'Warm-up: 5 min', 'Execution: Easy.', 'Effort: Relaxed; RPE 1/5; Target HR: 120–130 bpm',
    'Main set: 20 min', 'Execution: Steady.', 'Effort: Controlled; RPE 2/5; Target HR: 140–150 bpm',
    'Cool-down: 5 min', 'Execution: Ease down.', 'Effort: Easy; RPE 1/5; Target HR: 120–130 bpm',
  ].join('\n');
  const prescription = [
    { phase: 'warmup', effort: 'Relaxed', rpe: 1, targetHr: '120–130 bpm' },
    { phase: 'main', effort: 'Controlled', rpe: 2, targetHr: '140–150 bpm' },
    { phase: 'cooldown', effort: 'Easy', rpe: 1, targetHr: '120–130 bpm' },
  ];
  const summary = summarizePrescription(details, { language: 'en-US', prescription });
  assert.equal(summary.hr, 'Warm-up: 120–130 bpm · Main: 140–150 bpm · Cool-down: 120–130 bpm');
  assert.equal(summary.rpe, '2/5');
  assert.equal(pt.aiCoach.mainRpeLabel, 'RPE principal');
  assert.equal(en.aiCoach.mainRpeLabel, 'Main RPE');
  assert.equal(summarizePrescription(details.replace(/; Target HR: [^\n]+/g, ''), { language: 'en-US' }).hr, 'By effort and breathing; no HR reference available.');
});

test('a proposal with no numerical RPE keeps its effort cue', async () => {
  const { summarizePrescription } = await displayPromise;
  const details = 'Principal: 20 min\nExecução: Mantenha a passada confortável.\nEsforço: Respiração controlada, conseguindo conversar.';
  const summary = summarizePrescription(details, {
    language: 'pt-BR',
    prescription: [{ phase: 'main', effort: 'Respiração controlada, conseguindo conversar.', rpe: null, targetHr: '' }],
  });
  assert.equal(summary.rpe, 'Respiração controlada, conseguindo conversar.');
  assert.notEqual(summary.rpe, '—');
});

test('weekly weather display localizes verified window values and keeps partial/unavailable explicit', async () => {
  const { formatWeeklyWeather, formatWeeklyWeatherSummary } = await displayPromise;
  const evidence = {
    status: 'verified', window: { minC: 10, maxC: 12.7 },
    hours: [[1, '08:00+01:00', 10, 2], [2, '09:00+01:00', 12.7, 2], [3, '10:00+01:00', 11, 61]],
  };
  const translate = (messages) => (key) => key.split('.').reduce((value, part) => value?.[part], messages) ?? key;
  assert.equal(formatWeeklyWeather(evidence, { language: 'pt-BR', translate: translate(pt) }), '10–12.7 °C · máxima no período: 12.7 °C · Parcialmente nublado, Chuva leve');
  assert.equal(formatWeeklyWeather(evidence, { temperatureUnit: 'F', language: 'en-US', translate: translate(en) }), '50–54.9 °F · period high: 54.9 °F · Partly cloudy, Light rain');
  assert.equal(formatWeeklyWeather({ status: 'partial' }, { language: 'pt-BR', translate: translate(pt) }), pt.aiCoach.forecastPartial);
  assert.equal(formatWeeklyWeather(null, { language: 'en-US', translate: translate(en) }), en.aiCoach.forecastUnavailable);
  assert.deepEqual(
    formatWeeklyWeatherSummary(evidence, { language: 'pt-BR', translate: translate(pt) }),
    {
      status: '',
      range: '10–12,7 °C',
      high: 'Máxima no período: 12,7 °C',
      conditions: ['Parcialmente nublado', 'Chuva leve'],
    },
  );
  assert.deepEqual(
    formatWeeklyWeatherSummary(evidence, { temperatureUnit: 'F', language: 'en-US', translate: translate(en) }),
    {
      status: '',
      range: '50–54.9 °F',
      high: 'Maximum during period: 54.9 °F',
      conditions: ['Partly cloudy', 'Light rain'],
    },
  );
  assert.equal(
    formatWeeklyWeatherSummary({ status: 'partial' }, { language: 'en-US', translate: translate(en) }).status,
    en.aiCoach.forecastPartial,
  );
  assert.equal(
    formatWeeklyWeatherSummary(null, { language: 'pt-BR', translate: translate(pt) }).status,
    pt.aiCoach.forecastUnavailable,
  );
  assert.deepEqual(
    formatWeeklyWeatherSummary({ ...evidence, hours: [[4, '11:00+01:00', 11, 999]] }, { language: 'en-US', translate: translate(en) }).conditions,
    [en.weather.unknown],
  );
});

test('weekly justification presentation removes only recognized technical references', async () => {
  const { cleanWeeklyJustification } = await displayPromise;
  assert.equal(
    cleanWeeklyJustification('Continuidade do ciclo cycle:abc123 e treino training:42, com cautela. UUID 123e4567-e89b-12d3-a456-426614174000.'),
    'Continuidade do ciclo e treino, com cautela. UUID.',
  );
});
