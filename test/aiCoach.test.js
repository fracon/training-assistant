'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const publicDir = join(__dirname, '..', 'src', 'public');

const {
  PROMPT_TEMPLATE,
  PLACEHOLDERS,
  pad2,
  nextMonday,
  formatDiaSlashes,
  dateInputValue,
  parseInputDate,
  availabilityDefaults,
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
  assert.match(html, /type="submit" id="generateBtn"/);
  assert.match(html, /data-lucide="sparkles"/);
  assert.match(html, /id="copyBtn"/);
  assert.match(html, /data-lucide="copy"/);
  assert.match(html, /<pre id="promptOutput"/);
  assert.match(html, /data-i18n="aiCoach\.title"/);
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
