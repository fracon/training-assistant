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
  buildPrompt,
  copyPromptText,
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
  assert.equal(tokens.length, 9, 'exactly nine placeholders exist');
  assert.deepEqual(tokens, [
    '{{DATA_DA_SEGUNDA}}',
    '{{DISP_SEG}}',
    '{{DISP_TER}}',
    '{{DISP_QUA}}',
    '{{DISP_QUI}}',
    '{{DISP_SEX}}',
    '{{DISP_SAB}}',
    '{{DISP_DOM}}',
    '{{CONTEXTO_OPCIONAL}}',
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
  assert.ok(prompt.includes('Segunda: Manhã, antes das 8h'));
  assert.ok(prompt.includes('Domingo: Manhã, entre 8h e 9h'));
  assert.ok(prompt.includes('viagem na terça; pouco sono na quinta.'));
});

test('buildPrompt falls back to defaults for untouched days and context', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: { quarta: 'Só à noite' },
    contexto: '',
  });

  assert.ok(prompt.includes('Segunda: Rotina normal'));
  assert.ok(prompt.includes('Quarta: Só à noite'));
  assert.ok(prompt.includes('\n-\n'), 'empty context renders a dash placeholder value');
});

test('buildPrompt trims whitespace from availability and context', () => {
  const prompt = buildPrompt({
    targetDate: new Date(2026, 7, 31),
    disponibilidade: { segunda: '  Tarde  ' },
    contexto: '  calor forte previsto  ',
  });
  assert.ok(prompt.includes('Segunda: Tarde\n'));
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

  assert.match(html, /type="date" id="targetDate"/);
  for (const id of ['dispSeg', 'dispTer', 'dispQua', 'dispQui', 'dispSex', 'dispSab', 'dispDom']) {
    assert.match(html, new RegExp(`id="${id}" value="Rotina normal"`));
  }
  assert.match(html, /<textarea id="optionalContext"/);
  assert.match(html, /type="submit" id="generateBtn" class="btn-primary"/);
  assert.ok(!html.includes('generate-btn'), 'the scoped generate-btn class is retired');
  assert.match(html, /data-lucide="sparkles"/);
  assert.match(html, /id="copyBtn"/);
  assert.match(html, /data-lucide="copy"/);
  assert.match(html, /<pre id="promptOutput"/);
  assert.match(html, /data-i18n="aiCoach\.title"/);
});

test('the generate button matches the shared primary hover contract', () => {
  const css = readFileSync(join(publicDir, 'ai-coach.css'), 'utf8');

  assert.ok(!css.includes('.generate-btn'), 'no scoped generate-btn rules remain');
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
    assert.equal(typeof messages.aiCoach.targetDate, 'string');
    assert.equal(Object.keys(messages.aiCoach.days).length, 7);
    assert.equal(typeof messages.aiCoach.generate, 'string');
    assert.equal(typeof messages.aiCoach.copy, 'string');
    assert.equal(typeof messages.aiCoach.copied, 'string');
    assert.equal(typeof messages.shell.nav.aiCoach, 'string');
  }

  assert.notEqual(en.aiCoach.title, pt.aiCoach.title);
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
  assert.ok(prompt.includes('The week to be planned starts on:\n31/08/2026'));
  assert.ok(prompt.includes('Monday: Normal routine'));
  assert.ok(prompt.includes('Sunday: Normal routine'));
  assert.ok(!prompt.includes('Rotina normal'), 'no Portuguese leftovers in EN output');
  assert.ok(!prompt.includes('{{'));
  assert.ok(prompt.includes('traveling on Tuesday'));
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
    assert.ok(prompt.includes('Segunda: Rotina normal'));
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
  assert.ok(prompt.includes('Monday: Evening only'));
  assert.ok(prompt.includes('Tuesday: Normal routine'));
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
