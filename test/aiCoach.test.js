'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  PROMPT_TEMPLATE, PROMPT_TEMPLATE_EN, TEMPLATE_BY_LANG, buildPrompt, validatePromptFields,
  availabilityDefaults, buildDayRowHtml, nextMonday, previousWeekSummary,
  cycleContext, buildPromptContext, formatShoesBlock, copyPromptText, pad2,
  formatDiaSlashes, dateInputValue, parseInputDate, readTargetDateIso,
  resolveTemplateLang, orderedDayKeys,
} = require('../src/public/ai-coach.js');

const publicDir = join(__dirname, '../src/public');
const messages = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/pt.json')));
const enMessages = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/en.json')));
const week = {
  segunda: { can_train: true, available_periods: ['12_14', 'after_18'], available_minutes: 60, location: 'Fânzeres, Gondomar' },
  terca: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  quarta: { can_train: true, available_periods: ['before_08'], available_minutes: 45, location: 'Porto' },
  quinta: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  sexta: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  sabado: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  domingo: { can_train: false, available_periods: [], available_minutes: null, location: '' },
};

test('availability has no assumed daily status or duration', () => {
  assert.deepEqual(availabilityDefaults(), Object.fromEntries(Object.keys(week).map((day) => [day, {
    can_train: null, available_periods: [], available_minutes: null, location: '',
  }])));
});

test('structured availability validation requires explicit yes/no and complete available-day data', () => {
  const base = { targetDate: '2026-09-28', disponibilidade: week };
  assert.deepEqual(validatePromptFields(base), { valid: true, missing: [] });
  assert.deepEqual(validatePromptFields({ ...base, disponibilidade: { ...week, terca: { ...week.terca, can_train: null } } }).missing, ['availability']);
  assert.deepEqual(validatePromptFields({ ...base, disponibilidade: { ...week, segunda: { ...week.segunda, available_periods: [] } } }).missing, ['availability']);
  assert.deepEqual(validatePromptFields({ ...base, disponibilidade: { ...week, segunda: { ...week.segunda, available_minutes: null } } }).missing, ['availability']);
  assert.deepEqual(validatePromptFields({ ...base, disponibilidade: { ...week, segunda: { ...week.segunda, location: '' } } }).missing, ['availability']);
  assert.deepEqual(validatePromptFields({ ...base, targetDate: '31/02/2026' }).missing, ['targetDate']);
});

test('duration validation accepts every tested integer through 720 and rejects values outside the contract', () => {
  const base = { targetDate: '2026-09-28', disponibilidade: week };
  for (const minutes of [1, 75, 137, 720]) {
    const result = validatePromptFields({ ...base, disponibilidade: { ...week, segunda: { ...week.segunda, available_minutes: minutes } } });
    assert.equal(result.valid, true, `${minutes} minutes should be valid`);
  }
  for (const minutes of [0, -1, 721, 1.5, NaN, null, '']) {
    const result = validatePromptFields({ ...base, disponibilidade: { ...week, segunda: { ...week.segunda, available_minutes: minutes } } });
    assert.deepEqual(result.missing, ['availability'], `${String(minutes)} minutes should be invalid`);
  }
  assert.equal(validatePromptFields({ ...base, disponibilidade: { ...week, terca: { ...week.terca, available_minutes: null } } }).valid, true,
    'unavailable days do not require a duration');
});

test('availability duration control exposes the same inclusive upper limit as validation', () => {
  const html = buildDayRowHtml('segunda', { dayLabel: 'Segunda', state: week.segunda });
  assert.match(html, /data-duration min="1" max="720" step="1"/);
});

test('prompt prints unavailable days and structured windows, maximum minutes, and location', () => {
  const prompt = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: week, lang: 'pt-BR', messages });
  assert.match(prompt, /Segunda: Pode treinar: sim; Períodos disponíveis: 12h–14h; Após as 18h; Tempo máximo disponível para a sessão: 60 minutos; Local: Fânzeres, Gondomar/);
  assert.match(prompt, /Terça: Pode treinar: não/);
  assert.match(prompt, /Quarta: Pode treinar: sim; Períodos disponíveis: Antes das 08h; Tempo máximo disponível para a sessão: 45 minutos; Local: Porto/);
  assert.match(prompt, /Períodos múltiplos são alternativas para uma sessão naquele dia, não autorização para treinos múltiplos/);
  assert.match(prompt, /não é meta/);
  assert.match(prompt, /Nunca interprete a janela do período como duração do treino/);
  assert.match(prompt, /Não invente horário exato dentro da faixa nem condições meteorológicas/);
  assert.doesNotMatch(prompt, /Rotina normal/);
  assert.doesNotMatch(prompt, /08h–12h[^\n]*4 horas/);
});

test('English prompt has localized availability labels and no legacy routine', () => {
  const en = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/en.json')));
  const englishWeek = Object.fromEntries(Object.entries(week).map(([day, record]) => [day, record]));
  const prompt = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: englishWeek, lang: 'en-US', messages: en });
  assert.match(prompt, /Monday: Can train: yes; Available periods: 12:00–14:00; After 18:00; Maximum session time: 60 minutes; Location: Fânzeres, Gondomar/);
  assert.match(prompt, /Multiple periods are alternatives for one session that day, not permission for multiple sessions/);
  assert.match(prompt, /a ceiling, not a target/);
  assert.match(prompt, /never invent weather/);
  assert.doesNotMatch(prompt, /Normal routine|Rotina normal/);
  assert.match(PROMPT_TEMPLATE, /\{\{AVAILABILITY_BLOCK\}\}/);
  assert.match(PROMPT_TEMPLATE_EN, /\{\{AVAILABILITY_BLOCK\}\}/);
});

test('prompt defaults to Portuguese for missing or unsupported languages without inventing availability', () => {
  for (const lang of [undefined, 'pt-BR', 'fr-FR']) {
    const prompt = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: {}, lang });
    assert.ok(prompt.startsWith('Quero que você gere minha planilha'));
    assert.match(prompt, /monday: Availability not configured/);
    assert.doesNotMatch(prompt, /Rotina normal|\{\{/);
  }
});

test('one selected period remains one choice and exact location text is kept in the prompt', () => {
  const single = Object.fromEntries(Object.entries(week).map(([day, state]) => [day, { ...state }]));
  single.segunda.available_periods = ['08_12'];
  single.segunda.available_minutes = 75;
  single.segunda.location = '  Fânzeres, Gondomar  ';
  const prompt = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: single, messages });
  assert.match(prompt, /Períodos disponíveis: 08h–12h; Tempo máximo disponível para a sessão: 75 minutos; Local: {3}Fânzeres, Gondomar {2}/);
});

test('legacy free text and missing days remain unconfigured instead of becoming available or unavailable', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 8, 28),
    disponibilidade: { segunda: 'Rotina normal' },
    lang: 'pt-BR', messages,
  });
  assert.match(prompt, /Segunda: Disponibilidade não configurada; confirme com o usuário/);
  assert.match(prompt, /Terça: Disponibilidade não configurada; confirme com o usuário/);
  assert.match(prompt, /Se algum dia estiver sem configuração estruturada, não presuma disponibilidade/);
  assert.doesNotMatch(prompt, /Rotina normal/);
  assert.doesNotMatch(prompt, /Segunda: Pode treinar: não/);
});

test('day card uses native labeled controls and an unselected session duration', () => {
  const row = buildDayRowHtml('segunda', { dayLabel: 'Segunda-feira', messages: messages.aiCoach, state: {} });
  assert.match(row, /<fieldset class="day-row"/);
  assert.match(row, /type="radio" name="canTrain-monday" value="yes"/);
  assert.match(row, /type="radio" name="canTrain-monday" value="no"/);
  assert.match(row, /data-period="before_08"/);
  assert.match(row, /data-duration/);
  assert.match(row, /<input type="number" data-duration min="1" max="720" step="1"/);
  assert.match(row, /value="" placeholder="Minutos \(1–720\)"/);
  assert.match(row, /data-location/);
  const html = readFileSync(join(__dirname, '../src/public/ai-coach.html'), 'utf8');
  assert.match(html, /id="applyWeekdays"/);
  assert.match(html, /id="availabilityReview"/);
});

test('pad2, date formatting and local date parsing keep the date contracts', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(12), '12');
  const date = new Date(2026, 7, 3);
  assert.equal(formatDiaSlashes(date), '03/08/2026');
  assert.equal(dateInputValue(date), '2026-08-03');
  const parsed = parseInputDate('2026-08-31');
  assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()], [2026, 7, 31]);
  assert.equal(parseInputDate(''), null);
});

test('target date reads the DatePicker ISO value before localized display text', () => {
  const input = { value: '31/08/2026', dataset: { iso: '2026-08-31' } };
  assert.equal(readTargetDateIso(input, { getValue: () => '2026-09-07' }), '2026-09-07');
  assert.equal(readTargetDateIso(input, { getValue: () => '' }), '2026-08-31');
  assert.equal(readTargetDateIso({ value: '2026-08-31', dataset: { iso: '' } }, null), '2026-08-31');
  assert.equal(readTargetDateIso({ value: '31/02/2026', dataset: { iso: '' } }, null), '');
});

test('target date validation rejects impossible dates and accepts valid ISO and localized dates', () => {
  for (const targetDate of ['', '2026-02-30', '31/02/2026', 'not-a-date']) {
    assert.deepEqual(validatePromptFields({ targetDate, disponibilidade: week }).missing, ['targetDate']);
  }
  assert.deepEqual(validatePromptFields({ targetDate: '2026-09-28', disponibilidade: week }).missing, []);
  assert.deepEqual(validatePromptFields({ targetDate: '28/09/2026', disponibilidade: week }).missing, []);
});

test('template structure and placeholder tokens stay aligned in Portuguese and English', () => {
  const tokens = (template) => template.match(/\{\{[A-Z_]+\}\}/g) || [];
  assert.deepEqual(tokens(PROMPT_TEMPLATE_EN), tokens(PROMPT_TEMPLATE));
  for (const heading of ['CONTEXTO DO CICLO ATUAL', 'DATA DA SEMANA', 'DISPONIBILIDADE', 'CONTEXTO ADICIONAL DESTA SEMANA', 'INSTRUÇÕES PARA MONTAR A SEMANA', 'FORMATO DA PLANILHA', 'ARQUIVO EXCEL']) {
    assert.ok(PROMPT_TEMPLATE.includes(heading), `Portuguese template includes ${heading}`);
  }
  assert.match(PROMPT_TEMPLATE, /\| Data \| Dia \| Período \| Tipo \| Treino \| Detalhes \| FC alvo \| RPE \| Tênis \| Localização \| Previsão do tempo \| Observações \|/);
  assert.match(PROMPT_TEMPLATE, /copy|copie exatamente/i);
  assert.doesNotMatch(PROMPT_TEMPLATE, /\{\{DISPONIBILIDADE\}\}|\{\{DISP_SEG\}\}/);
});

test('template language resolution keeps Portuguese fallback for unknown languages', () => {
  assert.deepEqual(TEMPLATE_BY_LANG, { 'pt-BR': PROMPT_TEMPLATE, 'en-US': PROMPT_TEMPLATE_EN });
  assert.equal(resolveTemplateLang('pt-BR'), 'pt-BR');
  assert.equal(resolveTemplateLang('en-US'), 'en-US');
  assert.equal(resolveTemplateLang('fr-FR'), 'pt-BR');
  assert.equal(resolveTemplateLang(undefined), 'pt-BR');
});

test('ordered day keys respect Monday and Sunday week-start preferences', () => {
  assert.deepEqual(orderedDayKeys('Monday'), Object.keys(week));
  assert.deepEqual(orderedDayKeys('Sunday'), ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);
  assert.deepEqual(orderedDayKeys(), orderedDayKeys('Monday'));
});

test('day row translates its controls and renders every stable period key', () => {
  const row = buildDayRowHtml('segunda', { dayLabel: 'Monday', messages: enMessages.aiCoach, state: week.segunda });
  assert.match(row, /<legend class="day-label">Monday<\/legend>/);
  for (const period of ['before_08', '08_12', '12_14', '14_18', 'after_18']) assert.ok(row.includes(`data-period="${period}"`));
  assert.match(row, /checked/);
  assert.match(row, /value="60"/);
  assert.match(row, /Fânzeres, Gondomar/);
  assert.match(row, /aria-label="Can you train\?"/);
});

test('week starts on the Monday after the current date', () => {
  assert.equal(nextMonday(new Date(2026, 8, 28)).getDate(), 5);
});

test('nextMonday advances from every weekday and handles month and year boundaries', () => {
  const cases = [
    [new Date(2026, 7, 24), new Date(2026, 7, 31)],
    [new Date(2026, 7, 25), new Date(2026, 7, 31)],
    [new Date(2026, 7, 26), new Date(2026, 7, 31)],
    [new Date(2026, 7, 30), new Date(2026, 7, 31)],
    [new Date(2026, 11, 26), new Date(2026, 11, 28)],
    [new Date(2026, 11, 31), new Date(2027, 0, 4)],
  ];
  for (const [from, expected] of cases) {
    const actual = nextMonday(from);
    assert.deepEqual([actual.getFullYear(), actual.getMonth(), actual.getDate(), actual.getDay(), actual.getHours()],
      [expected.getFullYear(), expected.getMonth(), expected.getDate(), 1, 0]);
  }
});

test('ordered rendered day labels place the preferred first weekday first', () => {
  const localeDays = { segunda: 'monday', terca: 'tuesday', quarta: 'wednesday', quinta: 'thursday', sexta: 'friday', sabado: 'saturday', domingo: 'sunday' };
  const firstCard = (weekStart) => {
    const day = orderedDayKeys(weekStart)[0];
    return buildDayRowHtml(day, { dayLabel: enMessages.aiCoach.days[localeDays[day]], messages: enMessages.aiCoach, state: {} });
  };
  assert.match(firstCard('Monday'), /<legend class="day-label">Monday<\/legend>/);
  assert.match(firstCard('Sunday'), /<legend class="day-label">Sunday<\/legend>/);
});

test('weekly summaries count completed sessions and ignore incomplete entries', () => {
  const summary = previousWeekSummary([
    { dia: '2026-09-21', completed: 1, fit_distance: 5.5, fit_duration: '30:00' },
    { dia: '2026-09-22', completed: true, fit_distance: 3, fit_duration: '20:00' },
    { dia: '2026-09-23', completed: 0, fit_distance: null, fit_duration: null },
    null,
  ], new Date(2026, 8, 28));
  assert.equal(summary.completedTrainingsCount, 2);
  assert.equal(summary.totalDistanceKm, 8.5);
  assert.equal(summary.totalTimeMinutes, 50);
});

test('previous-week summary handles empty and malformed training records safely', () => {
  assert.deepEqual(previousWeekSummary(null, new Date(2026, 8, 28)), {
    completedTrainingsCount: 0, totalDistanceKm: 0, totalTimeMinutes: 0,
  });
  assert.deepEqual(previousWeekSummary([
    { dia: '2026-09-21', fit_distance: 'bad', fit_duration: 'bad' },
    { dia: '2026-09-22', completed: true },
    { dia: 'not-a-date', completed: true, fit_distance: 2 },
  ], new Date(2026, 8, 28)), {
    completedTrainingsCount: 1, totalDistanceKm: 0, totalTimeMinutes: 0,
  });
});

test('cycle context derives the current and total weeks and remaining days', () => {
  assert.deepEqual(cycleContext({ start_date: '2026-09-01', target_date: '2026-10-01' }, new Date(2026, 8, 15)), {
    start_date: '2026-09-01', target_date: '2026-10-01', name: undefined,
    goal: undefined, targetRaceDate: '2026-10-01', currentWeek: 3, totalWeeks: 5, daysRemaining: 16,
  });
  const context = buildPromptContext({ cycle: { objective: 'Autumn race' }, trainings: [], targetDate: new Date(2026, 8, 28), today: new Date(2026, 8, 20) });
  assert.equal(context.cycle.name, 'Autumn race');
  assert.equal(context.previousWeek.completedTrainingsCount, 0);
});

test('buildPromptContext maps cycle aliases and previous week summaries into the prompt', () => {
  const targetDate = new Date(2026, 7, 31);
  const context = buildPromptContext({
    targetDate, today: new Date(2026, 7, 24),
    cycle: { objective: 'Base Lisboa', primary_goal: 'Correr abaixo de 2h', start_date: '2026-08-03', target_date: '2026-10-18' },
    trainings: [
      { dia: '2026-08-24', fit_distance: '10', fit_duration: '1:00:00' },
      { dia: '2026-08-30', fit_distance: 5.5, fit_duration: '00:32:00' },
      { dia: '2026-08-31', fit_distance: 99, fit_duration: '9:00:00' },
    ],
  });
  assert.equal(context.cycle.name, 'Base Lisboa');
  assert.equal(context.cycle.goal, 'Correr abaixo de 2h');
  assert.equal(context.cycle.currentWeek, 4);
  assert.equal(context.cycle.totalWeeks, 11);
  assert.equal(context.cycle.daysRemaining, 55);
  assert.deepEqual(context.previousWeek, { completedTrainingsCount: 2, totalDistanceKm: 15.5, totalTimeMinutes: 92 });
  const prompt = buildPrompt({ targetDate, ...context, disponibilidade: week, messages });
  assert.match(prompt, /Nome do ciclo: Base Lisboa/);
  assert.match(prompt, /Meta do ciclo: Correr abaixo de 2h/);
  assert.match(prompt, /Treinos concluídos na semana anterior: 2/);
  assert.match(prompt, /Distância total da semana anterior \(km\): 15\.5/);
  assert.match(prompt, /Tempo total da semana anterior \(minutos\): 92/);
});

test('buildPrompt localizes cycle dates, week count and previous-week context in English', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31), disponibilidade: week, lang: 'en-US', messages: enMessages,
    cycle: { name: 'Lisbon Base', goal: 'Run under 2 hours', targetRaceDate: '2026-10-18', currentWeek: 4, totalWeeks: 12, daysRemaining: 38 },
    previousWeek: { completedTrainingsCount: 4, totalDistanceKm: 42.5, totalTimeMinutes: 238 },
  });
  assert.match(prompt, /Cycle name: Lisbon Base/);
  assert.match(prompt, /Cycle goal: Run under 2 hours/);
  assert.match(prompt, /Target race date: 10\/18\/2026/);
  assert.match(prompt, /Current week: Week 4 of 12/);
  assert.match(prompt, /Days remaining: 38/);
  assert.match(prompt, /Completed trainings in the previous week: 4/);
  assert.match(prompt, /Previous week total distance \(km\): 42\.5/);
  assert.match(prompt, /Previous week total time \(minutes\): 238/);
});

test('buildPrompt formats imperial previous-week distance and temperature instructions', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 8, 28), disponibilidade: week, lang: 'en-US', messages: enMessages,
    preferences: { distance_unit: 'mi', temperature_unit: 'F' },
    previousWeek: { totalDistanceKm: 15, totalTimeMinutes: 90, completedTrainingsCount: 2 },
  });
  assert.match(prompt, /Use miles for all distances and °F for all temperatures/);
  assert.match(prompt, /Previous week total distance \(miles\): 9\.32 mi/);
  assert.match(prompt, /73–75 °F/);
  assert.doesNotMatch(prompt, /Previous week total distance \(km\)/);
});

test('buildPrompt keeps metric units and weather examples localized', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 8, 28), disponibilidade: week, lang: 'pt-BR', messages,
    preferences: { distance_unit: 'km', temperature_unit: 'C' },
  });
  assert.match(prompt, /Use quilômetros para todas as distâncias e °C para todas as temperaturas/);
  assert.match(prompt, /\(ex: 23–24 °C, parcialmente nublado \(~12h\)\)/);
});

test('shoe prompt block includes active pairs, mileage, target and locale-specific labels', () => {
  const shoes = [
    { brand: 'Acme', model: 'Daily', status: 'active', mileage: 123, target_mileage: 500 },
    { brand: 'Acme', model: 'Retired', status: 'retired', mileage: 300 },
  ];
  const block = formatShoesBlock(shoes, messages, { distance_unit: 'km' });
  assert.match(block, /Acme Daily \(Current mileage: 123 km, Alvo: 500 km\)/);
  assert.doesNotMatch(block, /Retired/);
  assert.match(formatShoesBlock([], messages), /Nenhum tênis específico cadastrado/);
});

test('shoe prompt block has localized fallback, excludes retired pairs and formats imperial mileage', () => {
  const shoes = [
    { brand: 'Nike', model: 'Retired', status: 'retired', mileage: 500 },
    { brand: 'Asics', model: 'Nimbus', status: 'active', mileage: 160.9344, target_mileage: 804.672 },
  ];
  const block = formatShoesBlock(shoes, enMessages, { distance_unit: 'mi' });
  assert.match(block, /SHOES AVAILABLE FOR ROTATION/);
  assert.match(block, /Asics Nimbus \(Current mileage: 100\.00 mi, Target: 500\.00 mi\)/);
  assert.doesNotMatch(block, /Retired/);
  assert.match(formatShoesBlock([{ ...shoes[0], status: 'retired' }], enMessages), /No specific shoes registered/);
  assert.match(formatShoesBlock([], {}), /No specific shoes registered/);
});

test('prompt injects active shoes before the structured availability block in both languages', () => {
  for (const [lang, locale, title, activeLine] of [
    ['pt-BR', messages, 'TÊNIS DISPONÍVEIS PARA ROTAÇÃO', '- Acme Daily'],
    ['en-US', enMessages, 'SHOES AVAILABLE FOR ROTATION', '- Acme Daily'],
  ]) {
    const prompt = buildPrompt({
      targetDate: new Date(2026, 8, 28), disponibilidade: week, lang, messages: locale,
      shoes: [{ brand: 'Acme', model: 'Daily', status: 'active', mileage: 20 }],
    });
    assert.ok(!prompt.includes('{{SHOES_BLOCK}}'));
    assert.ok(prompt.includes(activeLine));
    assert.ok(prompt.indexOf(title) < prompt.indexOf(lang === 'pt-BR' ? 'DISPONIBILIDADE' : 'AVAILABILITY'));
  }
});

test('prompt generation replaces context placeholders and preserves supplied context only', () => {
  for (const [lang, locale] of [['pt-BR', messages], ['en-US', enMessages]]) {
    const prompt = buildPrompt({
      targetDate: new Date(2026, 8, 28), disponibilidade: week, contexto: 'viagem na terça', lang, messages: locale,
    });
    assert.ok(prompt.startsWith(lang === 'pt-BR' ? 'Quero que você gere' : 'I want you to generate'));
    assert.ok(prompt.includes('\nviagem na terça\n'));
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
    assert.doesNotMatch(prompt, /qualquer outra circunstância relevante|any other relevant circumstance/i);
  }
});

test('prompt trims optional context and uses a dash when it is blank', () => {
  const custom = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: week, contexto: '  viagem na terça  ', messages });
  assert.ok(custom.includes('\nviagem na terça\n'));
  assert.ok(!custom.includes('\n  viagem na terça  \n'));
  const empty = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: week, contexto: '  ', messages });
  assert.match(empty, /CONTEXTO ADICIONAL DESTA SEMANA\n\n-\n/);
});

test('AI Coach locale dictionaries retain translated page, form, prompt and shoe strings', () => {
  for (const locale of [messages, enMessages]) {
    assert.equal(typeof locale.aiCoach.title, 'string');
    assert.equal(typeof locale.aiCoach.targetDate, 'string');
    assert.equal(typeof locale.aiCoach.contextPlaceholder, 'string');
    assert.equal(typeof locale.aiCoach.availabilityReview, 'string');
    assert.equal(Object.keys(locale.aiCoach.days).length, 7);
    assert.equal(Object.keys(locale.aiCoach.periods).length, 5);
    assert.equal(typeof locale.aiCoach.shoesSectionTitle, 'string');
    assert.equal(typeof locale.aiCoach.shoesFallback, 'string');
    assert.equal(typeof locale.aiCoach.generate, 'string');
    assert.equal(typeof locale.aiCoach.copy, 'string');
  }
  assert.notEqual(messages.aiCoach.title, enMessages.aiCoach.title);
  assert.equal(messages.aiCoach.periods['08_12'], '08h–12h');
  assert.equal(enMessages.aiCoach.periods['08_12'], '08:00–12:00');
  assert.equal(messages.aiCoach.durationPlaceholder, 'Minutos (1–720)');
  assert.equal(enMessages.aiCoach.durationPlaceholder, 'Minutes (1–720)');
});

test('AI Coach runtime keeps language change, structured data and async prompt wiring', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(js, /addEventListener\('app:languagechange'/);
  assert.match(js, /renderDayRows\(\)/);
  assert.match(js, /lang: i18n\.language/);
  assert.match(js, /fetchShoes\(\)/);
  assert.match(js, /fetchAiCoachAvailability\(\)/);
  assert.match(js, /saveAiCoachAvailability\(days\)/);
  assert.match(js, /async function handleGenerate/);
  assert.match(js, /generateBtn\.disabled = !validation\.valid/);
  assert.match(js, /messages: i18n\.messages/);
  assert.doesNotMatch(js, /applyRoutineDefault|DEFAULT_ROUTINE_BY_LANG|Rotina normal/);
});

test('base location is only copied into available empty day fields', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(js, /baseLocationInput\.addEventListener\('change'/);
  assert.match(js, /if \(!input\.disabled && !input\.value\.trim\(\)\) input\.value = baseLocationInput\.value/);
  assert.match(js, /const states = readFormFields\(\)/);
  assert.match(js, /structuredClone\(monday\)/);
  assert.match(js, /\['terca', 'quarta', 'quinta', 'sexta'\]/);
});

test('context and base location placeholders remain translated and available in the form', () => {
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  const i18n = readFileSync(join(publicDir, 'shared/i18n.js'), 'utf8');
  assert.match(html, /id="optionalContext"[^>]*data-i18n-placeholder="aiCoach\.contextPlaceholder"/);
  assert.match(html, /id="baseLocation"[^>]*data-i18n-placeholder="aiCoach\.locationPlaceholder"/);
  assert.match(i18n, /\[data-i18n-placeholder\][\s\S]*?\.placeholder = translate/);
  assert.equal(messages.aiCoach.locationPlaceholder, 'Ex: Cidade, País');
  assert.equal(enMessages.aiCoach.locationPlaceholder, 'Ex: City, Country');
});

test('AI Coach responsive layout and controls retain visible focus and shared button styling', () => {
  const css = readFileSync(join(publicDir, 'ai-coach.css'), 'utf8');
  const theme = readFileSync(join(publicDir, 'shared/theme.css'), 'utf8');
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  assert.match(css, /\.day-row/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-width:\s*0/);
  assert.match(css, /\.day-field input,[\s\S]*?\.day-field select/);
  assert.match(theme, /\.btn-primary/);
  assert.match(html, /id="generateBtn"[^>]*class="btn-primary"/);
  assert.match(html, /id="availabilityGrid"/);
});

test('AI Coach page keeps shell, icon assets and all user-facing prompt controls', () => {
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  assert.match(html, /id="appView"/);
  assert.match(html, /shared\/shell\.js" type="module"/);
  assert.match(html, /ai-coach\.js" type="module"/);
  assert.match(html, /lucide@latest/);
  assert.match(html, /data-i18n="aiCoach\.title"/);
  assert.match(html, /data-i18n="aiCoach\.generate"/);
  assert.match(html, /id="copyLabel" data-i18n="aiCoach\.copy"/);
});

test('clipboard helper reports success, unsupported clipboard, and rejected writes', async () => {
  let copied = '';
  assert.equal(await copyPromptText('prompt', { writeText: async (value) => { copied = value; } }), true);
  assert.equal(copied, 'prompt');
  assert.equal(await copyPromptText('prompt', null), false);
  assert.equal(await copyPromptText('prompt', { writeText: async () => { throw new Error('denied'); } }), false);
});

test('clipboard helper uses the global async clipboard when none is passed', async () => {
  const original = globalThis.navigator;
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value) => { copied = value; } } } });
  try {
    assert.equal(await copyPromptText('global prompt'), true);
    assert.equal(copied, 'global prompt');
  } finally {
    if (original === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
  }
});

test('HTML retains date picker, context, prompt, copy and accessibility contracts', () => {
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(js, /createDatePicker, readDatePickerValue.*from '\.\/shared\/datepicker\.js'/);
  assert.match(html, /id="targetDateDisplay"/);
  assert.match(html, /type="date" id="targetDate"[^>]*aria-hidden="true" tabindex="-1"/);
  assert.match(html, /id="promptForm"/);
  assert.match(html, /id="optionalContext"/);
  assert.match(html, /id="promptOutput"/);
  assert.match(html, /id="copyBtn"/);
  assert.match(html, /aria-live="polite"/);
});

test('layout and language events rerender current structured values instead of resetting them', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(js, /function renderDayRows\(states = readFormFields\(\)\)/);
  assert.match(js, /document\.addEventListener\('kinesis:preferences-changed'/);
  assert.match(js, /document\.addEventListener\('app:languagechange'/);
  assert.match(js, /renderDayRows\(\);[\s\S]*?targetDatePicker\.refresh\(\)/);
});
