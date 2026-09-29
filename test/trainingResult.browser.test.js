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
    laps: [],
  };
}

test('the session page requires a realized RPE before saving, generating or uploading', async () => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for the session browser verification.');

  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    parseFitFile: async () => fitSummary(),
  });
  const account = await registerUser(db, {
    email: 'rpe-runner@example.test',
    password: PASSWORD,
    first_name: 'Rita',
    last_name: 'Rpe',
  });
  const seedTraining = (overrides = {}) => {
    const result = db.prepare(
      `INSERT INTO trainings (user_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes, feedback_rpe, feedback_notas, completed)
       VALUES (?, '2026-08-24', 'Manhã', 'Corrida', '6 × 1 km forte', 'Aquecer 15 min', '150-160 bpm', '4', 'Nimbus 26', NULL, NULL, ?, NULL, ?)`
    ).run(account.id, overrides.feedback_rpe ?? null, overrides.completed ?? 0);
    return Number(result.lastInsertRowid);
  };
  const manualId = seedTraining();
  const fitId = seedTraining();
  const legacyId = seedTraining({ completed: 1 });
  db.prepare(
    "UPDATE trainings SET result_data_source = 'fit_upload', fit_duration = '01:00:00', fit_distance = 10, fit_summary_json = '{}' WHERE id = ?"
  ).run(legacyId);
  const row = (id) => db.prepare(
    'SELECT feedback_rpe, feedback_notas, completed, result_data_source, fit_distance FROM trainings WHERE id = ?'
  ).get(id);

  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = new URL(baseUrl).origin;
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
      await setLanguage('en-US');
      await waitFor(
        "document.getElementById('sessionDate').textContent.trim() !== '-'",
        `session ${trainingId} loaded`
      );
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
    await clickUntil('#generateBtn', "document.getElementById('promptSection').hidden===true", 'the refused prompt');
    const refusedPrompt = await evaluate(`(()=>({
      errorText:document.getElementById('feedbackRpeError').textContent,
      promptHidden:document.getElementById('promptSection').hidden,
      prompt:document.getElementById('promptOutput').value,
    }))()`);
    assert.equal(refusedPrompt.errorText, PT_REQUIRED, 'the prompt action reports the same requirement');
    assert.equal(refusedPrompt.promptHidden, true, 'no prompt is produced for an unreported effort');
    assert.equal(refusedPrompt.prompt, '');
    assert.deepEqual(writes(), [], 'generating a prompt wrote nothing');
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

    /* ── The prompt describes the same realized effort ── */

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

    await clickUntil('#generateBtn', "document.getElementById('promptSection').hidden===false", 'the generated prompt');
    const generated = await evaluate(`(()=>({
      prompt:document.getElementById('promptOutput').value,
      unresolved:document.getElementById('promptOutput').value.includes('{{'),
    }))()`);
    assert.ok(generated.prompt.length > 0);
    assert.equal(generated.unresolved, false);
    assert.ok(
      writes().some(({ method, url }) => method === 'PATCH' && url.endsWith(`/api/trainings/${manualId}`)),
      'the prompt is generated from the persisted session'
    );
    assert.equal(row(manualId).completed, 1);

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
    assert.equal(legacy.distance, '10.00 km', 'the recorded distance is displayed in the shared unit format');
    assert.equal(legacy.duration, '01:00:00');

    await clickUntil('#saveBtn', "document.getElementById('feedbackRpeError').hidden===false", 'the legacy refusal');
    assert.deepEqual(writes(), [], 'the legacy session is not rewritten without the effort');
    assert.equal(row(legacyId).feedback_rpe, null);

    await evaluate("document.getElementById('rpe-5').click(); true");
    await clickUntil('#saveBtn', "location.pathname!=='/training-result.html'", 'the navigation after completing a legacy session');
    assert.equal(row(legacyId).feedback_rpe, 5, 'the effort is recorded without touching the result');
    assert.equal(row(legacyId).result_data_source, 'fit_upload');
    assert.equal(row(legacyId).fit_distance, 10);
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
