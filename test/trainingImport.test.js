'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_BY_HEADER,
  REQUIRED_FIELDS,
  accentless,
  pad2,
  isoFromSerial,
  isoFromCellDate,
  isValidIso,
  normalizeDia,
  cellToText,
  parseSheet,
} = require('../src/trainingImport');

function fakeRow(number, values) {
  return {
    number,
    cellCount: values.length,
    getCell(column) {
      if (column < 1 || column > values.length) return null;
      const value = values[column - 1];
      return { value: value === undefined ? null : value };
    },
  };
}

function fakeWorksheet(rows) {
  return {
    eachRow(_options, callback) {
      for (const row of rows) callback(row);
    },
  };
}

test('accentless strips diacritics, trims and lowercases headers', () => {
  assert.equal(accentless('  Período '), 'periodo');
  assert.equal(accentless('PREVISÃO NO HORÁRIO'), 'previsao no horario');
  assert.equal(accentless('Tênis'), 'tenis');
});

test('pad2 zero-pads single digits', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(11), '11');
});

test('isoFromSerial converts Excel serial dates to ISO strings', () => {
  // Serial 1 sits inside Excel's Lotus 1-2-3 leap-year bug window.
  assert.equal(isoFromSerial(1), '1899-12-31');
  assert.equal(isoFromSerial(60), '1900-02-28');
  // Modern dates convert exactly: 2026-08-23 is serial 46257.
  const serial = (Date.UTC(2026, 7, 23) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(isoFromSerial(serial), '2026-08-23');
});

test('isoFromCellDate never lets timezones move the calendar day', () => {
  // exceljs-style date: built on UTC midnight; local getters would lag a day
  // behind UTC in western timezones (the E2E bug).
  assert.equal(isoFromCellDate(new Date(Date.UTC(2026, 7, 23))), '2026-08-23');
  assert.equal(isoFromCellDate(new Date(Date.UTC(2026, 7, 24))), '2026-08-24');
  // Locally-built midnight dates must keep their local wall-calendar day.
  assert.equal(isoFromCellDate(new Date(2026, 7, 23)), '2026-08-23');
  // Real datetimes (neither side midnight) follow the serial's UTC day.
  assert.equal(isoFromCellDate(new Date(Date.UTC(2026, 7, 25, 12, 30))), '2026-08-25');

  // Deterministic branch coverage for every midnight combination, immune to
  // the machine's timezone: local-midnight-only wins with local getters.
  const fakeParts = ({ h = 0, utcH = 0 } = {}) => ({
    getHours: () => h,
    getMinutes: () => 0,
    getSeconds: () => 0,
    getMilliseconds: () => 0,
    getUTCHours: () => utcH,
    getUTCMinutes: () => 0,
    getUTCSeconds: () => 0,
    getUTCMilliseconds: () => 0,
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 22,
    getUTCFullYear: () => 2026,
    getUTCMonth: () => 7,
    getUTCDate: () => 23,
  });
  assert.equal(
    isoFromCellDate(fakeParts({ utcH: 3 })),
    '2026-08-22',
    'local midnight beats shifted UTC'
  );
  assert.equal(
    isoFromCellDate(fakeParts({ h: 21 })),
    '2026-08-23',
    'non-local-midnight reads the UTC day'
  );
  assert.equal(
    isoFromCellDate(fakeParts({})),
    '2026-08-23',
    'both midnights agree on the UTC day'
  );
});

test('isValidIso rejects impossible calendar dates', () => {
  assert.equal(isValidIso(2026, 2, 29), false);
  assert.equal(isValidIso(2024, 2, 29), true);
  assert.equal(isValidIso(2026, 4, 31), false);
  assert.equal(isValidIso(2026, 13, 1), false);
  assert.equal(isValidIso(2026, 0, 10), false);
});

test('normalizeDia handles Date objects, serials and tolerant strings', () => {
  assert.equal(normalizeDia(new Date(2026, 7, 23)), '2026-08-23');
  assert.equal(normalizeDia(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(
    normalizeDia(new Date(Date.UTC(2026, 7, 24))),
    '2026-08-24',
    'exceljs UTC-midnight dates must not shift backwards a day'
  );

  const serial = (Date.UTC(2026, 7, 23) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(normalizeDia(serial), '2026-08-23');

  assert.equal(normalizeDia('23/08/2026'), '2026-08-23');
  assert.equal(normalizeDia(' 24/08/2026 '), '2026-08-24', 'padded string');
  assert.equal(normalizeDia('\t25/08/2026\n'), '2026-08-25', 'hidden whitespace');
  assert.equal(normalizeDia('26/8/2026'), '2026-08-26', 'single-digit day/month');
  assert.equal(normalizeDia('9/8/2026'), '2026-08-09', 'single-digit day/month');
  assert.equal(normalizeDia('27-08-2026'), '2026-08-27', 'dash separator');
  assert.equal(normalizeDia('28-8-2026'), '2026-08-28', 'dash + single digits');
  assert.equal(normalizeDia('2026-08-23'), '2026-08-23');
});

test('normalizeDia rejects junk and impossible dates', () => {
  for (const junk of [
    '',
    '   ',
    '31/02/2026',
    '32/01/2026',
    '32-01-2026',
    '00/00/0000',
    '2026-13-01',
    'Aug 23',
    '08/2026',
    null,
    undefined,
    {},
    true,
  ]) {
    assert.equal(normalizeDia(junk), null, String(junk));
  }
});

test('cellToText flattens every exceljs cell shape', () => {
  assert.equal(cellToText('  Corrida '), 'Corrida');
  assert.equal(cellToText(42), '42');
  assert.equal(cellToText(null), '');
  assert.equal(cellToText(undefined), '');
  assert.equal(cellToText(new Date(2026, 7, 23)), '23/8/2026');
  assert.equal(
    cellToText(new Date(Date.UTC(2026, 7, 25))),
    '25/8/2026',
    'UTC-midnight date cells keep their day in any timezone'
  );
  assert.equal(cellToText(new Date('not a date')), '');
  assert.equal(cellToText({ result: ' Intervalado ' }), 'Intervalado');
  assert.equal(cellToText({ richText: [{ text: 'Long ' }, { text: 'Run' }] }), 'Long Run');
  assert.equal(cellToText({ text: 'https://sheet', hyperlink: 'x' }), 'https://sheet');
  assert.equal(cellToText({ formula: 'A1' }), '', 'formula cells without results are empty');
  assert.equal(cellToText({}), '');
  assert.equal(cellToText(new Number(7)), '7', 'boxed primitives stringify');
  assert.equal(cellToText({ toString: () => 'Custom' }), 'Custom');
});

test('header aliases cover the Phase 7 eleven-column AI layout', () => {
  const expected = {
    data: 'dia',
    dia: 'dia_semana',
    periodo: 'periodo',
    tipo: 'tipo',
    treino: 'treino',
    detalhes: 'detalhes',
    'fc alvo': 'fc_alvo',
    rpe: 'rpe',
    tenis: 'tenis',
    'previsao no horario': 'previsao',
    'previsao do tempo': 'previsao',
    observacoes: 'observacoes',
    date: 'dia',
    day: 'dia_semana',
    period: 'periodo',
    type: 'tipo',
    workout: 'treino',
    details: 'detalhes',
    'target hr': 'fc_alvo',
    shoe: 'tenis',
    'weather forecast': 'previsao',
    notes: 'observacoes',
  };
  assert.deepEqual(FIELD_BY_HEADER, expected);
  assert.deepEqual(REQUIRED_FIELDS, ['dia', 'tipo']);
});

test('parseSheet maps valid rows and normalizes Dia to ISO', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Período', 'Tipo', 'Treino', 'Detalhes', 'FC alvo', 'RPE', 'Tênis', 'Previsão do tempo', 'Observações']),
    fakeRow(2, ['23/08/2026', 'Domingo', 'Morning', 'Corrida', 'Long Run', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Sentir leve']),
    fakeRow(3, [new Date(2026, 7, 25), 'Terça', '', 'Intervalado', '', '', '', '', '', '', '']),
    fakeRow(4, [' 26/8/2026 ', 'Quarta', '', 'Rodagem', '', '', '', '', '', '', '']),
  ]);

  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 3);

  assert.deepEqual(records[0], {
    dia: '2026-08-23',
    dia_semana: 'Domingo',
    periodo: 'Morning',
    tipo: 'Corrida',
    treino: 'Long Run',
    detalhes: 'Zona 2',
    fc_alvo: '150',
    rpe: '3',
    tenis: 'Adizero',
    previsao: '90 min',
    observacoes: 'Sentir leve',
  });
  assert.equal(records[1].dia, '2026-08-25');
  assert.equal(records[1].dia_semana, 'Terça');
  assert.equal(records[1].tipo, 'Intervalado');
  assert.equal(records[1].periodo, '');
  assert.equal(records[2].dia, '2026-08-26', 'padded single-digit date parses');
});

test('parseSheet accepts the Phase 7 layout: Data date plus Dia weekday string', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Tipo']),
    fakeRow(2, [new Date(Date.UTC(2026, 7, 24)), 'Segunda', 'Corrida']),
    fakeRow(3, [new Date(2026, 7, 25), 'Terça', 'Ciclismo']),
    fakeRow(4, ['26/08/2026', 'Quarta', 'Rodagem']),
  ]);

  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, [], 'weekday strings never trigger date validation');
  assert.equal(records.length, 3);
  assert.equal(records[0].dia, '2026-08-24', 'UTC-midnight Data cell keeps its day');
  assert.equal(records[0].dia_semana, 'Segunda');
  assert.equal(records[1].dia, '2026-08-25');
  assert.equal(records[2].dia, '2026-08-26');

  const legacy = parseSheet(fakeWorksheet([
    fakeRow(1, ['Dia', 'Período', 'Tipo']),
    fakeRow(2, ['23/08/2026', 'Morning', 'Corrida']),
  ]));
  assert.deepEqual(legacy.errors, [
    { row: 1, col: 'Data', error: 'Missing required column.' },
  ], 'legacy Phase 6 sheets without a Data column are rejected up front');
  assert.equal(legacy.records.length, 0);
});

test('parseSheet accepts English AI headers and mirrors the Portuguese structure', () => {
  const values = ['23/08/2026', 'Domingo', 'Morning', 'Corrida', 'Long Run', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Sentir leve'];
  const english = parseSheet(fakeWorksheet([
    fakeRow(1, ['Date', 'Day', 'Period', 'Type', 'Workout', 'Details', 'Target HR', 'RPE', 'Shoe', 'Weather Forecast', 'Notes']),
    fakeRow(2, values),
  ]));
  const portuguese = parseSheet(fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Período', 'Tipo', 'Treino', 'Detalhes', 'FC alvo', 'RPE', 'Tênis', 'Previsão do tempo', 'Observações']),
    fakeRow(2, values),
  ]));

  assert.deepEqual(english.errors, [], 'English Date/Type satisfy the mandatory columns');
  assert.deepEqual(portuguese.errors, []);
  assert.equal(english.records.length, 1);
  assert.deepEqual(
    Object.keys(english.records[0]).sort(),
    Object.keys(portuguese.records[0]).sort(),
    'both languages resolve to the identical internal field set'
  );
  assert.deepEqual(english.records, portuguese.records, 'identical cell values produce byte-equal records');
  assert.equal(english.records[0].dia, '2026-08-23');
  assert.equal(english.records[0].dia_semana, 'Domingo');
});

test('parseSheet reports missing required columns on the header row', () => {
  const withoutTipo = parseSheet(fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Treino']),
    fakeRow(2, ['23/08/2026', 'Segunda', 'Corrida']),
  ]));
  assert.deepEqual(withoutTipo.errors, [{ row: 1, col: 'Tipo', error: 'Missing required column.' }]);
  assert.equal(withoutTipo.records.length, 0);

  const withoutBoth = parseSheet(fakeWorksheet([fakeRow(1, ['Treino', 'RPE'])]));
  assert.deepEqual(withoutBoth.errors, [
    { row: 1, col: 'Data', error: 'Missing required column.' },
    { row: 1, col: 'Tipo', error: 'Missing required column.' },
  ]);
});

test('parseSheet aborts rows with blank or invalid required cells', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Tipo']),
    fakeRow(2, ['', '', 'Corrida']),
    fakeRow(3, ['31/02/2026', 'Quinta', 'Corrida']),
    fakeRow(4, ['24/08/2026', 'Sexta', '']),
    fakeRow(5, ['25/08/2026', 'Sábado', 'Ciclismo']),
  ]);

  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, [
    { row: 2, col: 'Data', error: 'Required value is empty.' },
    { row: 3, col: 'Data', error: 'Invalid date format. Use DD/MM/YYYY.' },
    { row: 4, col: 'Tipo', error: 'Required value is empty.' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].dia, '2026-08-25');
  assert.equal(records[0].dia_semana, 'Sábado');
});

test('parseSheet skips fully empty data rows silently', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Tipo']),
    fakeRow(2, [null, undefined]),
    fakeRow(3, ['26/08/2026', 'Domingo', 'Corrida']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].dia, '2026-08-26');
});

test('parseSheet silently skips rogue AI footnote rows', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Tipo']),
    fakeRow(2, ['27/08/2026', 'Segunda', 'Corrida']),
    fakeRow(3, ['Nota: esta semana inicia o bloco de transição.']),
    fakeRow(4, ['Note: recovery week ahead']),
    fakeRow(5, ['OBSERVAÇÃO: aquecer 15 minutos antes de cada sessão']),
    fakeRow(6, ['Observaçao: sem acento padrao']),
    fakeRow(7, ['nota minúscula com espaço antes']),
    fakeRow(8, ['28/08/2026', 'Terça', 'Ciclismo']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.dia),
    ['2026-08-27', '2026-08-28']
  );
});

test('parseSheet still validates rows where a note prefix shares cells with data', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Dia', 'Tipo']),
    fakeRow(2, ['Nota: ver previsão', 'Quarta', 'Corrida']),
    fakeRow(3, ['29/08/2026', 'Quinta', 'Corrida', 'Nota extra no fim']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, [
    { row: 2, col: 'Data', error: 'Invalid date format. Use DD/MM/YYYY.' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].dia, '2026-08-29');
});

test('parseSheet flags a workbook with no usable rows at all', () => {
  const empty = parseSheet(fakeWorksheet([]));
  assert.deepEqual(empty.errors, [{ row: 1, col: 'Data', error: 'Missing header row.' }]);
  assert.equal(empty.records.length, 0);
});

test('cellToText treats the literal string "undefined" as empty', () => {
  assert.equal(cellToText('undefined'), '');
  assert.equal(cellToText('defined'), 'defined');
});

test('parseSheet tolerates header rows without a cellCount property', () => {
  const worksheet = fakeWorksheet([
    { number: 1, getCell: () => ({ value: 'Dia' }) },
    fakeRow(2, ['23/08/2026', 'Corrida']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.equal(records.length, 0);
  assert.deepEqual(errors, [
    { row: 1, col: 'Data', error: 'Missing required column.' },
    { row: 1, col: 'Tipo', error: 'Missing required column.' },
  ], 'a lone legacy Dia header no longer satisfies the date column');
});

test('parseSheet treats cells beyond a short row as empty', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Data', 'Tipo', 'Período', 'RPE']),
    fakeRow(2, ['23/08/2026', 'Corrida']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].rpe, '');
});
