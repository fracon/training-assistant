'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { prescriptionFingerprint } = require('../src/garmin-workout-contract');
const weekly = require('../src/ai/weekly-workouts');
const { recordSuggestion } = require('../src/ai/structure-suggestions');

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const freePort = async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
};
const SCREENSHOTS = process.env.KINESIS_SCREENSHOT_DIR || tmpdir();

const NONE = { type: 'none', lowerBpm: null, upperBpm: null, fasterSecondsPerKm: null, slowerSecondsPerKm: null };
const step = (phase, overrides = {}) => {
  const repeated = phase === 'main' && (overrides.repetitions || 1) > 1;
  return { phase, repetitions: 1, minutes: null, distanceMeters: null, instruction: 'Run with relaxed form.',
    effort: 'Controlled breathing.', rpe: 2, target: NONE, paceSecondsPerKm: null, recoveryMinutes: repeated ? 1 : null,
    recoveryGuidance: repeated ? 'Jog easily.' : null, recoveryRpe: repeated ? 1 : null, recoveryTarget: repeated ? NONE : null, ...overrides };
};
const session = (date, prescription, sessionKind = 'easy') => ({ date, weekday: 'monday', period: '08_12', sessionKind,
  prescription, shoeId: null, location: 'Porto, Portugal', weather: '', notes: '', justification: 'Synthetic.', evidence: ['cycle:cycle'] });

test('AI-suggested structure is reviewed, accepted and dismissed explicitly in the existing editor, PT/EN desktop and mobile', async () => {
  assert.ok(chrome, 'Chrome is required for the suggestion UI verification.');
  const db = createDatabase({ filename: ':memory:' });
  const owner = await registerUser(db, { email: 'suggestion-ui@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
  db.prepare("UPDATE users SET distance_unit = 'km' WHERE id = ?").run(owner.id);
  const addTraining = (value, language = 'en-US') => {
    const planned = weekly.materializePrescription(value, language).value;
    const id = db.prepare('INSERT INTO trainings (user_id,dia,periodo,tipo,treino,detalhes) VALUES (?,?,?,?,?,?)')
      .run(owner.id, value.date, value.period, planned.type, planned.workout, planned.details).lastInsertRowid;
    recordSuggestion(db, { userId: owner.id, trainingId: id, executionId: null, sessionIndex: 0, responseHash: 'synthetic',
      version: weekly.VERSION, session: value, name: planned.workout, details: planned.details, now: '2026-11-01T08:00:00.000Z' });
    return id;
  };
  const ready = addTraining(session('2026-11-02', [step('warmup', { minutes: 10 }),
    step('main', { minutes: 40, target: { ...NONE, type: 'heart_rate', lowerBpm: 130, upperBpm: 145 } }), step('cooldown', { minutes: 10 })]));
  const incompatible = addTraining(session('2026-11-03', [step('warmup', { minutes: 10 }),
    step('main', { repetitions: 21, minutes: 1 }), step('cooldown', { minutes: 10 })], 'intervals'), 'pt-BR');
  const conflicting = addTraining(session('2026-11-04', [step('warmup', { minutes: 10 }), step('main', { minutes: 50 }), step('cooldown', { minutes: 10 })]));
  const savedValue = { version: 3, sport: 'running', name: 'Easy run', steps: [
    { id: 'run-1', kind: 'run', end: { type: 'time', value: 1800 }, target: { type: 'none' } }] };
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (?,?,1,?,?)')
    .run(owner.id, conflicting, JSON.stringify(savedValue), prescriptionFingerprint(savedValue));

  const remoteCalls = [];
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_ACCESS_MODE: 'multiuser', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    // The athlete never connected Garmin: the structure must still be reviewable.
    garminFetch: async (url, init = {}) => { remoteCalls.push({ url, method: init.method || 'GET' }); return Response.json({ status: 'disconnected' }); },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort(); const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-suggestion-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`; let versionResponse;
    for (let i = 0; i < 100; i += 1) { try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {} await delay(50); }
    assert.ok(versionResponse?.ok);
    const target = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map(); const writes = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent' && /\/garmin\/(prescription|suggestion)/.test(message.params.request.url))
        writes.push({ url: message.params.request.url, body: JSON.parse(message.params.request.postData || '{}') });
      if (message.method) return;
      const handle = pending.get(message.id); if (!handle) return; pending.delete(message.id);
      message.error ? handle.reject(new Error(message.error.message)) : handle.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
    const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    const wait = async (expression) => {
      for (let i = 0; i < 150; i += 1) { if (await evaluate(expression).catch(() => false)) return; await delay(100); }
      const state = await evaluate("JSON.stringify({panel:document.getElementById('garminPrescriptionPanel')?.hidden,suggestion:document.getElementById('garminSuggestion')?.hidden,status:document.getElementById('garminSuggestionStatus')?.textContent,editor:document.getElementById('garminEditorView')?.hidden,preview:document.getElementById('garminPreview')?.hidden,active:document.activeElement?.id})").catch(() => 'none');
      throw new Error(`Timed out waiting for ${expression}; ${state}`);
    };
    const capture = async (name, selector = '#garminSuggestion') => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
      await delay(100);
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(SCREENSHOTS, `kinesis-suggestion-${name}.png`), Buffer.from(shot.data, 'base64'));
    };
    const open = async (trainingId) => {
      await command('Page.navigate', { url: `${baseUrl}/training-result.html?id=${trainingId}` });
      await wait("document.getElementById('sessionDate')?.textContent.trim() !== '-' && !document.getElementById('garminSessionCard').hidden");
      await evaluate("document.getElementById('garminAccordionPanel').hidden && document.getElementById('garminAccordionTrigger').click()");
      await wait("document.getElementById('garminAccordionPanel').hidden===false && document.getElementById('garminConnectionStatus').textContent.trim() !== ''");
    };
    const pressKey = async (key, code, keyCode) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    };
    // Keyboard navigation from the focused suggestion heading.
    const tabFromTitle = async (times) => {
      await evaluate("document.getElementById('garminSuggestionTitle').focus()");
      for (let index = 0; index < times; index += 1) await pressKey('Tab', 'Tab', 9);
      return evaluate('document.activeElement.id || document.activeElement.tagName');
    };
    const noHorizontalOverflow = () => evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    await command('Network.enable');
    await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner.id).token, url: baseUrl });

    // 1. EN desktop, never connected: the editor is pre-filled from the suggestion.
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await open(ready);
    await wait("!document.getElementById('garminSuggestion').hidden && !document.getElementById('garminPrescriptionPanel').hidden");
    assert.equal(await evaluate("document.getElementById('garminSuggestionTitle').textContent"), 'AI-suggested structure — review before sending');
    assert.match(await evaluate("document.getElementById('garminSuggestionStatus').textContent"), /^The editor below was filled from the AI suggestion/);
    const origin = await evaluate("document.getElementById('garminSuggestionOrigin').textContent");
    assert.match(origin, /^Suggested on .*2026.*\.$/);
    assert.doesNotMatch(origin, /2026-11-01/, 'the origin date uses the shared locale formatter');
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'AI-suggested structure to review');
    assert.equal(await evaluate("document.getElementById('garminWorkoutName').value"), 'Easy run');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#garminWorkoutEditor [data-end-value]')].filter(input=>!input.closest('[hidden]')).map(input=>input.value)"), ['10:00', '40:00', '10:00']);
    assert.equal(await evaluate("document.querySelector('#garminRunBlocks [data-target-type]').value"), 'heart_rate');
    assert.equal(await evaluate("document.getElementById('garminSuggestionIssuesGroup').hidden"), true);
    assert.equal(await evaluate("document.getElementById('garminSuggestionReview').hidden"), true, 'nothing to compare against before a structure is saved');
    await evaluate("document.querySelector('#garminSuggestionCompare summary').click()");
    assert.match(await evaluate("document.getElementById('garminSuggestionGuidance').textContent"), /Target HR: 130–145 bpm/,
      'the original guidance stays available for comparison');
    assert.equal(await tabFromTitle(1), 'SUMMARY', 'the comparison is the first keyboard stop after the heading');
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'none', 'visible keyboard focus ring');
    assert.equal(await noHorizontalOverflow(), true);
    await capture('ready-en-desktop');
    await evaluate("document.getElementById('garminPrescriptionSave').click()");
    await wait("!document.getElementById('garminPreview').hidden && document.getElementById('garminSuggestion').hidden");
    const accept = writes.find((write) => write.url.endsWith(`/trainings/${ready}/garmin/prescription`));
    assert.equal(accept.body.expected_suggestion_revision, 1);
    assert.equal(typeof accept.body.suggestion_id, 'number');
    assert.deepEqual(db.prepare('SELECT source,suggestion_id FROM garmin_workout_prescriptions WHERE training_id=?').get(ready),
      { source: 'ai_suggestion', suggestion_id: accept.body.suggestion_id });
    assert.equal(await evaluate("document.activeElement.id"), 'garminPreviewTitle');
    assert.equal(await evaluate("document.getElementById('garminPublishButton').disabled"), true, 'sending still requires a Garmin connection');
    assert.equal(await evaluate("document.getElementById('garminActionHelp').textContent"), 'The structure is saved in Kinesis. Connect your Garmin account to send it.');
    await capture('accepted-en-desktop', '#garminPreview');
    // Reload restores the saved structure without a Garmin connection.
    await open(ready);
    await wait("!document.getElementById('garminPrescriptionPanel').hidden && !document.getElementById('garminPreview').hidden");
    assert.equal(await evaluate("document.getElementById('garminSuggestion').hidden"), true);

    // 2. EN desktop conflict: the saved structure wins until an explicit choice.
    await open(conflicting);
    await wait("!document.getElementById('garminSuggestion').hidden && !document.getElementById('garminPreview').hidden");
    assert.match(await evaluate("document.getElementById('garminSuggestionStatus').textContent"), /differs from the saved one/);
    assert.equal(await evaluate("document.getElementById('garminSuggestionDismiss').textContent"), 'Keep current structure');
    assert.equal(await evaluate("document.getElementById('garminSuggestionReview').hidden"), false);
    await capture('conflict-en-desktop');
    await evaluate("document.getElementById('garminSuggestionReview').click()");
    await wait("!document.getElementById('garminEditorView').hidden && document.activeElement.id==='garminSuggestionTitle'");
    assert.match(await evaluate("document.getElementById('garminSuggestionStatus').textContent"), /^You are reviewing the new AI suggestion/);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#garminWorkoutEditor [data-end-value]')].filter(input=>!input.closest('[hidden]')).map(input=>input.value)"), ['10:00', '50:00', '10:00']);
    await evaluate("document.getElementById('garminSuggestionDismiss').click()");
    await wait("document.getElementById('garminSuggestion').hidden && !document.getElementById('garminPreview').hidden && document.activeElement.id==='garminPreviewTitle'");
    assert.equal(db.prepare("SELECT status FROM training_structure_suggestions WHERE training_id=?").get(conflicting).status, 'dismissed');
    assert.equal(db.prepare('SELECT fingerprint FROM garmin_workout_prescriptions WHERE training_id=?').get(conflicting).fingerprint,
      prescriptionFingerprint(savedValue), 'keeping the current structure never changes it');

    // 3. PT mobile: an incompatible suggestion is explained, never shown as ready.
    db.prepare("UPDATE users SET preferred_lang='pt-BR' WHERE id=?").run(owner.id);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await open(incompatible);
    await wait("!document.getElementById('garminSuggestion').hidden && document.getElementById('garminSuggestionTitle').textContent.startsWith('Estrutura sugerida')");
    assert.equal(await evaluate("document.getElementById('garminSuggestionTitle').textContent"), 'Estrutura sugerida pela IA — revise antes de enviar');
    assert.match(await evaluate("document.getElementById('garminSuggestionStatus').textContent"), /não pode virar um treino de relógio/);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#garminSuggestionIssues li')].map(item=>item.textContent)"),
      ['Bloco principal 1: tem 21 repetições; um grupo de repetições no relógio aceita no máximo 20.']);
    assert.equal(await evaluate("document.getElementById('garminWorkoutName').value"), '', 'nothing was converted into the editor');
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'Estrutura sugerida pela IA para revisar');
    assert.equal(await noHorizontalOverflow(), true);
    assert.ok(await evaluate("[...document.querySelectorAll('.garmin-suggestion-actions button')].every(button=>button.hidden||button.getBoundingClientRect().right<=window.innerWidth)"));
    await capture('incompatible-pt-mobile');
    assert.equal(await tabFromTitle(2), 'garminSuggestionDismiss', 'the hidden review action is skipped by the keyboard');
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'none', 'visible keyboard focus ring');
    await pressKey('Enter', 'Enter', 13);
    // Offline with nothing saved and the suggestion dismissed there is no
    // structure left to review: the panel closes and focus stays on the
    // section header instead of a hidden control.
    await wait("document.getElementById('garminSuggestion').hidden && document.getElementById('garminPrescriptionPanel').hidden && document.activeElement.id==='garminAccordionTrigger'");
    assert.equal(db.prepare("SELECT status FROM training_structure_suggestions WHERE training_id=?").get(incompatible).status, 'dismissed');

    // Reduced-height viewport keeps the PT conflict actions reachable.
    const lowHeight = addTraining(session('2026-11-05', [step('warmup', { minutes: 10 }), step('main', { minutes: 30 }), step('cooldown', { minutes: 10 })]), 'pt-BR');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 480, deviceScaleFactor: 1, mobile: false });
    await open(lowHeight);
    await wait("!document.getElementById('garminSuggestion').hidden");
    assert.equal(await evaluate("document.getElementById('garminSuggestionDismiss').textContent"), 'Descartar sugestão');
    await evaluate("document.getElementById('garminSuggestionDismiss').scrollIntoView({block:'center'})");
    assert.ok(await evaluate("(()=>{const r=document.getElementById('garminSuggestionDismiss').getBoundingClientRect();return r.top>=0&&r.bottom<=window.innerHeight})()"));
    await capture('ready-pt-low-height', '.garmin-suggestion-actions');

    assert.deepEqual(remoteCalls.filter((call) => call.method !== 'GET'), [], 'reviewing, accepting and dismissing never mutate Garmin');
    assert.ok(writes.every((write) => !write.url.includes('/publish')), 'nothing was published');
  } finally {
    socket?.close();
    const chromeExit = child.exitCode !== null ? Promise.resolve() : once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([chromeExit, delay(2000)]);
    await app.close(); db.close(); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
