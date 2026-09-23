'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  PROMPT_TEMPLATE, PROMPT_TEMPLATE_EN, buildPrompt, validatePromptFields,
  availabilityDefaults, buildDayRowHtml, nextMonday, previousWeekSummary,
  cycleContext, buildPromptContext, formatShoesBlock, copyPromptText,
} = require('../src/public/ai-coach.js');

const messages = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/pt.json')));
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
  assert.match(row, /<option value="" selected>/);
  assert.match(row, /data-location/);
  const html = readFileSync(join(__dirname, '../src/public/ai-coach.html'), 'utf8');
  assert.match(html, /id="applyWeekdays"/);
  assert.match(html, /id="availabilityReview"/);
});

test('week starts on the Monday after the current date', () => {
  assert.equal(nextMonday(new Date(2026, 8, 28)).getDate(), 5);
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

test('cycle context derives the current and total weeks and remaining days', () => {
  assert.deepEqual(cycleContext({ start_date: '2026-09-01', target_date: '2026-10-01' }, new Date(2026, 8, 15)), {
    start_date: '2026-09-01', target_date: '2026-10-01', name: undefined,
    goal: undefined, targetRaceDate: '2026-10-01', currentWeek: 3, totalWeeks: 5, daysRemaining: 16,
  });
  const context = buildPromptContext({ cycle: { objective: 'Autumn race' }, trainings: [], targetDate: new Date(2026, 8, 28), today: new Date(2026, 8, 20) });
  assert.equal(context.cycle.name, 'Autumn race');
  assert.equal(context.previousWeek.completedTrainingsCount, 0);
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

test('clipboard helper reports success, unsupported clipboard, and rejected writes', async () => {
  let copied = '';
  assert.equal(await copyPromptText('prompt', { writeText: async (value) => { copied = value; } }), true);
  assert.equal(copied, 'prompt');
  assert.equal(await copyPromptText('prompt', null), false);
  assert.equal(await copyPromptText('prompt', { writeText: async () => { throw new Error('denied'); } }), false);
});
