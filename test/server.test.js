'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer, parseRpe } = require('../src/server');
const { generateMarkdown } = require('../src/markdownGenerator');

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

const GOOD_SUMMARY = {
  activity: {
    sport: 'running',
    startTime: '2026-02-03T07:30:00.000Z',
    endTime: '2026-02-03T08:10:00.000Z',
  },
  laps: [makeLapView()],
  totals: {
    durationSeconds: 1800.25,
    durationLabel: '30:00',
    distanceKm: 5.5,
    distanceLabel: '5.50',
    avgPaceSecondsPerKm: 327.3,
    avgPaceLabel: '5:27',
    avgHeartRate: 152,
    maxHeartRate: 164,
    ascentMeters: 45,
  },
};

function stubParse(summary = GOOD_SUMMARY) {
  return async (buffer) => {
    stubParse.lastBuffer = buffer;
    return summary;
  };
}

function failingParse() {
  return async () => {
    throw new Error('unreadable fit');
  };
}

function multipart(parts) {
  const boundary = '----trainingassistant';
  const chunks = [];
  for (const part of parts) {
    const filename = part.fileName ? `; filename="${part.fileName}"` : '';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: ${part.contentType || 'text/plain'}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function postParts(app, parts) {
  const body = multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/fit/parse',
    headers: body.headers,
    payload: body.payload,
  });
}

function fullFormFields() {
  return [
    { name: 'tipo_treino', value: 'Intervalado' },
    { name: 'treino_planejado', value: '6x1km forte | trote 400m' },
    { name: 'fc_alvo', value: '145–155 bpm' },
    { name: 'rpe_alvo', value: '4' },
    { name: 'tenis', value: 'Nimbus 26' },
    { name: 'fonte_fc', value: 'Cinta Peitoral' },
    { name: 'clima', value: '22°C, Nublado' },
    { name: 'terreno', value: 'Asfalto' },
    { name: 'rpe_percebido', value: '5' },
    { name: 'respiracao', value: 'Ofegante' },
    { name: 'sensacao_muscular', value: 'Pesada' },
    { name: 'energia_final', value: 'No limite' },
    { name: 'dor_desconforto', value: 'Pontada leve no Aquiles direito' },
    { name: 'feedback_livre', value: 'Vento contra | hidratei bem' },
  ];
}

test('parseRpe accepts blank, integer, and boundary values', () => {
  assert.deepEqual(parseRpe(undefined), { ok: true, value: null });
  assert.deepEqual(parseRpe(''), { ok: true, value: null });
  assert.deepEqual(parseRpe('   '), { ok: true, value: null });
  assert.deepEqual(parseRpe('3'), { ok: true, value: 3 });
  assert.deepEqual(parseRpe('1'), { ok: true, value: 1 });
  assert.deepEqual(parseRpe('5'), { ok: true, value: 5 });
});

test('parseRpe rejects non-integers and out-of-range values', () => {
  assert.deepEqual(parseRpe('abc'), { ok: false, error: 'rpe must be an integer between 1 and 5.' });
  assert.equal(parseRpe('2.5').ok, false);
  assert.equal(parseRpe('0').ok, false);
  assert.equal(parseRpe('6').ok, false);
});

test('POST /api/fit/parse rejects non-multipart requests', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await app.inject({
    method: 'POST',
    url: '/api/fit/parse',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Expected multipart/form-data upload.' });
});

test('POST /api/fit/parse requires a file field', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [{ name: 'feedback_livre', value: 'no file here' }]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Missing .FIT file field.' });
});

test('POST /api/fit/parse only accepts .FIT extensions', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'activity.txt', value: 'plain text' },
  ]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'Only .FIT files are supported.' });
});

test('POST /api/fit/parse validates the planned rpe field', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
    { name: 'rpe_alvo', value: 'eleven' },
  ]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'rpe must be an integer between 1 and 5.' });
});

test('POST /api/fit/parse validates the perceived rpe field', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
    { name: 'rpe_alvo', value: '' },
    { name: 'rpe_percebido', value: '6' },
  ]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'rpe must be an integer between 1 and 5.' });
});

test('POST /api/fit/parse reports unreadable files as 422', async () => {
  const app = await buildServer({ parseFitFile: failingParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
  ]);
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    error: 'Could not read lap data from this .FIT file.',
    detail: 'unreadable fit',
  });
});

test('POST /api/fit/parse enforces the configured size limit', async () => {
  const app = await buildServer({
    parseFitFile: failingParse(),
    maxFileSizeBytes: 8,
  });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: Buffer.alloc(64, 1) },
  ]);
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), { error: 'File exceeds the size limit.' });
});

test('POST /api/fit/parse renders the full coach prompt from the complete payload', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'WORKOUT.FIT', value: Buffer.from([0x0c, 0x00]) },
    ...fullFormFields(),
  ]);
  assert.equal(response.statusCode, 200);

  const payload = response.json();
  assert.equal(payload.fileName, 'WORKOUT.FIT');
  assert.equal(payload.sizeBytes, 2);
  assert.deepEqual(payload.activity, GOOD_SUMMARY.activity);
  assert.deepEqual(payload.laps, GOOD_SUMMARY.laps);
  assert.deepEqual(payload.totals, GOOD_SUMMARY.totals);
  assert.ok(stubParse.lastBuffer.equals(Buffer.from([0x0c, 0x00])));

  const expectedMarkdown = generateMarkdown(GOOD_SUMMARY, {
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
  });
  assert.equal(payload.markdown, expectedMarkdown);

  assert.ok(payload.markdown.includes('Tipo de treino: Intervalado'));
  assert.ok(payload.markdown.includes('RPE alvo: 4/5'));
  assert.ok(payload.markdown.includes('RPE percebido: 5/5'));
  assert.ok(payload.markdown.includes('Tênis utilizado: Nimbus 26'));
  assert.ok(payload.markdown.includes('Duração total: 30:00'));
  assert.ok(payload.markdown.includes('Distância total: 5.50 km'));
  assert.ok(payload.markdown.includes('Pace médio: 5:27 min/km'));
  assert.ok(payload.markdown.includes('FC média: 152 bpm'));
  assert.ok(payload.markdown.includes('FC máxima: 164 bpm'));
  assert.ok(payload.markdown.includes('Desnível positivo: 45 m'));
  assert.ok(payload.markdown.includes('Horário: 07:30'));
  assert.ok(payload.markdown.includes('Dia da semana: terça-feira'));
  assert.ok(payload.markdown.includes('| Run | 1 | 10:04 |'));
});

test('POST /api/fit/parse tolerates an empty form payload', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
  ]);
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.ok(payload.markdown.includes('Tipo de treino: não informado'));
  assert.ok(payload.markdown.includes('RPE alvo: não informado'));
  assert.ok(payload.markdown.includes('Dor ou desconforto:\nNenhum relatado'));
});

test('GET / serves the single page frontend', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.ok(response.body.includes('Training Assistant'));
  assert.ok(response.body.includes('Treino Planejado'));
});

test('the default parser rejects garbage uploads end-to-end', async () => {
  const app = await buildServer();
  const emptyFitFile = Buffer.from([
    14, 16, 32, 0, 0, 0, 0, 0, 46, 70, 73, 84, 98, 239, 0, 0,
  ]);
  const response = await postParts(app, [
    { name: 'file', fileName: 'garbage.fit', value: emptyFitFile },
  ]);
  assert.equal(response.statusCode, 422);
});
