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

test('Garmin workout editor saves a faithful v2 sequence without remote mutation in PT/EN desktop and mobile Chrome', async (t) => {
  assert.ok(chrome, 'Chrome is required for Garmin UI verification.');
  const db = createDatabase({ filename: ':memory:' });
  const owner = await registerUser(db, { email: 'garmin-ui@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
  db.prepare("UPDATE users SET distance_unit = 'km' WHERE id = ?").run(owner.id);
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino,detalhes) VALUES (?,?,?,?,?)').run(owner.id, '2026-11-02', 'Run', 'Intervals', 'structured workout');
  const remoteCalls = [];
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner.id), KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url) => {
      remoteCalls.push(url);
      if (url.endsWith('/status')) { await statusGate; return Response.json({ status: 'connected' }); }
      if (url.endsWith('/capabilities')) return Response.json({ devices: [{ name: 'Forerunner 55' }], running_catalog_status: 'available' });
      return Response.json({ status: 'connected' });
    },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort(); const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`; let versionResponse;
    for (let i = 0; i < 100; i += 1) { try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {} await delay(50); }
    assert.ok(versionResponse?.ok);
    const target = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map(); const prescriptionRequests = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/trainings/1/garmin/prescription') && message.params.request.postData) prescriptionRequests.push(JSON.parse(message.params.request.postData));
      if (message.method) return;
      const handle = pending.get(message.id); if (!handle) return; pending.delete(message.id);
      message.error ? handle.reject(new Error(message.error.message)) : handle.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
    const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    const captureGarminCard = async (filename) => {
      const geometry = await evaluate("(()=>{const r=document.getElementById('garminSessionCard').getBoundingClientRect();return {width:innerWidth,height:Math.min(5000,Math.ceil(r.height+140))}})()");
      // The application shell scrolls inside .main-content. Give that scroll
      // container enough viewport height for a complete, reviewable capture.
      await command('Emulation.setDeviceMetricsOverride', {
        width: geometry.width, height: geometry.height, deviceScaleFactor: 1, mobile: geometry.width < 600,
      });
      await evaluate("document.querySelector('.main-content').scrollTop=0");
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      require('node:fs').writeFileSync(filename, Buffer.from(shot.data, 'base64'));
    };
    await command('Network.enable'); await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner.id).token, url: baseUrl });
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: `${baseUrl}/training-result.html?id=1` });
    const wait = async (expression) => { for (let i = 0; i < 150; i += 1) { if (await evaluate(expression).catch(() => false)) return; await delay(100); } const diagnostic = await evaluate("JSON.stringify({title:document.getElementById('garminTitle')?.textContent,card:document.getElementById('garminSessionCard')?.hidden,date:document.getElementById('sessionDate')?.textContent,blocks:document.getElementById('garminRunBlocks')?.innerHTML,errors:[...document.querySelectorAll('[role=alert]')].map(el=>el.textContent)})").catch(()=>'none'); throw new Error(`Timed out waiting for ${expression}; ${diagnostic}`); };
    await wait("document.getElementById('sessionDate')?.textContent.trim() !== '-' && !document.getElementById('garminSessionCard').hidden && document.querySelector('#garminRunBlocks .garmin-editor-block')");
    assert.equal(await evaluate("document.querySelector('[data-end-type=\\\"step-run-1\\\"]')?.value"), 'time');
    assert.equal(await evaluate("!document.getElementById('fitFile').disabled"), true);
    releaseStatus();
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Connected')");
    await evaluate("document.getElementById('garminWorkoutName').value='Mixed intervals';document.getElementById('garminWorkoutName').dispatchEvent(new Event('input',{bubbles:true}))");
    await evaluate("document.getElementById('garminWarmupEnabled').click()");
    await evaluate("document.querySelector('[data-end-type=warmup]').value='distance';document.querySelector('[data-end-type=warmup]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-end-value=warmup]').value='1.5';document.querySelector('[data-target-type=warmup]').value='pace';document.querySelector('[data-target-type=warmup]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-target-lower=warmup]').value='6:00';document.querySelector('[data-target-upper=warmup]').value='5:30'");
    await evaluate("document.querySelector('[data-end-value=step-run-1]').value='10:00';document.querySelector('[data-target-type=step-run-1-target]').value='heart_rate';document.querySelector('[data-target-type=step-run-1-target]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-target-lower=step-run-1-target]').value='130';document.querySelector('[data-target-upper=step-run-1-target]').value='145'");
    await evaluate("document.getElementById('garminAddRepeatBlock').click();document.querySelector('#garminRunBlocks [data-repetitions]').value='2'");
    await evaluate("document.getElementById('garminAddRunBlock').click()");
    await evaluate("document.getElementById('garminCooldownEnabled').click();document.querySelector('[data-end-value=cooldown]').value='05:00'");
    await evaluate("document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-recovery-enabled]').closest('label')).display"), 'flex');
    const saved = JSON.parse(db.prepare('SELECT prescription_json FROM garmin_workout_prescriptions WHERE training_id=1').get().prescription_json);
    assert.equal(saved.version, 2);
    assert.equal(saved.steps[0].kind, 'warmup');
    assert.deepEqual(saved.steps[0].end, { type: 'distance', value: 1500 });
    assert.deepEqual(saved.steps[0].target, { type: 'pace', unit: 'min_per_km', slower_seconds: 360, faster_seconds: 330 });
    assert.equal(saved.steps.find((step) => step.kind === 'repeat').repetitions, 2);
    assert.equal(saved.steps.at(-1).kind, 'cooldown');
    assert.deepEqual(prescriptionRequests.at(-1).prescription, saved);
    const preview = await evaluate("document.getElementById('garminPreviewSteps').textContent");
    assert.match(preview, /Warm-up/); assert.match(preview, /2 repeats/); assert.match(preview, /Cool-down/);
    assert.equal(remoteCalls.filter((url) => url.endsWith('/workouts') || url.endsWith('/workouts/schedule')).length, 0, 'save/review never calls Garmin mutations');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM garmin_training_operations').get().count, 0);
    const requestsBeforeInvalid = prescriptionRequests.length;
    await evaluate("document.querySelector('[data-recovery-enabled]').click();document.querySelector('[data-end-value$=\\\"-recovery\\\"]').value='00:00';document.getElementById('garminPrescriptionForm').requestSubmit()");
    assert.equal(prescriptionRequests.length, requestsBeforeInvalid, 'invalid active recovery is rejected before saving');
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-invalid')"), 'true');
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-describedby')"), 'garminPrescriptionError');
    assert.match(await evaluate("document.getElementById('garminOperationStatus').textContent"), /highlighted fields|campos destacados/i);
    await evaluate("document.querySelector('[data-end-value$=\\\"-recovery\\\"]').value='02:00';document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("document.getElementById('garminOperationStatus').textContent.includes('Structure saved')");
    await evaluate("document.getElementById('garminSessionCard').scrollIntoView({block:'start'})");
    await captureGarminCard('/tmp/kinesis-garmin-editor-pt-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})");
    assert.equal(mobile.width, 390); assert.ok(mobile.scrollWidth <= mobile.width);
    await evaluate("document.getElementById('garminSessionCard').scrollIntoView({block:'start'})");
    await captureGarminCard('/tmp/kinesis-garmin-editor-pt-mobile.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\\\"en-US\\\"]').click()"); await wait("document.documentElement.lang==='en-US'");
    await evaluate("document.getElementById('garminSessionCard').scrollIntoView({block:'start'})");
    await captureGarminCard('/tmp/kinesis-garmin-editor-en-mobile.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('garminSessionCard').scrollIntoView({block:'start'})");
    await captureGarminCard('/tmp/kinesis-garmin-editor-en-desktop.png');
    assert.equal(await evaluate("document.querySelector('[data-end-type=warmup]').value"), 'distance');
    assert.equal(await evaluate("document.querySelector('[data-end-value=step-run-1]').value"), '10:00');
    await evaluate("document.querySelector('.lang-switch [data-lang=\\\"pt-BR\\\"]').click()"); await wait("document.documentElement.lang==='pt-BR'");
    assert.equal(await evaluate("document.querySelector('[data-end-value=step-run-1]').value"), '10:00');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 480, deviceScaleFactor: 1, mobile: false });
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-editor-pt-low-window.png', Buffer.from(shot.data, 'base64')));
  } finally {
    socket?.close(); child.kill('SIGTERM'); await app.close(); db.close(); rmSync(profile, { recursive: true, force: true });
  }
});
