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
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { readAiConfig } = require('../src/ai/config');

const PASSWORD = 'rpe-browser-secret-1';
const EN_REQUIRED = 'Select the realized RPE (1 to 5) to record and analyze this workout.';
const PT_REQUIRED = 'Selecione o RPE realizado (1 a 5) para registrar e analisar o treino.';

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((file) => existsSync(file));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fitSummary() {
  const lapTypes = ['Warmup', 'Cooldown', 'Run', 'Rest', 'Run', 'Run', 'Rest', 'Run', 'Run', 'Cooldown', 'Warmup', 'Run'];
  const laps = lapTypes.map((stepType, index) => ({
    lap: index + 1,
    stepType,
    distanceLabel: index === 3 ? '0.09' : '1.00',
    durationLabel: index === 0 ? '1:02:03' : index === 9 ? '0:45' : '5:00',
    avgPaceLabel: index === 1 || index === 3 ? '--:--' : '5:00',
    avgHeartRate: index === 1 || index === 3 ? null : 198 + index,
    avgCadenceSpm: index === 1 || index === 3 ? null : 220 + index,
    ascentMeters: index === 1 || index === 3 ? null : 120 + index,
  }));
  return {
    totals: {
      durationSeconds: 3600,
      distanceKm: 10,
      avgPaceSecondsPerKm: 360,
      avgHeartRate: 155,
      maxHeartRate: 175,
      ascentMeters: 120,
    },
    activity: {
      sport: 'running',
      startTime: '2026-08-24T07:00:00Z',
      endTime: '2026-08-24T08:00:00Z',
    },
    laps,
  };
}

test('the session page requires a realized RPE before saving, generating or uploading', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for the session browser verification.');

  const db = createDatabase({ filename: ':memory:' });
  let providerCalls = 0;
  let invalidNextProviderResponse = false;
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    parseFitFile: async () => fitSummary(),
    aiConfig: readAiConfig({ AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-browser-only', AI_RETRIES: '0' }),
    aiClient: async (payload) => {
      providerCalls += 1;
      const request = JSON.parse(payload.input[0].content[0].text);
      const saved = db.prepare('SELECT completed,feedback_rpe,feedback_notas FROM trainings WHERE id=?').get(request.context.resource.source.id);
      assert.equal(saved.completed, 1, 'canonical result persistence finished before the simulated provider was invoked');
      assert.ok(saved.feedback_rpe >= 1 && saved.feedback_rpe <= 5);
      assert.equal(request.context.resource.report.authority, 'user_report');
      assert.equal(request.context.resource.report.feedback_rpe, saved.feedback_rpe, 'the analysis context reads the persisted realized effort');
      assert.equal(request.context.resource.report.feedback_notas, saved.feedback_notas, 'the analysis context reads the persisted feedback notes');
      if (request.context.resource.actual.result_data_source === 'fit_upload')
        assert.ok(request.context.resource.actual.fitLaps.length > 0, 'the simulated provider receives bounded, decoded FIT lap evidence');
      const evidence = [`${request.context.resource.source.type}:${request.context.resource.source.id}`];
      await delay(900);
      const value = {
          schemaVersion: 'workout-analysis-v1', language: request.context.preferences.language,
          summary: { text: 'Synthetic analysis arrived while the session stayed open.', evidence },
          comparison: { text: 'The saved result is compared with its planned session.', evidence },
          contextualReading: [{ text: `This synthetic case contains a saved ${request.context.resource.actual.result_data_source === 'fit_upload' ? 'FIT' : 'manual'} result.`, evidence }],
          attention: [], recommendations: [{ text: 'Keep the next session unchanged unless later evidence suggests an adjustment.', evidence }],
          classification: { value: 'adequate', evidence }, limitations: ['Synthetic provider; no real model was called.'],
          reusableInterpretations: [{ kind: 'pattern', text: 'The synthetic report describes a controlled effort.', evidence }],
        };
      if (invalidNextProviderResponse) {
        invalidNextProviderResponse = false;
        value.summary.text = 'RPE 8/10';
      }
      return {
        value,
        usage: { input: 700, output: 240, cached: 0 }, error: null,
      };
    },
  });
  const account = await registerUser(db, {
    email: 'rpe-runner@example.test',
    password: PASSWORD,
    first_name: 'Rita',
    last_name: 'Rpe',
  });
  const admin = await registerUser(db, {
    email: 'analysis-admin@example.test', password: PASSWORD,
    first_name: 'Ada', last_name: 'Admin',
  });
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  const otherUser = await registerUser(db, {
    email: 'analysis-other@example.test', password: PASSWORD,
    first_name: 'Owen', last_name: 'Other',
  });
  const seedTraining = (userId = account.id, overrides = {}) => {
    const result = db.prepare(
      `INSERT INTO trainings (user_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes, feedback_rpe, feedback_notas, completed)
       VALUES (?, '2026-08-24', 'Manhã', 'Corrida', '6 × 1 km forte', 'Aquecer 15 min', '150-160 bpm', '4', 'Nimbus 26', NULL, NULL, ?, NULL, ?)`
    ).run(userId, overrides.feedback_rpe ?? null, overrides.completed ?? 0);
    return Number(result.lastInsertRowid);
  };
  const manualId = seedTraining();
  const fitId = seedTraining();
  const feedbackId = seedTraining(account.id, { feedback_rpe: 4 });
  const legacyId = seedTraining(account.id, { completed: 1 });
  db.prepare(
    "UPDATE trainings SET result_data_source = 'fit_upload', fit_duration = '01:00:00', fit_distance = 10, fit_summary_json = '{}' WHERE id = ?"
  ).run(legacyId);
  const row = (id) => db.prepare(
    'SELECT feedback_rpe, feedback_notas, completed, result_data_source, fit_distance FROM trainings WHERE id = ?'
  ).get(id);

  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = new URL(baseUrl).origin;
  const commonPreview = await app.inject({
    method: 'POST', url: '/api/ai/admin/preview', payload: { purpose: 'analysis', resource_id: manualId },
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, account.id).token}` },
  });
  assert.equal(commonPreview.statusCode, 403, 'external prompt preview is admin-only in the backend');
  const crossOwnerAdminPreview = await app.inject({
    method: 'POST', url: '/api/ai/admin/preview', payload: { purpose: 'analysis', resource_id: manualId },
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, admin.id).token}` },
  });
  assert.equal(crossOwnerAdminPreview.statusCode, 404, 'admin prompt access still enforces training ownership');
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-rpe-chrome-'));
  const uploads = mkdtempSync(path.join(tmpdir(), 'kinesis-rpe-fit-'));
  const fitFile = path.join(uploads, 'morning-run.fit');
  writeFileSync(fitFile, 'FITDATA');
  const chromeProcess = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let socket;
  try {
    const debugUrl = `http://127.0.0.1:${debugPort}`;
    let versionResponse;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        versionResponse = await fetch(`${debugUrl}/json/version`);
        if (versionResponse.ok) break;
      } catch {}
      await delay(50);
    }
    assert.ok(versionResponse?.ok, 'Chrome DevTools endpoint became available.');
    const targetResponse = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetResponse.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    const requests = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent') {
        requests.push({
          method: message.params.request.method,
          url: message.params.request.url,
        });
      }
      if (message.method) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    };
    const pressKey = async (key, code, keyCode) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await delay(60);
    };
    const pressShiftTab = async () => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await delay(60);
    };
    // Session writes only: the shell persists its own language preference
    // whenever the test switches languages.
    const writes = () => requests.filter(
      ({ method, url }) => !['GET', 'HEAD'].includes(method)
        && url.startsWith(origin)
        && !url.startsWith(`${origin}/api/users/me/language`)
    );
    const waitFor = async (expression, description, timeoutMs = 15000) => {
      // A poll that spans a navigation sees its execution context destroyed;
      // the page itself is fine, so the poll simply starts again.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          return await evaluate(
            `new Promise((resolve,reject)=>{const end=Date.now()+${timeoutMs};const check=()=>{`
            + `let value;try{value=(${expression})}catch{value=false}`
            + `if(value){resolve(value);return}`
            + `if(Date.now()>end){reject(new Error('Timed out waiting for ${description}'));return}`
            + `requestAnimationFrame(check)};check()})`
          );
        } catch (error) {
          if (!/navigated or closed|context was destroyed|Cannot find context|Target closed/i.test(error.message)) throw error;
          await delay(100);
        }
      }
      throw new Error(`Gave up waiting for ${description}.`);
    };
    const setLanguage = async (lang) => {
      await waitFor(
        `!!document.querySelector(".lang-switch [data-lang='${lang}']")`,
        `the ${lang} switch`
      );
      await evaluate(`document.querySelector(".lang-switch [data-lang='${lang}']").click()`);
      await waitFor(`document.documentElement.lang==='${lang}'`, `language ${lang}`);
      await waitFor(
        `!!document.getElementById('rpe-1').getAttribute('aria-label')`,
        'the localized effort options'
      );
    };
    const openSession = async (trainingId) => {
      requests.length = 0;
      await command('Page.navigate', { url: `${baseUrl}/training-result.html?id=${trainingId}` });
      await waitFor(
        "document.getElementById('sessionDate').textContent.trim() !== '-'",
        `session ${trainingId} loaded`
      );
      await setLanguage('en-US');
      await delay(300);
    };
    // The page attaches its listeners once the session is loaded, so an
    // interaction issued earlier is retried until the page answers it. A
    // refused action writes nothing and repeats exactly; once a real request
    // left the page the wait extends instead, so a slow save is never issued
    // twice and no second navigation can race the next one.
    const settle = async (effect, description) => {
      await delay(250);
      try {
        return await waitFor(effect, description, writes().length > 0 ? 15000 : 1500);
      } catch (error) {
        if (error.message.startsWith('Timed out waiting for')) return null;
        throw error;
      }
    };
    const clickUntil = async (selector, effect, description) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const clicked = await evaluate(
          `(()=>{const node=document.querySelector(${JSON.stringify(selector)});`
          + 'if(!node)return false;node.click();return true})()'
        );
        if (clicked && await settle(effect, description)) return true;
        await delay(120);
      }
      throw new Error(`Gave up waiting for ${description}.`);
    };
    const chooseFile = async (selector, file) => {
      const { root } = await command('DOM.getDocument');
      const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector });
      assert.ok(nodeId, `${selector} exists`);
      await command('DOM.setFileInputFiles', { files: [file], nodeId });
    };
    const clickUntilFile = async (selector, file, effect, description) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await chooseFile(selector, file);
        if (await settle(effect, description)) return true;
        await delay(120);
      }
      throw new Error(`Gave up waiting for ${description}.`);
    };

    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await command('DOM.enable');
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await command('Network.setCookie', {
      name: SESSION_COOKIE_NAME,
      value: createSession(db, account.id).token,
      url: origin,
    });

    /* ── The group is required, named, and silent until it is answered ── */

    await openSession(manualId);
    assert.equal(
      await evaluate(`(()=>{const section=document.getElementById('analysisSection');return section.hidden && getComputedStyle(section).display==='none'})()`),
      true,
      'an empty analysis section is absent from the initial browser layout'
    );
    assert.equal(requests.some(({ method, url }) => method === 'GET' && new URL(url).pathname.startsWith('/api/ai/executions')), false,
      'a session without an analysis request does not query execution progress');
    const failFirstHistoryRead = await command('Page.addScriptToEvaluateOnNewDocument', {
      source: `(()=>{const original=window.fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(String(input),location.href);if(url.pathname==='/api/trainings/${feedbackId}/analyses'&&!sessionStorage.getItem('synthetic-analysis-read-failed')){sessionStorage.setItem('synthetic-analysis-read-failed','1');return Promise.reject(new TypeError('synthetic history read failure'))}return original(input,init)}})()`,
    });
    await openSession(feedbackId);
    assert.equal(await evaluate("document.getElementById('analysisSection').hidden"), true,
      'saved feedback by itself does not reveal an analysis section');
    assert.equal(requests.some(({ method, url }) => method === 'GET' && new URL(url).pathname.startsWith('/api/ai/executions')), false,
      'saved feedback by itself does not query execution progress');
    await waitFor("document.getElementById('analysisLoadWarning').hidden===false", 'the initial history read failure outside the analysis section');
    assert.equal(await evaluate("document.getElementById('analysisLoadMessage').textContent.includes('Could not load saved analyses')"), true);
    assert.equal(await evaluate("document.getElementById('analysisSection').hidden"), true, 'unknown history does not create an empty analysis section');
    assert.equal(requests.some(({ method, url }) => method === 'GET' && new URL(url).pathname.startsWith('/api/ai/executions')), false, 'a failed history read does not start execution polling');
    await evaluate("document.getElementById('analysisLoadWarning').scrollIntoView({block:'center'}); true");
    await delay(100);
    const loadWarningShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/issue65-analysis-load-warning.png', Buffer.from(loadWarningShot.data, 'base64'));
    await setLanguage('pt-BR');
    assert.equal(await evaluate("document.getElementById('analysisLoadMessage').textContent.includes('Não foi possível carregar')"), true, 'the independent read warning is localized in Portuguese');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('analysisLoadWarning').scrollIntoView({block:'center'}); true");
    await delay(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the contextual history warning has no mobile overflow');
    const mobileLoadWarningShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/issue65-analysis-load-warning-mobile.png', Buffer.from(mobileLoadWarningShot.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await setLanguage('en-US');
    await evaluate("document.getElementById('analysisLoadAgain').click(); true");
    await waitFor("document.getElementById('analysisLoadWarning').hidden", 'the free read retry resolving to an empty history');
    assert.equal(await evaluate("document.getElementById('analysisSection').hidden"), true, 'a successful empty read stays absent after recovery');
    assert.equal(writes().some(({ method, url }) => method === 'POST' && url.endsWith('/api/ai/executions')), false, 'retrying history is read-only and does not enqueue generation');
    await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: failFirstHistoryRead.identifier });
    await evaluate(`sessionStorage.setItem('kinesis:analysis-request:${feedbackId}', 'stale-synthetic-request-key')`);
    await command('Page.reload');
    await waitFor(`sessionStorage.getItem('kinesis:analysis-request:${feedbackId}')===null`, 'clearing a stale request key after the owner-scoped execution list confirms no accepted request');
    assert.equal(await evaluate("document.getElementById('analysisSection').hidden"), true,
      'a stale key with no accepted execution does not leave an empty error panel');
    assert.equal(requests.filter(({ method, url }) => method === 'GET' && new URL(url).pathname === '/api/ai/executions').length, 1,
      'recovery performs one exact lookup for a stored idempotency key');
    assert.equal(new URL(requests.find(({ method, url }) => method === 'GET' && new URL(url).pathname === '/api/ai/executions').url).searchParams.get('idempotency_key'), 'stale-synthetic-request-key',
      'recovery checks the exact stored key instead of scanning a capped recent list');
    assert.equal(requests.some(({ method, url }) => method === 'GET' && /\/api\/ai\/executions\/[^/]+$/.test(new URL(url).pathname)), false,
      'recovery without a matching execution never polls a nonexistent execution');
    assert.equal(writes().some(({ method, url }) => method === 'POST' && url.endsWith('/api/ai/executions')), false,
      'opening and recovering the session never starts generation');
    await openSession(manualId);
    const initial = await evaluate(`(()=>{
      const group=document.getElementById('feedbackRpe');
      const error=document.getElementById('feedbackRpeError');
      return {
        role:group.getAttribute('role'),
        required:group.getAttribute('aria-required'),
        labelledby:group.getAttribute('aria-labelledby'),
        labelText:document.getElementById(group.getAttribute('aria-labelledby')).textContent.trim(),
        requiredMark:!!document.querySelector('#feedbackRpeLabel .required-mark'),
        describedby:group.getAttribute('aria-describedby'),
        invalid:group.getAttribute('aria-invalid'),
        checked:document.querySelector('#feedbackRpe input:checked')?.value??null,
        names:[...document.querySelectorAll('#feedbackRpe input')].map((node)=>node.getAttribute('aria-label')),
        errorHidden:error.hidden,
        errorText:error.textContent,
        errorVisible:error.offsetParent!==null,
        roleAlert:error.getAttribute('role'),
        source:document.getElementById('resultSourceSelect').value,
      };
    })()`);
    assert.equal(initial.role, 'radiogroup');
    assert.equal(initial.required, 'true');
    assert.equal(initial.labelledby, 'feedbackRpeLabel');
    assert.match(initial.labelText, /Realized RPE \(1 to 5\)/);
    assert.equal(initial.requiredMark, true, 'the required choice is visible, not only announced');
    assert.equal(initial.describedby, null, 'nothing is described while there is no error');
    assert.equal(initial.invalid, null);
    assert.equal(initial.checked, null, 'a session without a reported effort starts unanswered');
    assert.deepEqual(initial.names, [
      '1 - Very Easy', '2 - Easy', '3 - Moderate', '4 - Hard', '5 - Max',
    ], 'every option carries its localized name');
    assert.equal(initial.errorHidden, true);
    assert.equal(initial.errorText, '');
    assert.equal(initial.errorVisible, false, 'a hidden error takes no space');
    assert.equal(initial.roleAlert, 'alert');
    assert.equal(initial.source, 'fit');

    /* ── A manual result without the effort writes nothing ── */

    await waitFor(
      "document.getElementById('saveBtn') && document.getElementById('resultSourceSelect').value!==''",
      'the loaded session form'
    );
    await evaluate(`(()=>{
      const set=(id,value)=>{const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));};
      const source=document.getElementById('resultSourceSelect');
      source.value='manual';
      source.dispatchEvent(new Event('change'));
      set('manualDistance','10.25');
      set('manualHours','0');
      set('manualMinutes','42');
      set('manualSeconds','00');
      set('feedbackNotas','ritmo controlado');
      set('feedbackWeather','22C nublado');
      return true;
    })()`);
    await clickUntil('#saveBtn', "document.getElementById('feedbackRpeError').hidden===false", 'the inline RPE error');
    const refused = await evaluate(`(()=>{
      const group=document.getElementById('feedbackRpe');
      const error=document.getElementById('feedbackRpeError');
      return {
        errorText:error.textContent,
        errorVisible:error.offsetParent!==null,
        describedby:group.getAttribute('aria-describedby'),
        invalid:group.getAttribute('aria-invalid'),
        active:document.activeElement.id,
        distance:document.getElementById('manualDistance').value,
        minutes:document.getElementById('manualMinutes').value,
        notes:document.getElementById('feedbackNotas').value,
        weather:document.getElementById('feedbackWeather').value,
        status:document.getElementById('status').textContent,
        saveEnabled:!document.getElementById('saveBtn').disabled,
        path:location.pathname,
      };
    })()`);
    assert.equal(refused.errorText, EN_REQUIRED);
    assert.equal(refused.errorVisible, true);
    assert.equal(refused.describedby, 'feedbackRpeError', 'the error is announced with the group');
    assert.equal(refused.invalid, 'true');
    assert.equal(refused.active, 'rpe-1', 'focus moves to the answer the page needs');
    assert.equal(refused.distance, '10.25', 'every other value survives the refusal');
    assert.equal(refused.minutes, '42');
    assert.equal(refused.notes, 'ritmo controlado');
    assert.equal(refused.weather, '22C nublado');
    assert.equal(refused.status, EN_REQUIRED);
    assert.equal(refused.saveEnabled, true, 'the button is usable again');
    assert.equal(refused.path, '/training-result.html', 'no navigation happened');
    assert.deepEqual(writes(), [], 'no write request left the page');
    assert.deepEqual(row(manualId), {
      feedback_rpe: null,
      feedback_notas: null,
      completed: 0,
      result_data_source: 'none',
      fit_distance: null,
    }, 'the session is untouched');

    /* ── The same refusal answers in the language being read ── */

    await setLanguage('pt-BR');
    const translated = await evaluate(`(()=>({
      errorText:document.getElementById('feedbackRpeError').textContent,
      status:document.getElementById('status').textContent,
      firstName:document.getElementById('rpe-1').getAttribute('aria-label'),
    }))()`);
    assert.equal(translated.errorText, PT_REQUIRED, 'a visible error follows the language switch');
    assert.equal(translated.status, PT_REQUIRED);
    assert.equal(translated.firstName, '1 - Muito Fácil');
    await clickUntil('#generateBtn', "document.getElementById('feedbackRpeError').hidden===false", 'the refused analysis');
    const refusedPrompt = await evaluate(`(()=>({
      errorText:document.getElementById('feedbackRpeError').textContent,
      analysisHidden:document.getElementById('analysisSection').hidden,
      technicalPrompt:!![...document.querySelectorAll('button')].find((button)=>button.textContent.includes('View external prompt')),
    }))()`);
    assert.equal(refusedPrompt.errorText, PT_REQUIRED, 'the analysis action reports the same requirement');
    assert.equal(refusedPrompt.analysisHidden, true, 'no analysis appears without a saved result and effort');
    assert.equal(refusedPrompt.technicalPrompt, false, 'a common account does not receive the admin prompt control');
    assert.deepEqual(writes(), [], 'an invalid analysis request made no result write or paid execution');
    await setLanguage('en-US');

    /* ── The keyboard answers the group and the result is recorded ── */

    await evaluate("document.getElementById('rpe-1').focus(); true");
    await pressKey('ArrowRight', 'ArrowRight', 39);
    await pressKey('ArrowRight', 'ArrowRight', 39);
    const answered = await evaluate(`(()=>{
      const group=document.getElementById('feedbackRpe');
      return {
        checked:document.querySelector('#feedbackRpe input:checked').value,
        active:document.activeElement.id,
        errorHidden:document.getElementById('feedbackRpeError').hidden,
        describedby:group.getAttribute('aria-describedby'),
        invalid:group.getAttribute('aria-invalid'),
        status:document.getElementById('status').textContent,
      };
    })()`);
    assert.equal(answered.checked, '3', 'arrow keys move through the group');
    assert.equal(answered.active, 'rpe-3', 'focus follows the checked option');
    assert.equal(answered.errorHidden, true, 'answering clears the error');
    assert.equal(answered.describedby, null);
    assert.equal(answered.invalid, null);
    assert.equal(answered.status, '');

    await clickUntil('#saveBtn', "location.pathname!=='/training-result.html'", 'the navigation after a saved result');
    const manualWrite = writes().find(({ method }) => method === 'PUT');
    assert.ok(manualWrite, 'the manual result was written');
    assert.match(manualWrite.url, new RegExp(`/api/trainings/${manualId}/manual-results$`));
    assert.deepEqual(row(manualId), {
      feedback_rpe: 3,
      feedback_notas: 'ritmo controlado',
      completed: 1,
      result_data_source: 'manual',
      fit_distance: 10.25,
    }, 'the reported effort is stored with the concluded result');

    /* ── The explicit analysis uses the saved result and recovers on reload ── */

    await openSession(manualId);
    await waitFor(
      "document.querySelector('#feedbackRpe input:checked')?.value==='3'"
      + " && document.getElementById('feedbackNotas').value==='ritmo controlado'"
      + " && document.getElementById('manualDistance').value==='10.25'",
      'the restored session'
    );
    const restored = await evaluate(`(()=>({
      checked:document.querySelector('#feedbackRpe input:checked').value,
      distance:document.getElementById('manualDistance').value,
      notes:document.getElementById('feedbackNotas').value,
      source:document.getElementById('resultSourceSelect').value,
      errorHidden:document.getElementById('feedbackRpeError').hidden,
    }))()`);
    assert.equal(restored.checked, '3', 'a stored effort is offered back as the answer');
    assert.equal(restored.distance, '10.25');
    assert.equal(restored.notes, 'ritmo controlado');
    assert.equal(restored.source, 'manual');
    assert.equal(restored.errorHidden, true, 'a stored effort never opens with an error');

    await evaluate(`(()=>{
      const original=window.fetch.bind(window);let failed=false;window.__analysisListReads=0;
      window.fetch=(input,init)=>{
        if(String(input).includes('/api/trainings/${manualId}/analyses')){
          window.__analysisListReads++;
          if(!failed){failed=true;return Promise.reject(new TypeError('synthetic read interruption'));}
        }
        return original(input,init);
      };
    })()`);
    await clickUntil('#generateBtn', "document.getElementById('analysisSection').hidden===false", 'the analysis execution');
    await waitFor("document.getElementById('analysisState').textContent.includes('progress')", 'the analysis running state');
    assert.equal(providerCalls, 1, 'one simulated provider call started');
    assert.equal(writes().filter(({ method, url }) => method === 'POST' && url.endsWith('/api/ai/executions')).length, 1, 'one explicit execution POST was sent');
    await waitFor('window.__analysisListReads>=2', 'the free retry after a transient terminal analysis-list read failure');
    await waitFor("document.getElementById('analysisContent').textContent.includes('Synthetic analysis arrived')", 'automatic analysis display after the failed first list read');
    const generationWrites = writes();
    requests.length = 0;
    await command('Page.reload');
    await waitFor("document.getElementById('analysisContent').textContent.includes('Synthetic analysis arrived')", 'the automatically recovered analysis');
    assert.equal(requests.some(({ method, url }) => method === 'GET' && new URL(url).pathname.startsWith('/api/ai/executions')), false,
      'reopening a persisted completed analysis does not poll an execution');
    const generated = await evaluate(`(()=>({
      analysis:document.getElementById('analysisContent').textContent,
      url:location.pathname,
      hidden:document.getElementById('analysisSection').hidden,
    }))()`);
    assert.ok(generated.analysis.includes('Synthetic analysis arrived'));
    assert.equal(generated.url, '/training-result.html', 'the completed result appears without navigation');
    assert.equal(generated.analysis.includes('training:'), false, 'ordinary analysis text has no raw evidence references');
    assert.equal(await evaluate("document.querySelector('.analysis-header button')?.hidden"), true, 'the free read-again control disappears after recovery succeeds');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.analysis-header button')).display"), 'none', 'the recovered action is also absent in computed browser layout');
    await evaluate("document.getElementById('analysisSection').scrollIntoView({block:'start'}); true");
    const desktopShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/issue65-analysis-desktop.png', Buffer.from(desktopShot.data, 'base64'));
    await evaluate("(()=>{const trigger=document.querySelector('.analysis-interpretation button');trigger.focus();trigger.click();return true})()");
    await waitFor("document.querySelector('.analysis-interpretation h4').textContent==='Confirmed interpretation'", 'confirming the reusable interpretation');
    await delay(150);
    await evaluate("(()=>{const trigger=document.querySelector('.analysis-interpretation button');trigger.focus();trigger.click();return true})()");
    await waitFor("document.getElementById('analysisCorrectionDialog').hidden===false", 'opening the accessible correction dialog');
    assert.equal(await evaluate("document.activeElement.matches('[data-analysis-correction-close]')"), true, 'the correction dialog takes initial focus');
    await pressShiftTab();
    assert.equal(await evaluate("document.activeElement.matches('[data-analysis-correction-save]')"), true, 'Shift+Tab wraps to the final correction action');
    await pressKey('Tab', 'Tab', 9);
    assert.equal(await evaluate("document.activeElement.matches('[data-analysis-correction-close]')"), true, 'Tab wraps to the first correction control');
    await pressKey('Escape', 'Escape', 27);
    await waitFor("document.getElementById('analysisCorrectionDialog').hidden", 'closing the correction dialog with Escape');
    assert.equal(await evaluate("document.activeElement.dataset.interpretationAction?.endsWith(':correct')"), true, 'Escape restores focus to the correction trigger');
    await evaluate("document.querySelector('[data-interpretation-action$=\":correct\"]').click(); true");
    await waitFor("document.getElementById('analysisCorrectionDialog').hidden===false", 'reopening the correction dialog');
    assert.equal(await evaluate("document.activeElement.matches('[data-analysis-correction-close]')"), true, 'reopened correction dialog restores initial focus');
    await evaluate(`(()=>{const field=document.getElementById('analysisCorrectionText');field.value='Synthetic correction confirmed in the browser.';field.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    // A held network mutation rejects after the user tries to click twice.
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__originalFetch=original;window.__correctionCalls=0;window.__rejectCorrection=null;window.__failAnalysisRefresh=false;window.fetch=(input,init)=>{if(window.__failAnalysisRefresh&&String(input).includes('/api/trainings/${manualId}/analyses')){window.__failAnalysisRefresh=false;return Promise.reject(new TypeError('refresh unavailable'))}if(String(input).includes('/api/ai/interpretations/')&&String(input).endsWith('/correct')){window.__correctionCalls++;if(window.__correctionCalls===1)return new Promise((_,reject)=>window.__rejectCorrection=()=>reject(new TypeError('offline')));if(window.__correctionCalls===2)return Promise.resolve(new Response(JSON.stringify({error:'interpretationConflict',errors:['interpretationConflict']}),{status:409,headers:{'content-type':'application/json'}}));}return original(input,init).then(async response=>{if(String(input).includes('/api/ai/interpretations/')&&String(input).endsWith('/correct'))window.__lastMutation=await response.clone().json();return response})}})()`);
    await evaluate("document.querySelector('[data-analysis-correction-save]').click(); true");
    await waitFor('window.__rejectCorrection!==null', 'the held interpretation mutation');
    const duplicateState = await evaluate(`(()=>{document.querySelector('[data-analysis-correction-save]').click();return {disabled:document.querySelector('[data-analysis-correction-save]').disabled,calls:window.__correctionCalls}})()`);
    assert.equal(duplicateState.disabled, true, 'the correction submit is disabled while the write is pending');
    assert.equal(duplicateState.calls, 1, 'a double click sends only one mutation');
    await evaluate('window.__rejectCorrection(); true');
    await waitFor("document.getElementById('analysisCorrectionError').hidden===false", 'the localized network error inside the open correction dialog');
    const networkFailure = await evaluate(`(()=>({open:!document.getElementById('analysisCorrectionDialog').hidden,text:document.getElementById('analysisCorrectionText').value,error:document.getElementById('analysisCorrectionError').textContent}))()`);
    assert.equal(networkFailure.open, true, 'a failed correction does not close the dialog');
    assert.equal(networkFailure.text, 'Synthetic correction confirmed in the browser.', 'typed correction survives a network failure');
    assert.match(networkFailure.error, /Could not save/);
    await evaluate("document.querySelector('[data-analysis-correction-save]').click(); true");
    await waitFor("document.getElementById('analysisCorrectionError').textContent.includes('changed in another action')", 'a localized interpretation version conflict');
    assert.equal(await evaluate("document.getElementById('analysisCorrectionText').value"), 'Synthetic correction confirmed in the browser.');
    await evaluate(`(()=>{window.__failAnalysisRefresh=true;const field=document.getElementById('analysisCorrectionText');field.value='Synthetic correction confirmed in the browser.';document.querySelector('[data-analysis-correction-save]').click();return true})()`);
    await waitFor("document.querySelector('.analysis-interpretation p').textContent==='Synthetic correction confirmed in the browser.'", 'saving the local interpretation correction');
    assert.equal(await evaluate("document.getElementById('analysisCorrectionDialog').hidden"), true, 'the dialog closes after the mutation response confirms success');
    assert.equal(await evaluate("document.activeElement.dataset.interpretationAction?.endsWith(':correct')"), true, 'focus returns to the equivalent control on the updated item');
    await waitFor("document.getElementById('analysisLoadMessage').textContent.includes('Could not load saved analyses')", 'a refresh error distinct from the confirmed correction');
    assert.equal(await evaluate("document.getElementById('analysisLoadWarning').hidden"), false, 'a history refresh problem is shown separately from the still-visible analysis');
    assert.equal(await evaluate("document.querySelector('.analysis-interpretation p').textContent"), 'Synthetic correction confirmed in the browser.', 'the confirmed correction remains visible despite a failed list refresh');
    await command('Page.reload');
    await waitFor("document.querySelector('.analysis-interpretation p').textContent==='Synthetic correction confirmed in the browser.'", 'recovery of the persisted correction after reload');
    await evaluate("document.querySelector('.analysis-interpretation button:last-child').click(); true");
    await waitFor("document.querySelector('.analysis-interpretation h4').textContent==='Dismissed'", 'discarding the corrected interpretation');
    await setLanguage('pt-BR');
    assert.equal(await evaluate("document.querySelector('#analysisSection h2').textContent.includes('Análise')"), true, 'analysis labels rerender in Portuguese');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.getElementById('analysisSection').scrollIntoView({block:'start'}); true");
    await delay(250);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the analysis has no mobile horizontal overflow');
    const mobileShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/issue65-analysis-mobile.png', Buffer.from(mobileShot.data, 'base64'));
    await setLanguage('en-US');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const ownerRead = await app.inject({
      method: 'GET', url: `/api/trainings/${manualId}/analyses`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, account.id).token}` },
    });
    assert.equal(ownerRead.statusCode, 200);
    assert.equal(ownerRead.json().latest.result.summary.text, 'Synthetic analysis arrived while the session stayed open.');
    assert.equal('evidence' in ownerRead.json().latest.result.summary, false, 'ordinary analysis reads omit evidence identifiers');
    for (const userId of [admin.id, otherUser.id]) {
      const foreignRead = await app.inject({
        method: 'GET', url: `/api/trainings/${manualId}/analyses`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, userId).token}` },
      });
      assert.equal(foreignRead.statusCode, 404, 'neither a different user nor an admin can cross ownership');
    }
    assert.equal(generated.hidden, false);
    assert.equal(providerCalls, 1, 'reload recovered the same execution without another provider call');
    assert.ok(
      generationWrites.some(({ method, url }) => method === 'PATCH' && url.endsWith(`/api/trainings/${manualId}`)),
      'feedback persistence precedes analysis generation'
    );
    assert.equal(row(manualId).completed, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workout_analysis_versions WHERE training_id=?').get(manualId).n, 1, 'the applied analysis history is persisted');

    /* ── Memory keeps drafts on mutation failure and separates saved success from refresh ── */

    const latestAnalysisId = db.prepare('SELECT id FROM workout_analysis_versions WHERE training_id=? ORDER BY sequence DESC LIMIT 1').get(manualId).id;
    const memoryItemId = 'browser-memory-interpretation';
    db.prepare(`INSERT INTO ai_interpretations
      (id,user_id,training_id,analysis_id,kind,text,evidence_json,evidence_key,evidence_hash,content_hash,disposition,created_at,updated_at)
      VALUES (?,?,?,?,'pattern','Synthetic memory item','[]','[]','browser-memory-evidence','browser-memory-content','pending','2026-10-26T12:00:00Z','2026-10-26T12:00:00Z')`)
      .run(memoryItemId, account.id, manualId, latestAnalysisId);
    await command('Page.navigate', { url: `${baseUrl}/training-memory.html` });
    await waitFor(`document.querySelector('[data-memory-item="${memoryItemId}"]')`, 'the synthetic interpretation on Training Memory');
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__memoryFetch=original;let fail=true;window.__failMemoryRead=false;window.fetch=(input,init)=>{if(window.__failMemoryRead&&String(input)==='/api/ai/memory'){window.__failMemoryRead=false;return Promise.reject(new TypeError('refresh unavailable'))}if(fail&&String(input).includes('/api/ai/interpretations/${memoryItemId}/correct')){fail=false;return Promise.reject(new TypeError('offline'))}return original(input,init)}})()`);
    await evaluate(`(()=>{const article=document.querySelector('[data-memory-item="${memoryItemId}"]');article.querySelector('summary').click();const field=article.querySelector('textarea');field.value='Memory correction remains editable.';field.dispatchEvent(new Event('input',{bubbles:true}));article.querySelector('[data-memory-action$="save-correction"]').click();return true})()`);
    await waitFor("!document.getElementById('memoryError').classList.contains('hidden')", 'the memory mutation error');
    assert.equal(await evaluate(`document.querySelector('[data-memory-item="${memoryItemId}"] textarea').value`), 'Memory correction remains editable.', 'memory correction remains in the editor after a failed write');
    await evaluate(`(()=>{window.__failMemoryRead=true;const save=document.querySelector('[data-memory-item="${memoryItemId}"] [data-memory-action$="save-correction"]');save.focus();save.click();return true})()`);
    await waitFor(`document.querySelector('[data-memory-item="${memoryItemId}"]').textContent.includes('Corrected')`, 'the saved correction in Training Memory');
    await waitFor("document.getElementById('memoryError').textContent.includes('decision was saved')", 'the memory refresh warning that preserves confirmed success');
    assert.equal(await evaluate("document.activeElement.dataset.memoryAction"), `${memoryItemId}:save-correction`, 'the successful memory rerender restores the equivalent correction control');
    await evaluate("document.getElementById('reloadMemory').click(); true");
    await waitFor("document.getElementById('memoryError').classList.contains('hidden')", 'the free memory refresh');

    /* ── A FIT upload waits for the same reported effort ── */

    await openSession(fitId);
    await waitFor("!!document.getElementById('fitFile')", 'the upload control');
    await clickUntilFile('#fitFile', fitFile, "document.getElementById('feedbackRpeError').hidden===false", 'the upload refusal');
    const refusedUpload = await evaluate(`(()=>({
      files:document.getElementById('fitFile').files.length,
      dropzone:document.getElementById('fitDropzone').textContent.includes('morning-run.fit'),
      errorText:document.getElementById('feedbackRpeError').textContent,
      active:document.activeElement.id,
      status:document.getElementById('status').textContent,
    }))()`);
    assert.equal(refusedUpload.files, 0, 'a refused upload keeps no pending file');
    assert.equal(refusedUpload.dropzone, false, 'the dropzone returns to its invitation');
    assert.equal(refusedUpload.errorText, EN_REQUIRED);
    assert.equal(refusedUpload.active, 'rpe-1');
    assert.equal(refusedUpload.status, EN_REQUIRED);
    assert.deepEqual(writes(), [], 'the FIT endpoint was never called');
    assert.deepEqual(row(fitId), {
      feedback_rpe: null,
      feedback_notas: null,
      completed: 0,
      result_data_source: 'none',
      fit_distance: null,
    });

    await evaluate("document.getElementById('rpe-4').click(); true");
    await clickUntilFile('#fitFile', fitFile, "document.getElementById('fitDataSection').hidden===false", 'the stored FIT result');
    const upload = writes().find(({ method }) => method === 'POST');
    assert.ok(upload, 'the upload was sent once the effort was reported');
    assert.match(upload.url, new RegExp(`/api/trainings/${fitId}/fit$`));
    assert.deepEqual(row(fitId), {
      feedback_rpe: 4,
      feedback_notas: null,
      completed: 1,
      result_data_source: 'fit_upload',
      fit_distance: 10,
    });
    await clickUntil('#generateBtn', "document.getElementById('analysisContent').textContent.includes('Synthetic analysis arrived')", 'the explicit analysis of the persisted FIT result');
    assert.equal(providerCalls, 2, 'FIT analysis adds exactly one simulated provider call');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workout_analysis_versions WHERE training_id=?').get(fitId).n, 1, 'the FIT analysis version is stored against its owned result');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const desktopTable = await evaluate(`(()=>({
      header:document.querySelector('#fitLapsTable th:nth-child(7)').textContent.replace(/\\u00ad/g,'').replace(/\\s+/g,' ').trim(),
      firstCadence:document.querySelector('#fitLapsBody tr:first-child td:nth-child(7)').textContent.trim(),
      missingCadence:document.querySelector('#fitLapsBody tr:nth-child(2) td:nth-child(7)').textContent.trim(),
      firstAscent:document.querySelector('#fitLapsBody tr:first-child td:nth-child(8)').textContent.trim(),
      missingAscent:document.querySelector('#fitLapsBody tr:nth-child(2) td:nth-child(8)').textContent.trim(),
      tableVisible:getComputedStyle(document.querySelector('#fitLapsTable')).display !== 'none',
      tableRows:document.querySelectorAll('#fitLapsBody tr').length,
      paceLines:document.querySelectorAll('#fitLapsBody tr:first-child .fit-lap-pace > span').length,
      paceValue:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace-value').textContent,
      paceUnit:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace-unit').textContent,
      pageOverflow:document.documentElement.scrollWidth>window.innerWidth,
      cardRect:(()=>{const r=document.getElementById('fitDataSection').closest('.card').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
      titleRect:(()=>{const r=document.querySelector('#fitLapsSection .fit-data-title').getBoundingClientRect(); return {left:r.left,right:r.right,bottom:r.bottom}})(),
      tableRect:(()=>{const r=document.getElementById('fitLapsTable').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})(),
    }))()`);
    const { cardRect, titleRect, tableRect, ...desktopValues } = desktopTable;
    assert.deepEqual(desktopValues, {
      header: 'Cadence (spm)', firstCadence: '220', missingCadence: '-',
      firstAscent: '120', missingAscent: '-', tableVisible: true, tableRows: 12,
      paceLines: 2, paceValue: '5:00', paceUnit: 'min/km',
      pageOverflow: false,
    });
    assert.ok(titleRect.left > cardRect.left, 'lap title stays inside the card padding');
    assert.ok(titleRect.right < cardRect.right, 'lap title stays inside the card padding');
    assert.ok(tableRect.left > cardRect.left, 'lap table stays inside the card padding');
    assert.ok(tableRect.right < cardRect.right, 'lap table stays inside the card padding');
    assert.ok(tableRect.top > titleRect.bottom, 'lap table is separated from its title');
    await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
    await delay(80);
    const desktopScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync('/tmp/kinesis-laps-en-1280.png', Buffer.from(desktopScreenshot.data, 'base64'));
    for (const sidebarState of ['collapsed', 'open']) {
      await evaluate("document.getElementById('sidebarToggle').click(); true");
      await delay(80);
      const sidebarLayout = await evaluate(`({
        collapsed:document.querySelector('.app-shell').classList.contains('collapsed'),
        pageOverflow:document.documentElement.scrollWidth>window.innerWidth,
        sectionOverflow:document.querySelector('.fit-laps-section').scrollWidth>document.querySelector('.fit-laps-section').clientWidth,
        tableVisible:getComputedStyle(document.querySelector('#fitLapsTable')).display !== 'none',
      })`);
      assert.equal(sidebarLayout.collapsed, sidebarState === 'collapsed');
      assert.equal(sidebarLayout.pageOverflow, false, `page remains contained with sidebar ${sidebarState}`);
      assert.equal(sidebarLayout.sectionOverflow, false, `section remains contained with sidebar ${sidebarState}`);
      assert.equal(sidebarLayout.tableVisible, true, `table remains visible with sidebar ${sidebarState}`);
    }
    await evaluate("document.querySelector('.app-shell').classList.contains('collapsed') ? true : document.getElementById('sidebarToggle').click(); true");
    for (const width of [360, 390, 560, 600, 640, 768]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await delay(350);
      const compact = await evaluate(`(()=>({
        tableVisible:getComputedStyle(document.querySelector('#fitLapsTable')).display !== 'none',
        tableRows:document.querySelectorAll('#fitLapsBody tr').length,
        firstRowText:document.querySelector('#fitLapsBody tr:first-child').textContent,
        paceValue:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace-value').textContent,
        paceUnit:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace-unit').textContent,
        headerFontSize:parseFloat(getComputedStyle(document.querySelector('#fitLapsTable th')).fontSize),
        lastLapNumber:document.querySelector('#fitLapsBody tr:last-child td:first-child').textContent,
        sectionOverflow:document.querySelector('.fit-laps-section').scrollWidth>document.querySelector('.fit-laps-section').clientWidth,
        pageOverflow:document.documentElement.scrollWidth>window.innerWidth,
        cardRect:(()=>{const r=document.getElementById('fitDataSection').closest('.card').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
        tableRect:(()=>{const r=document.getElementById('fitLapsTable').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
        overflowing:[...document.querySelectorAll('#fitLapsTable th,#fitLapsTable td')].map(e=>({tag:e.tagName,text:e.textContent.trim(),width:e.clientWidth,scroll:e.scrollWidth,rect:[e.getBoundingClientRect().left,e.getBoundingClientRect().right]})).filter(e=>e.scroll>e.width),
      }))()`);
      assert.equal(compact.tableVisible, true, `table remains visible at ${width}px`);
      assert.equal(compact.tableRows, 12, `all laps remain visible at ${width}px`);
      assert.match(compact.firstRowText, /220/);
      assert.match(await evaluate("document.querySelector('#fitLapsBody').textContent"), /-/);
      assert.equal(compact.paceValue, '5:00');
      assert.equal(compact.paceUnit, 'min/km');
      assert.ok(compact.headerFontSize >= 11, `headers retain the project reading scale at ${width}px`);
      assert.equal(compact.lastLapNumber, '12');
      assert.equal(compact.sectionOverflow, false, `section has no horizontal overflow at ${width}px: ${JSON.stringify(compact)}`);
      assert.equal(compact.pageOverflow, false, `page has no horizontal overflow at ${width}px: ${JSON.stringify(compact)}`);
      assert.ok(compact.tableRect.left > compact.cardRect.left, `table keeps card padding at ${width}px`);
      assert.ok(compact.tableRect.right < compact.cardRect.right, `table keeps card padding at ${width}px`);
      if ([360, 640].includes(width)) {
        await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
        await delay(80);
        const capture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(`/tmp/kinesis-review-en-${width}.png`, Buffer.from(capture.data, 'base64'));
      }
    }
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(350);
    await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
    await delay(80);
    const englishMobileScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync('/tmp/kinesis-laps-en-390.png', Buffer.from(englishMobileScreenshot.data, 'base64'));
    await setLanguage('pt-BR');
    await evaluate("document.getElementById('userPreferences').click(); true");
    await waitFor("document.getElementById('preferencesModal') && !document.getElementById('preferencesModal').classList.contains('hidden')", 'preferences modal');
    await evaluate("document.querySelector('#preferencesForm [name=distance_unit][value=mi]').click(); document.getElementById('preferencesSubmit').click(); true");
    await waitFor("document.querySelector('#fitLapsBody .fit-lap-pace-unit')?.textContent==='min/mi'", 'mile pace unit');
    const portugueseTable = await evaluate(`({
      cadence:document.querySelector('#fitLapsTable th:nth-child(7)').textContent.replace(/\\u00ad/g,'').replace(/\\s+/g,' ').trim(),
      ascent:document.querySelector('#fitLapsTable th:nth-child(8)').textContent.replace(/\\u00ad/g,'').replace(/\\s+/g,' ').trim(),
      pace:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace').textContent,
      total:document.getElementById('fitElevation').previousElementSibling.textContent.trim(),
    })`);
    assert.equal(portugueseTable.cadence, 'Cadência (ppm)');
    assert.equal(portugueseTable.ascent, 'Subida (m)');
    assert.match(portugueseTable.pace, /min\/mi/);
    assert.equal(portugueseTable.total, 'Ganho de altitude');
    for (const width of [360, 390, 560, 640, 768]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await delay(350);
      const portugueseLayout = await evaluate(`(()=>({
        header:document.querySelector('#fitLapsTable th:nth-child(7)').getAttribute('aria-label'),
        cadence:document.querySelector('#fitLapsBody tr:first-child td:nth-child(7)').textContent,
        paceUnit:document.querySelector('#fitLapsBody tr:first-child .fit-lap-pace-unit').textContent,
        fontSize:parseFloat(getComputedStyle(document.querySelector('#fitLapsTable th')).fontSize),
        sectionOverflow:document.getElementById('fitLapsSection').scrollWidth>document.getElementById('fitLapsSection').clientWidth,
        pageOverflow:document.documentElement.scrollWidth>window.innerWidth,
        rows:document.querySelectorAll('#fitLapsBody tr').length,
        card:(()=>{const r=document.getElementById('fitDataSection').closest('.card').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
        table:(()=>{const r=document.getElementById('fitLapsTable').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
      }))()`);
      assert.equal(portugueseLayout.header, 'Cadência (ppm)');
      assert.equal(portugueseLayout.cadence, '220');
      assert.equal(portugueseLayout.paceUnit, 'min/mi');
      assert.equal(portugueseLayout.rows, 12);
      assert.ok(portugueseLayout.fontSize >= 11);
      assert.equal(portugueseLayout.sectionOverflow, false, `PT table fits at ${width}px`);
      assert.equal(portugueseLayout.pageOverflow, false, `PT page fits at ${width}px`);
      assert.ok(portugueseLayout.table.left > portugueseLayout.card.left);
      assert.ok(portugueseLayout.table.right < portugueseLayout.card.right);
      if ([360, 640].includes(width)) {
        await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
        await delay(80);
        const capture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(`/tmp/kinesis-review-pt-${width}.png`, Buffer.from(capture.data, 'base64'));
      }
    }
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(350);
    for (const state of ['open', 'collapsed']) {
      await evaluate("document.getElementById('sidebarToggle').click(); true");
      await delay(350);
      const desktopPortuguese = await evaluate(`(()=>({
        collapsed:document.querySelector('.app-shell').classList.contains('collapsed'),
        pageOverflow:document.documentElement.scrollWidth>window.innerWidth,
        sectionOverflow:document.getElementById('fitLapsSection').scrollWidth>document.getElementById('fitLapsSection').clientWidth,
        cadence:document.querySelector('#fitLapsTable th:nth-child(7)').getAttribute('aria-label'),
        card:(()=>{const r=document.getElementById('fitDataSection').closest('.card').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
        table:(()=>{const r=document.getElementById('fitLapsTable').getBoundingClientRect(); return {left:r.left,right:r.right}})(),
      }))()`);
      assert.equal(desktopPortuguese.collapsed, state === 'collapsed');
      assert.equal(desktopPortuguese.pageOverflow, false);
      assert.equal(desktopPortuguese.sectionOverflow, false);
      assert.equal(desktopPortuguese.cadence, 'Cadência (ppm)');
      assert.ok(desktopPortuguese.table.left > desktopPortuguese.card.left);
      assert.ok(desktopPortuguese.table.right < desktopPortuguese.card.right);
    }
    await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
    await delay(80);
    const portugueseDesktopScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync('/tmp/kinesis-laps-pt-1280.png', Buffer.from(portugueseDesktopScreenshot.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(350);
    await evaluate("document.getElementById('fitLapsSection').scrollIntoView({block:'center'}); true");
    await delay(80);
    const mobileScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync('/tmp/kinesis-laps-pt-390.png', Buffer.from(mobileScreenshot.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await setLanguage('en-US');

    /* ── A legacy concluded session reads and is completed once ── */

    await openSession(legacyId);
    await waitFor(
      "document.getElementById('fitDataSection').hidden===false",
      'the legacy recorded result'
    );
    const legacy = await evaluate(`(()=>({
      checked:document.querySelector('#feedbackRpe input:checked')?.value??null,
      distance:document.getElementById('fitDistance').textContent,
      duration:document.getElementById('fitDuration').textContent,
      dataHidden:document.getElementById('fitDataSection').hidden,
    }))()`);
    assert.equal(legacy.checked, null, 'a legacy session has no effort to offer');
    assert.equal(legacy.dataHidden, false, 'its recorded result is still readable');
    assert.equal(legacy.distance, '6.21 mi', 'the recorded distance is displayed in the shared unit format');
    assert.equal(legacy.duration, '01:00:00');

    await clickUntil('#saveBtn', "document.getElementById('feedbackRpeError').hidden===false", 'the legacy refusal');
    assert.deepEqual(writes(), [], 'the legacy session is not rewritten without the effort');
    assert.equal(row(legacyId).feedback_rpe, null);

    await evaluate("document.getElementById('rpe-5').click(); true");
    await clickUntil('#saveBtn', "location.pathname!=='/training-result.html'", 'the navigation after completing a legacy session');
    assert.equal(row(legacyId).feedback_rpe, 5, 'the effort is recorded without touching the result');
    assert.equal(row(legacyId).result_data_source, 'fit_upload');
    assert.equal(row(legacyId).fit_distance, 10);

    /* ── Admin prompt access stays free and owner-scoped ── */

    const adminTrainingId = seedTraining(admin.id, { completed: 1, feedback_rpe: 3 });
    db.prepare("UPDATE trainings SET result_data_source='manual',fit_distance=5,fit_duration='30:00',fit_avg_pace='6:00' WHERE id=?").run(adminTrainingId);
    await command('Network.setCookie', {
      name: SESSION_COOKIE_NAME, value: createSession(db, admin.id).token, url: origin,
    });
    await openSession(adminTrainingId);
    await waitFor("[...document.querySelectorAll('button')].some((button)=>button.textContent.includes('View external prompt'))", 'the admin-only prompt action');
    await setLanguage('pt-BR');
    assert.deepEqual(
      await evaluate(`(()=>({prompt:document.querySelector('[data-analysis-external-prompt=true] span').textContent,analyze:document.querySelector('#generateBtn span').textContent}))()`),
      { prompt: 'Ver prompt externo', analyze: 'Analisar treino' },
      'admin actions retain localized product labels in Portuguese'
    );
    await waitFor("document.querySelectorAll('.form-actions button svg').length===2", 'the Lucide icons in the action footer');
    await evaluate(`(()=>{
      document.getElementById('rpe-4').click();
      const notes=document.getElementById('feedbackNotas');
      notes.value='Saved before external prompt preview.';
      notes.dispatchEvent(new Event('input',{bubbles:true}));
      const buttons=[...document.querySelectorAll('.form-actions button')];
      window.__actionButtonHeights=buttons.map(button=>Math.round(button.getBoundingClientRect().height));
      window.__actionButtonRects=buttons.map(button=>{const rect=button.getBoundingClientRect();return {x:Math.round(rect.x),y:Math.round(rect.y),right:Math.round(rect.right)}});
      const footer=document.querySelector('.form-actions').getBoundingClientRect();
      window.__actionFooterRect={left:Math.round(footer.left),right:Math.round(footer.right)};
      window.__actionContainerWidth=document.querySelector('.feedback-card').clientWidth;
      return true;
    })()`);
    await evaluate("document.querySelector('.form-actions').scrollIntoView({block:'center'}); true");
    await delay(120);
    const actionDesktop = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/kinesis-session-actions-desktop.png', Buffer.from(actionDesktop.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, 'the admin action footer has no horizontal overflow at mobile width');
    await evaluate("document.querySelector('.form-actions').scrollIntoView({block:'center'}); true");
    await delay(100);
    const mobileActionLayout = await evaluate(`(()=>({
      rows:new Set([...document.querySelectorAll('.form-actions button')].map(button=>Math.round(button.getBoundingClientRect().y))).size,
      widths:[...document.querySelectorAll('.form-actions button')].map(button=>Math.round(button.getBoundingClientRect().width)),
      overflow:document.documentElement.scrollWidth>innerWidth,
    }))()`);
    assert.equal(mobileActionLayout.rows, 3, 'mobile actions use an intentional single-column layout');
    assert.equal(new Set(mobileActionLayout.widths).size, 1, 'mobile action buttons share one aligned width');
    const actionMobile = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/kinesis-session-actions-mobile.png', Buffer.from(actionMobile.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await clickUntil("[data-analysis-external-prompt='true']", "!!document.querySelector('.analysis-prompt-card textarea')?.value.includes('Saved before external prompt preview.')", 'the free admin prompt preview after saving feedback');
    assert.equal(row(adminTrainingId).feedback_rpe, 4, 'the external prompt action saves the current RPE first');
    assert.equal(row(adminTrainingId).feedback_notas, 'Saved before external prompt preview.', 'the external prompt action saves current notes first');
    const memoryRead = await app.inject({
      method: 'GET', url: '/api/ai/memory',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, admin.id).token}` },
    });
    assert.equal(memoryRead.statusCode, 200);
    const memory = memoryRead.json();
    const rememberedSession = [...memory.recent, ...memory.comparables]
      .find((item) => item.href.endsWith(`id=${adminTrainingId}`));
    assert.equal(rememberedSession.report.feedback_rpe, 4, 'the training memory reads the newly saved RPE from its canonical row');
    assert.equal(rememberedSession.report.feedback_notas, 'Saved before external prompt preview.', 'the training memory reads the newly saved dated report');
    const promptWriteOrder = writes().map(({ method, url }) => `${method} ${new URL(url).pathname}`);
    assert.deepEqual(promptWriteOrder, [
      `PATCH /api/trainings/${adminTrainingId}`,
      'POST /api/ai/admin/preview',
    ], 'feedback persistence completes before the free prompt preview is requested');
    assert.equal(await evaluate('new Set(window.__actionButtonHeights).size'), 1,
      `all three footer actions use the same button height (observed: ${JSON.stringify(await evaluate('window.__actionButtonHeights'))})`);
    const desktopActionRows = await evaluate('new Set(window.__actionButtonRects.map(rect=>rect.y)).size');
    const actionContainerWidth = await evaluate('window.__actionContainerWidth');
    assert.equal(desktopActionRows, actionContainerWidth <= 620 ? 3 : 1,
      'the desktop action group stays on one row when it fits and stacks deliberately by card width otherwise');
    assert.equal(await evaluate('window.__actionButtonRects.every(rect=>rect.x>=window.__actionFooterRect.left&&rect.right<=window.__actionFooterRect.right)'), true, 'the action group stays inside the footer and card width');
    if (actionContainerWidth > 620)
      assert.equal(await evaluate('window.__actionButtonRects[1].y===window.__actionButtonRects[2].y && window.__actionButtonRects[1].x<window.__actionButtonRects[2].x'), true,
        'the primary analysis action and compact admin prompt stay grouped beside the stable save action');
    const adminPreview = await evaluate(`(()=>({
      role:document.querySelector('[role=dialog][aria-modal=true]')!==null,
      active:document.activeElement.getAttribute('aria-label'),
      prompt:document.querySelector('.analysis-prompt-card textarea')?.value||'',
      copy:document.querySelector('.analysis-prompt-card textarea')?.readOnly,
    }))()`);
    assert.equal(adminPreview.role, true, 'the external prompt opens in the shared accessible modal');
    assert.equal(adminPreview.copy, true);
    assert.ok(adminPreview.prompt.includes('INSTRUÇÕES PARA A ANÁLISE'));
    assert.equal(providerCalls, 2, 'viewing the prompt does not call the provider');
    assert.equal(writes().filter(({ method, url }) => method === 'POST' && url.endsWith('/api/ai/executions')).length, 0);
    await pressKey('Tab', 'Tab', 9);
    await pressKey('Tab', 'Tab', 9);
    await pressKey('Tab', 'Tab', 9);
    assert.equal(await evaluate("document.activeElement.matches('.analysis-dialog-actions button:last-child')"), true, 'Shift+Tab wraps to the last modal action');
    await pressKey('Tab', 'Tab', 9);
    assert.equal(await evaluate("document.activeElement.matches('.analysis-prompt-card header button')"), true, 'Tab wraps to the first modal control');
    await pressShiftTab();
    assert.equal(await evaluate("document.activeElement.matches('.analysis-dialog-actions button:last-child')"), true, 'Shift+Tab wraps to the last modal control');
    await pressKey('Escape', 'Escape', 27);
    await waitFor("document.querySelector('.analysis-prompt-card')?.closest('[role=dialog]').hidden===true", 'the prompt modal closing with Escape');
    assert.equal(await evaluate('document.activeElement===document.querySelector("[data-analysis-external-prompt=true]")'), true, 'focus returns to the prompt trigger');
    await setLanguage('en-US');
    assert.deepEqual(
      await evaluate(`(()=>({prompt:document.querySelector('[data-analysis-external-prompt=true] span').textContent,analyze:document.querySelector('#generateBtn span').textContent}))()`),
      { prompt: 'View external prompt', analyze: 'Analyze workout' },
      'admin actions rerender in English after the Portuguese preview'
    );

    /* ── A lost POST response recovers the same terminal execution, including failure ── */

    await openSession(adminTrainingId);
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__analysisOriginalFetch=original;window.__lostAnalysisPosts=0;window.fetch=(input,init)=>{if(String(input)==='/api/ai/executions'&&init?.method==='POST'){window.__lostAnalysisPosts++;return original(input,init).then(response=>new Promise((_,reject)=>setTimeout(()=>reject(new TypeError('response lost after acceptance')),1400)))}return original(input,init)}})()`);
    invalidNextProviderResponse = true;
    await evaluate("document.getElementById('generateBtn').click(); true");
    await waitFor("document.getElementById('analysisNotice').textContent.includes('did not meet the required response rules')", 'terminal analysis failure recovered after its POST response was lost');
    assert.equal(await evaluate('window.__lostAnalysisPosts'), 1, 'only the explicit generation POST was sent');
    assert.equal(providerCalls, 3, 'the failed terminal execution represents one simulated provider call');
    assert.equal(db.prepare('SELECT state FROM workout_analysis_versions WHERE training_id=?').get(adminTrainingId).state, 'failed');
    await command('Page.reload');
    await waitFor("document.getElementById('analysisNotice').textContent.includes('did not meet the required response rules')", 'the terminal failure after reload');
    assert.equal(providerCalls, 3, 'reload reads the saved failed execution without replaying the provider');
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__analysisOriginalFetch=original;window.__lostAnalysisPosts=0;window.fetch=(input,init)=>{if(String(input)==='/api/ai/executions'&&init?.method==='POST'){window.__lostAnalysisPosts++;return original(input,init).then(response=>new Promise((_,reject)=>setTimeout(()=>reject(new TypeError('response lost after acceptance')),1400)))}return original(input,init)}})()`);
    await evaluate("document.getElementById('generateBtn').click(); true");
    await waitFor("document.getElementById('analysisContent').textContent.includes('Synthetic analysis arrived while the session stayed open.')", 'a successful terminal execution after an explicit new request');
    assert.equal(await evaluate('window.__lostAnalysisPosts'), 1, 'the second explicit run sends one POST');
    assert.equal(providerCalls, 4, 'the second explicit action invokes one additional simulated provider call');
    await command('Page.reload');
    await waitFor("document.getElementById('analysisContent').textContent.includes('Synthetic analysis arrived while the session stayed open.')", 'the successful terminal result after reload');
    assert.equal(providerCalls, 4, 'successful reload recovery is read-only');
  } finally {
    try {
      socket?.close();
    } catch {}
    chromeProcess.kill();
    await app.close();
    db.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(uploads, { recursive: true, force: true });
  }
});
