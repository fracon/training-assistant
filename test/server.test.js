'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer, parseRpe } = require('../src/server');
const { generateMarkdown } = require('../src/markdownGenerator');

function makeLapView(overrides = {}) {
  return {
    stepType: 'Run',
    lap: 1,
    duration: 600.4,
    durationLabel: '10:00',
    cumulativeSeconds: 600.4,
    cumulativeLabel: '10:00',
    distanceKm: 2.0,
    distanceLabel: '2.00',
    avgPaceSecondsPerKm: 300.2,
    avgPaceLabel: '5:00',
    bestPaceSecondsPerKm: 150,
    bestPaceLabel: '2:30',
    avgHeartRate: 150,
    maxHeartRate: 162,
    ascentMeters: 10,
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

test('parseRpe accepts blank, integer, and boundary values', () => {
  assert.deepEqual(parseRpe(undefined), { ok: true, value: null });
  assert.deepEqual(parseRpe(''), { ok: true, value: null });
  assert.deepEqual(parseRpe('   '), { ok: true, value: null });
  assert.deepEqual(parseRpe('7'), { ok: true, value: 7 });
  assert.deepEqual(parseRpe('1'), { ok: true, value: 1 });
  assert.deepEqual(parseRpe('10'), { ok: true, value: 10 });
});

test('parseRpe rejects non-integers and out-of-range values', () => {
  assert.deepEqual(parseRpe('abc'), { ok: false, error: 'rpe must be an integer between 1 and 10.' });
  assert.equal(parseRpe('7.5').ok, false);
  assert.equal(parseRpe('0').ok, false);
  assert.equal(parseRpe('11').ok, false);
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
  const response = await postParts(app, [{ name: 'notes', value: 'no file here' }]);
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

test('POST /api/fit/parse validates the rpe field', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
    { name: 'rpe', value: 'eleven' },
  ]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'rpe must be an integer between 1 and 10.' });
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

test('POST /api/fit/parse returns laps and markdown without feedback', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'WORKOUT.FIT', value: Buffer.from([0x0c, 0x00]) },
    { name: 'rpe', value: '' },
  ]);
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.fileName, 'WORKOUT.FIT');
  assert.equal(payload.sizeBytes, 2);
  assert.deepEqual(payload.activity, GOOD_SUMMARY.activity);
  assert.deepEqual(payload.laps, GOOD_SUMMARY.laps);
  assert.ok(stubParse.lastBuffer.equals(Buffer.from([0x0c, 0x00])));
  const expectedMarkdown = generateMarkdown(GOOD_SUMMARY, { rpe: null, notes: '' });
  assert.equal(payload.markdown, expectedMarkdown);
  assert.ok(payload.markdown.includes('- **RPE:** not informed'));
});

test('POST /api/fit/parse embeds rpe and notes in the markdown prompt', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await postParts(app, [
    { name: 'file', fileName: 'run.fit', value: 'binary' },
    { name: 'rpe', value: '7' },
    { name: 'notes', value: 'vento forte | pernas leves' },
  ]);
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.ok(payload.markdown.includes('- **RPE:** 7/10'));
  assert.ok(payload.markdown.includes('vento forte \\| pernas leves'));
});

test('GET / serves the single page frontend', async () => {
  const app = await buildServer({ parseFitFile: stubParse() });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.ok(response.body.includes('Training Assistant'));
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
