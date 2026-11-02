'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');

function zipFit() {
  const name = Buffer.from('activity.fit'); const data = Buffer.from('synthetic-running-fit');
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); data.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function findChrome() { return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync); }
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const number = server.address().port; await new Promise((resolve) => server.close(resolve)); return number;
}

test('Garmin activity result flow in Chrome stays explicit, localized, keyboard reachable and responsive', async (t) => {
  const chrome = findChrome(); assert.ok(chrome, 'Chrome is required for session UI verification');
  const db = createDatabase({ filename: ':memory:' });
  const original = zipFit(); const calls = [];
  const summary = { activity: { sport: 'running', startTime: '2026-11-02T07:00:00Z', endTime: '2026-11-02T07:58:20Z' },
    totals: { durationSeconds: 3500, durationLabel: '58:20', distanceKm: 10, avgPaceSecondsPerKm: 350,
      avgPaceLabel: '5:50', avgHeartRate: null, maxHeartRate: 181, ascentMeters: 78, calories: 501 },
    laps: [{ lap: 1, durationLabel: '58:20', distanceKm: 10, avgHeartRate: null }] };
  const app = await buildServer({ db, sessionCookieSecure: false, parseFitFile: async () => summary,
    garminConfig: { GARMIN_PILOT_ENABLED: 'true', GARMIN_PILOT_USER_ID: '1', KINESIS_GARMIN_SERVICE_TOKEN: 'synthetic-browser-token', GARMIN_CONNECTOR_URL: 'http://connector.invalid' },
    garminFetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/status')) return Response.json({ status: calls.some((call) => call.url.endsWith('/auth/start')) ? 'connected' : 'disconnected',
        ...(calls.some((call) => call.url.endsWith('/auth/start')) ? { identity_fingerprint: 'a'.repeat(64) } : {}) });
      if (url.endsWith('/auth/start')) return Response.json({ status: 'mfa_required', challenge_id: 'synthetic-mfa-challenge-1234567890', expires_in: 300 });
      if (url.endsWith('/auth/finish')) return Response.json({ status: 'connected', identity_fingerprint: 'a'.repeat(64) });
      if (url.endsWith('/capabilities')) return Response.json({ devices: [], running_catalog_status: 'available' });
      if (url.endsWith('/activities')) return Response.json({ items: [{ activityId: 42, activityName: 'Synthetic morning run', source_cursor: init.body ? JSON.parse(init.body).offset : 0,
        startTimeLocal: '2026-11-02T07:00:00', activityType: 'running', duration: 3500, distance: 10000,
        averageHR: null, maxHR: 181, calories: 501, elevationGain: 78 }], next_offset: (init.body ? JSON.parse(init.body).offset : 0) + 1,
        has_more: false, budget_exhausted: false });
      if (url.endsWith('/original')) return new Response(original, { headers: { 'content-type': 'application/octet-stream' } });
      throw new Error('unexpected synthetic connector call');
    } });
  const user = await registerUser(db, { email: 'visual-import@example.test', password: 'synthetic-password-1', first_name: 'Rita', last_name: 'Runner' });
  db.prepare("UPDATE users SET preferred_lang='pt-BR' WHERE id=?").run(user.id);
  db.prepare(`INSERT INTO shoes(id,user_id,brand,model,mileage) VALUES('planned-shoe',?,'Planned','Road shoe',0)`).run(user.id);
  db.prepare(`INSERT INTO trainings(id,user_id,dia,tipo,treino,detalhes,fc_alvo,rpe,tenis,location,fit_distance,
    fit_duration,fit_avg_hr,fit_max_hr,fit_elevation_gain,fit_calories,result_data_source)
    VALUES(1,?,'2026-11-02','Corrida','Corrida livre','Rodagem leve planejada','Zona 2','RPE 3',
      'Planned Road shoe','Porto',5,'30:00',145,165,12,260,'manual')`).run(user.id);
  const session = createSession(db, user.id);
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' }); const origin = new URL(baseUrl).origin;
  const chromePort = await port(); const profile = `/tmp/kinesis-garmin-import-chrome-${process.pid}`;
  const processChrome = spawn(chrome, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run',
    '--remote-allow-origins=*',`--remote-debugging-port=${chromePort}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${chromePort}`; let version;
    for (let attempt = 0; attempt < 100; attempt += 1) { try { version = await fetch(`${debugUrl}/json/version`); if (version.ok) break; } catch {} await delay(50); }
    assert.ok(version?.ok, 'Chrome DevTools endpoint is ready');
    const created = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let commandId = 0; const pending = new Map();
    socket.addEventListener('message', (event) => { const msg = JSON.parse(event.data); if (msg.method) return; const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); msg.error ? resolve.reject(new Error(msg.error.message)) : resolve.resolve(msg.result); } });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++commandId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const pressEnter = async () => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
    const waitFor = async (expression, label) => { for (let attempt = 0; attempt < 160; attempt += 1) { try { if (await evaluate(expression)) return; } catch {} await delay(50); } throw new Error(`Timed out waiting for ${label}; state=${JSON.stringify(await evaluate(`(()=>({value:(${expression}),lang:document.documentElement.lang,summary:document.getElementById('feedbackAccordionSummary')?.textContent,status:document.getElementById('garminActivityStatus')?.textContent,source:document.getElementById('resultSourceSelect')?.value}))()`).catch((error)=>error.message))} calls=${calls.map((call)=>call.url).join(',')}`); };
    await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Network.enable'); await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' });
    await command('Page.navigate', { url: `${origin}/training-result.html?id=1` });
    await waitFor("document.getElementById('resultSourceSelect') && document.getElementById('sessionDate').textContent.trim() !== ''", 'session page data');
    await waitFor("document.getElementById('garminConnectionStatus').textContent !== 'Checking connection…'", 'shared Garmin status initialization');
    await evaluate("document.getElementById('feedbackAccordionTrigger').click(); const s=document.getElementById('resultSourceSelect'); s.value='garmin'; s.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('feedbackNotas').value='draft survives Garmin sign-in and import'; document.querySelector('[name=\"rpe\"][value=\"3\"]').checked=true; document.querySelector('[name=\"rpe\"][value=\"3\"]').dispatchEvent(new Event('change',{bubbles:true})); true");
    await waitFor("document.getElementById('garminActivityField').hidden===false", 'Garmin result source panel');
    await evaluate("document.getElementById('garminActivitySearch').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('Conecte')", 'connection needed guidance');
    await waitFor("document.getElementById('garminConnectButton').hidden===false", 'shared Garmin connection control');
    await evaluate("document.getElementById('garminConnectButton').click(); document.getElementById('garminEmail').value='synthetic@example.test'; document.getElementById('garminPassword').value='synthetic-password'; true");
    await evaluate("document.getElementById('garminAuthSubmit').click(); true");
    await waitFor("document.getElementById('garminMfaField').hidden===false", 'shared MFA challenge');
    assert.equal(await evaluate("document.getElementById('feedbackNotas').value"), 'draft survives Garmin sign-in and import');
    await evaluate("document.getElementById('garminMfaCode').value='123456'; document.getElementById('garminAuthSubmit').click(); true");
    await waitFor("document.getElementById('garminDisconnectButton').hidden===false", 'shared connection completion');
    assert.equal(await evaluate("document.getElementById('feedbackNotas').value"), 'draft survives Garmin sign-in and import');
    await evaluate("document.getElementById('garminActivitySearch').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').children.length===1", 'running candidate');
    assert.equal(await evaluate("document.getElementById('feedbackAccordionSummary').textContent.includes('Buscando')"), false);
    const sourceBadgeBeforePreview = await evaluate("document.getElementById('resultSourceBadge').textContent");
    assert.equal(await evaluate("(()=>{const b=document.getElementById('garminActivitySearch');b.focus();return document.activeElement===b})()"), true,
      'search action is keyboard focusable');
    assert.equal(await evaluate("(()=>{const b=document.querySelector('.garmin-activity-candidate button');b.focus();return document.activeElement===b})()"), true,
      'candidate selection is keyboard focusable');
    await evaluate("document.querySelector('.garmin-activity-candidate button').click(); true");
    await waitFor("!document.getElementById('garminActivityPreview').hidden", 'local FIT preview');
    assert.equal(await evaluate("document.getElementById('resultSourceBadge').textContent"), sourceBadgeBeforePreview, 'preview does not mutate the result');
    assert.equal(await evaluate("document.getElementById('feedbackAccordionPanel').hidden"), false);
    await evaluate("document.getElementById('garminActivityPreview').scrollIntoView({block:'center'}); true");
    await delay(150);
    const captureDir = path.join(__dirname, '..', 'docs', 'garmin-activity-import-screenshots'); mkdirSync(captureDir, { recursive: true });
    const screenshot = async (name) => { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(path.join(captureDir, name), Buffer.from(shot.data, 'base64')); };
    await screenshot('pt-review-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 460, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.body.style.zoom='200%'; true"); await delay(150); await screenshot('pt-review-low-height-zoom-200.png');
    await evaluate("document.body.style.zoom=''; document.getElementById('garminActivityConfirm').click(); true");
    await waitFor("document.querySelector('.confirm-card') !== null", 'explicit replacement confirmation');
    await evaluate("document.getElementById('confirmOkBtn').click(); true");
    await waitFor("document.getElementById('garminActivityLink').textContent.includes('42')", 'confirmed result link');
    assert.equal(await evaluate("document.getElementById('feedbackRpeError').hidden"), true);
    assert.equal(await evaluate("document.getElementById('feedbackNotas').value"), 'draft survives Garmin sign-in and import');
    assert.equal(await evaluate("document.querySelector('[name=\"rpe\"][value=\"3\"]').checked"), true);
    assert.equal(db.prepare('SELECT feedback_rpe FROM trainings WHERE id=1').get().feedback_rpe, null,
      'an unsaved local effort remains a draft and is not sent as part of result import');
    assert.equal(db.prepare('SELECT completed FROM trainings WHERE id=1').get().completed, 0, 'missing RPE leaves the objective import open');
    const plannedBeforeLanguage = await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})");
    assert.equal(db.prepare('SELECT fit_avg_hr FROM trainings WHERE id=1').get().fit_avg_hr, null,
      'a missing metric in the replacement clears the previous value');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click(); true");
    await waitFor("document.documentElement.lang==='en-US'", 'English language switch without reload');
    assert.equal(await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})"),
      plannedBeforeLanguage, 'planned prescription survives canonical result merge and language change');
    assert.equal(await evaluate("document.getElementById('feedbackNotas').value"), 'draft survives Garmin sign-in and import');
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('42')"), true);
    assert.equal(await evaluate("document.getElementById('fitAvgHr').textContent.trim()"), '-');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click(); true");
    await waitFor("document.documentElement.lang==='pt-BR'", 'Portuguese language switch without reload');
    assert.equal(await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})"),
      plannedBeforeLanguage, 'planned prescription survives switching back to Portuguese');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click(); true");
    await waitFor("document.documentElement.lang==='en-US'", 'English language switch at mobile viewport');
    await waitFor("document.getElementById('feedbackAccordionSummary').textContent==='Unsaved changes'", 'localized unsaved feedback summary');
    await evaluate("if(document.getElementById('feedbackAccordionTrigger').getAttribute('aria-expanded')!=='true')document.getElementById('feedbackAccordionTrigger').click();document.getElementById('garminActivityLink').scrollIntoView({block:'center'});true");
    await waitFor("!document.getElementById('garminActivityLink').hidden", 'visible Garmin provenance');
    const plannedInEnglish = await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})");
    const bounds = await evaluate("(()=>{const e=document.querySelector('.app-shell');const r=e.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right}})()");
    assert.equal(bounds.width, 390); assert.ok(bounds.scroll <= bounds.width, `mobile content fits viewport: ${JSON.stringify(bounds)}`);
    await waitFor("!document.getElementById('fitLapsSection').hidden", 'imported lap details');
    const lapScroll = await evaluate("(()=>{const e=document.querySelector('.fit-laps-wrapper');return {tabIndex:e.tabIndex,overflow:getComputedStyle(e).overflowX}})()");
    assert.equal(lapScroll.tabIndex, 0); assert.ok(['auto', 'scroll'].includes(lapScroll.overflow), `lap detail supports horizontal scrolling: ${JSON.stringify(lapScroll)}`);
    await screenshot('en-imported-mobile.png');
    await command('Page.reload');
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityLink') && !document.getElementById('garminActivityLink').hidden", 'canonical result reload');
    const plannedAfterReload = JSON.parse(await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})"));
    assert.ok(plannedAfterReload.rpe.includes('3'), `planned RPE survives reload: ${JSON.stringify(plannedAfterReload)}`);
    assert.equal(plannedAfterReload.hr, JSON.parse(plannedInEnglish).hr);
    assert.equal(plannedAfterReload.details, JSON.parse(plannedInEnglish).details);
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('42')"), true);
    assert.equal(await evaluate("document.getElementById('fitAvgHr').textContent.trim()"), '-');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const keyboard = await evaluate("(()=>{const b=document.getElementById('feedbackAccordionTrigger');b.focus();return document.activeElement.id})()");
    assert.equal(keyboard, 'feedbackAccordionTrigger', 'keyboard focus remains available on result summary');
    assert.ok(calls.some((call) => call.url.endsWith('/activities/42/original')));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM garmin_training_operations').get().n, 0, 'activity import does not publish a workout');
  } finally {
    if (socket) socket.close(); processChrome.kill(); await app.close(); db.close();
  }
});
