'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
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

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const freePort = async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
};

test('Garmin session UI previews without remote mutation in PT/EN on desktop and mobile Chrome', async (t) => {
  assert.ok(chrome, 'Chrome is required for Garmin UI verification.');
  const db = createDatabase({ filename: ':memory:' });
  const owner = await registerUser(db, { email: 'garmin-ui@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
  db.prepare("UPDATE users SET distance_unit = 'mi' WHERE id = ?").run(owner.id);
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino,detalhes) VALUES (?,?,?,?,?)').run(owner.id, '2026-11-02', 'Run', 'Intervals', '6 x 3 min');
  const restored = { version: 1, sport: 'running', name: 'Restored synthetic', steps: [
    { id: 'repeat', kind: 'repeat', repetitions: 4, skip_last_rest_step: true,
      interval: { end: { type: 'distance', value: 8047 },
        target: { type: 'heart_rate', mode: 'absolute', lower_bpm: 145, upper_bpm: 165 } },
      recovery: { end: { type: 'time', value: 120 },
        target: { type: 'pace', unit: 'min_per_mile', slower_seconds: 540, faster_seconds: 480 } } },
  ] };
  db.prepare('INSERT INTO garmin_workout_prescriptions (user_id,training_id,revision,prescription_json,fingerprint) VALUES (1,1,1,?,?)')
    .run(JSON.stringify(restored), prescriptionFingerprint(restored));
  const remoteCalls = [];
  const prescriptionRequests = [];
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner.id), KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url) => {
      remoteCalls.push(url);
      if (url.endsWith('/status')) { await statusGate; return Response.json({ status: 'connected' }); }
      if (url.endsWith('/capabilities')) return Response.json({ devices: [{ name: 'Synthetic watch' }], running_catalog_status: 'available' });
      if (url.endsWith('/workouts/schedule')) return Response.json({ scheduled: true, scheduled_workout_id: 123 });
      if (url.endsWith('/workouts')) return Response.json({ workout_id: 42 });
      return Response.json({ status: 'connected' });
    },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort(); const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-chrome-'));
  const process = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`; let versionResponse;
    for (let i = 0; i < 100; i += 1) { try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {} await delay(50); }
    assert.ok(versionResponse?.ok);
    const target = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent'
          && message.params.request.url.includes('/api/trainings/1/garmin/prescription')
          && message.params.request.postData) {
        prescriptionRequests.push(JSON.parse(message.params.request.postData));
      }
      if (message.method) return;
      const handle = pending.get(message.id); if (!handle) return; pending.delete(message.id);
      message.error ? handle.reject(new Error(message.error.message)) : handle.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
    const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    await command('Network.enable'); await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner.id).token, url: baseUrl });
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: `${baseUrl}/training-result.html?id=1` });
    const wait = async (expression) => { for (let i = 0; i < 150; i += 1) { if (await evaluate(expression).catch(() => false)) return; await delay(100); } const diagnostic = await evaluate("JSON.stringify({operation:document.getElementById('garminOperationStatus')?.textContent,connection:document.getElementById('garminConnectionStatus')?.textContent,previewHidden:document.getElementById('garminPreview')?.hidden,recoveryType:document.getElementById('garminRecoveryTargetType')?.value,recoveryLower:document.getElementById('garminRecoveryLower')?.value,recoveryUpper:document.getElementById('garminRecoveryUpper')?.value,invalid:[...document.querySelectorAll('#garminPrescriptionForm :invalid')].map(el=>el.id)})").catch(() => 'unavailable'); throw new Error(`Garmin session panel did not become ready: ${diagnostic}; last prescription request=${JSON.stringify(prescriptionRequests.at(-1))}; persisted=${db.prepare('SELECT revision,prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json}`); };
    await wait("document.getElementById('sessionDate')?.textContent.trim() !== '-' && !document.getElementById('garminSessionCard').hidden && document.getElementById('feedbackNotas')");
    assert.equal(await evaluate("document.getElementById('garminTargetType').value"), 'heart_rate');
    assert.equal(await evaluate("document.getElementById('garminLower').value"), '145');
    assert.equal(await evaluate("document.getElementById('garminUpper').value"), '165');
    assert.equal(await evaluate("document.getElementById('garminRecoveryTargetType').value"), 'pace');
    assert.equal(await evaluate("document.getElementById('garminRecoveryLower').value"), '9.0000');
    assert.equal(await evaluate("document.getElementById('garminRecoveryUpper').value"), '8.0000');
    assert.equal(await evaluate("!document.getElementById('fitFile').disabled"), true);
    await evaluate("document.getElementById('garminWorkoutName').value='Edited while Garmin is pending';document.getElementById('garminWorkoutName').dispatchEvent(new Event('input',{bubbles:true}))");
    releaseStatus();
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Connected')");
    assert.equal(await evaluate("document.getElementById('garminWorkoutName').value"), 'Edited while Garmin is pending');
    await evaluate("document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    const persistedHeartRate = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
    assert.deepEqual(persistedHeartRate.steps[0].target, restored.steps[0].target);
    assert.equal(persistedHeartRate.steps[0].interval.end.value, 8047);
    assert.deepEqual(persistedHeartRate.steps[0].recovery.target, restored.steps[0].recovery.target);
    await evaluate("document.getElementById('garminSessionCard').scrollIntoView()");
    const desktop = await evaluate("(()=>{const el=document.getElementById('garminSessionCard'),r=el.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:r.width,visible:!el.hidden}})()");
    assert.equal(desktop.visible, true); assert.ok(desktop.scrollWidth <= desktop.width); assert.ok(desktop.cardWidth > 300);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-desktop.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\\\"pt-BR\\\"]').click()");
    await wait("document.documentElement.lang === 'pt-BR'");
    assert.match(await evaluate("document.getElementById('garminConnectButton').textContent.trim()"), /Conectar/);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-pt-desktop.png', Buffer.from(shot.data, 'base64')));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await evaluate("(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:document.getElementById('garminSessionCard').getBoundingClientRect().width}))()");
    assert.equal(mobile.width, 390); assert.ok(mobile.scrollWidth <= mobile.width); assert.ok(mobile.cardWidth <= mobile.width);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-pt-mobile.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\\\"en-US\\\"]').click()"); await wait("document.documentElement.lang === 'en-US'");
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-mobile.png', Buffer.from(shot.data, 'base64')));
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 480, deviceScaleFactor: 1, mobile: false });
    const low = await evaluate("(()=>({height:innerHeight,scrollWidth:document.documentElement.scrollWidth,width:innerWidth,cardWidth:document.getElementById('garminSessionCard').getBoundingClientRect().width}))()");
    assert.equal(low.height, 480); assert.ok(low.scrollWidth <= low.width); assert.ok(low.cardWidth < low.width);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-low-window.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.getElementById('garminWorkoutName').value='Tempo synthetic';document.getElementById('garminIntervalType').value='distance';document.getElementById('garminIntervalType').dispatchEvent(new Event('change'));document.getElementById('garminInterval').value='5';document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /4 repeats: 5\.00 mi/);
    assert.equal(JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions').get().prescription_json).steps[0].interval.end.value, 8047);
    await evaluate("document.getElementById('garminPreview').scrollIntoView()");
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-distance-preview.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.getElementById('garminIntervalType').value='time';document.getElementById('garminIntervalType').dispatchEvent(new Event('change'));document.getElementById('garminInterval').value='5';document.getElementById('garminInterval').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('garminRepetitions').value='4';document.getElementById('garminRepetitions').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('garminRecovery').value='2';document.getElementById('garminRecovery').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("document.getElementById('garminPreviewSteps').textContent.includes('5:00 min')");
    await evaluate("document.getElementById('garminWorkoutName').value='Tempo synthetic';document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /4 repeats: 5:00 min/);
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /Recovery after 3 intervals \(no recovery after the final interval\): 2:00 min/);
    assert.doesNotMatch(await evaluate("document.getElementById('garminPreview').textContent"), /\{(?:kind|detail|date)\}/);
    await evaluate("document.getElementById('garminPreview').scrollIntoView()");
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-preview.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click()");
    await wait("document.documentElement.lang === 'pt-BR'");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /4 repetições: 5:00 min/);
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /Recuperação após 3 intervalos \(sem recuperação após a última repetição\): 2:00 min/);
    assert.doesNotMatch(await evaluate("document.getElementById('garminPreview').textContent"), /\{(?:kind|detail|date)\}/);
    assert.match(await evaluate("document.getElementById('garminOperationStatus').textContent"), /Estrutura salva/);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-pt-preview.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click()");
    await wait("document.documentElement.lang === 'en-US'");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /4 repeats: 5:00 min/);
    assert.equal(remoteCalls.filter((url) => url.endsWith('/workouts') || url.endsWith('/workouts/schedule')).length, 0, 'saving and previewing must not mutate Garmin');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM garmin_training_operations').get().count, 0);
    await evaluate("document.getElementById('garminPublishButton').click()");
    await wait("document.getElementById('confirmOkBtn') !== null");
    assert.equal(await evaluate('document.activeElement.id'), 'confirmCancelBtn');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab' });
    assert.equal(await evaluate('document.activeElement.id'), 'confirmOkBtn');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' });
    await wait("document.getElementById('confirmOkBtn') === null");
    assert.equal(remoteCalls.filter((url) => url.endsWith('/workouts') || url.endsWith('/workouts/schedule')).length, 0, 'canceling confirmation must not mutate Garmin');
    await evaluate("document.getElementById('garminPublishButton').click()");
    await wait("document.getElementById('confirmOkBtn') !== null");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab' });
    assert.equal(await evaluate('document.activeElement.id'), 'confirmOkBtn');
    await evaluate("document.getElementById('confirmOkBtn').click()");
    await wait("document.getElementById('garminOperationStatus').textContent.includes('Scheduled in Garmin Connect')");
    assert.equal(remoteCalls.filter((url) => url.endsWith('/workouts') || url.endsWith('/workouts/schedule')).length, 2);
    assert.equal(db.prepare('SELECT status FROM garmin_training_operations').get().status, 'scheduled');
    await evaluate('location.reload()');
    await wait("document.getElementById('garminOperationStatus').textContent.includes('Scheduled in Garmin Connect')");
    const restoredPace = { ...restored, name: 'Pace synthetic', steps: [{ ...restored.steps[0],
      interval: { ...restored.steps[0].interval,
        target: { type: 'pace', unit: 'min_per_mile', slower_seconds: 540, faster_seconds: 480 } } }] };
    db.prepare('UPDATE garmin_workout_prescriptions SET revision=revision+1,prescription_json=?,fingerprint=? WHERE user_id=? AND training_id=1')
      .run(JSON.stringify(restoredPace), prescriptionFingerprint(restoredPace), owner.id);
    await evaluate('location.reload()');
    await wait("document.getElementById('garminTargetType').value === 'pace'");
    assert.equal(await evaluate("document.getElementById('garminLower').value"), '9.0000');
    assert.equal(await evaluate("document.getElementById('garminUpper').value"), '8.0000');
    await evaluate("document.getElementById('garminWorkoutName').value='Pace renamed';document.getElementById('garminWorkoutName').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    for (let i = 0; i < 100; i += 1) {
      const current = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
      if (current.name === 'Pace renamed') break;
      await delay(50);
    }
    const persistedPace = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
    assert.deepEqual(persistedPace.steps[0].interval.target, restoredPace.steps[0].interval.target);
    await wait("document.getElementById('garminOperationStatus').textContent.includes('Structure saved')");

    const noRecoveryTarget = { ...restored, name: 'Recovery target synthetic', steps: [{ ...restored.steps[0],
      recovery: { end: { type: 'time', value: 120 }, target: { type: 'none' } } }] };
    db.prepare('UPDATE garmin_workout_prescriptions SET revision=revision+1,prescription_json=?,fingerprint=? WHERE user_id=? AND training_id=1')
      .run(JSON.stringify(noRecoveryTarget), prescriptionFingerprint(noRecoveryTarget), owner.id);
    await evaluate('location.reload()');
    await wait("document.getElementById('garminRecoveryTargetType').value === 'none'");
    await delay(250);
    await evaluate("window.__garminSubmitCount=0;document.getElementById('garminPrescriptionForm').addEventListener('submit',()=>window.__garminSubmitCount++)");
    const requestsBeforeRecoveryEdit = prescriptionRequests.length;
    await evaluate("document.getElementById('garminRecoveryTargetType').value='heart_rate';document.getElementById('garminRecoveryTargetType').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('garminRecoveryLower').value='110';document.getElementById('garminRecoveryLower').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('garminRecoveryUpper').value='130';document.getElementById('garminRecoveryUpper').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#garminPrescriptionForm button[type=submit]').click()");
    for (let i = 0; i < 100; i += 1) {
      const current = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
      if (current.steps[0].recovery.target.type === 'heart_rate') break;
      await delay(50);
    }
    assert.equal(prescriptionRequests.length, requestsBeforeRecoveryEdit + 1,
      `the explicit recovery-target save reached the backend once (submit events=${await evaluate('window.__garminSubmitCount')})`);
    const persistedRecoveryTarget = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
    assert.equal(persistedRecoveryTarget.steps[0].recovery.end.value, 120);
    assert.deepEqual(persistedRecoveryTarget.steps[0].recovery.target,
      { type: 'heart_rate', mode: 'absolute', lower_bpm: 110, upper_bpm: 130 });
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /110–130 bpm/);
    assert.deepEqual(prescriptionRequests.at(-1).prescription.steps[0].recovery.target,
      persistedRecoveryTarget.steps[0].recovery.target);

    const saveRecoveryEdit = async ({ type, lower, upper, minutes, expectedTarget, expectedSeconds }) => {
      const previousRequestCount = prescriptionRequests.length;
      const previousRow = db.prepare('SELECT revision,fingerprint,prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get();
      const previous = JSON.parse(previousRow.prescription_json);
      const changes = [`document.getElementById('garminRecoveryTargetType').value=${JSON.stringify(type)}`,
        "document.getElementById('garminRecoveryTargetType').dispatchEvent(new Event('change',{bubbles:true}))"];
      if (lower !== undefined) changes.push(`document.getElementById('garminRecoveryLower').value=${JSON.stringify(String(lower))}`,
        "document.getElementById('garminRecoveryLower').dispatchEvent(new Event('input',{bubbles:true}))");
      if (upper !== undefined) changes.push(`document.getElementById('garminRecoveryUpper').value=${JSON.stringify(String(upper))}`,
        "document.getElementById('garminRecoveryUpper').dispatchEvent(new Event('input',{bubbles:true}))");
      if (minutes !== undefined) changes.push(`document.getElementById('garminRecovery').value=${JSON.stringify(String(minutes))}`,
        "document.getElementById('garminRecovery').dispatchEvent(new Event('input',{bubbles:true}))");
      changes.push("document.querySelector('#garminPrescriptionForm button[type=submit]').click()");
      await evaluate(changes.join(';'));
      for (let i = 0; i < 100 && prescriptionRequests.length === previousRequestCount; i += 1) await delay(50);
      assert.equal(prescriptionRequests.length, previousRequestCount + 1, `one save request for ${type}`);
      for (let i = 0; i < 100; i += 1) {
        const saved = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
        const recovery = saved.steps[0].recovery;
        if (JSON.stringify(recovery.target) === JSON.stringify(expectedTarget)
            && recovery.end.value === expectedSeconds) break;
        await delay(50);
      }
      const savedRow = db.prepare('SELECT revision,fingerprint,prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get();
      const saved = JSON.parse(savedRow.prescription_json);
      const recovery = saved.steps[0].recovery;
      assert.equal(recovery.end.value, expectedSeconds);
      assert.deepEqual(recovery.target, expectedTarget);
      assert.deepEqual(prescriptionRequests.at(-1).prescription.steps[0].recovery, recovery);
      await wait("!document.getElementById('garminPreview').hidden");
      assert.notEqual(previousRow.fingerprint, savedRow.fingerprint);
      return recovery;
    };

    await saveRecoveryEdit({ type: 'none', expectedTarget: { type: 'none' }, expectedSeconds: 120 });
    await saveRecoveryEdit({ type: 'heart_rate', lower: 120, upper: 140,
      expectedTarget: { type: 'heart_rate', mode: 'absolute', lower_bpm: 120, upper_bpm: 140 }, expectedSeconds: 120 });
    await saveRecoveryEdit({ type: 'pace', lower: 9.5, upper: 8.25,
      expectedTarget: { type: 'pace', unit: 'min_per_mile', slower_seconds: 570, faster_seconds: 495 }, expectedSeconds: 120 });
    await saveRecoveryEdit({ type: 'pace', lower: 9.25, upper: 8.5,
      expectedTarget: { type: 'pace', unit: 'min_per_mile', slower_seconds: 555, faster_seconds: 510 }, expectedSeconds: 120 });

    db.prepare("UPDATE users SET distance_unit='km' WHERE id=?").run(owner.id);
    await evaluate('location.reload()');
    await wait("document.getElementById('garminRecoveryTargetType').value === 'pace'");
    assert.equal(await evaluate("document.getElementById('garminRecovery').value"), '2');
    assert.equal(await evaluate("document.getElementById('garminRecoveryLower').value"), String((555 / 60 / 1.609344).toFixed(4)));
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click()");
    await wait("document.documentElement.lang === 'pt-BR'");
    await saveRecoveryEdit({ type: 'pace', lower: 5.25, upper: 4.5,
      expectedTarget: { type: 'pace', unit: 'min_per_km', slower_seconds: 315, faster_seconds: 270 }, expectedSeconds: 120 });
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /4:30 min\/km/);
    await saveRecoveryEdit({ type: 'heart_rate', lower: 135, upper: 150, minutes: 4,
      expectedTarget: { type: 'heart_rate', mode: 'absolute', lower_bpm: 135, upper_bpm: 150 }, expectedSeconds: 240 });
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /135–150 bpm/);
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click()");
    await wait("document.documentElement.lang === 'en-US'");
    const beforeNoop = db.prepare('SELECT revision,fingerprint,prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get();
    const noOpRequestCount = prescriptionRequests.length;
    await evaluate("document.getElementById('garminPrescriptionForm').requestSubmit()");
    for (let i = 0; i < 100 && prescriptionRequests.length === noOpRequestCount; i += 1) await delay(50);
    assert.equal(prescriptionRequests.length, noOpRequestCount + 1);
    const afterNoop = db.prepare('SELECT revision,fingerprint,prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get();
    assert.equal(afterNoop.revision, beforeNoop.revision);
    assert.equal(afterNoop.fingerprint, beforeNoop.fingerprint);
    assert.deepEqual(JSON.parse(afterNoop.prescription_json).steps[0].recovery,
      JSON.parse(beforeNoop.prescription_json).steps[0].recovery);
  } finally {
    socket?.close(); process.kill('SIGTERM');
    await Promise.race([once(process, 'exit'), delay(2000)]);
    await app.close(); db.close(); rmSync(profile, { recursive: true, force: true });
  }
  t.diagnostic('Chrome captures: PT/EN desktop, PT/EN mobile, and EN low-height window in /tmp/kinesis-garmin-ui-*.png; all Garmin responses simulated.');
});
