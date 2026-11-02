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

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const freePort = async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
};

test('Garmin login progress and disconnect confirmation work in PT/EN Chrome', { timeout: 60000 }, async () => {
  assert.ok(chrome, 'Chrome is required for Garmin connection verification.');
  const db = createDatabase({ filename: ':memory:' });
  const owner = await registerUser(db, { email: 'garmin-connection-ui@example.test', password: 'Synthetic-only-1', first_name: 'Test', last_name: 'Runner' });
  db.prepare("UPDATE users SET preferred_lang='pt-BR' WHERE id=?").run(owner.id);
  db.prepare('INSERT INTO trainings (user_id,dia,tipo,treino) VALUES (?,?,?,?)').run(owner.id, '2026-11-02', 'Run', 'Synthetic');
  let connected = false;
  let authStarts = 0;
  let deletes = 0;
  let releaseStart;
  let startEntered;
  let releaseSecondStart;
  let secondStartEntered;
  let releaseRetryStart;
  let retryStartEntered;
  let releaseFinish;
  let finishEntered;
  let releaseDelete;
  let deleteEntered;
  let releaseMobileDelete;
  let mobileDeleteEntered;
  let releaseFailedDelete;
  let failedDeleteEntered;
  let holdStatus = false;
  let releaseStatus;
  let statusEntered;
  let holdAuthStaleStatus = false;
  let releaseAuthStaleStatus;
  let authStaleStatusEntered;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const startSignal = new Promise((resolve) => { startEntered = resolve; });
  const secondStartGate = new Promise((resolve) => { releaseSecondStart = resolve; });
  const secondStartSignal = new Promise((resolve) => { secondStartEntered = resolve; });
  const retryStartGate = new Promise((resolve) => { releaseRetryStart = resolve; });
  const retryStartSignal = new Promise((resolve) => { retryStartEntered = resolve; });
  const finishGate = new Promise((resolve) => { releaseFinish = resolve; });
  const finishSignal = new Promise((resolve) => { finishEntered = resolve; });
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  const deleteSignal = new Promise((resolve) => { deleteEntered = resolve; });
  const mobileDeleteGate = new Promise((resolve) => { releaseMobileDelete = resolve; });
  const mobileDeleteSignal = new Promise((resolve) => { mobileDeleteEntered = resolve; });
  const failedDeleteGate = new Promise((resolve) => { releaseFailedDelete = resolve; });
  const failedDeleteSignal = new Promise((resolve) => { failedDeleteEntered = resolve; });
  const statusSignal = new Promise((resolve) => { statusEntered = resolve; });
  const authStaleStatusSignal = new Promise((resolve) => { authStaleStatusEntered = resolve; });
  const app = await buildServer({ db, sessionCookieSecure: false,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: String(owner.id),
      KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-service-token-'.repeat(2), GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url, init = {}) => {
      if (url.endsWith('/status')) {
        const snapshot = connected;
        if (holdStatus) { holdStatus = false; statusEntered(); await new Promise((resolve) => { releaseStatus = resolve; }); }
        if (holdAuthStaleStatus) { holdAuthStaleStatus = false; authStaleStatusEntered(); await new Promise((resolve) => { releaseAuthStaleStatus = resolve; }); }
        return Response.json({ status: snapshot ? 'connected' : 'disconnected', identity_fingerprint: 'a'.repeat(64) });
      }
      if (url.endsWith('/capabilities')) return Response.json({ devices: connected ? [{ name: 'Synthetic watch' }] : [], running_catalog_status: 'available' });
      if (url.endsWith('/auth/start')) {
        authStarts += 1;
        if (authStarts === 1) { startEntered(); await startGate; return Response.json({ status: 'mfa_required', challenge_id: 'synthetic-mfa-challenge-123456', expires_in: 300 }); }
        if (authStarts === 2) { secondStartEntered(); await secondStartGate; return Response.json({ detail: { code: 'auth_required' } }, { status: 401 }); }
        retryStartEntered(); await retryStartGate;
        connected = true;
        return Response.json({ status: 'connected', identity_fingerprint: 'a'.repeat(64) });
      }
      if (url.endsWith('/auth/finish')) {
        finishEntered(); await finishGate; connected = true;
        return Response.json({ status: 'connected', identity_fingerprint: 'a'.repeat(64) });
      }
      if (init.method === 'DELETE') {
        deletes += 1;
        if (deletes === 1) { failedDeleteEntered(); await failedDeleteGate; return Response.json({ detail: { code: 'unavailable' } }, { status: 503 }); }
        if (deletes === 3) { mobileDeleteEntered(); await mobileDeleteGate; connected = false; return Response.json({ status: 'disconnected' }); }
        deleteEntered(); await deleteGate; connected = false;
        return Response.json({ status: 'disconnected' });
      }
      return Response.json({ status: 'disconnected' });
    },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-garmin-connection-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-allow-origins=*', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = 'http://127.0.0.1:' + debugPort;
    let versionResponse;
    for (let i = 0; i < 100; i += 1) { try { versionResponse = await fetch(debugUrl + '/json/version'); if (versionResponse.ok) break; } catch {} await delay(50); }
    assert.ok(versionResponse?.ok);
    const target = await (await fetch(debugUrl + '/json/new?about:blank', { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    const httpResponses = [];
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/garmin/connection')) {
        httpResponses.push({ status: message.params.response.status, url: message.params.response.url });
      }
      if (message.method) return;
      const handle = pending.get(message.id); if (!handle) return; pending.delete(message.id);
      message.error ? handle.reject(new Error(message.error.message)) : handle.resolve(message.result);
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 120; i += 1) { if (await evaluate(expression).catch(() => false)) return; await delay(50); }
      throw new Error('Timed out waiting for ' + expression + '; modal=' + await evaluate("JSON.stringify({text:document.querySelector('.confirm-card')?.innerText,busy:document.querySelector('.confirm-card')?.getAttribute('aria-busy'),disabled:document.getElementById('confirmOkBtn')?.disabled,progress:document.querySelector('.confirm-progress')?.innerText,status:document.getElementById('garminConnectionStatus')?.innerText})").catch(() => 'unavailable') + '; deletes=' + deletes + '; http=' + JSON.stringify(httpResponses));
    };
    const capture = async (filename, selector) => {
      await evaluate("document.querySelector(" + JSON.stringify(selector) + ")?.scrollIntoView({block:'center'})");
      await delay(100);
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(filename, Buffer.from(shot.data, 'base64'));
    };
    await command('Network.enable');
    await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner.id).token, url: baseUrl });
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: baseUrl + '/training-result.html?id=1' });
    await wait("document.getElementById('garminConnectionStatus')?.textContent.includes('Não conectado')");
    assert.deepEqual(await evaluate(`(()=>({garmin:[document.getElementById('garminAccordionTrigger').getAttribute('aria-expanded'),document.getElementById('garminAccordionPanel').hidden],feedback:[document.getElementById('feedbackAccordionTrigger').getAttribute('aria-expanded'),document.getElementById('feedbackAccordionPanel').hidden]}))()`),
      { garmin: ['false', true], feedback: ['false', true] }, 'both accordions start closed on the loaded session page');
    await capture('/tmp/kinesis-session-accordions-closed-pt-desktop.png', '#garminSessionCard');
    await evaluate("document.getElementById('garminAccordionTrigger').click()");
    await wait("document.getElementById('garminAccordionPanel').hidden===false");
    assert.equal(await evaluate("document.getElementById('feedbackAccordionPanel').hidden"), true, 'opening Garmin does not open feedback');
    await evaluate("document.getElementById('feedbackAccordionTrigger').click()");
    assert.deepEqual(await evaluate("[document.getElementById('garminAccordionPanel').hidden,document.getElementById('feedbackAccordionPanel').hidden]"),
      [false, false], 'both independently opened panels remain open together');
    await capture('/tmp/kinesis-session-accordions-expanded-pt-desktop.png', '#feedbackAccordionTrigger');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('feedbackAccordionTrigger').click();document.getElementById('garminAccordionTrigger').click()");
    await capture('/tmp/kinesis-session-accordions-closed-pt-mobile.png', '#garminSessionCard');
    await evaluate("document.getElementById('garminAccordionTrigger').click();document.getElementById('feedbackAccordionTrigger').click()");
    await capture('/tmp/kinesis-session-accordions-expanded-pt-mobile.png', '#feedbackAccordionTrigger');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the expanded mobile accordions do not overflow horizontally');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
    await delay(80);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the accordion headers and content remain usable in a low mobile window');
    await command('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 1, mobile: false });
    await delay(80);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the content reflows without horizontal overflow at a 200% equivalent viewport');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(100);
    await evaluate("document.getElementById('garminConnectButton').click();document.getElementById('garminEmail').value='synthetic@example.test';document.getElementById('garminPassword').value='transient-only';document.getElementById('garminPassword').focus()");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await command('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait("document.getElementById('garminAuthProgress').textContent.includes('Conectando ao Garmin Connect')");
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'Conectando ao Garmin Connect…', 'the collapsed header carries authentication progress in Portuguese');
    await startSignal;
    assert.deepEqual(await evaluate("({busy:document.getElementById('garminAuthForm').getAttribute('aria-busy'),progress:document.getElementById('garminAuthProgress').innerText,disabled:document.getElementById('garminAuthSubmit').disabled,email:document.getElementById('garminEmail').value,password:document.getElementById('garminPassword').value})"),
      { busy: 'true', progress: 'Conectando ao Garmin Connect…', disabled: true, email: 'synthetic@example.test', password: '' });
    await evaluate("document.getElementById('garminAccordionTrigger').click()");
    assert.equal(await evaluate("document.getElementById('garminAccordionPanel').hidden"), true, 'collapsing the panel does not cancel authentication');
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'Conectando ao Garmin Connect…');
    await evaluate("document.getElementById('garminAccordionTrigger').click()");
    assert.equal(await evaluate("document.getElementById('garminAuthForm').getAttribute('aria-busy')"), 'true', 'reopening preserves the in-flight login state');
    await evaluate("document.getElementById('garminAuthForm').requestSubmit();document.getElementById('garminAuthForm').requestSubmit()");
    assert.equal(authStarts, 1, 'repeated Enter submission cannot dispatch a second login');
    await capture('/tmp/kinesis-garmin-auth-progress-pt-desktop.png', '#garminAuthProgress');
    releaseStart();
    await wait("!document.getElementById('garminMfaField').hidden && document.getElementById('garminConnectionStatus').textContent.includes('código de verificação')");
    assert.equal(await evaluate("document.getElementById('garminAuthProgress').hidden"), true);
    await evaluate("document.getElementById('garminAccordionTrigger').click()");
    assert.equal(await evaluate("document.getElementById('garminAccordionPanel').hidden"), true, 'the MFA challenge remains active while collapsed');
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'Aguardando verificação');
    await evaluate("document.getElementById('garminAccordionTrigger').click()");
    assert.equal(await evaluate("document.getElementById('garminMfaField').hidden"), false, 'reopening retains the same MFA challenge');
    await evaluate("document.getElementById('garminMfaCode').value='123456';document.getElementById('garminAuthForm').requestSubmit()");
    await finishSignal;
    assert.deepEqual(await evaluate("({progress:document.getElementById('garminAuthProgress').innerText,disabled:document.getElementById('garminMfaCode').disabled,busy:document.getElementById('garminAuthForm').getAttribute('aria-busy')})"),
      { progress: 'Validando código de verificação…', disabled: true, busy: 'true' });
    await capture('/tmp/kinesis-garmin-mfa-progress-pt-desktop.png', '#garminAuthProgress');
    releaseFinish();
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Conectado ao Garmin Connect') && document.getElementById('garminAuthForm').hidden");
    assert.equal(await evaluate("document.getElementById('garminAccordionSummary').textContent"), 'Conectado · Sem estrutura salva', 'a connected account is distinguished from a saved workout');
    assert.equal(await evaluate("[localStorage,sessionStorage].some(store=>Object.values(store).some(value=>String(value).includes('transient-only')))"), false, 'credentials are absent from browser storage');
    await wait("!document.getElementById('garminDisconnectButton').disabled");

    await evaluate("document.getElementById('garminDisconnectButton').click()");
    await wait("document.querySelector('.confirm-card')?.textContent.includes('Desconectar Garmin')");
    assert.equal(await evaluate("document.querySelector('.confirm-card .lucide-unlink') !== null"), true);
    assert.match(await evaluate("document.querySelector('.confirm-card').textContent"), /Seus treinos e atividades no Garmin Connect serão mantidos/);
    await evaluate("document.getElementById('confirmCancelBtn').click()");
    await wait("!document.querySelector('.confirm-card')");
    assert.equal(deletes, 0, 'Cancel performs no connector request.');

    // Hold an older connected status read while a user-initiated disconnect fails once and is retried.
    holdStatus = true;
    await evaluate("(()=>{const button=document.getElementById('garminConnectionRetry');button.hidden=false;button.click()})()");
    await statusSignal;
    await evaluate("document.getElementById('garminDisconnectButton').click()");
    await wait("document.querySelector('.confirm-card') !== null");
    await evaluate("document.getElementById('confirmOkBtn').click()");
    await wait("document.querySelector('.confirm-card')?.getAttribute('aria-busy')==='true'");
    await evaluate("document.querySelector('.confirm-backdrop').click()");
    assert.equal(await evaluate("document.querySelector('.confirm-card') !== null"), true, 'backdrop cannot dismiss an in-flight cleanup');
    await Promise.race([failedDeleteSignal, delay(500)]);
    assert.equal(deletes, 1, 'confirmed disconnect reaches the backend exactly once');
    await capture('/tmp/kinesis-garmin-disconnecting-pt-desktop.png', '.confirm-card');
    releaseFailedDelete();
    await wait("document.querySelector('.confirm-failure')?.textContent.includes('Não foi possível concluir a desconexão')");
    assert.equal(await evaluate("document.querySelector('.confirm-card') !== null"), true, 'failure retains the dialog for an explicit retry');
    await evaluate("document.querySelector('.confirm-backdrop').click()");
    await wait("!document.querySelector('.confirm-card')");
    assert.equal(deletes, 1, 'closing a recoverable failure does not dispatch another cleanup');
    await evaluate("document.getElementById('garminDisconnectButton').click()");
    await wait("document.querySelector('.confirm-card') !== null");
    await evaluate("document.getElementById('confirmOkBtn').click()");
    await wait("document.querySelector('.confirm-card')?.getAttribute('aria-busy')==='true'");
    await delay(200);
    assert.equal(deletes, 2, 'only an explicit retry dispatches a second cleanup');
    await capture('/tmp/kinesis-garmin-disconnecting-retry-pt-desktop.png', '.confirm-card');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('.confirm-card') !== null"), true, 'Escape cannot dismiss an in-flight cleanup.');
    releaseDelete();
    await wait("!document.querySelector('.confirm-card') && document.getElementById('garminConnectionStatus').textContent==='Não conectado.'");
    if (releaseStatus) releaseStatus();
    await delay(100);
    assert.equal(await evaluate("document.getElementById('garminConnectionStatus').textContent"), 'Não conectado.', 'an old connected status cannot overwrite confirmed disconnect.');
    assert.deepEqual(httpResponses.map((response) => response.status), [503, 200], 'the UI preserves cleanup failure then confirmed disconnect');
    assert.deepEqual(await evaluate("({destination:document.getElementById('garminDestination').hidden,panel:document.getElementById('garminPrescriptionPanel').hidden,connect:!document.getElementById('garminConnectButton').hidden,focus:document.activeElement.id})"),
      { destination: true, panel: true, connect: true, focus: 'garminConnectButton' });

    db.prepare("UPDATE users SET preferred_lang='en-US' WHERE id=?").run(owner.id);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await command('Page.reload');
    await wait("document.getElementById('garminConnectionStatus')?.textContent==='Not connected.'");
    holdAuthStaleStatus = true;
    await evaluate("(()=>{const retry=document.getElementById('garminConnectionRetry');retry.hidden=false;retry.click()})()");
    await authStaleStatusSignal;
    await evaluate("document.getElementById('garminConnectButton').click();document.getElementById('garminEmail').value='synthetic@example.test';document.getElementById('garminPassword').value='transient-only';document.getElementById('garminAuthForm').requestSubmit()");
    // The auth endpoint is held immediately, making the loading state observable on mobile.
    await secondStartSignal;
    await wait("document.getElementById('garminAuthProgress').textContent.includes('Connecting to Garmin Connect')");
    assert.equal(await evaluate("document.getElementById('garminAuthSubmit').disabled"), true);
    await capture('/tmp/kinesis-garmin-auth-progress-en-mobile.png', '#garminAuthProgress');
    releaseSecondStart();
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Could not authenticate your Garmin account')");
    assert.deepEqual(await evaluate("({email:document.getElementById('garminEmail').value,password:document.getElementById('garminPassword').value,submitDisabled:document.getElementById('garminAuthSubmit').disabled,busy:document.getElementById('garminAuthForm').getAttribute('aria-busy')})"),
      { email: 'synthetic@example.test', password: '', submitDisabled: false, busy: 'false' });
    releaseAuthStaleStatus();
    await delay(100);
    assert.match(await evaluate("document.getElementById('garminConnectionStatus').textContent"), /Could not authenticate your Garmin account/,
      'an older status response cannot overwrite the newer authentication failure');
    await evaluate("document.getElementById('garminPassword').value='retry-secret';document.getElementById('garminAuthForm').requestSubmit()");
    await retryStartSignal;
    await wait("document.getElementById('garminAuthProgress').textContent.includes('Connecting to Garmin Connect')");
    releaseRetryStart();
    await wait("document.getElementById('garminConnectionStatus').textContent.includes('Connected to Garmin Connect')");
    await evaluate("document.getElementById('garminDisconnectButton').click()");
    await wait("document.querySelector('.confirm-card')?.textContent.includes('Disconnect Garmin')");
    await capture('/tmp/kinesis-garmin-disconnect-confirm-en-mobile.png', '.confirm-card');
    assert.equal(await evaluate("document.querySelector('.confirm-card .lucide-unlink') !== null"), true);
    await evaluate("document.getElementById('confirmOkBtn').click()");
    await wait("document.querySelector('.confirm-card')?.getAttribute('aria-busy')==='true'");
    await mobileDeleteSignal;
    await capture('/tmp/kinesis-garmin-disconnecting-en-mobile.png', '.confirm-card');
    releaseMobileDelete();
    await wait("!document.querySelector('.confirm-card') && document.getElementById('garminConnectionStatus').textContent==='Not connected.'");
    await capture('/tmp/kinesis-garmin-disconnected-en-mobile.png', '#garminConnectionStatus');
    assert.equal(deletes, 3, 'disconnect completes only after the user confirms it');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
    assert.equal(authStarts, 3, 'one explicit retry follows one known authentication failure');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM garmin_training_operations WHERE user_id=?').get(owner.id).count, 0);
  } finally {
    releaseStart?.(); releaseSecondStart?.(); releaseRetryStart?.(); releaseFinish?.(); releaseFailedDelete?.(); releaseDelete?.(); releaseMobileDelete?.(); releaseStatus?.(); releaseAuthStaleStatus?.();
    socket?.close(); child.kill('SIGTERM'); rmSync(profile, { recursive: true, force: true });
    await app.close(); db.close();
  }
});
