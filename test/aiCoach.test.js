'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  PROMPT_TEMPLATE, PROMPT_TEMPLATE_EN, TEMPLATE_BY_LANG, buildPrompt, validatePromptFields, validateAvailabilityDay,
  availabilityDefaults, buildDayRowHtml, nextMonday, previousWeekSummary,
  cycleContext, buildPromptContext, formatShoesBlock, copyPromptText, pad2,
  formatDiaSlashes, dateInputValue, parseInputDate, readTargetDateIso,
  resolveTemplateLang, orderedDayKeys,
} = require('../src/public/ai-coach.js');

const publicDir = join(__dirname, '../src/public');
const messages = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/pt.json')));
const enMessages = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/en.json')));
const week = {
  segunda: { can_train: true, available_periods: ['12_14'], available_minutes: 60, location: 'Fânzeres, Gondomar' },
  terca: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  quarta: { can_train: true, available_periods: ['before_08'], available_minutes: 45, location: 'Porto' },
  quinta: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  sexta: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  sabado: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  domingo: { can_train: false, available_periods: [], available_minutes: null, location: '' },
};

test('availability starts with unchecked days treated as unavailable in the form', () => {
  assert.deepEqual(availabilityDefaults(), Object.fromEntries(Object.keys(week).map((day) => [day, {
    can_train: false, available_periods: [], available_minutes: null, location: '',
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
  const firstUse = Object.fromEntries(Object.keys(week).map((day) => [day, {
    can_train: false, available_periods: [], available_minutes: null, location: '',
  }]));
  assert.equal(validatePromptFields({ ...base, disponibilidade: firstUse }).valid, true,
    'unchecked days are valid unavailable days on the initial form');
});

test('availability duration control exposes the same inclusive upper limit as validation', () => {
  const html = buildDayRowHtml('segunda', { dayLabel: 'Segunda', state: week.segunda });
  assert.match(html, /data-duration data-hint-id="availability-monday-duration-hint" min="1" max="720" step="1"/);
  assert.match(html, /label class="field-label" for="availability-monday-duration"/);
  assert.match(html, /p class="field-hint" id="availability-monday-duration-hint"/);
  assert.match(html, /label class="field-label" for="availability-monday-location"/);
  assert.doesNotMatch(html, /<label class="day-field"/);
});

test('day location validation matches the trimmed 200-character backend contract', () => {
  const valid = (location) => validateAvailabilityDay({ ...week.segunda, location });
  assert.deepEqual(valid('x'), []);
  assert.deepEqual(valid('x'.repeat(200)), []);
  assert.deepEqual(valid('x'.repeat(201)), ['availabilityLocationTooLong']);
  assert.deepEqual(valid(`  ${'x'.repeat(200)}  `), []);
  assert.deepEqual(valid(`  ${'x'.repeat(201)}  `), ['availabilityLocationTooLong']);
  assert.deepEqual(valid('   '), ['availabilityNeedsLocation']);
  assert.deepEqual(validateAvailabilityDay({ ...week.terca, location: 'x'.repeat(201) }), [],
    'unavailable days do not require a location');
  assert.equal(validatePromptFields({ targetDate: '2026-09-28', disponibilidade: { ...week, segunda: { ...week.segunda, location: 'x'.repeat(200) } } }).valid, true);
  assert.equal(validatePromptFields({ targetDate: '2026-09-28', disponibilidade: { ...week, segunda: { ...week.segunda, location: 'x'.repeat(201) } } }).valid, false);
  assert.equal(messages.aiCoach.availabilityLocationTooLong, 'A localização deve ter no máximo 200 caracteres.');
  assert.equal(enMessages.aiCoach.availabilityLocationTooLong, 'Location must be at most 200 characters.');
});

test('generated Portuguese prompt assigns dates by weekday, not row position, for interleaved training days', () => {
  const prompt = buildPrompt({ targetDate: new Date(2026, 9, 5), disponibilidade: week, lang: 'pt-BR', messages });
  assert.match(prompt, /8\. Não determine que eu persiga pace nas subidas\. FC pode subir significativamente nesses trechos; considere principalmente esforço e respiração\./);
  assert.doesNotMatch(prompt, /meu percurso habitual possui bastante subida/i);
  assert.match(prompt, /\n9\. Considere temperatura e condições meteorológicas/);
  assert.match(prompt, /Segunda: Pode treinar: sim; Período preferencial: 12h–14h; Tempo máximo disponível para a sessão: 60 minutos; Local: Fânzeres, Gondomar/);
  assert.match(prompt, /Terça: Pode treinar: não/);
  assert.match(prompt, /Quarta: Pode treinar: sim; Período preferencial: Antes das 08h; Tempo máximo disponível para a sessão: 45 minutos; Local: Porto/);
  assert.match(prompt, /VERIFICAÇÃO OBRIGATÓRIA DA PREVISÃO DO TEMPO/);
  assert.match(prompt, /Faça esta pesquisa autonomamente, usando as ferramentas de pesquisa e navegação disponíveis/);
  assert.match(prompt, /Não peça ao usuário para confirmar fontes, localidade, datas, horários ou fuso, nem autorização para pesquisar/);
  assert.match(prompt, /Abra e consulte o conteúdo da página ou os dados da fonte de previsão; não use somente resumos de resultados de busca/);
  assert.match(prompt, /consulte pelo menos uma segunda fonte de previsão horária, se houver ferramenta e acesso disponíveis/);
  assert.match(prompt, /localidade informada para aquele dia, à data local do treino e às horas necessárias/);
  assert.match(prompt, /Confira o fuso horário da fonte, inclusive indicações locais no cabeçalho ou nos metadados/);
  assert.match(prompt, /Para localidades em Portugal continental, incluindo Fânzeres, Gondomar, use Europe\/Lisbon/);
  for (const interval of [
    '00:00 ≤ hora < 08:00', '08:00 ≤ hora < 12:00', '12:00 ≤ hora < 14:00',
    '14:00 ≤ hora < 18:00', '18:00 ≤ hora < 24:00',
  ]) assert.ok(prompt.includes(interval), `generated PT prompt includes ${interval}`);
  assert.match(prompt, /faixa de temperaturas das horas verificadas, usando °C/);
  assert.match(prompt, /use a maior temperatura verificada nessa janela/);
  assert.match(prompt, /Nunca substitua essa máxima pela máxima diária nem por temperaturas fora do período/);
  assert.match(prompt, /Se a cobertura for parcial, declare a limitação/);
  assert.match(prompt, /localidade, data, cobertura horária ou fuso/);
  assert.match(prompt, /data além do horizonte de previsão/);
  assert.match(prompt, /não interrompa a elaboração da planilha para pedir confirmação ao usuário/i);
  assert.match(prompt, /Cite a fonte consultada, preferencialmente com link direto, e a data e hora da consulta com o fuso correspondente/);
  assert.match(prompt, /Preencha essa coluna no Excel antes de entregá-lo/);
  assert.match(prompt, /Use as datas efetivas da semana começando em 05\/10\/2026, no formato DD\/MM\/YYYY/);
  assert.match(prompt, /Calcule a data de cada treino pelo dia da semana, usando essa segunda-feira como referência: segunda \+0 dias, terça \+1, quarta \+2, quinta \+3, sexta \+4, sábado \+5 e domingo \+6/);
  assert.match(prompt, /Dias omitidos ou sem treino não alteram as datas dos demais; a ordem ou quantidade de linhas não determina a data/);
  assert.match(prompt, /Mais de um treino no mesmo dia usa a mesma data/);
  assert.match(prompt, /A previsão do tempo deve corresponder à mesma data local atribuída ao treino/);
  assert.match(prompt, /início em 05\/10\/2026, treinos somente na segunda e na quarta usam 05\/10\/2026 e 07\/10\/2026/);
  assert.doesNotMatch(prompt, /avançando um dia por linha/i);
  assert.match(prompt, /ex\.: 23–24 °C, parcialmente nublado; janela 12h–14h, máxima da janela 24 °C/);
  assert.match(prompt, /\| Data \| Dia \| Período \| Tipo \| Treino \| Detalhes \| FC alvo \| RPE \| Tênis \| Localização \| Previsão do tempo \| Observações \|/);
  assert.match(prompt, /não é meta/);
  assert.match(prompt, /Nunca interprete a janela do período como duração do treino/);
  assert.match(prompt, /Não invente um horário exato de início/);
  assert.match(prompt, /coluna existente “Previsão do tempo”, sem alterar as 12 colunas nem o formato de importação do Kinesis/);
  assert.doesNotMatch(prompt, /Rotina normal/);
  assert.doesNotMatch(prompt, /08h–12h[^\n]*4 horas/);
});

test('generated English prompt assigns dates by weekday, not row position, for interleaved training days', () => {
  const en = JSON.parse(readFileSync(join(__dirname, '../src/public/locales/en.json')));
  const englishWeek = Object.fromEntries(Object.entries(week).map(([day, record]) => [day, record]));
  const prompt = buildPrompt({
    targetDate: new Date(2026, 9, 5), disponibilidade: englishWeek, lang: 'en-US', messages: en,
    preferences: { distance_unit: 'mi', temperature_unit: 'F' },
  });
  assert.match(prompt, /Monday: Can train: yes; Preferred period: 12:00–14:00; Maximum session time: 60 minutes; Location: Fânzeres, Gondomar/);
  assert.match(prompt, /8\. Do not dictate that I chase pace on uphills\. HR may rise significantly in these sections; consider effort and breathing primarily\./);
  assert.doesNotMatch(prompt, /my usual route has plenty of hills/i);
  assert.match(prompt, /\n9\. Consider temperature and weather conditions/);
  assert.match(prompt, /MANDATORY WEATHER FORECAST VERIFICATION/);
  assert.match(prompt, /Perform this research autonomously using the available search and browsing tools/);
  assert.match(prompt, /Do not ask the user to confirm sources, locations, dates, times, or time zones, or to authorize research/);
  assert.match(prompt, /Open and inspect the forecast page or source data; do not rely only on search-result summaries/);
  assert.match(prompt, /consult at least one second hourly-forecast source when tools and access are available/);
  assert.match(prompt, /matches the location given for that day, the local training date, and the required hours/);
  assert.match(prompt, /Check the source time zone, including local-time indications in its header or metadata/);
  assert.match(prompt, /For locations in mainland Portugal, including Fânzeres, Gondomar, use Europe\/Lisbon/);
  for (const interval of [
    '00:00 ≤ hour < 08:00', '08:00 ≤ hour < 12:00', '12:00 ≤ hour < 14:00',
    '14:00 ≤ hour < 18:00', '18:00 ≤ hour < 24:00',
  ]) assert.ok(prompt.includes(interval), `generated EN prompt includes ${interval}`);
  assert.match(prompt, /temperature range for the verified hours in °F/);
  assert.match(prompt, /highest verified temperature in that window/);
  assert.match(prompt, /Never replace this maximum with a daily maximum or temperatures outside the period/);
  assert.match(prompt, /If coverage is partial, state that limitation/);
  assert.match(prompt, /location, date, hourly coverage, or time zone/);
  assert.match(prompt, /a date beyond the forecast horizon/);
  assert.match(prompt, /Do not invent data or interrupt spreadsheet preparation to ask the user for confirmation/);
  assert.match(prompt, /Cite the source, preferably with a direct link, and the lookup date and time with its time zone/);
  assert.match(prompt, /Fill this column in the Excel file before delivering it/);
  assert.match(prompt, /Use the actual dates of the week starting on 05\/10\/2026, in DD\/MM\/YYYY format/);
  assert.match(prompt, /Calculate each workout date from its weekday using that Monday as the reference: Monday \+0 days, Tuesday \+1, Wednesday \+2, Thursday \+3, Friday \+4, Saturday \+5, and Sunday \+6/);
  assert.match(prompt, /Omitted days or days without a workout do not change the dates of other workouts; row order or row count does not determine a date/);
  assert.match(prompt, /Multiple workouts on the same weekday use the same date/);
  assert.match(prompt, /The weather forecast must match the same local date assigned to the workout/);
  assert.match(prompt, /week starting on 05\/10\/2026, workouts only on Monday and Wednesday use 05\/10\/2026 and 07\/10\/2026/);
  assert.doesNotMatch(prompt, /advancing one day per row/i);
  assert.match(prompt, /73–75 °F, partly cloudy; 12:00–14:00 window, window high 75 °F/);
  assert.match(prompt, /\| Date \| Day \| Period \| Type \| Workout \| Details \| Target HR \| RPE \| Shoe \| Location \| Weather Forecast \| Notes \|/);
  assert.match(prompt, /a ceiling, not a target/);
  assert.match(prompt, /Do not invent an exact start time/);
  assert.match(prompt, /existing “Weather Forecast” column without changing the 12 columns or the Kinesis import format/);
  assert.match(prompt, /Maximum session time: 60 minutes; Location: Fânzeres, Gondomar/);
  assert.doesNotMatch(prompt, /Normal routine|Rotina normal/);
  assert.doesNotMatch(prompt, /ask the user to confirm (?:the )?forecast/i);
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
  assert.match(prompt, /Período preferencial: 08h–12h; Tempo máximo disponível para a sessão: 75 minutos; Local: {3}Fânzeres, Gondomar {2}/);
});

test('legacy multiple periods cannot be silently selected in validation or prompt output', () => {
  const legacy = { ...week, segunda: { ...week.segunda, available_periods: ['08_12', '14_18'] } };
  assert.deepEqual(validatePromptFields({ targetDate: '2026-09-28', disponibilidade: legacy }).missing, ['availability']);
  const prompt = buildPrompt({ targetDate: new Date(2026, 8, 28), disponibilidade: legacy, messages });
  assert.match(prompt, /Segunda: Escolha exatamente um período preferencial/);
  assert.doesNotMatch(prompt, /Segunda: Pode treinar: sim/);
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

test('weekly agenda uses native labeled controls and an unselected session duration', () => {
  const row = buildDayRowHtml('segunda', { dayLabel: 'Segunda-feira', messages: messages.aiCoach, state: {} });
  assert.match(row, /<fieldset class="day-row"/);
  assert.match(row, /type="checkbox" data-can-train/);
  assert.match(row, /data-expand/);
  assert.match(row, /day-summary/);
  assert.match(row, /data-period="before_08"/);
  assert.match(row, /data-duration/);
  assert.match(row, /<input id="availability-monday-duration" type="number" data-duration/);
  assert.match(row, /value="" placeholder="Ex\.: 60"/);
  assert.match(row, /De 1 a 720 minutos, incluindo aquecimento e volta à calma\./);
  assert.match(row, /data-location/);
  assert.match(row, /data-lucide="chevron-down" class="day-expand-icon" aria-hidden="true"/);
  const configuredRow = buildDayRowHtml('segunda', { dayLabel: 'Segunda-feira', messages: messages.aiCoach, state: week.segunda });
  assert.match(configuredRow, /data-day-location-summary[^>]*><i data-lucide="map-pin" aria-hidden="true"><\/i><span>Fânzeres, Gondomar<\/span>/);
  const legacyRow = buildDayRowHtml('segunda', {
    dayLabel: 'Segunda-feira',
    messages: messages.aiCoach,
    state: { can_train: true, available_periods: ['08_12', '14_18'], available_minutes: 75, location: 'Porto' },
  });
  assert.match(legacyRow, /class="legacy-period-summary"[^>]*role="note"/);
  assert.match(legacyRow, /Períodos anteriores salvos/);
  assert.match(legacyRow, /08h–12h; 14h–18h/);
  assert.match(legacyRow, /Escolha um único período preferencial para substituí-las/);
  assert.doesNotMatch(legacyRow, /data-period="08_12"[^>]*checked/);
  assert.doesNotMatch(legacyRow, /data-period="14_18"[^>]*checked/);
  const unsafeRow = buildDayRowHtml('segunda', { dayLabel: 'Segunda-feira', messages: messages.aiCoach, state: { ...week.segunda, location: 'A <b> & "local"' } });
  assert.match(unsafeRow, /<span>A &lt;b&gt; &amp; &quot;local&quot;<\/span>/);
  assert.doesNotMatch(unsafeRow, /<span>A <b>/);
  assert.match(row, /<ul class="day-error"[^>]*data-day-error/);
  const html = readFileSync(join(__dirname, '../src/public/ai-coach.html'), 'utf8');
  assert.match(row, /id="applyWeekdays"/);
  assert.match(row, /data-lucide="copy" aria-hidden="true"/);
  assert.doesNotMatch(row, /id="applyWeekdays" class="btn-secondary"/);
  assert.match(html, /id="availabilityReview"/);
});

test('unavailable day summaries stay compact and details start closed', () => {
  const row = buildDayRowHtml('segunda', {
    dayLabel: 'Segunda-feira',
    messages: messages.aiCoach,
    state: { can_train: false, available_periods: [], available_minutes: null, location: '' },
  });
  assert.match(row, /day-summary-copy"><span data-day-summary>Indisponível/);
  assert.doesNotMatch(row, /day-toggle-status/);
  assert.match(row, /aria-expanded="false"/);
  assert.match(row, /class="day-details"[^>]*hidden/);
  assert.match(row, /data-day-location-summary hidden/);
  assert.doesNotMatch(row, /data-lucide="map-pin"/);
  assert.match(row, /aria-label="Mostrar detalhes Segunda-feira"/);
  assert.doesNotMatch(row, /data-expand[^>]*disabled/);
});

test('weekly agenda keeps the availability checkbox independent from the accordion control', () => {
  for (const day of ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo']) {
    const row = buildDayRowHtml(day, {
      dayLabel: day,
      messages: messages.aiCoach,
      state: { can_train: false, available_periods: [], available_minutes: null, location: '' },
    });
    assert.match(row, /data-can-train/);
    assert.match(row, /data-expand/);
    assert.doesNotMatch(row, /data-expand[^>]*disabled/);
    assert.doesNotMatch(row, /<label class="day-toggle">/);
  }
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
  assert.match(row, /class="day-label">Monday<\/span>/);
  for (const period of ['before_08', '08_12', '12_14', '14_18', 'after_18']) assert.ok(row.includes(`data-period="${period}"`));
  assert.match(row, /checked/);
  assert.match(row, /value="60"/);
  assert.match(row, /Fânzeres, Gondomar/);
  assert.match(row, /aria-label="Monday"/);
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
  assert.match(firstCard('Monday'), /class="day-label">Monday<\/span>/);
  assert.match(firstCard('Sunday'), /class="day-label">Sunday<\/span>/);
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
  assert.match(prompt, /\(ex\.: 23–24 °C, parcialmente nublado; janela 12h–14h, máxima da janela 24 °C\)/);
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

test('Request Workouts locale dictionaries retain translated page, form, prompt and shoe strings', () => {
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
  assert.equal(messages.aiCoach.title, 'Solicitar Treinos');
  assert.equal(messages.aiCoach.pageTitle, 'Solicitar Treinos - Kinesis');
  assert.equal(messages.aiCoach.subtitle, 'Organize seus objetivos e sua disponibilidade para preparar uma solicitação de treinos com IA.');
  assert.equal(enMessages.aiCoach.title, 'Request Workouts');
  assert.equal(enMessages.aiCoach.pageTitle, 'Request Workouts - Kinesis');
  assert.equal(enMessages.aiCoach.subtitle, 'Organize your goals and availability to prepare an AI training request.');
  assert.equal(messages.shell.nav.requestWorkouts, 'Solicitar Treinos');
  assert.equal(enMessages.shell.nav.requestWorkouts, 'Request Workouts');
  assert.equal(messages.home.onboarding.aiAction, 'Planejar com IA');
  assert.equal(enMessages.home.onboarding.aiAction, 'Plan with AI');
  assert.equal(messages.home.onboarding.planText, messages.aiCoach.subtitle);
  assert.equal(enMessages.home.onboarding.planText, enMessages.aiCoach.subtitle);
  assert.equal(messages.aiCoach.periods['08_12'], '08h–12h');
  assert.equal(enMessages.aiCoach.periods['08_12'], '08:00–12:00');
  assert.equal(messages.aiCoach.durationPlaceholder, 'Ex.: 60');
  assert.equal(enMessages.aiCoach.durationPlaceholder, 'e.g. 60');
  assert.equal(messages.aiCoach.durationHint, 'De 1 a 720 minutos, incluindo aquecimento e volta à calma.');
  assert.equal(enMessages.aiCoach.durationHint, 'From 1 to 720 minutes, including warm-up and cool-down.');
  assert.equal(messages.aiCoach.saveAvailability, 'Salvar agenda semanal');
  assert.equal(enMessages.aiCoach.saveAvailability, 'Save weekly schedule');
  assert.equal(messages.aiCoach.availabilitySaved, 'Agenda semanal salva.');
  assert.equal(enMessages.aiCoach.availabilitySaved, 'Weekly schedule saved.');
  assert.equal(typeof messages.aiCoach.availabilityLoading, 'string');
  assert.equal(typeof enMessages.aiCoach.availabilityLoading, 'string');
  assert.equal(typeof messages.aiCoach.availabilityRetry, 'string');
  assert.equal(typeof enMessages.aiCoach.availabilityRetry, 'string');
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
  assert.match(js, /generateBtn\.disabled = !availabilityReady \|\| !validation\.valid/);
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
  assert.match(css, /\.period-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column/);
  assert.doesNotMatch(css, /\.period-list\s*\{[\s\S]*?grid-template-columns/);
  assert.match(css, /input\[data-duration\][\s\S]*?max-width:\s*9rem/);
  assert.match(css, /input\[data-location\][\s\S]*?max-width:\s*28rem/);
  assert.doesNotMatch(css, /\.day-field/);
  assert.match(css, /\.availability-day-field input\s*\{[\s\S]*?font-weight:\s*500/);
  assert.match(css, /\.day-summary\.is-expanded\s+\[data-day-summary\][\s\S]*?display:\s*none/);
  assert.match(css, /\.day-expand\[aria-expanded='true'\]\s+\.day-expand-icon[\s\S]*?transform:\s*rotate\(180deg\)/);
  assert.match(css, /\.day-expand-icon\s*\{[\s\S]*?display:\s*block[\s\S]*?transform-origin:\s*center center/);
  assert.match(css, /\.day-location-summary\[hidden\]\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /\.availability-status\.is-success[\s\S]*?color:\s*var\(--ok\)/);
  assert.match(css, /\.availability-status\.is-error[\s\S]*?color:\s*var\(--danger\)/);
  assert.match(css, /\.availability-save-action\s*\{[\s\S]*?border:\s*0/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.day-error\s*\{[\s\S]*?border-top:\s*1px solid var\(--line\)/);
  assert.match(css, /\.day-copy-action\s*\{[\s\S]*?border:\s*0/);
  assert.doesNotMatch(css, /\.ai-coach-page\s*\{[\s\S]*?overflow-x:\s*hidden/);
  assert.match(theme, /\.btn-primary/);
  assert.match(html, /id="generateBtn"[^>]*class="btn-primary"/);
  assert.match(html, /id="saveAvailability"[^>]*class="availability-save-action"/);
  assert.match(html, /id="saveAvailability"[^>]*><i data-lucide="save" aria-hidden="true"><\/i><span id="saveAvailabilityLabel"><\/span>/);
  assert.match(html, /id="availabilityGrid"/);
});

test('Request Workouts page keeps shell, icon assets and all user-facing prompt controls', () => {
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  assert.match(html, /id="appView"/);
  assert.match(html, /shared\/shell\.js" type="module"/);
  assert.match(html, /ai-coach\.js" type="module"/);
  assert.match(html, /lucide@latest/);
  assert.match(html, /data-i18n="aiCoach\.title"/);
  assert.match(html, /<title data-i18n="aiCoach\.pageTitle">Request Workouts - Kinesis<\/title>/);
  assert.match(html, /<h1 data-i18n="aiCoach\.title">Request Workouts<\/h1>/);
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
  assert.match(js, /function renderDayRows\(states = readFormFields\(\), \{ preserveDays = \[\], focusSnapshot \} = \{\}\)/);
  assert.match(js, /if \(preserveDays\.includes\(day\)\) continue/);
  assert.match(js, /function captureDailyFocus\(\)/);
  assert.match(js, /function restoreDailyFocus\(snapshot\)/);
  assert.match(js, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(js, /document\.addEventListener\('kinesis:preferences-changed'/);
  assert.match(js, /document\.addEventListener\('app:languagechange'/);
  assert.match(js, /renderDayRows\(\);[\s\S]*?targetDatePicker\.refresh\(\)/);
});
