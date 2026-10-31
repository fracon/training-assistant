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

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const freePort = async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
};

test('Garmin session UI previews without remote mutation in PT/EN on desktop and mobile Chrome', async (t) => {
  assert.ok(chrome, 'Chrome is required for Garmin UI verification.');
  const db = createDatabase({ filename: ':memory:' });
  const owner = await registerUser(db, { email: 'garmin-ui@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino,detalhes) VALUES (?,?,?,?,?)').run(owner.id, '2026-11-02', 'Run', 'Intervals', '6 x 3 min');
  const remoteCalls = [];
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner.id), KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url) => {
      remoteCalls.push(url);
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
    socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.method) return; const handle = pending.get(message.id); if (!handle) return; pending.delete(message.id); message.error ? handle.reject(new Error(message.error.message)) : handle.resolve(message.result); });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
    const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    await command('Network.enable'); await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner.id).token, url: baseUrl });
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: `${baseUrl}/training-result.html?id=1` });
    const wait = async (expression) => { for (let i = 0; i < 150; i += 1) { if (await evaluate(expression).catch(() => false)) return; await delay(100); } throw new Error('Garmin session panel did not become ready.'); };
    await wait("document.getElementById('sessionDate')?.textContent.trim() !== '-' && !document.getElementById('garminSessionCard').hidden");
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Connected')");
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
    await evaluate("document.getElementById('garminWorkoutName').value='Tempo synthetic';document.getElementById('garminPrescriptionForm').requestSubmit()");
    await wait("!document.getElementById('garminPreview').hidden");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /Run: 30 min/);
    assert.doesNotMatch(await evaluate("document.getElementById('garminPreview').textContent"), /\{(?:kind|detail|date)\}/);
    await evaluate("document.getElementById('garminPreview').scrollIntoView()");
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-en-preview.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click()");
    await wait("document.documentElement.lang === 'pt-BR'");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /Corrida: 30 min/);
    assert.doesNotMatch(await evaluate("document.getElementById('garminPreview').textContent"), /\{(?:kind|detail|date)\}/);
    assert.match(await evaluate("document.getElementById('garminOperationStatus').textContent"), /Estrutura salva/);
    await command('Page.captureScreenshot').then((shot) => require('node:fs').writeFileSync('/tmp/kinesis-garmin-ui-pt-preview.png', Buffer.from(shot.data, 'base64')));
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click()");
    await wait("document.documentElement.lang === 'en-US'");
    assert.match(await evaluate("document.getElementById('garminPreviewSteps').textContent"), /Run: 30 min/);
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
  } finally {
    socket?.close(); process.kill('SIGTERM');
    await Promise.race([once(process, 'exit'), delay(2000)]);
    await app.close(); db.close(); rmSync(profile, { recursive: true, force: true });
  }
  t.diagnostic('Chrome captures: PT/EN desktop, PT/EN mobile, and EN low-height window in /tmp/kinesis-garmin-ui-*.png; all Garmin responses simulated.');
});
