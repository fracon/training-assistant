'use strict';

const { withCompletedAnamnesis } = require('./helpers/anamnesis.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ExcelJS = require('exceljs');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'Importer@Example.com',
  password: 'super-secret-1',
  first_name: 'Imp',
  last_name: 'Orter',
};

const HEADERS = [
  'Data',
  'Dia',
  'Período',
  'Tipo',
  'Treino',
  'Detalhes',
  'FC alvo',
  'RPE',
  'Tênis',
  'Previsão do tempo',
  'Observações',
];

async function spreadsheetBuffer(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Treinos');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function multipartBody(boundary, filename, buffer, contentType = 'application/octet-stream') {
  const parts = [];
  if (buffer !== null) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `content-disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `content-type: ${contentType}\r\n\r\n`
      )
    );
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function httpRequest(base, path, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(path, base),
      { method, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function setup({ maxFileSizeBytes } = {}) {
  const db = withCompletedAnamnesis(createDatabase({ filename: ':memory:' }));
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    ...(maxFileSizeBytes ? { maxFileSizeBytes } : {}),
  });

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: REGISTER_PAYLOAD });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const rawCookie = [].concat(login.headers['set-cookie'] ?? [])[0];
  const cookiePair = rawCookie.split(';')[0];

  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  await createActiveCycle(app, cookiePair);

  const upload = async (
    buffer,
    filename = 'planilha.xlsx',
    cookies = cookiePair,
    contentType = 'application/octet-stream'
  ) => {
    const boundary = `----trainingassistant${Date.now()}${Math.random().toString(16).slice(2)}`;
    const body = multipartBody(boundary, filename, buffer ?? null, contentType);
    const response = await httpRequest(
      base,
      '/api/calendar/import',
      {
        method: 'POST',
        headers: {
          cookie: cookies ?? '',
          connection: 'close',
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
        body,
      }
    );
    return {
      status: response.status,
      json: async () => JSON.parse(response.text || '{}'),
    };
  };

  const getTrainings = async (cookies = cookiePair) => {
    const response = await httpRequest(base, '/api/calendar/trainings', {
      method: 'GET',
      headers: { cookie: cookies ?? '', connection: 'close' },
    });
    return {
      status: response.status,
      json: async () => JSON.parse(response.text || '{}'),
    };
  };

  return { db, app, cookiePair, upload, getTrainings };
}

async function createActiveCycle(app, cookiePair) {
  await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie: cookiePair },
    payload: { objective: 'Test Marathon', status: 'active' },
  });
}

test('spreadsheet import requires an authenticated session', async () => {
  const { app, upload } = await setup();

  const buffer = await spreadsheetBuffer(HEADERS, [['23/08/2026', '', 'Corrida']]);
  const anonymous = await upload(buffer, 'planilha.xlsx', null);
  assert.equal(anonymous.status, 401);

  await app.close();
});

test('import rejects requests without an active training cycle', async () => {
  const db = withCompletedAnamnesis(createDatabase({ filename: ':memory:' }));
  const app = await buildServer({ db, sessionCookieSecure: false });

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: REGISTER_PAYLOAD });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];

  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const buffer = await spreadsheetBuffer(HEADERS, [['23/08/2026', '', 'Corrida']]);
  const boundary = `----ta${Date.now()}`;
  const body = multipartBody(boundary, 'planilha.xlsx', buffer);
  const response = await httpRequest(base, '/api/calendar/import', {
    method: 'POST',
    headers: {
      cookie,
      connection: 'close',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.text), { error: 'No active training cycle. Create one first.' });

  await app.close();
  db.close();
});

test('import rejects requests without a file part', async () => {
  const { app, upload } = await setup();

  const response = await upload(null);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Missing spreadsheet file.' });

  await app.close();
});

test('import rejects buffers that are not valid spreadsheets', async () => {
  const { app, upload } = await setup();

  const response = await upload(Buffer.from('PK\x05\x06' + '\0'.repeat(18)));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Unsupported spreadsheet file. Please upload a valid .xlsx or .xls workbook.',
  });

  await app.close();
});

test('import accepts a valid xlsx when the browser sends a generic MIME type', async () => {
  const { app, upload } = await setup();
  const buffer = await spreadsheetBuffer(HEADERS, [
    ['23/08/2026', 'Domingo', 'Manhã', 'Corrida', 'Leve', '', '', '', '', '', ''],
  ]);

  const response = await upload(buffer, 'valid.xlsx', undefined, 'application/zip');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 1, skipped: 0 });
  await app.close();
});

test('import rejects files without a spreadsheet MIME type or extension', async () => {
  const { app, upload } = await setup();
  const buffer = await spreadsheetBuffer(HEADERS, [['23/08/2026', '', 'Corrida']]);

  const response = await upload(buffer, 'valid.txt', undefined, 'application/octet-stream');

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Unsupported spreadsheet file. Please upload a valid .xlsx or .xls workbook.',
  });
  await app.close();
});

test('import parses rows, normalizes Dia and persists trainings', async () => {
  const { db, app, upload, getTrainings } = await setup();

  const buffer = await spreadsheetBuffer(HEADERS, [
    ['23/08/2026', 'Domingo', 'Manhã', 'Corrida', 'Longão', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Leve'],
    [new Date(2026, 7, 25), 'Terça', 'Tarde', 'Intervalado', '', '', '', '', '', '', ''],
    ['', '', ''],
  ]);
  const response = await upload(buffer);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 2, skipped: 0 });

  const stored = db
    .prepare('SELECT dia, periodo, tipo, treino FROM trainings ORDER BY dia')
    .all();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[0], {
    dia: '2026-08-23',
    periodo: 'Manhã',
    tipo: 'Corrida',
    treino: 'Longão',
  });
  assert.equal(stored[1].dia, '2026-08-25');

  const listed = await getTrainings();
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).trainings.length, 2);

  await app.close();
});

test('import persists a planned location column and exposes it via the session API', async () => {
  const { db, app, upload } = await setup();

  const headers = ['Data', 'Dia', 'Tipo', 'Localização'];
  const buffer = await spreadsheetBuffer(headers, [
    ['23/08/2026', 'Domingo', 'Corrida', 'Fânzeres'],
    ['24/08/2026', 'Segunda', 'Rodagem', ''],
  ]);
  const response = await upload(buffer);
  assert.equal(response.status, 200);

  const rows = db
    .prepare('SELECT dia, location FROM trainings ORDER BY dia')
    .all();
  assert.deepEqual(rows, [
    { dia: '2026-08-23', location: 'Fânzeres' },
    { dia: '2026-08-24', location: null },
  ]);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];
  const session = await app.inject({
    method: 'GET',
    url: '/api/trainings/1',
    headers: { cookie },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().training.location, 'Fânzeres');

  await app.close();
});

test('English AI Coach location survives Excel import, persistence, and session retrieval verbatim', async () => {
  const { db, app, upload } = await setup();
  const location = 'Parc de la Tête-d’Or — Łódź, sector A!';
  const buffer = await spreadsheetBuffer(
    ['Date', 'Day', 'Period', 'Type', 'Workout', 'Details', 'Target HR', 'RPE', 'Shoe', 'Location', 'Weather Forecast', 'Notes'],
    [['23/08/2026', 'Sunday', 'Morning', 'Run', 'Long run', 'Zone 2', '150', '3', 'Adizero', location, '73 °F', 'Easy']]
  );
  const response = await upload(buffer);
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT location FROM trainings').get().location, location);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];
  const session = await app.inject({ method: 'GET', url: '/api/trainings/1', headers: { cookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().training.location, location);

  await app.close();
});

test('import skips exact date/name/description duplicates while keeping distinct same-day workouts', async () => {
  const { db, app, upload, getTrainings } = await setup();

  db.prepare(
    'INSERT INTO trainings (user_id, dia, tipo, treino, detalhes) VALUES (?, ?, ?, ?, ?)'
  ).run(1, '2026-08-23', 'Corrida', 'Longão', 'Zona 2');

  const buffer = await spreadsheetBuffer(HEADERS, [
    ['23/08/2026', 'Domingo', 'Manhã', 'Corrida', 'Longão', 'Zona 2'],
    ['23/08/2026', 'Domingo', 'Tarde', 'Tempo', 'Tempo run', 'Zona 2'],
    ['23/08/2026', 'Domingo', 'Noite', 'Corrida', 'Tempo run', 'Zona 3'],
    ['24/08/2026', 'Segunda', 'Manhã', 'Intervalado', 'Pista', '8x400m'],
    ['24/08/2026', 'Segunda', 'Tarde', 'Intervalado', 'Pista', '8x400m'],
  ]);
  const response = await upload(buffer);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 3, skipped: 2 });

  const listed = await getTrainings();
  const trainings = (await listed.json()).trainings;
  assert.equal(trainings.length, 4);
  assert.deepEqual(
    trainings.map(({ dia, treino, detalhes }) => [dia, treino, detalhes]),
    [
      ['2026-08-23', 'Longão', 'Zona 2'],
      ['2026-08-23', 'Tempo run', 'Zona 2'],
      ['2026-08-23', 'Tempo run', 'Zona 3'],
      ['2026-08-24', 'Pista', '8x400m'],
    ]
  );

  await app.close();
});

test('listing trainings returns only the owner rows ordered by date', async () => {
  const { db, app, getTrainings } = await setup();

  const insert = db.prepare(
    'INSERT INTO trainings (user_id, dia, tipo) VALUES (?, ?, ?)'
  );
  insert.run(1, '2026-08-23', 'Corrida');
  insert.run(1, '2026-08-20', 'Ciclismo');

  const response = await getTrainings();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    payload.trainings.map((training) => [training.dia, training.tipo]),
    [
      ['2026-08-20', 'Ciclismo'],
      ['2026-08-23', 'Corrida'],
    ]
  );

  const anonymous = await getTrainings(null);
  assert.equal(anonymous.status, 401);

  await app.close();
});

test('import aborts entirely and reports every offending row', async () => {
  const { db, app, upload } = await setup();

  const buffer = await spreadsheetBuffer(HEADERS, [
    ['23/08/2026', 'Domingo', 'Manhã', 'Corrida'],
    ['', 'Segunda', 'Tarde', 'Ciclismo'],
    ['31/02/2026', 'Quarta', 'Noite', 'Natação'],
    ['26/08/2026', 'Quinta'],
    ['27/08/2026', 'Sexta', 'Manhã', 'Musculação'],
  ]);
  const response = await upload(buffer);

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(Array.isArray(payload.errors), true);
  // Row numbers reference the spreadsheet itself, header included (row 1).
  assert.deepEqual(payload.errors[0], { row: 3, col: 'Data', error: 'Required value is empty.' });
  assert.deepEqual(payload.errors[1], {
    row: 4,
    col: 'Data',
    error: 'Invalid date format. Use DD/MM/YYYY.',
  });
  assert.deepEqual(payload.errors[2], { row: 5, col: 'Tipo', error: 'Required value is empty.' });

  const stored = db.prepare('SELECT COUNT(*) AS total FROM trainings').get();
  assert.equal(stored.total, 0, 'no partial inserts on failed imports');

  await app.close();
});

test('import rejects sheets whose required columns are missing', async () => {
  const { app, upload } = await setup();

  const withoutTipo = await upload(
    await spreadsheetBuffer(['Data', 'Período'], [['23/08/2026', 'Manhã']])
  );
  assert.equal(withoutTipo.status, 400);
  assert.deepEqual(await withoutTipo.json(), {
    errors: [{ row: 1, col: 'Tipo', error: 'Missing required column.' }],
  });

  const legacyDiaOnly = await upload(
    await spreadsheetBuffer(['Dia', 'Período'], [['Segunda', 'Manhã']])
  );
  assert.equal(legacyDiaOnly.status, 400);
  assert.deepEqual(await legacyDiaOnly.json(), {
    errors: [
      { row: 1, col: 'Data', error: 'Missing required column.' },
      { row: 1, col: 'Tipo', error: 'Missing required column.' },
    ],
  });

  const withoutBoth = await upload(await spreadsheetBuffer(['Treino', 'RPE'], [['Fácil', '2']]));
  assert.equal(withoutBoth.status, 400);
  const payload = await withoutBoth.json();
  assert.deepEqual(payload.errors, [
    { row: 1, col: 'Data', error: 'Missing required column.' },
    { row: 1, col: 'Tipo', error: 'Missing required column.' },
  ]);

  await app.close();
});

test('import expects multipart requests', async () => {
  const db = withCompletedAnamnesis(createDatabase({ filename: ':memory:' }));
  const app = await buildServer({ db, sessionCookieSecure: false });

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: REGISTER_PAYLOAD });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookiePair = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];

  await createActiveCycle(app, cookiePair);

  const response = await app.inject({
    method: 'POST',
    url: '/api/calendar/import',
    headers: { cookie: cookiePair },
    payload: { not: 'multipart' },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Expected multipart/form-data upload.' });

  await app.close();
});

test('import enforces the configured file size limit with a 413', async () => {
  const { app, upload } = await setup({ maxFileSizeBytes: 512 });

  const big = Buffer.concat([
    await spreadsheetBuffer(HEADERS, []),
    Buffer.alloc(2048, 1),
  ]);
  const response = await upload(big);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'File exceeds the size limit.' });

  await app.close();
});

test('import rejects workbooks without any sheet', async () => {
  const { app, upload } = await setup();

  const emptyWorkbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(await emptyWorkbook.xlsx.writeBuffer());
  const response = await upload(buffer);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'The spreadsheet has no sheets.' });

  await app.close();
});

test('import rejects header-only sheets that contain no training rows', async () => {
  const { app, upload } = await setup();

  const response = await upload(await spreadsheetBuffer(HEADERS, []));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    errors: [{ row: 1, col: 'Data', error: 'No training rows found.' }],
  });

  await app.close();
});

// Roadmap S3 / SheetJS security update. The backend reads workbooks with
// SheetJS (PR #26) because ExcelJS rejects namespace-prefixed workbook XML
// and cannot read legacy .xls files; both must keep importing.
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function inlineCell(ref, text) {
  return `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${text}</x:t></x:is></x:c>`;
}
async function namespacedWorkbook(rows) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const columns = 'ABCDEFGHIJKL';
  const sheetRows = rows.map((row, index) => `<x:row r="${index + 1}">${
    row.map((value, column) => inlineCell(`${columns[column]}${index + 1}`, value)).join('')}</x:row>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><x:workbook xmlns:x="${NS}" xmlns:r="${REL}"><x:sheets><x:sheet name="Treinos" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${NS}"><x:sheetData>${sheetRows}</x:sheetData></x:worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('import keeps reading namespace-prefixed workbooks (PR #26)', async () => {
  const { db, app, upload } = await setup();
  const buffer = await namespacedWorkbook([
    ['Data', 'Dia', 'Tipo', 'Treino', 'Detalhes'],
    ['12/09/2026', 'Sábado', 'Corrida', 'Longão', '90 min leve'],
  ]);
  // ExcelJS, the alternative library, cannot read this workbook.
  await assert.rejects(new ExcelJS.Workbook().xlsx.load(buffer).then((workbook) => {
    if (!workbook.worksheets[0]?.getCell('A2').value) throw new Error('unreadable');
  }));

  const response = await upload(buffer, 'treinos.xlsx');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 1, skipped: 0 });
  assert.deepEqual(db.prepare('SELECT dia, tipo, treino, detalhes FROM trainings').get(),
    { dia: '2026-09-12', tipo: 'Corrida', treino: 'Longão', detalhes: '90 min leve' });
  await app.close();
});

test('import keeps reading legacy .xls workbooks', async () => {
  const XLSX = require('xlsx');
  const { db, app, upload } = await setup();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Data', 'Dia', 'Tipo', 'Treino'],
    ['13/09/2026', 'Domingo', 'Corrida', 'Regenerativo'],
  ]), 'Treinos');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' });

  const response = await upload(buffer, 'treinos.xls', undefined, 'application/vnd.ms-excel');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 1, skipped: 0 });
  assert.deepEqual(db.prepare('SELECT dia, treino FROM trainings').get(), { dia: '2026-09-13', treino: 'Regenerativo' });
  await app.close();
});

test('the workbook reader is a SheetJS release with the known advisories fixed', () => {
  // npm's `xlsx` stopped at 0.18.5 (prototype pollution GHSA-4r6h-8v6p-xvw6,
  // ReDoS GHSA-5pgg-2g8v-p4x9); fixed releases ship from cdn.sheetjs.com.
  const { version } = require('xlsx');
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 0 || minor > 20 || (minor === 20 && patch >= 2), version);
  const lock = require('../package-lock.json').packages['node_modules/xlsx'];
  assert.match(lock.resolved, /^https:\/\/cdn\.sheetjs\.com\/xlsx-\d+\.\d+\.\d+\/xlsx-\d+\.\d+\.\d+\.tgz$/);
  assert.match(lock.integrity, /^sha512-/);
});

test('calendar sessions expose owner-scoped completion and realized effort for agenda status', async (t) => {
  const { db, app, getTrainings } = await setup();
  t.after(async () => { await app.close(); db.close(); });
  const owner = db.prepare('SELECT id FROM users').get().id;
  const other = Number(db.prepare("INSERT INTO users (email, password_hash) VALUES ('other-agenda@example.test', 'unused')").run().lastInsertRowid);
  const insert = db.prepare('INSERT INTO trainings (user_id, dia, tipo, completed, feedback_rpe) VALUES (?, ?, ?, ?, ?)');
  insert.run(owner, '2026-11-05', 'Leve', 1, 3);
  insert.run(owner, '2026-11-06', 'Leve', 0, null);
  insert.run(other, '2026-11-05', 'Leve', 1, 5);
  const response = await getTrainings();
  assert.equal(response.status, 200);
  const { trainings } = await response.json();
  assert.deepEqual(trainings.map(({ completed, feedback_rpe }) => ({ completed, feedback_rpe })), [{ completed: 1, feedback_rpe: 3 }, { completed: 0, feedback_rpe: null }]);
});
