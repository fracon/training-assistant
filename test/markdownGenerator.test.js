'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMPT_TEMPLATE,
  generateMarkdown,
  escapeCell,
  formatMetric,
} = require('../src/markdownGenerator');

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

const EXPECTED_TOKEN_VALUES = {
  '{{DATA}}': '03/02/2026',
  '{{DIA_SEMANA}}': 'terça-feira',
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

test('escapeCell neutralizes pipes and line breaks', () => {
  assert.equal(escapeCell('felt | strong'), 'felt \\| strong');
  assert.equal(escapeCell('line1\nline2\r\nline3'), 'line1 line2 line3');
});

test('formatMetric renders nullish values as dashes', () => {
  assert.equal(formatMetric(null), '-');
  assert.equal(formatMetric(undefined), '-');
  assert.equal(formatMetric(88), '88');
});

test('the template declares every placeholder exactly once', () => {
  for (const token of Object.keys(EXPECTED_TOKEN_VALUES)) {
    const occurrences = PROMPT_TEMPLATE.split(token).length - 1;
    assert.equal(occurrences, 1, `expected exactly one occurrence of ${token}`);
  }
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK)));
});

test('generateMarkdown fills the exact template with parsed and reported data', () => {
  const expected = PROMPT_TEMPLATE.replace(
    /\{\{[A-Z_]+\}\}/g,
    (token) => EXPECTED_TOKEN_VALUES[token],
  );
  assert.equal(generateMarkdown(FULL_SUMMARY, FULL_FEEDBACK), expected);
});

test('generateMarkdown falls back to uninformed markers when data is missing', () => {
  const markdown = generateMarkdown();

  assert.ok(markdown.includes('Data: não informado'));
  assert.ok(markdown.includes('Dia da semana: não informado'));
  assert.ok(markdown.includes('Tipo de treino: não informado'));
  assert.ok(markdown.includes('Treino planejado: não informado'));
  assert.ok(markdown.includes('FC alvo: não informado'));
  assert.ok(markdown.includes('RPE alvo: não informado'));
  assert.ok(markdown.includes('Tênis: não informado'));
  assert.ok(markdown.includes('Duração total: não informado'));
  assert.ok(markdown.includes('Distância total: não informado'));
  assert.ok(markdown.includes('Pace médio: não informado'));
  assert.ok(markdown.includes('FC média: não informado'));
  assert.ok(markdown.includes('FC máxima: não informado'));
  assert.ok(markdown.includes('Desnível positivo: não informado'));
  assert.ok(markdown.includes('Tênis utilizado: não informado'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(markdown));
  assert.ok(!markdown.includes('| Step | Lap |'));
});

test('missing sections render explicit fallback lines', () => {
  const markdown = generateMarkdown(undefined);

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
});
