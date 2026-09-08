'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const {
  PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_EN,
  PLACEHOLDERS,
  LOCATION_PLACEHOLDERS,
  DEFAULT_ROUTINE_BY_LANG,
  pad2,
  nextMonday,
  formatDiaSlashes,
  dateInputValue,
  parseInputDate,
  availabilityDefaults,
  applyRoutineDefault,
  resolveTemplateLang,
  defaultRoutineFor,
  orderedDayKeys,
  buildDayRowHtml,
  readDayInputState,
  applyDayInputState,
  renderDayGrid,
  DAY_INPUT_IDS,
  LOCATION_INPUT_IDS,
  validatePromptFields,
  buildPrompt,
  buildPromptContext,
  previousWeekSummary,
  cycleContext,
  copyPromptText,
  formatShoesBlock,
} = require('../src/public/ai-coach.js');

test('pad2 zero-pads single digits only', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(12), '12');
});

test('nextMonday always lands on the following Monday', () => {
  const cases = [
    [new Date(2026, 7, 24), new Date(2026, 7, 31)], // Monday → next week
    [new Date(2026, 7, 25), new Date(2026, 7, 31)], // Tuesday
    [new Date(2026, 7, 26), new Date(2026, 7, 31)], // Wednesday
    [new Date(2026, 7, 30), new Date(2026, 7, 31)], // Sunday
    [new Date(2026, 11, 26), new Date(2026, 11, 28)], // Saturday → month rollover
    [new Date(2026, 11, 31), new Date(2027, 0, 4)], // Thursday → year rollover
  ];
  for (const [from, expected] of cases) {
    const result = nextMonday(from);
    assert.equal(result.getFullYear(), expected.getFullYear());
    assert.equal(result.getMonth(), expected.getMonth());
    assert.equal(result.getDate(), expected.getDate());
    assert.equal(result.getDay(), 1);
    assert.equal(result.getHours(), 0, 'time component is stripped');
  }
});

test('date formatters produce DD/MM/YYYY and yyyy-mm-dd', () => {
  const date = new Date(2026, 7, 3);
  assert.equal(formatDiaSlashes(date), '03/08/2026');
  assert.equal(dateInputValue(date), '2026-08-03');
  assert.equal(formatDiaSlashes(new Date(2027, 0, 17)), '17/01/2027');
});

test('parseInputDate reads the date input as a local date', () => {
  const parsed = parseInputDate('2026-08-31');
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 7);
  assert.equal(parsed.getDate(), 31);
  assert.equal(parseInputDate(''), null);
  assert.equal(parseInputDate('junk'), null);
  assert.equal(parseInputDate(undefined), null);
});

test('availability defaults to the standard routine on all seven days', () => {
  assert.deepEqual(availabilityDefaults(), {
    segunda: 'Rotina normal',
    terca: 'Rotina normal',
    quarta: 'Rotina normal',
    quinta: 'Rotina normal',
    sexta: 'Rotina normal',
    sabado: 'Rotina normal',
    domingo: 'Rotina normal',
  });
});

test('validatePromptFields requires a valid target date, locations and daily routines', () => {
  const complete = {
    targetDate: '31/08/2026',
    language: 'pt-BR',
    baseLocation: 'Fânzeres',
    disponibilidade: Object.fromEntries(Object.keys(DAY_INPUT_IDS).map((day) => [day, 'Rotina normal'])),
    localizacao: {},
  };
  assert.deepEqual(validatePromptFields(complete), { valid: true, missing: [] });
  assert.deepEqual(validatePromptFields({ ...complete, targetDate: '2026-08-31' }), { valid: true, missing: [] });
  assert.deepEqual(validatePromptFields({ ...complete, targetDate: '' }), { valid: false, missing: ['targetDate',] });
  assert.deepEqual(validatePromptFields({ ...complete, baseLocation: '', localizacao: {} }), { valid: false, missing: ['location'] });
  assert.deepEqual(
    validatePromptFields({ ...complete, baseLocation: '', localizacao: Object.fromEntries(Object.keys(DAY_INPUT_IDS).map((day) => [day, 'Porto'])) }),
    { valid: true, missing: [] },
    'individual day locations can satisfy the location requirement'
  );
  assert.deepEqual(
    validatePromptFields({ ...complete, disponibilidade: { ...complete.disponibilidade, domingo: ' ' } }),
    { valid: false, missing: ['availability'] }
  );
  assert.deepEqual(validatePromptFields({ ...complete, targetDate: '31/02/2026' }).missing, ['targetDate']);
  assert.deepEqual(validatePromptFields({ ...complete, targetDate: '2026-02-30' }).missing, ['targetDate']);
});

test('the prompt template keeps the required Portuguese structure', () => {
  assert.match(PROMPT_TEMPLATE, /DATA DA SEMANA/);
  assert.match(PROMPT_TEMPLATE, /DISPONIBILIDADE/);
  assert.match(PROMPT_TEMPLATE, /CONTEXTO ADICIONAL DESTA SEMANA/);
  assert.match(PROMPT_TEMPLATE, /INSTRUÇÕES PARA MONTAR A SEMANA/);
  assert.match(PROMPT_TEMPLATE, /FORMATO DA PLANILHA/);
  assert.match(PROMPT_TEMPLATE, /ARQUIVO EXCEL/);
  assert.match(PROMPT_TEMPLATE, /Fânzeres, Gondomar, Portugal/);
  assert.match(
    PROMPT_TEMPLATE,
    /\| Data \| Dia \| Período \| Tipo \| Treino \| Detalhes \| FC alvo \| RPE \| Tênis \| Previsão do tempo \| Observações \|/
  );
  assert.match(PROMPT_TEMPLATE, /15\. O objetivo não é maximizar cada treino individualmente\./);
  assert.match(
    PROMPT_TEMPLATE,
    /DATA DA SEMANA\n\nA semana a ser planejada começa em:\n\{\{DATA_DA_SEGUNDA\}\}\n\n\{\{SHOES_BLOCK\}\}\n\nDISPONIBILIDADE/,
    'shoes block sits between the date and availability sections'
  );
  assert.match(
    PROMPT_TEMPLATE,
    /CONTEXTO ADICIONAL DESTA SEMANA\n\n\{\{CONTEXTO_OPCIONAL\}\}\n\nINSTRUÇÕES PARA MONTAR A SEMANA/,
    'context section flows straight into the instructions'
  );
  const ptRule =
    'REGRA ESTRITA: NUNCA adicione linhas de notas, observações, rodapés ou células mescladas na planilha. A planilha deve conter EXCLUSIVAMENTE a linha de cabeçalho e as linhas de treino. Qualquer explicação extra deve ir apenas no texto da sua resposta, nunca no arquivo.';
  assert.ok(PROMPT_TEMPLATE.includes(ptRule), 'strict no-notes Excel rule present');
  assert.ok(
    PROMPT_TEMPLATE.indexOf('ARQUIVO EXCEL') !== -1 &&
      PROMPT_TEMPLATE.indexOf(ptRule) > PROMPT_TEMPLATE.indexOf('ARQUIVO EXCEL'),
    'strict rule lives inside the ARQUIVO EXCEL section'
  );
  assert.ok(!PROMPT_TEMPLATE.includes('Exemplos:'), 'example list lives in the UI, not the prompt');

  const tokens = PROMPT_TEMPLATE.match(/\{\{[A-Z_]+\}\}/g) ?? [];
  assert.equal(tokens.length, 28, 'the template carries the schedule, location, cycle-context, and unit placeholders');
  assert.deepEqual(tokens, [
    '{{UNIT_INSTRUCTION}}',
    '{{CYCLE_NAME}}',
    '{{CYCLE_GOAL}}',
    '{{TARGET_RACE_DATE}}',
    '{{CURRENT_WEEK}}',
    '{{DAYS_REMAINING}}',
    '{{PREV_WEEK_TRAININGS}}',
    '{{DISTANCE_UNIT_LABEL}}',
    '{{PREV_WEEK_DISTANCE_KM}}',
    '{{PREV_WEEK_TIME_MINUTES}}',
    '{{DATA_DA_SEGUNDA}}',
    '{{SHOES_BLOCK}}',
    '{{DISP_SEG}}',
    '{{LOCAL_SEG}}',
    '{{DISP_TER}}',
    '{{LOCAL_TER}}',
    '{{DISP_QUA}}',
    '{{LOCAL_QUA}}',
    '{{DISP_QUI}}',
    '{{LOCAL_QUI}}',
    '{{DISP_SEX}}',
    '{{LOCAL_SEX}}',
    '{{DISP_SAB}}',
    '{{LOCAL_SAB}}',
    '{{DISP_DOM}}',
    '{{LOCAL_DOM}}',
    '{{CONTEXTO_OPCIONAL}}',
    '{{WEATHER_EXAMPLE}}',
  ]);
});

test('buildPrompt replaces every placeholder with user values', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {
      segunda: 'Manhã, antes das 8h',
      terca: 'Manhã, antes das 8h',
      quarta: 'Manhã, antes das 8h',
      quinta: 'Manhã, antes das 8h',
      sexta: 'Manhã, antes das 8h',
      sabado: 'Livre o dia todo',
      domingo: 'Manhã, entre 8h e 9h',
    },
    contexto: 'viagem na terça; pouco sono na quinta.',
  });

  assert.ok(!prompt.includes('{{'), 'no placeholder survives generation');
  assert.ok(prompt.includes('A semana a ser planejada começa em:\n31/08/2026'));
  assert.ok(prompt.includes('- Segunda-feira: Manhã, antes das 8h (Local: -)'));
  assert.ok(prompt.includes('- Domingo: Manhã, entre 8h e 9h (Local: -)'));
  assert.ok(prompt.includes('viagem na terça; pouco sono na quinta.'));
});

test('buildPrompt injects current cycle and previous-week context in Portuguese', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    cycle: {
      name: 'Base Lisboa',
      goal: 'Correr abaixo de 2h',
      target_date: '2026-10-18',
      currentWeek: 4,
      totalWeeks: 12,
      daysRemaining: 38,
    },
    previousWeek: {
      completedTrainingsCount: 4,
      totalDistanceKm: 42.5,
      totalTimeMinutes: 238,
    },
  });

  const intro = prompt.indexOf('Quero que você gere minha planilha');
  const cycle = prompt.indexOf('CONTEXTO DO CICLO ATUAL');
  const checklist = prompt.indexOf('Use TODO o contexto disponível');
  assert.ok(intro < cycle && cycle < checklist, 'cycle context follows the introduction before the checklist');
  assert.match(prompt, /Nome do ciclo: Base Lisboa/);
  assert.match(prompt, /Meta do ciclo: Correr abaixo de 2h/);
  assert.match(prompt, /Data da prova-alvo: 18\/10\/2026/);
  assert.match(prompt, /Semana atual: Semana 4 de 12/);
  assert.match(prompt, /Dias restantes: 38/);
  assert.match(prompt, /Treinos concluídos na semana anterior: 4/);
  assert.match(prompt, /Distância total da semana anterior \(km\): 42\.5/);
  assert.match(prompt, /Tempo total da semana anterior \(minutos\): 238/);
});

test('buildPrompt falls back to defaults for untouched days and context', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: { quarta: 'Só à noite' },
    contexto: '',
  });

  assert.ok(prompt.includes('- Segunda-feira: Rotina normal (Local: -)'));
  assert.ok(prompt.includes('- Quarta-feira: Só à noite (Local: -)'));
  assert.ok(prompt.includes('\n-\n'), 'empty context renders a dash placeholder value');
});

test('buildPrompt trims whitespace from availability and context', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: { segunda: '  Tarde  ' },
    contexto: '  calor forte previsto  ',
  });
  assert.ok(prompt.includes('- Segunda-feira: Tarde (Local: -)\n'));
  assert.ok(prompt.includes('\ncalor forte previsto\n'));
});

test('copyPromptText writes through the Clipboard API', async () => {
  const written = [];
  const clipboard = { writeText: async (text) => written.push(text) };

  assert.equal(await copyPromptText('meu prompt', clipboard), true);
  assert.deepEqual(written, ['meu prompt']);
});

test('copyPromptText reports failures instead of throwing', async () => {
  const rejecting = { writeText: async () => { throw new Error('denied'); } };
  assert.equal(await copyPromptText('x', rejecting), false);
  assert.equal(await copyPromptText('x', undefined), false);
  assert.equal(await copyPromptText('x', {}), false);
});

test('copyPromptText uses the global navigator clipboard by default', async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const written = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => written.push(text) } },
  });
  try {
    assert.equal(await copyPromptText('clipboard default path'), true);
    assert.deepEqual(written, ['clipboard default path']);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    }
  }
});

test('ai-coach.html wires the shell, lucide and the full form', () => {
  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');

  assert.match(html, /shared\/shell\.css/);
  assert.match(html, /ai-coach\.css/);
  assert.match(html, /unpkg\.com\/lucide@latest/);
  assert.match(html, /shared\/shell\.js" type="module"/);
  assert.match(html, /ai-coach\.js" type="module"/);
  assert.match(html, /id="appView"/);

  assert.match(
    html,
    /<title data-i18n="aiCoach\.pageTitle">Request Workouts - Kinesis<\/title>/,
    'the browser tab title is i18n-bound with the Kinesis suffix'
  );
  assert.match(html, /<h1 data-i18n="aiCoach\.title">Request Workouts<\/h1>/);

  assert.match(html, /type="date" id="targetDate"[^>]*required/);
  assert.match(html, /for="targetDate" data-i18n="aiCoach\.targetDate">[^<]*<span class="required-mark"/);
  assert.match(
    html,
    /class="availability-grid" id="availabilityGrid"[\s\S]*?<\/div>/,
    'the day cards are rendered dynamically into the availability grid container'
  );
  assert.ok(!html.includes('id="dispSeg"'), 'no hardcoded day availability inputs remain in the page');
  assert.ok(!html.includes('value="Rotina normal"'), 'day routines are injected by the renderer, not the page');
  assert.ok(!html.includes('id="locSeg"'), 'no hardcoded day location inputs remain in the page');
  assert.match(html, /type="text" id="baseLocation"/);
  assert.match(
    html,
    /type="text" id="baseLocation" data-i18n-placeholder="aiCoach\.locationPlaceholder" placeholder="Ex: City, Country"/,
    'the base location input ships a generic, i18n-bound placeholder'
  );
  assert.match(html, /for="baseLocation" data-i18n="aiCoach\.baseLocation"/);
  assert.match(html, /data-i18n="aiCoach\.baseLocationHint"/);
  assert.match(html, /<textarea id="optionalContext"/);
  assert.match(html, /type="submit" id="generateBtn" class="btn-primary"/);
  assert.ok(!html.includes('generate-btn'), 'the scoped generate-btn class is retired');
  assert.match(
    html,
    /<i data-lucide="sparkles"[^>]*><\/i>\s*<span data-i18n=/,
    'the icon renders directly before the label span'
  );
  assert.match(html, /data-lucide="sparkles"/);
  assert.match(html, /id="copyBtn"/);
  assert.match(html, /data-lucide="copy"/);
  assert.match(html, /<pre id="promptOutput"/);
  assert.match(html, /data-i18n="aiCoach\.title"/);
});

test('training request date input uses localized display with ISO state binding', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');
  assert.match(js, /normalizeTargetDate/);
  assert.match(js, /parseLocalizedDate/);
  assert.match(js, /targetDateInput\.dataset\.iso/);
  assert.match(js, /const targetDate = parseInputDate\(targetIso\)/);
});

test('availability day rows stack the availability and location inputs vertically', () => {
  const css = readFileSync(join(publicDir, 'ai-coach.css'), 'utf8');

  assert.match(
    css,
    /\.day-row \{[^}]*grid-template-columns:\s*1fr;/,
    'the availability and location inputs stack in a single column'
  );
  assert.match(css, /\.day-row \{[^}]*gap:\s*0\.5rem/, 'a vertical gap keeps the stacked inputs apart');
  assert.match(css, /\.day-row \.day-label \{[^}]*grid-column:\s*1 \/ -1/, 'the day label spans the full row');
  assert.match(css, /\.day-row \{[^}]*border-radius:\s*12px/, 'each day is grouped inside its own card');
  assert.match(css, /\.day-row input\[type='text'\] \{[^}]*width:\s*100%/, 'both inputs fill the full day-card width');
  assert.ok(!css.includes('grid-template-columns: 1fr 1fr'), 'no side-by-side day layout remains');
  assert.ok(!css.includes('@media (max-width: 560px)'), 'stacking no longer needs a mobile-only override');
  assert.match(css, /\.required-mark \{[^}]*color:\s*var\(--danger\)/);
  assert.match(css, /\.btn-primary:disabled \{[^}]*cursor:\s*not-allowed[^}]*opacity:\s*0\.55/);
});

test('orderedDayKeys starts the week on the preferred day', () => {
  assert.deepEqual(orderedDayKeys('Monday'), [
    'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
  ], 'monday-preference renders Monday through Sunday');
  assert.deepEqual(orderedDayKeys('Sunday'), [
    'domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado',
  ], 'sunday-preference renders Sunday through Saturday');
  assert.deepEqual(orderedDayKeys(), orderedDayKeys('Monday'), 'Monday is the default week start');
  assert.equal(orderedDayKeys('Monday').length, 7);
  assert.equal(orderedDayKeys('Sunday').length, 7);
});

test('the first rendered day card follows the week-start preference', () => {
  const buildRows = (weekStart) => orderedDayKeys(weekStart).map((day) =>
    buildDayRowHtml(day, { dayLabel: day, routine: 'Rotina normal', locationPlaceholder: 'Local' })
  );

  const mondayOrdered = buildRows('Monday');
  assert.match(mondayOrdered[0], /aiCoach\.days\.monday/, 'monday preference leads with the Monday card');
  assert.match(mondayOrdered[6], /aiCoach\.days\.sunday/, 'monday preference ends with the Sunday card');

  const sundayOrdered = buildRows('Sunday');
  assert.match(sundayOrdered[0], /aiCoach\.days\.sunday/, 'sunday preference leads with the Sunday card');
  assert.match(sundayOrdered[6], /aiCoach\.days\.saturday/, 'sunday preference ends with the Saturday card');
});

test('buildDayRowHtml wires daily state to its own availability and location inputs', () => {
  const row = buildDayRowHtml('segunda', {
    dayLabel: 'Monday',
    routine: 'Rotina normal',
    locationPlaceholder: 'Local',
  });
  assert.match(row, /^<div class="day-row">\s*<label for="dispSeg"/);
  assert.match(row, /class="day-label" data-i18n="aiCoach\.days\.monday">Monday<span class="required-mark"/);
  assert.match(row, /id="dispSeg" value="Rotina normal" autocomplete="off"/);
  assert.match(row, /id="locSeg" data-i18n-placeholder="aiCoach\.location" placeholder="Local" autocomplete="off"/);

  const sundayRow = buildDayRowHtml('domingo', { dayLabel: 'Domingo', routine: 'rotina', locationPlaceholder: 'Local' });
  assert.match(sundayRow, /data-i18n="aiCoach\.days\.sunday">Domingo<span class="required-mark"/);
  assert.match(sundayRow, /id="dispDom"/);
  assert.match(sundayRow, /id="locDom"/);
});

test('day cards render dynamically from the user week-start preference', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');

  assert.match(js, /import \{ initShell, getShellI18n, getUserPreferences, refreshIcons \}/);
  assert.match(js, /const availabilityGrid = document\.getElementById\('availabilityGrid'\)/);
  assert.match(js, /renderDayGrid\(\{/);
  assert.match(js, /weekStart: getUserPreferences\(\)\.first_day_of_week/);
  assert.match(js, /grid\.innerHTML = orderedDayKeys\(weekStart\)/);
  assert.match(js, /\.map\(\(day\) => buildDayRowHtml\(day/);
  assert.match(js, /data-i18n="aiCoach\.days\.\$\{DAY_LOCALE_KEYS\[day\]\}"/);
  assert.match(js, /kinesis:preferences-changed/);
  assert.ok(!js.includes('for (const inputId of Object.values(DAY_INPUT_IDS))'), 'input defaults flow through the renderer only');
});

test('day state is a day-keyed dictionary that round-trips both input fields', () => {
  const dom = { values: {} };
  const getValue = (id) => dom.values[id];
  const setValue = (id, value) => { dom.values[id] = value; };

  const state = readDayInputState(getValue);
  assert.equal(Object.keys(state).length, 7, 'one record per day');
  assert.ok(Object.keys(state).every((day) => 'availability' in state[day] && 'location' in state[day]));

  dom.values[DAY_INPUT_IDS.segunda] = 'Rotina normal';
  dom.values[LOCATION_INPUT_IDS.segunda] = 'Fânzeres';
  applyDayInputState(readDayInputState(getValue), setValue);
  assert.equal(dom.values[DAY_INPUT_IDS.segunda], 'Rotina normal');
  assert.equal(dom.values[LOCATION_INPUT_IDS.segunda], 'Fânzeres');

  const partial = { terceira: { availability: undefined, location: 'X' } };
  applyDayInputState(partial, setValue);
  assert.equal(dom.values[LOCATION_INPUT_IDS.terceira], undefined, 'unknown days and undefined fields are skipped');
});

test('changing the week start keeps the cascaded daily locations filled', () => {
  const grid = { innerHTML: '' };
  const dom = { values: {} };
  const getValue = (id) => dom.values[id];
  const setValue = (id, value) => { dom.values[id] = value; };

  const render = (weekStart) => renderDayGrid({
    weekStart,
    routine: 'Rotina normal',
    grid,
    getValue,
    setValue,
  });

  for (const id of Object.values(DAY_INPUT_IDS)) {
    dom.values[id] = 'Rotina normal';
  }

  render('Monday');
  assert.match(grid.innerHTML, /aiCoach\.days\.monday[\s\S]*aiCoach\.days\.sunday/, 'monday preference mounts Monday first');

  const baseLocation = 'Fânzeres';
  for (const id of Object.values(LOCATION_INPUT_IDS)) {
    setValue(id, baseLocation);
  }

  render('Sunday');
  assert.match(grid.innerHTML, /aiCoach\.days\.sunday[\s\S]*aiCoach\.days\.saturday/, 'sunday preference re-mounts Sunday first');
  for (const id of Object.values(LOCATION_INPUT_IDS)) {
    assert.equal(dom.values[id], baseLocation, `${id} keeps its cascaded value after the re-mount`);
  }
  for (const id of Object.values(DAY_INPUT_IDS)) {
    assert.equal(dom.values[id], 'Rotina normal', `${id} keeps the routine default`);
  }
});

test('manual location overrides survive a week-start re-mount', () => {
  const grid = { innerHTML: '' };
  const dom = { values: {} };
  const getValue = (id) => dom.values[id];
  const setValue = (id, value) => { dom.values[id] = value; };

  const render = (weekStart) => renderDayGrid({
    weekStart,
    routine: 'Rotina normal',
    grid,
    getValue,
    setValue,
  });

  render('Monday');
  setValue(DAY_INPUT_IDS.quarta, 'Manhã');
  setValue(LOCATION_INPUT_IDS.quarta, 'Estrada da Ponte');
  setValue(LOCATION_INPUT_IDS.sabado, 'Fânzeres');

  render('Sunday');

  assert.equal(dom.values[DAY_INPUT_IDS.quarta], 'Manhã');
  assert.equal(dom.values[LOCATION_INPUT_IDS.quarta], 'Estrada da Ponte');
  assert.equal(dom.values[LOCATION_INPUT_IDS.sabado], 'Fânzeres');
  assert.equal(dom.values[LOCATION_INPUT_IDS.domingo], undefined, 'the first Sunday mount fills no location default');
});

test('day-based location inputs are wired through LOCATION_INPUT_IDS', () => {
  assert.deepEqual(LOCATION_PLACEHOLDERS, {
    segunda: '{{LOCAL_SEG}}',
    terca: '{{LOCAL_TER}}',
    quarta: '{{LOCAL_QUA}}',
    quinta: '{{LOCAL_QUI}}',
    sexta: '{{LOCAL_SEX}}',
    sabado: '{{LOCAL_SAB}}',
    domingo: '{{LOCAL_DOM}}',
  });
  assert.equal(Object.keys(LOCATION_PLACEHOLDERS).length, 7);
  assert.deepEqual(Object.keys(PLACEHOLDERS), Object.keys(LOCATION_PLACEHOLDERS));
});

test('buildPrompt injects a per-day location after the availability text', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    localizacao: {
      segunda: 'Parque da Cidade',
      sabado: 'Fânzeres',
    },
  });

  assert.ok(prompt.includes('- Segunda-feira: Rotina normal (Local: Parque da Cidade)'));
  assert.ok(prompt.includes('- Sábado: Rotina normal (Local: Fânzeres)'));
  assert.ok(prompt.includes('- Terça-feira: Rotina normal (Local: -)'), 'unset days render the dash placeholder');
  assert.ok(!prompt.includes('{{LOCAL_'), 'no location placeholder survives generation');
});

test('buildPrompt injects English locations with the Location label', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    lang: 'en-US',
    localizacao: {
      domingo: 'Riverfront',
    },
  });

  assert.ok(prompt.includes('- Sunday: Normal routine (Location: Riverfront)'));
  assert.ok(prompt.includes('- Monday: Normal routine (Location: -)'));
  assert.ok(!prompt.includes('{{LOCAL_'));
});

test('buildPrompt trims location whitespace and cascades an empty override to a dash', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    localizacao: {
      quarta: '  Estrada da Ponte  ',
      sexta: '',
    },
  });

  assert.ok(prompt.includes('- Quarta-feira: Rotina normal (Local: Estrada da Ponte)'));
  assert.ok(prompt.includes('- Sexta-feira: Rotina normal (Local: -)'));
});

test('the generate button matches the shared primary hover contract', () => {
  const css = readFileSync(join(publicDir, 'ai-coach.css'), 'utf8');
  const theme = readFileSync(join(publicDir, 'shared', 'theme.css'), 'utf8');

  assert.ok(!css.includes('.generate-btn'), 'no scoped generate-btn rules remain');
  assert.match(
    theme,
    /\.btn-primary \{[^}]*display:\s*inline-flex;\s*\n\s*align-items:\s*center;\s*\n\s*justify-content:\s*center;\s*\n\s*gap:\s*0\.5rem/,
    'the icon and the label share one strict flex centering rule'
  );
  assert.match(
    theme,
    /\.btn-primary > svg \{[^}]*flex-shrink:\s*0/,
    'the sparkles icon cannot drift or squish inside the button'
  );
  assert.match(
    css,
    /\.btn-primary \{[^}]*transition:\s*all 0\.2s ease/,
    'one smooth animation curve for the primary action'
  );
  assert.match(
    css,
    /\.btn-primary:hover:not\(:disabled\) \{[^}]*transform:\s*translateY\(-2px\)/,
    'the button lifts exactly like the training-result primary'
  );
  assert.match(css, /\.btn-primary:hover:not\(:disabled\) \{[^}]*background:\s*#405c46/);
  assert.ok(!css.includes('translateY(-1px)'), 'the old subtle lift is gone');
});

test('locale files expose every ai-coach string in both languages', async () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

  for (const messages of [en, pt]) {
    assert.equal(typeof messages.aiCoach.title, 'string');
    assert.equal(typeof messages.aiCoach.pageTitle, 'string');
    assert.equal(typeof messages.aiCoach.targetDate, 'string');
    assert.equal(typeof messages.aiCoach.baseLocation, 'string');
    assert.equal(typeof messages.aiCoach.baseLocationHint, 'string');
    assert.equal(typeof messages.aiCoach.locationPlaceholder, 'string');
    assert.equal(typeof messages.aiCoach.location, 'string');
    assert.equal(Object.keys(messages.aiCoach.days).length, 7);
    assert.equal(typeof messages.aiCoach.generate, 'string');
    assert.equal(typeof messages.aiCoach.copy, 'string');
    assert.equal(typeof messages.aiCoach.copied, 'string');
    assert.equal(typeof messages.aiCoach.shoesSectionTitle, 'string');
    assert.equal(typeof messages.aiCoach.shoesFallback, 'string');
    assert.equal(typeof messages.aiCoach.shoesTarget, 'string');
    assert.equal(typeof messages.shell.nav.requestWorkouts, 'string');
  }

  assert.notEqual(en.aiCoach.title, pt.aiCoach.title);
  assert.equal(en.aiCoach.baseLocation, 'Base location');
  assert.equal(pt.aiCoach.baseLocation, 'Localidade base');
  assert.equal(en.aiCoach.locationPlaceholder, 'Ex: City, Country');
  assert.equal(pt.aiCoach.locationPlaceholder, 'Ex: Cidade, País');
  assert.equal(en.aiCoach.location, 'Location');
  assert.equal(pt.aiCoach.location, 'Local');
  assert.match(en.aiCoach.pageTitle, /- Kinesis$/);
  assert.match(pt.aiCoach.pageTitle, /- Kinesis$/);
  assert.equal(en.aiCoach.pageTitle, 'Request Workouts - Kinesis');
  assert.equal(pt.aiCoach.pageTitle, 'Solicitar Treinos - Kinesis');
  assert.equal(en.aiCoach.shoesSectionTitle, 'SHOES AVAILABLE FOR ROTATION');
  assert.equal(pt.aiCoach.shoesSectionTitle, 'TÊNIS DISPONÍVEIS PARA ROTAÇÃO');
});

test('the default routine string is language-aware', () => {
  assert.deepEqual(DEFAULT_ROUTINE_BY_LANG, {
    'en-US': 'Normal routine',
    'pt-BR': 'Rotina normal',
  });
  assert.equal(defaultRoutineFor('en-US'), 'Normal routine');
  assert.equal(defaultRoutineFor('pt-BR'), 'Rotina normal');
  assert.equal(defaultRoutineFor('junk'), 'Normal routine', 'app-wide en-US fallback');

  assert.deepEqual(availabilityDefaults('pt-BR'), availabilityDefaults());
  for (const value of Object.values(availabilityDefaults('en-US'))) {
    assert.equal(value, 'Normal routine');
  }
});

test('applyRoutineDefault rewrites only untouched day values', () => {
  const values = {
    segunda: 'Rotina normal',
    terca: 'Só depois das 19h',
    quarta: 'Rotina normal',
    quinta: '',
    sexta: 'Rotina normal',
    sabado: 'Livre',
    domingo: 'Rotina normal',
  };
  assert.deepEqual(
    applyRoutineDefault(values, 'Rotina normal', 'Normal routine'),
    {
      segunda: 'Normal routine',
      terca: 'Só depois das 19h',
      quarta: 'Normal routine',
      quinta: '',
      sexta: 'Normal routine',
      sabado: 'Livre',
      domingo: 'Normal routine',
    }
  );
  assert.deepEqual(
    applyRoutineDefault({ segunda: 'Custom' }, 'Rotina normal', 'Rotina normal'),
    { segunda: 'Custom' },
    'identical defaults leave everything untouched'
  );
});

test('resolveTemplateLang keeps Portuguese as the template fallback', () => {
  assert.equal(resolveTemplateLang('pt-BR'), 'pt-BR');
  assert.equal(resolveTemplateLang('en-US'), 'en-US');
  assert.equal(resolveTemplateLang('fr-FR'), 'pt-BR');
  assert.equal(resolveTemplateLang(undefined), 'pt-BR');
});

test('both templates carry the identical placeholder contract', () => {
  const tokensOf = (template) => template.match(/\{\{[A-Z_]+\}\}/g) ?? [];
  assert.deepEqual(tokensOf(PROMPT_TEMPLATE_EN), tokensOf(PROMPT_TEMPLATE));
  assert.match(PROMPT_TEMPLATE_EN, /WEEK DATE/);
  assert.match(PROMPT_TEMPLATE_EN, /AVAILABILITY/);
  assert.match(PROMPT_TEMPLATE_EN, /ADDITIONAL CONTEXT FOR THIS WEEK/);
  assert.match(PROMPT_TEMPLATE_EN, /INSTRUCTIONS FOR PLANNING THE WEEK/);
  assert.match(PROMPT_TEMPLATE_EN, /SPREADSHEET FORMAT/);
  assert.match(PROMPT_TEMPLATE_EN, /EXCEL FILE/);
  assert.match(PROMPT_TEMPLATE_EN, /Fânzeres, Gondomar, Portugal/);
  assert.match(
    PROMPT_TEMPLATE_EN,
    /\| Date \| Day \| Period \| Type \| Workout \| Details \| Target HR \| RPE \| Shoe \| Weather Forecast \| Notes \|/
  );
  assert.match(
    PROMPT_TEMPLATE_EN,
    /If recent data indicates that the originally expected plan should be altered, prioritize the correct adaptation/
  );
  assert.match(
    PROMPT_TEMPLATE_EN,
    /WEEK DATE\n\nThe week to be planned starts on:\n\{\{DATA_DA_SEGUNDA\}\}\n\n\{\{SHOES_BLOCK\}\}\n\nAVAILABILITY/,
    'shoes block sits between the date and availability sections'
  );
  assert.match(
    PROMPT_TEMPLATE_EN,
    /ADDITIONAL CONTEXT FOR THIS WEEK\n\n\{\{CONTEXTO_OPCIONAL\}\}\n\nINSTRUCTIONS FOR PLANNING THE WEEK/,
    'context section flows straight into the instructions'
  );
  const enRule =
    'STRICT RULE: NEVER add note rows, observations, footers, or merged cells inside the spreadsheet. The spreadsheet must EXCLUSIVELY contain the header row and the training rows. Any extra explanations must go only in the text of your response, never in the file.';
  assert.ok(PROMPT_TEMPLATE_EN.includes(enRule), 'strict no-notes Excel rule present');
  assert.ok(
    PROMPT_TEMPLATE_EN.indexOf('EXCEL FILE') !== -1 &&
      PROMPT_TEMPLATE_EN.indexOf(enRule) > PROMPT_TEMPLATE_EN.indexOf('EXCEL FILE'),
    'strict rule lives inside the EXCEL FILE section'
  );
  assert.ok(!PROMPT_TEMPLATE_EN.includes('Examples:'), 'example list lives in the UI, not the prompt');
  assert.ok(!PROMPT_TEMPLATE.includes('{{DISPONIBILIDADE}}'));
});

test('buildPrompt generates the English template in English mode', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: 'traveling on Tuesday',
    lang: 'en-US',
  });

  assert.ok(prompt.startsWith('I want you to generate my running training schedule'));
  assert.ok(prompt.includes('The week to be planned starts on:\n08/31/2026'));
  assert.ok(prompt.includes('- Monday: Normal routine (Location: -)'));
  assert.ok(prompt.includes('- Sunday: Normal routine (Location: -)'));
  assert.ok(!prompt.includes('Rotina normal'), 'no Portuguese leftovers in EN output');
  assert.ok(!prompt.includes('{{'));
  assert.ok(prompt.includes('traveling on Tuesday'));
});

test('buildPrompt injects localized cycle and previous-week context in English', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    lang: 'en-US',
    cycle: {
      name: 'Lisbon Base',
      primary_goal: 'Run under 2 hours',
      target_date: '2026-10-18',
      current_week: 4,
      total_weeks: 12,
      days_remaining: 38,
    },
    previousWeek: {
      completed_trainings_count: 4,
      total_distance_km: 42.5,
      total_time_minutes: 238,
    },
  });

  const intro = prompt.indexOf('I want you to generate my running training schedule');
  const cycle = prompt.indexOf('CURRENT CYCLE CONTEXT');
  const checklist = prompt.indexOf('Use ALL available context');
  assert.ok(intro < cycle && cycle < checklist);
  assert.match(prompt, /Cycle name: Lisbon Base/);
  assert.match(prompt, /Cycle goal: Run under 2 hours/);
  assert.match(prompt, /Target race date: 10\/18\/2026/);
  assert.match(prompt, /Current week: Week 4 of 12/);
  assert.match(prompt, /Days remaining: 38/);
  assert.match(prompt, /Completed trainings in the previous week: 4/);
  assert.match(prompt, /Previous week total distance \(km\): 42\.5/);
  assert.match(prompt, /Previous week total time \(minutes\): 238/);
});

test('buildPrompt converts previous-week distance and instructs the coach to use imperial units', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    lang: 'en-US',
    preferences: { distance_unit: 'mi', temperature_unit: 'F' },
    previousWeek: { totalDistanceKm: 15, totalTimeMinutes: 90, completedTrainingsCount: 2 },
  });

  assert.match(prompt, /Use miles for all distances and °F for all temperatures/);
  assert.match(prompt, /Previous week total distance \(miles\): 9\.32 mi/);
  assert.match(prompt, /Weather Forecast.*73–75 °F/s);
  assert.doesNotMatch(prompt, /Previous week total distance \(km\)/);
});

test('buildPrompt localizes metric unit instructions and weather examples in Portuguese', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    lang: 'pt-BR',
    preferences: { distance_unit: 'km', temperature_unit: 'C' },
  });

  assert.match(prompt, /Use quilômetros para todas as distâncias e °C para todas as temperaturas/);
  assert.match(prompt, /Previsão do tempo.*\(ex: 23–24 °C, parcialmente nublado \(~12h\)\)/s);
});

test('buildPromptContext binds the active cycle and completed previous-week metrics', () => {
  const targetDate = new Date(2026, 7, 31);
  const context = buildPromptContext({
    targetDate,
    today: new Date(2026, 7, 24),
    cycle: {
      objective: 'Base Lisboa',
      primary_goal: 'Correr abaixo de 2h',
      start_date: '2026-08-03',
      target_date: '2026-10-18',
    },
    trainings: [
      { dia: '2026-08-24', fit_distance: '10', fit_duration: '1:00:00' },
      { dia: '2026-08-30', fit_distance: 5.5, fit_duration: '00:32:00' },
      { dia: '2026-08-31', fit_distance: 99, fit_duration: '9:00:00' },
    ],
  });

  assert.equal(context.cycle.name, 'Base Lisboa', 'cycle objective maps to the prompt name');
  assert.equal(context.cycle.goal, 'Correr abaixo de 2h', 'goal maps from the primary_goal alias');
  assert.equal(context.cycle.primary_goal, 'Correr abaixo de 2h');
  assert.equal(context.cycle.currentWeek, 4);
  assert.equal(context.cycle.totalWeeks, 11);
  assert.equal(context.cycle.daysRemaining, 55);
  assert.deepEqual(context.previousWeek, {
    completedTrainingsCount: 2,
    totalDistanceKm: 15.5,
    totalTimeMinutes: 92,
  });

  const prompt = buildPrompt({ targetDate, ...context });
  assert.match(prompt, /Nome do ciclo: Base Lisboa/);
  assert.match(prompt, /Meta do ciclo: Correr abaixo de 2h/);
  assert.match(prompt, /Treinos concluídos na semana anterior: 2/);
  assert.match(prompt, /Distância total da semana anterior \(km\): 15\.5/);
  assert.match(prompt, /Tempo total da semana anterior \(minutos\): 92/);
  assert.ok(!prompt.includes('Nome do ciclo: -'));
});

test('previousWeekSummary handles empty or malformed training data safely', () => {
  const targetDate = new Date(2026, 7, 31);
  assert.deepEqual(previousWeekSummary(null, targetDate), {
    completedTrainingsCount: 0,
    totalDistanceKm: 0,
    totalTimeMinutes: 0,
  });
  assert.deepEqual(previousWeekSummary([
    { dia: '2026-08-24', fit_distance: 'bad', fit_duration: 'bad' },
    { dia: '2026-08-25', completed: true },
  ], targetDate), {
    completedTrainingsCount: 1,
    totalDistanceKm: 0,
    totalTimeMinutes: 0,
  });
});

test('buildPrompt keeps the Portuguese template by default and for unknown languages', () => {
  for (const lang of [undefined, 'pt-BR', 'fr-FR']) {
    const prompt = buildPrompt({
      targetDate: new Date(2026, 7, 31),
      disponibilidade: {},
      contexto: '',
      lang,
    });
    assert.ok(prompt.startsWith('Quero que você gere minha planilha de treinos'));
    assert.ok(prompt.includes('- Segunda-feira: Rotina normal (Local: -)'));
    assert.ok(!prompt.includes('{{'));
  }
});

test('buildPrompt merges user values over language-aware defaults', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: { segunda: 'Evening only' },
    contexto: '',
    lang: 'en-US',
  });
  assert.ok(prompt.includes('- Monday: Evening only (Location: -)'));
  assert.ok(prompt.includes('- Tuesday: Normal routine (Location: -)'));
});

test('formatShoesBlock renders active shoes with mileage and target', () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const shoes = [
    { brand: 'Nike', model: 'Pegasus 41', mileage: 320, target_mileage: 800, status: 'active' },
    { brand: 'Asics', model: 'Nimbus 26', mileage: 150, target_mileage: null, status: 'active' },
  ];
  const block = formatShoesBlock(shoes, en);
  assert.ok(block.includes('SHOES AVAILABLE FOR ROTATION'));
  assert.ok(block.includes('- Nike Pegasus 41 (Current mileage: 320 km, Target: 800 km)'));
  assert.ok(block.includes('- Asics Nimbus 26 (Current mileage: 150 km)'));
  assert.ok(!block.includes('Nimbus 26 (Current mileage: 150 km, Target:'));
});

test('formatShoesBlock shows fallback when no active shoes exist', () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const shoes = [
    { brand: 'Nike', model: 'Vaporfly', mileage: 500, status: 'retired' },
  ];
  const block = formatShoesBlock(shoes, en);
  assert.ok(block.includes('SHOES AVAILABLE FOR ROTATION'));
  assert.ok(block.includes('No specific shoes registered; use standard rotation.'));
  assert.ok(!block.includes('Vaporfly'));
});

test('formatShoesBlock shows fallback for empty array', () => {
  const block = formatShoesBlock([], {});
  assert.ok(block.includes('SHOES AVAILABLE FOR ROTATION'));
  assert.ok(block.includes('No specific shoes registered; use standard rotation.'));
});

test('formatShoesBlock uses Portuguese locale keys', () => {
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));
  const shoes = [
    { brand: 'Nike', model: 'Pegasus 41', mileage: 320, target_mileage: 800, status: 'active' },
  ];
  const block = formatShoesBlock(shoes, pt);
  assert.ok(block.includes('TÊNIS DISPONÍVEIS PARA ROTAÇÃO'));
  assert.ok(block.includes('Alvo: 800 km'));
});

test('formatShoesBlock defaults mileage to zero when missing', () => {
  const block = formatShoesBlock([{ brand: 'NB', model: 'SC Elite', mileage: undefined, status: 'active' }], {});
  assert.ok(block.includes('Current mileage: 0 km'));
});

test('buildPrompt injects active shoes block before availability in Portuguese', () => {
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));
  const shoes = [
    { brand: 'Nike', model: 'Pegasus 41', mileage: 320, target_mileage: 800, status: 'active' },
  ];
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: '',
    shoes,
    messages: pt,
  });
  assert.ok(!prompt.includes('{{SHOES_BLOCK}}'), 'placeholder is replaced');
  assert.ok(prompt.includes('TÊNIS DISPONÍVEIS PARA ROTAÇÃO'));
  assert.ok(prompt.includes('- Nike Pegasus 41'));
  const shoesIdx = prompt.indexOf('TÊNIS DISPONÍVEIS PARA ROTAÇÃO');
  const dispIdx = prompt.indexOf('DISPONIBILIDADE');
  assert.ok(shoesIdx < dispIdx, 'shoes section appears before availability');
});

test('buildPrompt injects shoes block before availability in English', () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const shoes = [
    { brand: 'Asics', model: 'Nimbus 26', mileage: 150, target_mileage: null, status: 'active' },
  ];
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: '',
    lang: 'en-US',
    shoes,
    messages: en,
  });
  assert.ok(!prompt.includes('{{SHOES_BLOCK}}'));
  assert.ok(prompt.includes('SHOES AVAILABLE FOR ROTATION'));
  assert.ok(prompt.includes('- Asics Nimbus 26 (Current mileage: 150 km)'));
  const shoesIdx = prompt.indexOf('SHOES AVAILABLE FOR ROTATION');
  const availIdx = prompt.indexOf('AVAILABILITY');
  assert.ok(shoesIdx < availIdx, 'shoes section appears before availability');
});

test('buildPrompt shows fallback when shoes array is empty', () => {
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: '',
    shoes: [],
    messages: pt,
  });
  assert.ok(prompt.includes('Nenhum tênis específico cadastrado; use a rotação padrão.'));
});

test('buildPrompt filters out retired shoes from the block', () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const shoes = [
    { brand: 'Nike', model: 'Vaporfly', mileage: 500, status: 'retired' },
    { brand: 'Asics', model: 'Nimbus 26', mileage: 150, status: 'active' },
  ];
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: '',
    lang: 'en-US',
    shoes,
    messages: en,
  });
  assert.ok(!prompt.includes('Vaporfly'), 'retired shoe is excluded');
  assert.ok(prompt.includes('Nimbus 26'), 'active shoe is included');
});

test('locale files expose the translated default routine', async () => {
  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

  assert.equal(en.aiCoach.defaultRoutine, 'Normal routine');
  assert.equal(pt.aiCoach.defaultRoutine, 'Rotina normal');
});

test('ai-coach.js wires the guarded language-change listener and lang-aware generation', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');

  assert.match(js, /addEventListener\('app:languagechange'/);
  assert.match(js, /applyRoutineDefault\(currentValues, lastRoutineDefault, nextDefault\)/);
  assert.match(js, /lastRoutineDefault = nextDefault;/);
  assert.match(js, /lang: i18n\.language/);
  assert.match(js, /import { fetchShoes } from '\.\/shared\/api\.js'/);
  assert.match(js, /async function handleGenerate/);
  assert.match(js, /await fetchShoes\(\)/);
  assert.match(js, /generateBtn\.disabled = true/);
  assert.match(js, /generateBtn\.disabled = !validation\.valid/);
  assert.match(js, /shoes,/);
  assert.match(js, /messages: i18n\.messages/);
});

test('base location cascades to every day and location state feeds the prompt', () => {
  const js = readFileSync(join(publicDir, 'ai-coach.js'), 'utf8');

  assert.match(js, /baseLocationInput\.addEventListener\('input'/, 'typing the base location refreshes all days');
  assert.match(js, /LOCATION_INPUT_IDS/);
  assert.match(js, /const localizacao = \{\};/);
  assert.match(js, /localizacao\[day\] = input\.value/);
  assert.match(js, /localizacao,/);
});

test('generated prompts no longer embed the context examples', () => {
  const pt = buildPrompt({ targetDate: new Date(2026, 7, 31), disponibilidade: {}, contexto: '' });
  const en = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: '',
    lang: 'en-US',
  });

  assert.ok(!pt.includes('qualquer outra circunstância relevante'));
  assert.ok(!pt.includes('compromisso de trabalho;'));
  assert.ok(!en.includes('any other relevant circumstance'));
  assert.ok(!en.includes('work commitments;'));

  const custom = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: {},
    contexto: 'viagem na terça',
  });
  assert.ok(custom.includes('\nviagem na terça\n'), 'user context still lands in the prompt');
});

test('the textarea placeholder is translated and swaps on language change', async () => {
  const { translate } = require('../src/public/shared/i18n.js');

  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  assert.match(html, /data-i18n-placeholder="aiCoach\.contextPlaceholder"/);
  assert.match(html, /<textarea id="optionalContext"/);

  const shellSource = readFileSync(
    join(publicDir, 'shared', 'i18n.js'),
    'utf8'
  );
  assert.match(
    shellSource,
    /\[data-i18n-placeholder\][\s\S]*?\.placeholder = translate/,
    'shell i18n cycle rewrites only the placeholder attribute'
  );

  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

  const expectedEn =
    'Examples: travel, schedule changes, poor sleep, fatigue, pain/discomfort, work commitments, inability to run, shoe preference...';
  const expectedPt =
    'Exemplos: viagem, alteração de horário, pouco sono, fadiga, dor/desconforto, compromisso de trabalho, impossibilidade de correr, preferência de tênis...';

  assert.equal(en.aiCoach.contextPlaceholder, expectedEn);
  assert.equal(pt.aiCoach.contextPlaceholder, expectedPt);
  assert.equal(translate(en, 'aiCoach.contextPlaceholder'), expectedEn);
  assert.equal(translate(pt, 'aiCoach.contextPlaceholder'), expectedPt);
  assert.equal(typeof en.aiCoach.optionalContextPlaceholder, 'undefined', 'old key removed');
  assert.equal(typeof pt.aiCoach.optionalContextPlaceholder, 'undefined', 'old key removed');
});

test('the base location placeholder is generic and translated per language', async () => {
  const { translate } = require('../src/public/shared/i18n.js');

  const html = readFileSync(join(publicDir, 'ai-coach.html'), 'utf8');
  assert.match(html, /id="baseLocation" data-i18n-placeholder="aiCoach\.locationPlaceholder" placeholder="Ex: City, Country"/);

  const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(publicDir, 'locales', 'pt.json'), 'utf8'));

  assert.equal(en.aiCoach.locationPlaceholder, 'Ex: City, Country');
  assert.equal(pt.aiCoach.locationPlaceholder, 'Ex: Cidade, País');
  assert.equal(translate(en, 'aiCoach.locationPlaceholder'), 'Ex: City, Country');
  assert.equal(translate(pt, 'aiCoach.locationPlaceholder'), 'Ex: Cidade, País');
});
