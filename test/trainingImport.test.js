'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_BY_HEADER,
  REQUIRED_FIELDS,
  accentless,
  pad2,
  isoFromSerial,
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

test('isValidIso rejects impossible calendar dates', () => {
  assert.equal(isValidIso(2026, 2, 29), false);
  assert.equal(isValidIso(2024, 2, 29), true);
  assert.equal(isValidIso(2026, 4, 31), false);
  assert.equal(isValidIso(2026, 13, 1), false);
  assert.equal(isValidIso(2026, 0, 10), false);
});

test('normalizeDia handles Date objects, serials and DD/MM/YYYY strings', () => {
  assert.deepEqual(normalizeDia(new Date(2026, 7, 23)), { ok: true, iso: '2026-08-23' });
  assert.deepEqual(normalizeDia(new Date(2026, 0, 5)), { ok: true, iso: '2026-01-05' });

  const serial = (Date.UTC(2026, 7, 23) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.deepEqual(normalizeDia(serial), { ok: true, iso: '2026-08-23' });

  assert.deepEqual(normalizeDia('23/08/2026'), { ok: true, iso: '2026-08-23' });
  assert.deepEqual(normalizeDia(' 1/3/2026 '), { ok: true, iso: '2026-03-01' });
  assert.deepEqual(normalizeDia('2026-08-23'), { ok: true, iso: '2026-08-23' });
});

test('normalizeDia rejects junk and impossible dates', () => {
  for (const junk of ['', '   ', '31/02/2026', '32/01/2026', '00/00/0000', '2026-13-01', 'Aug 23', '08/2026', null, undefined, {}, true]) {
    assert.equal(normalizeDia(junk).ok, false, String(junk));
  }
});

test('cellToText flattens every exceljs cell shape', () => {
  assert.equal(cellToText('  Corrida '), 'Corrida');
  assert.equal(cellToText(42), '42');
  assert.equal(cellToText(null), '');
  assert.equal(cellToText(undefined), '');
  assert.equal(cellToText(new Date(2026, 7, 23)), '23/8/2026');
  assert.equal(cellToText(new Date('not a date')), '');
  assert.equal(cellToText({ result: ' Intervalado ' }), 'Intervalado');
  assert.equal(cellToText({ richText: [{ text: 'Long ' }, { text: 'Run' }] }), 'Long Run');
  assert.equal(cellToText({ text: 'https://sheet', hyperlink: 'x' }), 'https://sheet');
  assert.equal(cellToText({ formula: 'A1' }), '', 'formula cells without results are empty');
  assert.equal(cellToText({}), '');
  assert.equal(cellToText(new Number(7)), '7', 'boxed primitives stringify');
  assert.equal(cellToText({ toString: () => 'Custom' }), 'Custom');
});

test('header aliases cover the ten spec columns', () => {
  const expected = [
    'dia', 'periodo', 'tipo', 'treino', 'detalhes',
    'fc alvo', 'rpe', 'tenis', 'previsao no horario', 'observacoes',
  ];
  for (const header of expected) {
    assert.ok(FIELD_BY_HEADER[header], header);
  }
  assert.deepEqual(REQUIRED_FIELDS, ['dia', 'tipo']);
});

test('parseSheet maps valid rows and normalizes Dia to ISO', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Dia', 'Período', 'Tipo', 'Treino', 'Detalhes', 'FC alvo', 'RPE', 'Tênis', 'Previsão no horário', 'Observações']),
    fakeRow(2, ['23/08/2026', 'Morning', 'Corrida', 'Long Run', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Sentir leve']),
    fakeRow(3, [new Date(2026, 7, 25), '', 'Intervalado', '', '', '', '', '', '', '']),
  ]);

  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 2);

  assert.deepEqual(records[0], {
    dia: '2026-08-23',
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
  assert.equal(records[1].tipo, 'Intervalado');
  assert.equal(records[1].periodo, '');
});

test('parseSheet reports missing required columns on the header row', () => {
  const withoutTipo = parseSheet(fakeWorksheet([
    fakeRow(1, ['Dia', 'Período', 'Treino']),
    fakeRow(2, ['23/08/2026', 'Morning', 'Corrida']),
  ]));
  assert.deepEqual(withoutTipo.errors, [{ row: 1, col: 'Tipo', error: 'Missing required column.' }]);
  assert.equal(withoutTipo.records.length, 0);

  const withoutBoth = parseSheet(fakeWorksheet([fakeRow(1, ['Treino', 'RPE'])]));
  assert.deepEqual(withoutBoth.errors, [
    { row: 1, col: 'Dia', error: 'Missing required column.' },
    { row: 1, col: 'Tipo', error: 'Missing required column.' },
  ]);
});

test('parseSheet aborts rows with blank or invalid required cells', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Dia', 'Tipo']),
    fakeRow(2, ['', 'Corrida']),
    fakeRow(3, ['31/02/2026', 'Corrida']),
    fakeRow(4, ['24/08/2026', '']),
    fakeRow(5, ['25/08/2026', 'Ciclismo']),
  ]);

  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, [
    { row: 2, col: 'Dia', error: 'Required value is empty.' },
    { row: 3, col: 'Dia', error: 'Invalid date format. Use DD/MM/YYYY.' },
    { row: 4, col: 'Tipo', error: 'Required value is empty.' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].dia, '2026-08-25');
});

test('parseSheet skips fully empty data rows silently', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Dia', 'Tipo']),
    fakeRow(2, [null, undefined]),
    fakeRow(3, ['26/08/2026', 'Corrida']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].dia, '2026-08-26');
});

test('parseSheet flags a workbook with no usable rows at all', () => {
  const empty = parseSheet(fakeWorksheet([]));
  assert.deepEqual(empty.errors, [{ row: 1, col: 'Dia', error: 'Missing header row.' }]);
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
    { row: 1, col: 'Dia', error: 'Missing required column.' },
    { row: 1, col: 'Tipo', error: 'Missing required column.' },
  ]);
});

test('parseSheet treats cells beyond a short row as empty', () => {
  const worksheet = fakeWorksheet([
    fakeRow(1, ['Dia', 'Tipo', 'Período', 'RPE']),
    fakeRow(2, ['23/08/2026', 'Corrida']),
  ]);
  const { records, errors } = parseSheet(worksheet);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].rpe, '');
});
