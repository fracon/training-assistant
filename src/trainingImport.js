'use strict';

// Header aliases are accent-less, lowercase keys so "Período", "PERIODO" and
// "periodo" all resolve to the same field.
// Phase 7 AI sheets carry 11 columns: "Data" holds the real date (mapped to
// the internal dia), while "Dia" holds a weekday string like "Segunda"
// (captured as dia_semana and never date-validated). The DB keeps using
// `dia` for the ISO date, so no migration is needed.
const FIELD_BY_HEADER = {
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
};

const REQUIRED_FIELDS = ['dia', 'tipo'];
const FIELD_ORDER = [
  'dia',
  'dia_semana',
  'periodo',
  'tipo',
  'treino',
  'detalhes',
  'fc_alvo',
  'rpe',
  'tenis',
  'previsao',
  'observacoes',
];

function accentless(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function pad2(number) {
  return String(number).padStart(2, '0');
}

// Excel serial dates count days since 1899-12-30 (including the Lotus 1-2-3
// 1900 leap-year bug offset).
function isoFromSerial(serial) {
  const ms = Math.round(serial * 86400000);
  const date = new Date(Date.UTC(1899, 11, 30) + ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function isValidIso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// exceljs materializes serial dates around UTC midnight while locally built
// Dates sit on local midnight; reading with the wrong getters shifts the
// calendar day by one near timezone boundaries. Whichever side reports
// midnight wins, so the wall-calendar day is always preserved.
function isoFromCellDate(date) {
  const utcMidnight =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  const localMidnight =
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0;
  if (localMidnight && !utcMidnight) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// Accepts JS Dates from real date cells (timezone-shift-proof), raw Excel
// serials and strings in DD/MM/YYYY or DD-MM-YYYY (single digits allowed,
// surrounding whitespace ignored) or YYYY-MM-DD. Returns the YYYY-MM-DD
// string, or null when the value is not a trustworthy calendar date.
function normalizeDia(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoFromCellDate(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return isoFromSerial(value);
  }
  const text = String(cellToText(value)).trim();
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return isValidIso(Number(year), Number(month), Number(day))
      ? `${year}-${pad2(month)}-${pad2(day)}`
      : null;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, year, month, day] = iso;
    return isValidIso(Number(year), Number(month), Number(day)) ? text : null;
  }
  return null;
}

// exceljs cells can be primitives, Date objects, formula results
// ({ result }), rich text ({ richText }), or hyperlink objects ({ text }).
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const [year, month, day] = isoFromCellDate(value).split('-');
    return `${Number(day)}/${Number(month)}/${year}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('').trim();
    }
    if ('result' in value) return cellToText(value.result);
    if (typeof value.text === 'string') return value.text.trim();
    if (value.toString && value.toString !== Object.prototype.toString) {
      return String(value).trim();
    }
    return '';
  }
  const text = String(value).trim();
  return text === 'undefined' ? '' : text;
}

// Builds the record list and row-level error array for a worksheet proxy
// exposing eachRow(cb) with rows carrying .number and .cellCount/.values-ish
// access via getCell(columnNumber).value - the surface used by exceljs.
function parseSheet(worksheet) {
  const errors = [];
  const records = [];
  let fieldsByColumn = null;
  let sawHeader = false;
  let headerOk = false;

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const rowNumber = row.number;
    const cellValue = (column) => {
      const cell = row.getCell(column);
      if (!cell) {
        return null;
      }
      return cell.value;
    };

    if (!sawHeader) {
      sawHeader = true;
      fieldsByColumn = {};
      const total = Math.max(row.cellCount ?? 0, 0);
      for (let column = 1; column <= total; column += 1) {
        const header = FIELD_BY_HEADER[accentless(cellToText(cellValue(column)))];
        if (header) fieldsByColumn[column] = header;
      }
      headerOk = REQUIRED_FIELDS.every((required) =>
        Object.values(fieldsByColumn).includes(required)
      );
      for (const required of REQUIRED_FIELDS) {
        if (!Object.values(fieldsByColumn).includes(required)) {
          errors.push({
            row: 1,
            col: required === 'dia' ? 'Data' : 'Tipo',
            error: 'Missing required column.',
          });
        }
      }
      return;
    }
    if (!headerOk) return;

    const values = {};
    for (const field of FIELD_ORDER) values[field] = '';
    let hasContent = false;
    let filledCells = 0;
    let soleText = '';
    for (const [column, field] of Object.entries(fieldsByColumn)) {
      const text = cellToText(cellValue(Number(column)));
      values[field] = text;
      if (text !== '') {
        hasContent = true;
        filledCells += 1;
        soleText = text;
      }
    }
    if (!hasContent) return;

    // AI coaches append "Nota:"/"Note:"/"Observação:" footers under the
    // table; a lone cell carrying one is metadata, never a training attempt.
    if (
      filledCells === 1 &&
      /^(nota|note|observacao)/.test(accentless(soleText))
    ) {
      return;
    }

    const dia = normalizeDia(values.dia);
    if (dia === null) {
      errors.push({
        row: rowNumber,
        col: 'Data',
        error:
          values.dia === ''
            ? 'Required value is empty.'
            : 'Invalid date format. Use DD/MM/YYYY.',
      });
    }
    if (values.tipo === '') {
      errors.push({
        row: rowNumber,
        col: 'Tipo',
        error: 'Required value is empty.',
      });
    }
    if (errors.some((error) => error.row === rowNumber)) return;

    const record = {};
    for (const field of FIELD_ORDER) record[field] = values[field];
    record.dia = dia;
    records.push(record);
  });

  if (!sawHeader) {
    errors.push({ row: 1, col: 'Data', error: 'Missing header row.' });
  }

  return { records, errors };
}

module.exports = {
  FIELD_BY_HEADER,
  FIELD_ORDER,
  REQUIRED_FIELDS,
  accentless,
  pad2,
  isoFromSerial,
  isoFromCellDate,
  isValidIso,
  normalizeDia,
  cellToText,
  parseSheet,
};
