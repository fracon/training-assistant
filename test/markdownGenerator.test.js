'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMPT_TEMPLATE,
  generateMarkdown,
  escapeCell,
  formatMetric,
} = require('../src/markdownGenerator');

const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

function makeLapView(overrides = {}) {
  return {
    stepType: 'Run',
    lap: 1,
    duration: 604,
    durationLabel: '10:04',
    cumulativeSeconds: 604,
    cumulativeLabel: '10:04',
    distanceKm: 2.0,
    distanceLabel: '2.00',
    avgPaceSecondsPerKm: 302,
    avgPaceLabel: '5:02',
    bestPaceSecondsPerKm: 270,
    bestPaceLabel: '4:30',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: 12,
    descentMeters: 4,
    avgCadenceSpm: 88,
    maxCadenceSpm: 92,
    strideMeters: 1.1,
    calories: 60,
    ...overrides,
  };
}

const FULL_SUMMARY = {
  activity: {
    sport: 'running',
    startTime: '2026-02-03T07:30:00.000Z',
    endTime: '2026-02-03T08:10:00.000Z',
  },
  laps: [
    makeLapView(),
    makeLapView({
      stepType: 'Rest',
      lap: 2,
      durationLabel: '20:00',
      cumulativeLabel: '30:04',
      distanceKm: 0,
      distanceLabel: '0.00',
      avgPaceSecondsPerKm: null,
      avgPaceLabel: '--:--',
      bestPaceSecondsPerKm: null,
      bestPaceLabel: '--:--',
      avgHeartRate: null,
      maxHeartRate: null,
      ascentMeters: null,
      descentMeters: null,
    }),
  ],
  totals: {
    durationSeconds: 1804,
    durationLabel: '30:04',
    distanceKm: 5,
    distanceLabel: '5.00',
    avgPaceSecondsPerKm: 360.8,
    avgPaceLabel: '6:01',
    avgHeartRate: 151,
    maxHeartRate: 162,
    ascentMeters: 22,
  },
};

const FULL_FEEDBACK = {
  tipoTreino: 'Intervalado',
  treinoPlanejado: '6x1km forte | trote 400m',
  fcAlvo: '145–155 bpm',
  rpeAlvo: 4,
  tenis: 'Nimbus 26',
  fonteFc: 'Cinta Peitoral',
  clima: '22°C, Nublado',
  terreno: 'Asfalto',
  rpePercebido: 5,
  respiracao: 'Ofegante',
  sensacaoMuscular: 'Pesada',
  energiaFinal: 'No limite',
  dorDesconforto: 'Pontada leve no Aquiles direito',
  feedbackLivre: 'Vento contra | hidratei bem',
};

const EXPECTED_LAPS_TABLE = [
  '| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | Ascent | Descent | Avg Cadence | Max Cadence | Stride (m) | Calories |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  '| Run | 1 | 10:04 | 10:04 | 2.00 | 5:02 | 4:30 | 150 | 162 | 12 | 4 | 88 | 92 | 1.1 | 60 |',
  '| Rest | 2 | 20:00 | 30:04 | 0.00 | --:-- | --:-- | - | - | - | - | 88 | 92 | 1.1 | 60 |',
].join('\n');

const TOKENS = [
  '{{DATA}}',
  '{{DIA_SEMANA}}',
  '{{TIPO_TREINO}}',
  '{{TREINO_PLANEJADO}}',
  '{{FC_ALVO}}',
  '{{RPE_ALVO}}',
  '{{TENIS}}',
  '{{DURACAO}}',
  '{{DISTANCIA}}',
  '{{PACE_MEDIO}}',
  '{{FC_MEDIA}}',
  '{{FC_MAXIMA}}',
  '{{DESNIVEL_POSITIVO}}',
  '{{TENIS_UTILIZADO}}',
  '{{FONTE_FC}}',
  '{{CLIMA}}',
  '{{TERRENO}}',
  '{{HORARIO}}',
  '{{RPE_PERCEBIDO}}',
  '{{RESPIRACAO}}',
  '{{SENSACAO_MUSCULAR}}',
  '{{ENERGIA_FINAL}}',
  '{{DOR_DESCONFORTO}}',
  '{{FEEDBACK}}',
  '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}',
];

function expectedTokenValues(lang) {
  const date =
    lang === 'pt-BR' ? '03/02/2026' : '02/03/2026';
  const weekday = lang === 'pt-BR' ? 'terça-feira' : 'Tuesday';
  const shared = {
    '{{TIPO_TREINO}}': 'Intervalado',
    '{{TREINO_PLANEJADO}}': '6x1km forte \\| trote 400m',
    '{{FC_ALVO}}': '145–155 bpm',
    '{{RPE_ALVO}}': '4/5',
    '{{TENIS}}': 'Nimbus 26',
    '{{DURACAO}}': '30:04',
    '{{DISTANCIA}}': '5.00 km',
    '{{PACE_MEDIO}}': '6:01 min/km',
    '{{FC_MEDIA}}': '151 bpm',
    '{{FC_MAXIMA}}': '162 bpm',
    '{{DESNIVEL_POSITIVO}}': '22 m',
    '{{TENIS_UTILIZADO}}': 'Nimbus 26',
    '{{FONTE_FC}}': 'Cinta Peitoral',
    '{{CLIMA}}': '22°C, Nublado',
    '{{TERRENO}}': 'Asfalto',
    '{{HORARIO}}': '07:30',
    '{{RPE_PERCEBIDO}}': '5/5',
    '{{RESPIRACAO}}': 'Ofegante',
    '{{SENSACAO_MUSCULAR}}': 'Pesada',
    '{{ENERGIA_FINAL}}': 'No limite',
    '{{DOR_DESCONFORTO}}': 'Pontada leve no Aquiles direito',
    '{{FEEDBACK}}': 'Vento contra \\| hidratei bem',
    '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}': EXPECTED_LAPS_TABLE,
  };
  return { '{{DATA}}': date, '{{DIA_SEMANA}}': weekday, ...shared };
}

test('escapeCell neutralizes pipes and line breaks', () => {
  assert.equal(escapeCell('felt | strong'), 'felt \\| strong');
  assert.equal(escapeCell('line1\nline2\r\nline3'), 'line1 line2 line3');
});

test('formatMetric renders nullish values as dashes', () => {
  assert.equal(formatMetric(null), '-');
  assert.equal(formatMetric(undefined), '-');
  assert.equal(formatMetric(88), '88');
});

for (const [lang, messages] of [['en-US', en], ['pt-BR', pt]]) {
  test(`the ${lang} template declares every placeholder exactly once`, () => {
    const template = buildRawTemplateForTest(messages);
    for (const token of TOKENS) {
      assert.equal(template.split(token).length - 1, 1, `exactly one ${token}`);
    }
  });

  test(`generateMarkdown leaves no placeholders behind (${lang})`, () => {
    const output = generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, lang);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(output));
  });

  test(`generateMarkdown fills the ${lang} template with parsed and reported data`, () => {
    const expected = buildRawTemplateForTest(messages).replace(
      /\{\{[A-Z_]+\}\}/g,
      (token) => expectedTokenValues(lang)[token]
    );
    assert.equal(generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, lang), expected);
  });
}

function buildRawTemplateForTest(messages) {
  const t = messages.prompt;
  const instructionBlock = t.instructions
    .map((item, index) => {
      const lines = [`${index + 1}. ${item.text}`];
      for (const bullet of item.bullets ?? []) lines.push(`   - ${bullet}`);
      return lines.join('\n');
    })
    .join('\n');
  return [
    t.intro1,
    '',
    t.intro2,
    '',
    t.sectionPlanned,
    '',
    `${t.fieldDate}: {{DATA}}`,
    `${t.fieldWeekday}: {{DIA_SEMANA}}`,
    `${t.fieldType}: {{TIPO_TREINO}}`,
    `${t.fieldPlanned}: {{TREINO_PLANEJADO}}`,
    `${t.fieldTargetHr}: {{FC_ALVO}}`,
    `${t.fieldTargetRpe}: {{RPE_ALVO}}`,
    `${t.fieldShoes}: {{TENIS}}`,
    '',
    t.sectionRealized,
    '',
    `${t.fieldTotalDuration}: {{DURACAO}}`,
    `${t.fieldTotalDistance}: {{DISTANCIA}}`,
    `${t.fieldAvgPace}: {{PACE_MEDIO}}`,
    `${t.fieldAvgHr}: {{FC_MEDIA}}`,
    `${t.fieldMaxHr}: {{FC_MAXIMA}}`,
    `${t.fieldElevation}: {{DESNIVEL_POSITIVO}}`,
    `${t.fieldShoesUsed}: {{TENIS_UTILIZADO}}`,
    '',
    t.hrSourceLabel,
    '{{FONTE_FC}}',
    '',
    t.conditionsLabel,
    `${t.fieldTempWeather}: {{CLIMA}}`,
    `${t.fieldTerrain}: {{TERRENO}}`,
    `${t.fieldTimeOfDay}: {{HORARIO}}`,
    '',
    t.perceptionLabel,
    `${t.fieldRpePerceived}: {{RPE_PERCEBIDO}}`,
    `${t.fieldBreathing}: {{RESPIRACAO}}`,
    `${t.fieldMuscleFeel}: {{SENSACAO_MUSCULAR}}`,
    `${t.fieldEndEnergy}: {{ENERGIA_FINAL}}`,
    '',
    t.discomfortLabel,
    '{{DOR_DESCONFORTO}}',
    '',
    t.freeFeedbackLabel,
    '{{FEEDBACK}}',
    '',
    t.sectionDetailed,
    '',
    '{{ANEXAR_SCREENSHOT_GARMIN_OU_INSERIR_DADOS_DE_LAPS_AQUI}}',
    '',
    t.instructionsTitle,
    '',
    instructionBlock,
    '',
    t.outro,
  ].join('\n');
}

test('PROMPT_TEMPLATE matches the default (en-US) template', () => {
  const enTemplate = buildRawTemplateForTest(en);
  assert.equal(PROMPT_TEMPLATE, enTemplate);
  assert.equal(generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK), generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, 'en-US'));
});

test('generateMarkdown renders the requested language end to end', () => {
  const english = generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, 'en-US');
  assert.ok(english.includes('PLANNED WORKOUT DATA'));
  assert.ok(english.includes('Workout type: Intervalado'));
  assert.ok(english.includes('Day of week: Tuesday'));
  assert.ok(english.includes('02/03/2026'));
  assert.ok(english.includes('ANALYSIS INSTRUCTIONS'));

  const portuguese = generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, 'pt-BR');
  assert.ok(portuguese.includes('DADOS DO TREINO PLANEJADO'));
  assert.ok(portuguese.includes('Tipo de treino: Intervalado'));
  assert.ok(portuguese.includes('Dia da semana: terça-feira'));
  assert.ok(portuguese.includes('03/02/2026'));
  assert.ok(portuguese.includes('INSTRUÇÕES PARA A ANÁLISE'));
});

test('unknown languages fall back to the en-US template', () => {
  const fallback = generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, 'fr-FR');
  assert.equal(fallback, generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK, 'en-US'));
});

test('generateMarkdown falls back to uninformed markers when data is missing', () => {
  for (const [lang, notInformed, noneReported] of [
    ['en-US', 'not informed', 'None reported'],
    ['pt-BR', 'não informado', 'Nenhum relatado'],
  ]) {
    const markdown = generateMarkdown(undefined, undefined, lang);

    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'Data' : 'Date'}: ${notInformed}`));
    assert.ok(markdown.includes(
      `${lang === 'pt-BR' ? 'Dia da semana' : 'Day of week'}: ${notInformed}`
    ));
    assert.ok(markdown.includes(
      `${lang === 'pt-BR' ? 'Tipo de treino' : 'Workout type'}: ${notInformed}`
    ));
    assert.ok(markdown.includes(
      `${lang === 'pt-BR' ? 'Treino planejado' : 'Planned workout'}: ${notInformed}`
    ));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'FC alvo' : 'Target HR'}: ${notInformed}`));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'RPE alvo' : 'Target RPE'}: ${notInformed}`));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'Tênis' : 'Shoes'}: ${notInformed}`));
    assert.ok(markdown.includes(
      `${lang === 'pt-BR' ? 'Duração total' : 'Total duration'}: ${notInformed}`
    ));
    assert.ok(markdown.includes(
      `${lang === 'pt-BR' ? 'Distância total' : 'Total distance'}: ${notInformed}`
    ));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'Pace médio' : 'Average pace'}: ${notInformed}`));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'FC média' : 'Average HR'}: ${notInformed}`));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'FC máxima' : 'Max HR'}: ${notInformed}`));
    assert.ok(markdown.includes(`${lang === 'pt-BR' ? 'Tênis utilizado' : 'Shoes used'}: ${notInformed}`));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(markdown));
    assert.ok(!markdown.includes('| Step | Lap |'));

    if (lang === 'pt-BR') {
      assert.ok(markdown.includes(`Desnível positivo: ${notInformed}`));
    } else {
      assert.ok(markdown.includes(`Elevation gain: ${notInformed}`));
    }
  }
});

test('missing sections render explicit fallback lines', () => {
  const markdown = generateMarkdown(undefined, undefined, 'pt-BR');

  const lines = markdown.split('\n');
  const indexOf = (line) => lines.indexOf(line);
  assert.notEqual(indexOf('Fonte da frequência cardíaca:'), -1);
  assert.equal(lines[indexOf('Fonte da frequência cardíaca:') + 1], 'não informado');
  assert.equal(lines[indexOf('Condições:') + 3], 'Horário: não informado');
  assert.equal(lines[indexOf('Percepção do treino:') + 1], 'RPE percebido: não informado');
  assert.equal(lines[indexOf('Dor ou desconforto:') + 1], 'Nenhum relatado');
  assert.equal(lines[indexOf('Feedback livre:') + 1], 'não informado');
  const detailedIndex = lines.indexOf('DADOS DETALHADOS');
  assert.equal(lines[detailedIndex + 2], '_Nenhum dado detalhado de laps disponível._');
  assert.ok(markdown.endsWith('implicações para o planejamento.'));

  const englishLines = generateMarkdown(undefined, undefined, 'en-US').split('\n');
  assert.equal(englishLines[englishLines.indexOf('Pain or discomfort:') + 1], 'None reported');
  assert.equal(
    englishLines[englishLines.indexOf('DETAILED DATA') + 2],
    '_No detailed lap data available._'
  );
});

test('blank or invalid inputs resolve to fallbacks without breaking the template', () => {
  const markdown = generateMarkdown(
    {
      activity: { startTime: 'not-a-date' },
      laps: [makeLapView()],
      totals: { durationLabel: '--:--', distanceKm: null },
    },
    {
      tipoTreino: '   ',
      treinoPlanejado: '',
      fcAlvo: undefined,
      rpeAlvo: null,
      tenis: '   ',
      fonteFc: '',
      clima: null,
      terreno: '  ',
      respiracao: undefined,
      sensacaoMuscular: '',
      energiaFinal: null,
      dorDesconforto: ' ',
      feedbackLivre: '\n\t',
    },
    'pt-BR'
  );

  assert.ok(markdown.includes('Data: não informado'));
  assert.ok(markdown.includes('Dia da semana: não informado'));
  assert.ok(markdown.includes('Horário: não informado'));
  assert.ok(markdown.includes('Tipo de treino: não informado'));
  assert.ok(markdown.includes('Treino planejado: não informado'));
  assert.ok(markdown.includes('FC alvo: não informado'));
  assert.ok(markdown.includes('RPE alvo: não informado'));
  assert.ok(markdown.includes('Tênis: não informado'));
  assert.ok(markdown.includes('Tênis utilizado: não informado'));
  assert.ok(markdown.includes('Duração total: não informado'));
  assert.ok(markdown.includes('Distância total: não informado'));
  assert.ok(markdown.includes('| Run | 1 | 10:04 |'));

  const englishMarkdown = generateMarkdown(
    { activity: { startTime: 'not-a-date' }, totals: { durationLabel: '--:--' } },
    {},
    'en-US'
  );
  assert.ok(englishMarkdown.includes('Time of day: not informed'));
  assert.ok(englishMarkdown.includes('Total duration: not informed'));
});
