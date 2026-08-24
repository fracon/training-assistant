'use strict';

// Header aliases are accent-less, lowercase keys so "Período", "PERIODO" and
// "periodo" all resolve to the same field.
const FIELD_BY_HEADER = {
  dia: 'dia',
  periodo: 'periodo',
  tipo: 'tipo',
  treino: 'treino',
  detalhes: 'detalhes',
  'fc alvo': 'fc_alvo',
  rpe: 'rpe',
  tenis: 'tenis',
  'previsao no horario': 'previsao',
  observacoes: 'observacoes',
};

const REQUIRED_FIELDS = ['dia', 'tipo'];
const FIELD_ORDER = [
  'dia',
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

// Accepts JS Dates from real date cells, raw Excel serials and strings in
// DD/MM/YYYY (the spec format) or YYYY-MM-DD. Always yields YYYY-MM-DD.
function normalizeDia(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      ok: true,
      iso: `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`,
    };
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { ok: true, iso: isoFromSerial(value) };
  }
  const text = cellToText(value);
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, day, month, year] = slash;
    if (isValidIso(Number(year), Number(month), Number(day))) {
      return { ok: true, iso: `${year}-${pad2(month)}-${pad2(day)}` };
    }
    return { ok: false };
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, year, month, day] = iso;
    if (isValidIso(Number(year), Number(month), Number(day))) {
      return { ok: true, iso: text };
    }
  }
  return { ok: false };
}

// exceljs cells can be primitives, Date objects, formula results
// ({ result }), rich text ({ richText }), or hyperlink objects ({ text }).
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getDate()}/${value.getMonth() + 1}/${value.getFullYear()}`;
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
            col: required === 'dia' ? 'Dia' : 'Tipo',
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
    for (const [column, field] of Object.entries(fieldsByColumn)) {
      const text = cellToText(cellValue(Number(column)));
      values[field] = text;
      if (text !== '') hasContent = true;
    }
    if (!hasContent) return;

    const dia = normalizeDia(values.dia);
    if (!dia.ok) {
      errors.push({
        row: rowNumber,
        col: 'Dia',
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
    record.dia = dia.iso;
    records.push(record);
  });

  if (!sawHeader) {
    errors.push({ row: 1, col: 'Dia', error: 'Missing header row.' });
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
  isValidIso,
  normalizeDia,
  cellToText,
  parseSheet,
};
