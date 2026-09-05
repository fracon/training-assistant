'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchCalendarTrainings,
  importTrainingsFile,
  changePassword,
} = require('../src/public/shared/api.js');
const { keyFromIso, trainingsByDay } = require('../src/public/calendar.js');

const originalFetch = globalThis.fetch;

function stubFetchOnce(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('fetchCalendarTrainings returns the trainings array', async () => {
  const calls = stubFetchOnce(async () => ({
    ok: true,
    json: async () => ({ trainings: [{ dia: '2026-08-23', tipo: 'Corrida' }] }),
  }));

  const trainings = await fetchCalendarTrainings();
  assert.deepEqual(trainings, [{ dia: '2026-08-23', tipo: 'Corrida' }]);
  assert.equal(calls[0].url, '/api/calendar/trainings');
});

test('fetchCalendarTrainings degrades to an empty list on failures', async () => {
  stubFetchOnce(async () => ({ ok: false, json: async () => ({}) }));
  assert.deepEqual(await fetchCalendarTrainings(), []);

  stubFetchOnce(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await fetchCalendarTrainings(), []);

  stubFetchOnce(async () => ({ ok: true, json: async () => ({ trainings: 'junk' }) }));
  assert.deepEqual(await fetchCalendarTrainings(), []);
});

test('fetchCalendarTrainings sends the dashboard week window as from/to query params', async () => {
  const calls = stubFetchOnce(async () => ({
    ok: true,
    json: async () => ({ trainings: [] }),
  }));

  await fetchCalendarTrainings('2026-08-17', '2026-08-23');
  assert.equal(calls[0].url, '/api/calendar/trainings?from=2026-08-17&to=2026-08-23');

  calls.length = 0;
  await fetchCalendarTrainings('2026-08-17');
  assert.equal(calls[0].url, '/api/calendar/trainings?from=2026-08-17');

  calls.length = 0;
  await fetchCalendarTrainings(undefined, '2026-08-23');
  assert.equal(calls[0].url, '/api/calendar/trainings?to=2026-08-23');
});

test('importTrainingsFile uploads FormData to the import endpoint', async () => {
  const calls = stubFetchOnce(async () => ({
    ok: true,
    json: async () => ({ imported: 4 }),
  }));

  const file = new Blob(['planilha'], { type: 'application/octet-stream' });
  const result = await importTrainingsFile(file);

  assert.deepEqual(result, { imported: 4 });
  assert.equal(calls[0].url, '/api/calendar/import');
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.body instanceof FormData);
  const storedFile = calls[0].options.body.get('file');
  assert.ok(storedFile instanceof Blob, 'file part is preserved as a blob');
  assert.equal(storedFile.size, file.size);
  assert.equal(storedFile.type, file.type);
});

test('importTrainingsFile surfaces row-level errors from a 400 response', async () => {
  const rowErrors = [
    { row: 3, col: 'Dia', error: 'Required value is empty.' },
    { row: 4, col: 'Dia', error: 'Invalid date format. Use DD/MM/YYYY.' },
  ];
  stubFetchOnce(async () => ({
    ok: false,
    json: async () => ({ errors: rowErrors }),
  }));

  await assert.rejects(
    () => importTrainingsFile({ name: 'planilha.xlsx' }),
    (error) => error.rowErrors && error.rowErrors.length === 2
  );
});

test('importTrainingsFile falls back to generic errors without row details', async () => {
  stubFetchOnce(async () => ({
    ok: false,
    json: async () => ({ error: 'Unsupported spreadsheet file. Please upload a valid .xlsx or .xls workbook.' }),
  }));

  await assert.rejects(
    () => importTrainingsFile({ name: 'planilha.xlsx' }),
    (error) => error.rowErrors === null && /Unsupported spreadsheet/.test(error.message)
  );

  stubFetchOnce(async () => ({
    ok: false,
    json: async () => {
      throw new Error('not json');
    },
  }));
  await assert.rejects(() => importTrainingsFile({ name: 'x.xlsx' }), /Import failed\./);

  stubFetchOnce(async () => {
    throw new Error('offline');
  });
  await assert.rejects(() => importTrainingsFile({ name: 'x.xlsx' }), /Network unavailable\./);
});

test('keyFromIso converts zero-padded ISO dates into grid cell keys', () => {
  assert.equal(keyFromIso('2026-08-23'), '2026-8-23');
  assert.equal(keyFromIso('2025-01-05'), '2025-1-5');
});

test('trainingsByDay groups rows by their grid cell key in order', () => {
  const grouped = trainingsByDay([
    { dia: '2026-08-23', tipo: 'Corrida' },
    { dia: '2026-08-23', tipo: 'Ciclismo' },
    { dia: '2026-09-01', tipo: 'Natação' },
  ]);

  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get('2026-8-23').map((training) => training.tipo), [
    'Corrida',
    'Ciclismo',
  ]);
  assert.deepEqual(grouped.get('2026-9-1').map((training) => training.tipo), ['Natação']);
});

test('changePassword PUTs the payload and attaches server error codes', async () => {
  const calls = stubFetchOnce(async () => ({
    ok: true,
    json: async () => ({ status: 'ok' }),
  }));

  const payload = {
    currentPassword: 'old-pass-1',
    newPassword: 'brand-new-1',
    confirmNewPassword: 'brand-new-1',
  };
  assert.deepEqual(await changePassword(payload), { status: 'ok' });
  assert.equal(calls[0].url, '/api/auth/password');
  assert.deepEqual(calls[0].options, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  globalThis.fetch = originalFetch;
  stubFetchOnce(async () => ({
    ok: false,
    json: async () => ({ error: 'Invalid password change request.', errors: ['passwordsMismatch'] }),
  }));

  await assert.rejects(changePassword(payload), (error) => {
    assert.equal(error.message, 'Invalid password change request.');
    assert.deepEqual(error.codes, ['passwordsMismatch']);
    return true;
  });
});

test('requestJson leaves no codes when the server reports none', async () => {
  stubFetchOnce(async () => ({
    ok: false,
    json: async () => ({ error: 'Generic failure.' }),
  }));

  await assert.rejects(changePassword({}), (error) => {
    assert.equal(error.message, 'Generic failure.');
    assert.equal(error.codes, undefined);
    return true;
  });
});
