'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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

function zipFit(fitBytes = 'synthetic-running-fit') {
  const name = Buffer.from('activity.fit'); const data = Buffer.from(fitBytes);
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
  const original = zipFit(); const conflictingOriginal = zipFit('conflicting-fit-bytes'); const calls = [];
  let conflictOriginalForActivity42 = false;
  let holdFirstActivityPage = false; let releaseFirstActivityPage;
  let holdNextPage = false; let releaseNextPage;
  let failNextPage = false; let emptyRefresh = false; let filteredPageScenario = false;
  let budgetScenario = false; const budgetPageRequests = [];
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
      if (url.endsWith('/activities')) {
        const offset = Number(init.body ? JSON.parse(init.body).offset : 0);
        if (budgetScenario) budgetPageRequests.push(offset);
        if (offset === 0 && holdFirstActivityPage) { await new Promise((resolve) => { releaseFirstActivityPage = resolve; }); holdFirstActivityPage = false; }
        if (offset > 0 && holdNextPage) { await new Promise((resolve) => { releaseNextPage = resolve; }); holdNextPage = false; }
        if (offset > 0 && failNextPage) { failNextPage = false; return Response.json({ detail: { code: 'unavailable' } }, { status: 503 }); }
        if (offset === 0 && emptyRefresh) { emptyRefresh = false; return Response.json({ items: [], next_offset: 0, has_more: false, budget_exhausted: false }); }
        if (budgetScenario && offset === 0) return Response.json({ items: [], next_offset: 50, has_more: true, budget_exhausted: true });
        if (budgetScenario && offset === 50) return Response.json({ items: [{ activityId: 45, activityName: 'Run after five remote pages', source_cursor: 50,
          startTimeLocal: '2026-11-02T07:00:00', activityType: 'running', duration: 3500, distance: 10000 }],
        next_offset: 100, has_more: true, budget_exhausted: true });
        if (budgetScenario && offset === 100) return Response.json({ items: [{ activityId: 46, activityName: 'Run beyond repeated page budgets', source_cursor: 100,
          startTimeLocal: '2026-11-02T08:00:00', activityType: 'running', duration: 1800, distance: 5000 }],
        next_offset: 150, has_more: true, budget_exhausted: true });
        if (budgetScenario && offset === 150) return Response.json({ items: [{ activityId: 47, activityName: 'Run after retry', source_cursor: 150,
          startTimeLocal: '2026-11-02T09:00:00', activityType: 'running', duration: 1800, distance: 5000 }],
        next_offset: 151, has_more: false, budget_exhausted: false });
        if (filteredPageScenario && offset === 0) return Response.json({ items: [{ activityId: 88, activityName: 'Synthetic cycling', source_cursor: 0,
          startTimeLocal: '2026-11-02T07:00:00', activityType: 'cycling', duration: 3500, distance: 10000 }], next_offset: 20, has_more: true, budget_exhausted: false });
        const item = filteredPageScenario && offset >= 30
          ? { activityId: 44, activityName: 'Third synthetic run', source_cursor: offset,
            startTimeLocal: '2026-10-31T18:10:00', activityType: 'running', duration: 1800, distance: 5000,
            averageHR: 142, maxHR: 160, calories: 250, elevationGain: 12 }
          : offset === 0
          ? { activityId: 42, activityName: 'Synthetic morning run', source_cursor: 0,
            startTimeLocal: '2026-11-02T07:00:00', activityType: 'running', duration: 3500, distance: 10000,
            averageHR: null, maxHR: 181, calories: 501, elevationGain: 78 }
          : { activityId: 43, activityName: 'Second synthetic activity with a deliberately long display name '.repeat(3), source_cursor: offset,
            startTimeLocal: '2026-11-01T18:10:00', activityType: 'running', duration: 1800, distance: 5000,
            averageHR: 142, maxHR: 160, calories: 250, elevationGain: 12 };
        return Response.json({ items: [item], next_offset: filteredPageScenario ? (offset === 0 ? 20 : offset + 10) : (offset === 0 ? 20 : offset + 1),
          has_more: filteredPageScenario ? offset < 30 : offset === 0, budget_exhausted: false });
      }
      if (url.endsWith('/original')) return new Response(url.includes('/activities/42/') && conflictOriginalForActivity42 ? conflictingOriginal : original,
        { headers: { 'content-type': 'application/octet-stream' } });
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
    const captureDir = path.join(__dirname, '..', 'docs', 'garmin-activity-import-screenshots'); mkdirSync(captureDir, { recursive: true });
    const screenshot = async (name) => { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(path.join(captureDir, name), Buffer.from(shot.data, 'base64')); };
    const pressEnter = async () => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
    const waitFor = async (expression, label) => { for (let attempt = 0; attempt < 160; attempt += 1) { try { if (await evaluate(expression)) return; } catch {} await delay(50); } throw new Error(`Timed out waiting for ${label}; state=${JSON.stringify(await evaluate(`(()=>({value:(${expression}),lang:document.documentElement.lang,summary:document.getElementById('feedbackAccordionSummary')?.textContent,status:document.getElementById('garminActivityStatus')?.textContent,source:document.getElementById('resultSourceSelect')?.value}))()`).catch((error)=>error.message))} calls=${calls.map((call)=>call.url).join(',')}`); };
    await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Network.enable'); await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' });
    await command('Page.navigate', { url: `${origin}/training-result.html?id=1` });
    await waitFor("document.getElementById('resultSourceSelect') && document.getElementById('sessionDate').textContent.trim() !== ''", 'session page data');
    await waitFor("document.getElementById('garminConnectionStatus').textContent !== 'Checking connection…'", 'shared Garmin status initialization');
    await evaluate("document.getElementById('feedbackAccordionTrigger').click(); const s=document.getElementById('resultSourceSelect'); s.value='garmin'; s.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('feedbackNotas').value='draft survives Garmin sign-in and import'; document.querySelector('[name=\"rpe\"][value=\"3\"]').checked=true; document.querySelector('[name=\"rpe\"][value=\"3\"]').dispatchEvent(new Event('change',{bubbles:true})); true");
    await waitFor("document.getElementById('garminActivityField').hidden===false", 'Garmin result source panel');
    assert.deepEqual(await evaluate("(()=>({initial:document.getElementById('garminActivitySearch').textContent.trim(),refresh:document.getElementById('garminActivityRefresh').hidden,more:document.getElementById('garminActivityMore').hidden,list:document.getElementById('garminActivityCandidates').hidden,status:document.getElementById('garminActivityStatus').hidden,window:document.getElementById('garminActivityWindow').textContent,switchHidden:document.getElementById('garminActivitySwitch').hidden}))()"),
      { initial: 'Buscar resultado deste treino', refresh: true, more: true, list: true, status: true, window: 'Período da busca: 18/10/2026 – 17/11/2026', switchHidden: true });
    assert.equal(await evaluate("getComputedStyle(document.getElementById('garminActivitySwitch')).display"), 'none',
      'the replacement control reserves no space before a Garmin result exists');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('garminActivityMore')).display"), 'none', 'hidden pagination reserves no layout space');
    await evaluate("document.getElementById('garminActivityField').scrollIntoView({block:'center'}); true"); await delay(120); await screenshot('pt-initial-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityField').scrollIntoView({block:'center'}); true"); await delay(100); await screenshot('pt-initial-mobile.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
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
    holdFirstActivityPage = true;
    await evaluate("document.getElementById('garminActivitySearch').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent==='Buscando atividades…'", 'immediate activity search progress');
    assert.deepEqual(await evaluate("(()=>({disabled:document.getElementById('garminActivitySearch').disabled,more:document.getElementById('garminActivityMore').hidden,list:document.getElementById('garminActivityCandidates').children.length}))()"),
      { disabled: true, more: true, list: 0 });
    for (let attempt = 0; attempt < 80 && !releaseFirstActivityPage; attempt += 1) await delay(25);
    assert.equal(typeof releaseFirstActivityPage, 'function'); releaseFirstActivityPage();
    const activityCallsWhileHeld = calls.filter((call) => call.url.endsWith('/activities')).length;
    await evaluate("const b=document.getElementById('garminActivitySearch');b.dispatchEvent(new MouseEvent('click',{bubbles:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));true");
    await delay(75);
    assert.equal(calls.filter((call) => call.url.endsWith('/activities')).length, activityCallsWhileHeld, 'handler guard blocks repeated clicks during a held query');
    await waitFor("document.getElementById('garminActivityCandidates').children.length===1", 'running candidate');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'continuation follows backend has_more rather than displayed count');
    assert.equal(await evaluate("document.getElementById('garminActivityWindow').textContent"), 'Período pesquisado: 18/10/2026 – 17/11/2026');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').textContent.includes('Corrida')"), true, 'running is localized in Portuguese');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click(); true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityCandidates').textContent.includes('Running')", 'English candidate sport label');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').textContent.includes('10.00 km')"), true, 'distance stays in the selected metric unit in English');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click(); true");
    await waitFor("document.documentElement.lang==='pt-BR' && document.getElementById('garminActivityCandidates').textContent.includes('Corrida')", 'Portuguese candidate sport label');
    assert.equal(await evaluate("document.getElementById('feedbackAccordionSummary').textContent.includes('Buscando')"), false);
    await evaluate("document.getElementById('garminActivityCandidates').scrollIntoView({block:'center'}); true"); await delay(100); await screenshot('pt-list-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityCandidates').scrollIntoView({block:'center'}); true"); await delay(100); await screenshot('pt-list-mobile.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    failNextPage = true; holdNextPage = true;
    await evaluate("document.getElementById('garminActivityMore').click(); true");
    await waitFor("document.getElementById('garminActivityMore').textContent==='Carregando…' && document.getElementById('garminActivityStatus').textContent==='Carregando mais atividades…'", 'immediate next-page loading');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 1, 'existing candidates remain while loading more');
    for (let attempt = 0; attempt < 80 && !releaseNextPage; attempt += 1) await delay(25);
    assert.equal(typeof releaseNextPage, 'function'); releaseNextPage();
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('indisponível')", 'recoverable next-page error');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 1, 'next-page failure preserves previous items');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'next-page failure preserves retry cursor action');
    await evaluate("document.getElementById('garminActivityMore').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').children.length===2", 'next page appended');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), true, 'pagination action disappears when backend says no continuation');
    assert.equal(await evaluate("document.getElementById('garminActivityRefresh').hidden"), false, 'refresh remains a distinct action after pagination ends');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const longCandidateBounds = await evaluate("(()=>{const c=document.querySelector('[data-activity-id=\"43\"]').closest('article');return {page:document.documentElement.scrollWidth,viewport:innerWidth,card:c.scrollWidth,cardClient:c.clientWidth,title:c.querySelector('strong').scrollWidth,titleClient:c.querySelector('strong').clientWidth}})()");
    assert.ok(longCandidateBounds.page <= longCandidateBounds.viewport && longCandidateBounds.card <= longCandidateBounds.cardClient
      && longCandidateBounds.title <= longCandidateBounds.titleClient, `long activity names wrap without overflow: ${JSON.stringify(longCandidateBounds)}`);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const sourceBadgeBeforePreview = await evaluate("document.getElementById('resultSourceBadge').textContent");
    assert.equal(await evaluate("(()=>{const b=document.getElementById('garminActivityRefresh');b.focus();return document.activeElement===b})()"), true,
      'refresh action is keyboard focusable after the initial search');
    assert.equal(await evaluate("(()=>{const b=document.querySelector('[data-activity-id=\"43\"]');b.focus();return document.activeElement===b})()"), true,
      'candidate selection is keyboard focusable');
    await evaluate("document.querySelector('[data-activity-id=\"43\"]').click(); true");
    await waitFor("!document.getElementById('garminActivityPreview').hidden", 'preview from the next page');
    assert.ok((await evaluate("document.getElementById('garminActivityPreviewName').textContent")).startsWith('Second synthetic activity'), 'later-page preview uses the chosen activity identity');
    assert.ok(calls.some((call) => call.url.endsWith('/activities') && JSON.parse(call.init.body).offset === 20), 'preview rechecks the candidate using its real source cursor');
    await evaluate("document.getElementById('garminActivityBack').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden && document.activeElement.dataset.activityId==='43'", 'return focus to later-page candidate');
    await evaluate("document.querySelector('[data-activity-id=\"42\"]').click(); true");
    await waitFor("!document.getElementById('garminActivityPreview').hidden", 'local FIT preview');
    await waitFor("document.activeElement.id==='garminActivityPreviewHeading'", 'review heading focus');
    assert.equal(await evaluate("document.activeElement.id"), 'garminActivityPreviewHeading', 'review focuses its heading');
    assert.deepEqual(await evaluate("(()=>({hidden:document.getElementById('garminActivityMore').hidden,display:getComputedStyle(document.getElementById('garminActivityMore')).display,refreshHidden:document.getElementById('garminActivityRefresh').hidden,searchHidden:document.getElementById('garminActivitySearch').hidden}))()"),
      { hidden: true, display: 'none', refreshHidden: true, searchHidden: true }, 'review hides the list-only controls');
    assert.equal(await evaluate("document.getElementById('garminActivityPreviewContext').textContent.includes('running')"), false, 'sport label is localized in review');
    const actionMetrics = await evaluate("(()=>{const metrics=document.getElementById('garminActivityPreviewData').getBoundingClientRect();const actions=document.querySelector('.garmin-activity-preview-actions');const rect=actions.getBoundingClientRect();const notice=document.getElementById('garminActivityReplaceNotice');const noticeRect=notice.getBoundingClientRect();const button=document.getElementById('garminActivityConfirm');return {gap:getComputedStyle(document.getElementById('garminActivityPreview')).rowGap,metricsToNotice:Math.round(noticeRect.top-metrics.bottom),noticeToActions:Math.round(rect.top-noticeRect.bottom),noticeHidden:notice.hidden,actionMargin:getComputedStyle(actions).marginBlockStart,primary:button.classList.contains('btn-primary'),small:button.classList.contains('btn-small'),height:Math.round(button.getBoundingClientRect().height)}})()");
    assert.deepEqual(actionMetrics,
      { gap: '16px', metricsToNotice: 16, noticeToActions: 16, noticeHidden: false, actionMargin: '0px', primary: true, small: false, height: 44 }, `action spacing: ${JSON.stringify(actionMetrics)}`);
    assert.equal(await evaluate("document.getElementById('resultSourceBadge').textContent"), sourceBadgeBeforePreview, 'preview does not mutate the result');
    assert.equal(await evaluate("document.getElementById('feedbackAccordionPanel').hidden"), false);
    await evaluate("document.getElementById('garminActivityPreview').scrollIntoView({block:'center'}); true");
    await delay(150);
    await screenshot('pt-review-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityPreview').scrollIntoView({block:'center'}); true"); await delay(120); await screenshot('pt-review-mobile.png');
    const reviewMobileBounds = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})");
    assert.equal(reviewMobileBounds.width, 390); assert.ok(reviewMobileBounds.scroll <= reviewMobileBounds.width, `review controls fit mobile viewport: ${JSON.stringify(reviewMobileBounds)}`);
    await evaluate("document.getElementById('garminActivityBack').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden && document.activeElement.dataset.activityId==='42'", 'back to selected activity and restore focus');
    await evaluate("document.querySelector('[data-activity-id=\"42\"]').click(); true");
    await waitFor("!document.getElementById('garminActivityPreview').hidden", 'review activity again');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 460, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.body.style.zoom='200%'; true"); await delay(150);
    await evaluate("document.getElementById('garminActivityPreviewHeading').scrollIntoView({block:'center'}); true"); await delay(150);
    await screenshot('pt-review-low-height-zoom-200.png');
    await evaluate("document.getElementById('garminActivityConfirm').scrollIntoView({block:'center'}); true"); await delay(120);
    await screenshot('pt-review-low-height-zoom-200-actions.png');
    await evaluate("document.body.style.zoom=''; const nativeFetch=window.fetch.bind(window); window.__holdGarminImport=true; window.fetch=async(...args)=>{if(String(args[0]).includes('/garmin/activity-import')&&window.__holdGarminImport){window.__holdGarminImport=false;await new Promise(resolve=>window.__releaseGarminImport=resolve);return Response.json({code:'import_error'},{status:503})}return nativeFetch(...args)}; document.getElementById('garminActivityConfirm').click(); true");
    await waitFor("document.querySelector('.confirm-card') !== null", 'explicit replacement confirmation');
    await evaluate("document.getElementById('confirmOkBtn').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent==='Importando atividade…'", 'explicit import progress');
    assert.equal(await evaluate("document.getElementById('garminActivityConfirm').disabled"), true, 'import button blocks duplicate confirmation');
    assert.equal(db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'manual', 'no success before persistence');
    await waitFor("typeof window.__releaseGarminImport==='function'", 'controlled import failure gate');
    await evaluate("window.__releaseGarminImport(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('Não foi possível importar')", 'recoverable import failure');
    assert.equal(await evaluate("!document.getElementById('garminActivityPreview').hidden"), true, 'failed import keeps the review available');
    assert.equal(db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'manual', 'failed import preserves prior result');
    await evaluate("document.getElementById('garminActivityConfirm').click(); true");
    await waitFor("document.querySelector('.confirm-card') !== null", 'replacement confirmation after recoverable failure');
    await evaluate("document.getElementById('confirmOkBtn').click(); true");
    await waitFor("document.getElementById('garminActivityLink').textContent.includes('42')", 'confirmed result link');
    assert.deepEqual(await evaluate("(()=>({switchVisible:!document.getElementById('garminActivitySwitch').hidden,label:document.getElementById('garminActivitySwitch').textContent,fieldHidden:document.getElementById('garminActivityField').hidden,guidanceHidden:document.getElementById('garminActivityGuidance').hidden,initialHidden:document.getElementById('garminActivitySearch').hidden}))()"),
      { switchVisible: true, label: 'Escolher outra atividade', fieldHidden: true, guidanceHidden: true, initialHidden: true },
      'the canonical imported result shows one replacement entry point without reserving the search panel');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('garminActivityField')).display"), 'none',
      'the hidden initial search panel leaves no blank space after import');
    await evaluate("document.getElementById('garminActivitySwitch').scrollIntoView({block:'center'});true"); await delay(120); await screenshot('pt-imported-desktop.png');
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').hidden===false", 'switch action opens the existing candidate list');
    assert.equal(await evaluate("document.getElementById('garminActivitySwitch').textContent"), 'Voltar ao resultado atual');
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityField').hidden", 'chooser can be cancelled without changing the imported result');
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('42')"), true);
    assert.equal(await evaluate("document.getElementById('garminActivitySwitch').textContent"), 'Escolher outra atividade');
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').hidden===false", 'chooser reopens from the current result');
    await evaluate("document.querySelector('[data-activity-id=\"43\"]').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden===false", 'another activity can be reviewed for replacement');
    assert.equal(await evaluate("document.getElementById('garminActivityReplaceNotice').hidden"), false, 'review explains the replacement before confirmation');
    assert.equal(await evaluate("document.getElementById('garminActivityConfirm').textContent"), 'Substituir resultado');
    await evaluate("document.getElementById('garminActivityBack').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden && document.activeElement.dataset.activityId==='43'", 'cancel returns focus to the alternative activity');
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('42')"), true,
      'reviewing and returning leaves the persisted activity untouched');
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityField').hidden", 'return action closes candidate list without discarding the saved result');
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').hidden===false", 'chooser opens again for explicit replacement');
    await evaluate("document.querySelector('[data-activity-id=\"43\"]').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden===false", 'replacement activity review');
    await evaluate("document.getElementById('garminActivityConfirm').click(); true");
    await waitFor("document.querySelector('.confirm-card') !== null", 'explicit replacement confirmation');
    await evaluate("document.getElementById('confirmOkBtn').click(); true");
    await waitFor("document.getElementById('garminActivityLink').textContent.includes('43') && document.getElementById('garminActivityField').hidden", 'confirmed replacement returns to imported-result state');
    assert.deepEqual(await evaluate("(()=>({switchVisible:!document.getElementById('garminActivitySwitch').hidden,label:document.getElementById('garminActivitySwitch').textContent,searchHidden:document.getElementById('garminActivitySearch').hidden,guideHidden:document.getElementById('garminActivityGuidance').hidden}))()"),
      { switchVisible: true, label: 'Escolher outra atividade', searchHidden: true, guideHidden: true });
    await evaluate("document.getElementById('garminActivitySwitch').scrollIntoView({block:'center'});true"); await delay(120); await screenshot('pt-imported-replaced-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivitySwitch').scrollIntoView({block:'center'});true"); await delay(120); await screenshot('pt-imported-replaced-mobile.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const savedBeforeConflict = db.prepare('SELECT fit_distance,result_data_source FROM trainings WHERE id=1').get();
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityCandidates').hidden===false", 'replacement list before recoverable conflict');
    await evaluate("document.querySelector('[data-activity-id=\"42\"]').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden===false", 'replacement preview before connection conflict');
    db.prepare('UPDATE garmin_pilot_connections SET connection_generation=connection_generation+1 WHERE user_id=1').run();
    await evaluate("document.getElementById('garminActivityConfirm').click(); true");
    await waitFor("document.querySelector('.confirm-card') !== null", 'explicit confirmation before recoverable conflict');
    await evaluate("document.getElementById('confirmOkBtn').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('conexão Garmin mudou')", 'localized replacement conflict');
    assert.deepEqual(db.prepare('SELECT fit_distance,result_data_source FROM trainings WHERE id=1').get(), savedBeforeConflict,
      'a stale connection conflict preserves the confirmed result');
    assert.deepEqual(db.prepare('SELECT activity_id,is_current FROM garmin_activity_imports ORDER BY activity_id').all(), [
      { activity_id: '42', is_current: 0 }, { activity_id: '43', is_current: 1 },
    ], 'failed replacement leaves the current link and history intact');
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('43')"), true);
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityField').hidden", 'conflict flow returns to current result');
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
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('43')"), true);
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
    const preferenceResponse = await fetch(`${origin}/api/users/me/preferences`, { method: 'PATCH',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ first_day_of_week: 'Monday', distance_unit: 'mi', temperature_unit: 'C' }) });
    assert.equal(preferenceResponse.status, 200, 'synthetic account switches to miles through the preferences contract');
    await command('Page.reload');
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityLink') && !document.getElementById('garminActivityLink').hidden", 'canonical result reload');
    const plannedAfterReload = JSON.parse(await evaluate("JSON.stringify({rpe:document.getElementById('plannedRpe').textContent,hr:document.getElementById('plannedFcAlvo').textContent,details:document.getElementById('plannedDetalhes').textContent})"));
    assert.ok(plannedAfterReload.rpe.includes('3'), `planned RPE survives reload: ${JSON.stringify(plannedAfterReload)}`);
    assert.equal(plannedAfterReload.hr, JSON.parse(plannedInEnglish).hr);
    assert.equal(plannedAfterReload.details, JSON.parse(plannedInEnglish).details);
    assert.equal(await evaluate("document.getElementById('garminActivityLink').textContent.includes('43')"), true);
    assert.deepEqual(await evaluate("(()=>({fieldHidden:document.getElementById('garminActivityField').hidden,guideHidden:document.getElementById('garminActivityGuidance').hidden,searchHidden:document.getElementById('garminActivitySearch').hidden,label:document.getElementById('garminActivitySwitch').textContent,switchVisible:!document.getElementById('garminActivitySwitch').hidden}))()"),
      { fieldHidden: true, guideHidden: true, searchHidden: true, label: 'Choose another activity', switchVisible: true },
      'reload derives the single replacement action from the canonical current activity link');
    assert.equal(await evaluate("document.getElementById('fitAvgHr').textContent.trim()"), '-');
    await evaluate("document.getElementById('feedbackAccordionTrigger').click(); true");
    holdFirstActivityPage = true;
    await evaluate("document.getElementById('garminActivitySwitch').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent==='Searching activities…'", 'English search loading');
    for (let attempt = 0; attempt < 80 && !releaseFirstActivityPage; attempt += 1) await delay(25);
    assert.equal(typeof releaseFirstActivityPage, 'function');
    await evaluate("document.getElementById('resultSourceSelect').value='manual';document.getElementById('resultSourceSelect').dispatchEvent(new Event('change',{bubbles:true}));true");
    assert.equal(await evaluate("document.getElementById('manualResultsField').hidden"), false, 'switching origin returns to the manual fallback');
    releaseFirstActivityPage(); await delay(100);
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 0, 'late Garmin results do not repaint after the origin changes');
    await evaluate("document.getElementById('resultSourceSelect').value='garmin';document.getElementById('resultSourceSelect').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('garminActivitySwitch').click();true");
    await waitFor("document.getElementById('garminActivityCandidates').children.length===1", 'miles candidate after reload');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').textContent.includes('6.21 mi')"), true, 'candidate distance follows the persisted miles preference');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').textContent.includes('Running')"), true, 'reloaded English UI localizes the sport');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click(); true");
    await waitFor("document.documentElement.lang==='pt-BR' && document.getElementById('garminActivityCandidates').textContent.includes('Corrida')", 'Portuguese candidate after miles reload');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').textContent.includes('6.21 mi')"), true, 'language changes do not change distance units');
    await evaluate("document.getElementById('garminActivityBack').click(); true");
    filteredPageScenario = true;
    await evaluate("document.getElementById('garminActivityRefresh').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('Nenhuma corrida nesta parte')", 'filtered empty page with continuation');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').hidden"), true, 'filtered empty pages keep the list container out of layout');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'empty filtered page keeps the backend continuation action available');
    await evaluate("document.getElementById('garminActivityMore').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-empty-filtered-page-desktop.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click();true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityStatus').textContent.includes('No runs in this part')", 'localized empty-page continuation in English');
    await evaluate("document.getElementById('garminActivityMore').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('en-empty-filtered-page-desktop.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click();true");
    await waitFor("document.documentElement.lang==='pt-BR'", 'return to Portuguese without losing the cursor');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityMore').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-empty-filtered-page-mobile.png');
    await evaluate("document.getElementById('garminActivityMore').click(); true");
    await waitFor("document.querySelector('[data-activity-id=\"43\"]') && !document.getElementById('garminActivityMore').hidden", 'running result on the next remote page');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 1, 'the following page appends the compatible run');
    await evaluate("document.querySelector('[data-activity-id=\"43\"]').click(); true");
    await waitFor("!document.getElementById('garminActivityPreview').hidden", 'preview from page after filtered empty response');
    await evaluate("document.getElementById('garminActivityBack').click(); true");
    await waitFor("document.getElementById('garminActivityPreview').hidden && !document.getElementById('garminActivityMore').hidden", 'preview return preserves the real continuation cursor');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click();true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityCandidates').textContent.includes('Running')", 'continuation remains visible after language change');
    await evaluate("document.getElementById('garminActivityMore').click(); true");
    await waitFor("document.querySelector('[data-activity-id=\"44\"]') && document.getElementById('garminActivityMore').hidden", 'final page closes continuation');
    filteredPageScenario = false;
    emptyRefresh = true;
    await evaluate("document.getElementById('garminActivityRefresh').click(); true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('No running activities found')", 'completed empty search result');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), true, 'a completed empty search has no continuation');
    assert.equal(db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'garmin_connect', 'refreshing search never changes the imported result');
    budgetScenario = true;
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('garminActivityRefresh').click();true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('search is not finished')", 'budget-exhausted search remains explicitly incomplete');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'budget exhaustion does not hide a valid cursor');
    assert.deepEqual(budgetPageRequests, [0], 'the UI waits for one explicit continuation instead of auto-traversing');
    await evaluate("document.getElementById('garminActivityMore').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('en-budget-exhausted-empty-desktop.png');
    await evaluate("document.getElementById('garminActivityMore').click();true");
    await waitFor("document.querySelector('[data-activity-id=\"45\"]') && document.getElementById('garminActivityStatus').textContent.includes('search is not finished')", 'manual cursor 50 returns a partial running candidate and a second exhausted budget');
    assert.deepEqual(budgetPageRequests, [0, 50], 'the exact returned offset 50 is sent on explicit click');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 1, 'partial results remain visible while more data is available');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false);
    await evaluate("document.querySelector('[data-activity-id=\"45\"]').click();true");
    await waitFor("document.getElementById('garminActivityPreview').hidden===false", 'preview on the page after the exhausted search budget');
    await evaluate("document.getElementById('garminActivityBack').click();true");
    await waitFor("document.getElementById('garminActivityPreview').hidden && !document.getElementById('garminActivityMore').hidden", 'preview return keeps the continuation available');
    budgetPageRequests.length = 0;
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click();true");
    await waitFor("document.documentElement.lang==='pt-BR' && document.getElementById('garminActivityStatus').textContent.includes('A busca ainda não terminou')", 'Portuguese incomplete-search message');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'language changes preserve the cursor action');
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-budget-exhausted-partial-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-budget-exhausted-partial-mobile.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click();true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityStatus').textContent.includes('search is not finished')", 'English incomplete-search message on mobile');
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('en-budget-exhausted-partial-mobile.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click();true");
    await waitFor("document.documentElement.lang==='pt-BR' && !document.getElementById('garminActivityMore').hidden", 'restore Portuguese continuation before retry');
    await evaluate("document.getElementById('garminActivityMore').click();true");
    await waitFor("document.querySelector('[data-activity-id=\"46\"]') && document.getElementById('garminActivityStatus').textContent.includes('A busca ainda não terminou')", 'third request budget returns another partial candidate');
    assert.deepEqual(budgetPageRequests, [100], 'one click issues only the next bounded request');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 2, 'the next budget-exhausted response appends without discarding earlier candidates');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false);
    budgetPageRequests.length = 0;
    failNextPage = true;
    await evaluate("document.getElementById('garminActivityMore').click();true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('indisponível')", 'recoverable next-request failure after page budget exhaustion');
    assert.deepEqual(budgetPageRequests, [150], 'failed continuation requests the exact cursor 150');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 2, 'failed continuation preserves partial candidates');
    assert.equal(await evaluate("document.getElementById('garminActivityMore').hidden"), false, 'failed continuation retains retry action');
    await evaluate("document.getElementById('garminActivityMore').click();true");
    await waitFor("document.querySelector('[data-activity-id=\"47\"]') && document.getElementById('garminActivityMore').hidden", 'same-cursor retry reaches the next page and the confirmed search end');
    assert.deepEqual(budgetPageRequests, [150, 150], 'retry reuses cursor 150 with no duplicated concurrent request');
    assert.equal(await evaluate("document.getElementById('garminActivityCandidates').children.length"), 3, 'the new candidate appends to prior partial results');
    budgetScenario = false;
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click();true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityMore').hidden", 'English terminal pagination state');
    const otherTraining = db.prepare(`INSERT INTO trainings(user_id,dia,tipo,treino,detalhes,result_data_source)
      VALUES(?,'2026-11-02','Corrida','Outra corrida','Resultado alheio','manual')`).run(user.id);
    db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
      VALUES(? ,?,'fit_sha256',?,'fit_upload',1)`).run(user.id, otherTraining.lastInsertRowid,
      createHash('sha256').update('conflicting-fit-bytes').digest('hex'));
    emptyRefresh = false; conflictOriginalForActivity42 = true;
    await evaluate("document.getElementById('garminActivityRefresh').click();true");
    await waitFor("document.querySelector('[data-activity-id=\"42\"]') && document.getElementById('garminActivityCandidates').hidden===false", 'candidate list for exact duplicate conflict');
    await evaluate("document.querySelector('[data-activity-id=\"42\"]').click();true");
    await waitFor("document.getElementById('garminActivityPreview').hidden===false", 'duplicate candidate preview');
    await evaluate("document.getElementById('garminActivityConfirm').click();true");
    await waitFor("document.querySelector('.confirm-card')!==null", 'duplicate conflict replacement confirmation');
    await evaluate("document.getElementById('confirmOkBtn').click();true");
    await waitFor("document.getElementById('garminActivityStatus').textContent.includes('already the current result in another session')", 'visible exact duplicate guidance');
    assert.equal(db.prepare('SELECT result_data_source FROM trainings WHERE id=1').get().result_data_source, 'garmin_connect', 'exact duplicate leaves current result intact');
    assert.equal(db.prepare('SELECT fit_distance FROM trainings WHERE id=?').get(otherTraining.lastInsertRowid).fit_distance, null, 'exact duplicate conflict has no partial write');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('en-duplicate-activity-conflict.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click();true");
    await waitFor("document.documentElement.lang==='pt-BR' && document.getElementById('garminActivityStatus').textContent.includes('já é o resultado atual')", 'localized exact duplicate guidance in Portuguese');
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-duplicate-activity-conflict.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click();true");
    await waitFor("document.documentElement.lang==='en-US' && document.getElementById('garminActivityStatus').textContent.includes('already the current result')", 'English duplicate guidance');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('en-duplicate-activity-conflict-mobile.png');
    await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click();true");
    await waitFor("document.documentElement.lang==='pt-BR' && document.getElementById('garminActivityStatus').textContent.includes('já é o resultado atual')", 'Portuguese mobile duplicate guidance');
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-duplicate-activity-conflict-mobile.png');
    await evaluate("document.getElementById('garminActivityStatus').scrollIntoView({block:'center'});true"); await delay(100); await screenshot('pt-duplicate-activity-conflict.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const keyboard = await evaluate("(()=>{const b=document.getElementById('feedbackAccordionTrigger');b.focus();return document.activeElement.id})()");
    assert.equal(keyboard, 'feedbackAccordionTrigger', 'keyboard focus remains available on result summary');
    assert.ok(calls.some((call) => call.url.endsWith('/activities/42/original')));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM garmin_training_operations').get().n, 0, 'activity import does not publish a workout');
  } finally {
    if (socket) socket.close(); processChrome.kill(); await app.close(); db.close();
  }
});
