'use strict';

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

function multipartBody(boundary, filename, buffer) {
  const parts = [];
  if (buffer !== null) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `content-disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `content-type: application/octet-stream\r\n\r\n`
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
  const db = createDatabase({ filename: ':memory:' });
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

  const upload = async (buffer, filename = 'planilha.xlsx', cookies = cookiePair) => {
    const boundary = `----trainingassistant${Date.now()}${Math.random().toString(16).slice(2)}`;
    const body = multipartBody(boundary, filename, buffer ?? null);
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
  const db = createDatabase({ filename: ':memory:' });
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

  const response = await upload(Buffer.from('this is not a spreadsheet'));
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
  assert.deepEqual(await response.json(), { imported: 2 });

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
  const db = createDatabase({ filename: ':memory:' });
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
