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
const { readAiConfig } = require('../src/ai/config');
const { materializePrescription } = require('../src/ai/weekly-workouts');

function findChrome() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((file) => existsSync(file));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function addIsoDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

test('authenticated AI Coach availability works in PT/EN on desktop/mobile with keyboard controls', async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for AI Coach browser verification.');
  const db = createDatabase({ filename: ':memory:' });
  const expectedSessionNotes =
    '<img src=x onerror="alert(1)">\nSessão sem pressa · café ☕\n' +
    'Observação contextual longa. '.repeat(30);
  const makeSession = (date, weekday) => {
    const simple = [
      { phase: 'warmup', repetitions: 1, minutes: 5, distanceMeters: null, instruction: 'Run gently and loosen up.', effort: 'Conversational breathing.', rpe: 1, targetHr: '', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: null, recoveryGuidance: null, recoveryRpe: null },
      { phase: 'main', repetitions: 1, minutes: 35, distanceMeters: null, instruction: 'Run continuously with relaxed form.', effort: 'Comfortable effort; speak in full sentences.', rpe: weekday === 'friday' ? null : 2, targetHr: '', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: null, recoveryGuidance: null, recoveryRpe: null },
      { phase: 'cooldown', repetitions: 1, minutes: 5, distanceMeters: null, instruction: 'Ease down gradually.', effort: 'Very easy breathing.', rpe: 1, targetHr: '', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: null, recoveryGuidance: null, recoveryRpe: null },
    ];
    const intervals = [
      { phase: 'warmup', repetitions: 1, minutes: 8, distanceMeters: null, instruction: 'Start with easy jogging and relaxed strides.', effort: 'Conversational breathing.', rpe: 1, targetHr: '115–125 bpm', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: null, recoveryGuidance: null, recoveryRpe: null },
      { phase: 'main', repetitions: 4, minutes: 3, distanceMeters: null, instruction: 'Run each surge strong and controlled.', effort: 'Firm effort with short phrases.', rpe: 3, targetHr: '145–155 bpm', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: 2, recoveryGuidance: 'Jog until breathing settles.', recoveryRpe: 2 },
      { phase: 'main', repetitions: 2, minutes: 4, distanceMeters: null, instruction: 'Lift the effort smoothly and hold form.', effort: 'Hard but controlled; no sprinting.', rpe: 4, targetHr: '155–165 bpm', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: 2, recoveryGuidance: 'Float easily before the next block.', recoveryRpe: 2 },
      { phase: 'cooldown', repetitions: 1, minutes: 7, distanceMeters: null, instruction: 'Ease down with relaxed steps.', effort: 'Very easy breathing.', rpe: 1, targetHr: '120–130 bpm', paceTargetSecondsPerKm: null, paceSecondsPerKm: null, recoveryMinutes: null, recoveryGuidance: null, recoveryRpe: null },
    ];
    return {
      date,
      weekday,
      period: '12_14',
      sessionKind: weekday === 'wednesday' ? 'intervals' : 'easy',
      prescription: weekday === 'wednesday' ? intervals : simple,
      shoeId: 'ui-shoe',
      location: 'São João da Madeira, Porto, Portugal',
      weather: 'Use verified Kinesis forecast',
      notes: expectedSessionNotes,
      justification: weekday === 'wednesday'
        ? `This progression responds to the dated history and feedback. ${'Context reviewed. '.repeat(18)}`
        : 'This follows the saved context and recorded training.',
      evidence: [`weather:${weekday}:${date}`],
    };
  };
  let proposalWeekStart = null;
  let simulatedProviderCalls = 0;
  const app = await buildServer({
    db,
    sessionCookieSecure: false,
    aiConfig: readAiConfig({
      AI_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic-browser-key',
      AI_RETRIES: '0',
    }),
    weatherFetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'geocoding-api.open-meteo.com') {
        const location = parsed.searchParams.get('name').split(',')[0];
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: location,
                latitude: 41.1,
                longitude: -8.6,
                country_code: 'PT',
                timezone: 'Europe/Lisbon',
                country: 'Portugal',
                admin1: 'Porto',
              },
            ],
          }),
        };
      }
      const day = parsed.searchParams.get('start_date');
      const forecastWeekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (forecastWeekday === 5) {
        return {
          ok: false,
          status: 503,
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: async () => ({}),
        };
      }
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Lisbon',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      });
      const time = [],
        temperatures = [],
        codes = [];
      const from = Date.parse(`${day}T00:00:00Z`) - 36 * 3600000;
      for (let instant = from; instant <= from + 96 * 3600000; instant += 3600000) {
        const parts = Object.fromEntries(
          formatter
            .formatToParts(new Date(instant))
            .map((part) => [part.type, part.value]),
        );
        if (`${parts.year}-${parts.month}-${parts.day}` !== day) continue;
        if (forecastWeekday === 3 && parts.hour === '13') continue;
        time.push(instant / 1000);
        temperatures.push(12 + Number(parts.hour));
        codes.push(parts.hour === '13' ? 61 : 2);
      }
      return {
        ok: true,
        json: async () => ({
          timezone: 'Europe/Lisbon',
          hourly: {
            time,
            temperature_2m: temperatures,
            weather_code: codes,
          },
        }),
      };
    },
    aiClient: async (payload) => {
      simulatedProviderCalls++;
      if (simulatedProviderCalls === 1) await delay(38_000);
      const context = JSON.parse(payload.input[0].content[0].text).context;
      if (simulatedProviderCalls === 2)
        return {
          value: null,
          usage: { input: 10, output: 2, cached: 0 },
          error: 'providerRejected',
        };
      proposalWeekStart = context.resource.weekStart;
      const sessions = [
        makeSession(proposalWeekStart, 'monday'),
        makeSession(addIsoDays(proposalWeekStart, 2), 'wednesday'),
        makeSession(addIsoDays(proposalWeekStart, 4), 'friday'),
      ];
      if (simulatedProviderCalls >= 3)
        sessions[0].justification = 'Current simulated request marker.';
      const value = {
        schemaVersion: 'weekly-workouts-v3',
        weekStart: proposalWeekStart,
        sessions,
      };
      return {
        value,
        usage: { input: 10, output: 10, cached: 0 },
        error: null,
      };
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'availability-browser@example.test',
      password: 'runner-secret-1',
      first_name: 'Coach',
      last_name: 'Runner',
      preferred_lang: 'pt-BR',
    },
  });
  db.prepare(
    "UPDATE users SET role = 'admin' WHERE email = 'availability-browser@example.test'",
  ).run();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'availability-browser@example.test',
      password: 'runner-secret-1',
    },
  });
  const cookie = []
    .concat(login.headers['set-cookie'] || [])[0]
    .split(';')[0]
    .split('=')[1];
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort();
  const profile = mkdtempSync(
    path.join(tmpdir(), 'kinesis-availability-chrome-'),
  );
  const chromeProcess = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
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
    assert.ok(
      versionResponse?.ok,
      'Chrome DevTools endpoint became available.',
    );
    const targetResponse = await fetch(`${debugUrl}/json/new?about:blank`, {
      method: 'PUT',
    });
    const target = await targetResponse.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const cdpEvents = [];
    const cdpEventWaiters = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        const waiterIndex = cdpEventWaiters.findIndex(
          (waiter) =>
            waiter.method === message.method && waiter.predicate(message),
        );
        if (waiterIndex >= 0)
          cdpEventWaiters.splice(waiterIndex, 1)[0].resolve(message);
        else cdpEvents.push(message);
        return;
      }
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const commandId = ++id;
        const timeout = setTimeout(() => {
          pending.delete(commandId);
          const detail = method === 'Runtime.evaluate'
            ? ` Expression: ${String(params.expression).slice(0, 180)}`
            : '';
          reject(new Error(`Timed out waiting for Chrome DevTools command ${method}.${detail}`));
        }, 70000);
        pending.set(commandId, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id: commandId, method, params }));
      });
    const waitForCdpEvent = (method, predicate = () => true) => {
      const queuedIndex = cdpEvents.findIndex(
        (event) => event.method === method && predicate(event),
      );
      if (queuedIndex >= 0)
        return Promise.resolve(cdpEvents.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { method, predicate, resolve: null, reject };
        const timeout = setTimeout(() => {
          const index = cdpEventWaiters.indexOf(waiter);
          if (index >= 0) {
            cdpEventWaiters.splice(index, 1);
            reject(new Error(`Timed out waiting for ${method}.`));
          }
        }, 15000);
        timeout.unref?.();
        waiter.resolve = (event) => {
          clearTimeout(timeout);
          resolve(event);
        };
        cdpEventWaiters.push(waiter);
      });
    };
    const waitForAvailabilityResponse = (method) =>
      waitForCdpEvent(
        'Fetch.requestPaused',
        (event) =>
          event.params.request.method === method &&
          event.params.request.url.includes('/api/ai-coach/availability'),
      );
    const releaseAvailabilityResponse = (event) =>
      command('Fetch.continueRequest', { requestId: event.params.requestId });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    const waitForText = (selector, expected, timeoutMs = 8000) =>
      evaluate(
        `new Promise((resolve,reject)=>{const end=Date.now()+${timeoutMs};const check=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(element?.textContent.trim()===${JSON.stringify(expected)}){resolve(true);return}if(Date.now()>end){reject(new Error('Timed out waiting for expected text '+JSON.stringify({selector,expected,actual:element?.textContent,visible:element&&!element.hidden})));return}setTimeout(check,30)};check()})`,
      );
    const saveWithDelayedResponse = async (
      editExpression,
      afterSubmitEdit = null,
    ) => {
      const responsePending = waitForAvailabilityResponse('PUT');
      await evaluate(`document.getElementById('saveAvailability').click()`);
      const response = await responsePending;
      const edit = await evaluate(editExpression);
      if (afterSubmitEdit) await afterSubmitEdit();
      await releaseAvailabilityResponse(response);
      const changedText = (await evaluate(
        `document.documentElement.lang.startsWith('en')`,
      ))
        ? 'Availability changed while saving. Save again before generating the proposal.'
        : 'A disponibilidade mudou durante o salvamento. Salve novamente antes de gerar a proposta.';
      await waitForText('#availabilityStatus', changedText);
      return edit;
    };
    const saveCurrentForm = async () => {
      await evaluate(`document.getElementById('saveAvailability').click()`);
      await waitForText('#availabilityStatus', 'Weekly schedule saved.');
    };
    const pressKey = async (key, code, keyCode, modifiers = 0) => {
      await command('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      });
      await command('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      });
    };
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    const origin = new URL(baseUrl).origin;
    const cookieResult = await command('Network.setCookie', {
      name: 'ta_session',
      value: cookie,
      url: origin,
    });
    assert.equal(cookieResult.success, true);
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const initialGet = waitForAvailabilityResponse('GET');
    const loaded = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.navigate', { url: `${baseUrl}/ai-coach.html` });
    await Promise.race([
      loaded,
      delay(15000).then(() => {
        throw new Error('AI Coach page load timed out.');
      }),
    ]);
    const ready = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(document.querySelectorAll('#availabilityGrid .day-row').length===7){resolve(true);return}if(Date.now()>end){reject(new Error('Availability grid did not render'));return}requestAnimationFrame(check)};check()})`,
    );
    assert.equal(ready, true);
    const actionPresentation = await evaluate(
      `(()=>{const primary=document.getElementById('generateBtn'),secondary=document.getElementById('externalPromptBtn');const primaryIcon=primary.querySelector('svg'),secondaryIcon=secondary.querySelector('svg');const primaryStyle=getComputedStyle(primary),secondaryStyle=getComputedStyle(secondary);secondary.hidden=true;const hiddenDisplay=getComputedStyle(secondary).display;secondary.hidden=false;return {language:document.documentElement.lang,secondaryHidden:secondary.hidden,hiddenDisplay,primaryLabel:primary.querySelector('span').textContent.trim(),secondaryLabel:secondary.querySelector('span').textContent.trim(),primaryDisplay:primaryStyle.display,secondaryDisplay:secondaryStyle.display,primaryAlign:primaryStyle.alignItems,secondaryAlign:secondaryStyle.alignItems,secondaryWidth:secondary.getBoundingClientRect().width,secondaryHeight:secondary.getBoundingClientRect().height,secondaryBorderRadius:secondaryStyle.borderRadius,secondaryBackground:secondaryStyle.backgroundColor,primaryIcon:primaryIcon?.getAttribute('data-lucide'),secondaryIcon:secondaryIcon?.getAttribute('data-lucide'),iconsAreSvg:primaryIcon?.tagName==='svg'&&secondaryIcon?.tagName==='svg',iconsDecorative:primaryIcon?.getAttribute('aria-hidden')==='true'&&secondaryIcon?.getAttribute('aria-hidden')==='true',actionOverflow:document.getElementById('promptForm').scrollWidth>document.getElementById('promptForm').clientWidth}})()`,
    );
    assert.deepEqual(actionPresentation, {
      language: 'pt-BR',
      secondaryHidden: false,
      hiddenDisplay: 'none',
      primaryLabel: 'Gerar proposta semanal',
      secondaryLabel: 'Ver prompt externo',
      primaryDisplay: 'flex',
      secondaryDisplay: 'flex',
      primaryAlign: 'center',
      secondaryAlign: 'center',
      secondaryWidth: actionPresentation.secondaryWidth,
      secondaryHeight: actionPresentation.secondaryHeight,
      secondaryBorderRadius: '999px',
      secondaryBackground: 'rgba(0, 0, 0, 0)',
      primaryIcon: 'calendar-plus',
      secondaryIcon: 'sparkles',
      iconsAreSvg: true,
      iconsDecorative: true,
      actionOverflow: false,
    });
    assert.ok(actionPresentation.secondaryWidth > 100);
    assert.ok(actionPresentation.secondaryWidth < 300);
    assert.ok(actionPresentation.secondaryHeight >= 36);
    await evaluate(
      `document.querySelector('.prompt-submit-actions').scrollIntoView({block:'center'})`,
    );
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-actions-desktop-pt.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English action labels did not render'));else requestAnimationFrame(check)};check()})`,
    );
    assert.deepEqual(
      await evaluate(
        `(()=>({generate:document.querySelector('#generateBtn span').textContent.trim(),external:document.querySelector('#externalPromptBtn span').textContent.trim(),primaryIcon:document.querySelector('#generateBtn svg')?.getAttribute('data-lucide'),secondaryIcon:document.querySelector('#externalPromptBtn svg')?.getAttribute('data-lucide'),adminActionPresent:!!document.getElementById('externalPromptBtn')}))()`,
      ),
      {
        generate: 'Generate weekly proposal',
        external: 'View external prompt',
        primaryIcon: 'calendar-plus',
        secondaryIcon: 'sparkles',
        adminActionPresent: true,
      },
    );
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Portuguese action labels did not restore'));else requestAnimationFrame(check)};check()})`,
    );
    const requestWorkoutsIcon = await evaluate(
      `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');const icon=item?.querySelector('svg');const style=icon?getComputedStyle(icon):null;return {active:item?.classList.contains('active'),icon:icon?.getAttribute('data-lucide'),display:style?.display,color:style?.color}})()`,
    );
    assert.deepEqual(requestWorkoutsIcon, {
      active: true,
      icon: 'sport-shoe',
      display: 'block',
      color: 'rgb(76, 110, 81)',
    });
    const portugueseBranding = await evaluate(
      `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');return {language:document.documentElement.lang,title:document.title,heading:document.querySelector('main h1').textContent.trim(),subtitle:document.querySelector('main .ai-coach-subtitle')?.textContent.trim(),label:item.querySelector('.nav-label').textContent.trim(),ariaLabel:item.getAttribute('aria-label'),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}})()`,
    );
    assert.deepEqual(portugueseBranding, {
      language: 'pt-BR',
      title: 'Solicitar Treinos - Kinesis',
      heading: 'Solicitar Treinos',
      subtitle:
        'Organize seus objetivos e sua disponibilidade para preparar uma solicitação de treinos com IA.',
      label: 'Solicitar Treinos',
      ariaLabel: 'Solicitar Treinos',
      scrollWidth: 1280,
      viewportWidth: 1280,
    });
    await evaluate(`document.getElementById('sidebarToggle').click()`);
    const collapsedPortuguese = await evaluate(
      `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');return {collapsed:document.querySelector('.app-shell').classList.contains('collapsed'),ariaLabel:item.getAttribute('aria-label'),labelVisible:getComputedStyle(item.querySelector('.nav-label')).display!=='none'}})()`,
    );
    assert.deepEqual(collapsedPortuguese, {
      collapsed: true,
      ariaLabel: 'Solicitar Treinos',
      labelVisible: false,
    });
    const portugueseGuard = await evaluate(
      `(()=>{const ids=['ai-coach','calendar'];return ids.map(id=>{const item=document.querySelector('[data-nav-id="'+id+'"]');const reason=item.querySelector('.cycle-guard-badge');return {id,label:item.getAttribute('aria-label'),disabled:item.getAttribute('aria-disabled'),reason:reason.textContent.trim(),reasonId:reason.id,describedBy:(item.getAttribute('aria-describedby')||'').split(/\\s+/)}})})()`,
    );
    assert.deepEqual(portugueseGuard, [
      {
        id: 'ai-coach',
        label: 'Solicitar Treinos',
        disabled: 'true',
        reason: 'Nenhum ciclo ativo',
        reasonId: 'cycle-guard-ai-coach-description',
        describedBy: ['cycle-guard-ai-coach-description'],
      },
      {
        id: 'calendar',
        label: 'Treinos',
        disabled: 'true',
        reason: 'Nenhum ciclo ativo',
        reasonId: 'cycle-guard-calendar-description',
        describedBy: ['cycle-guard-calendar-description'],
      },
    ]);
    await evaluate(
      `window.dispatchEvent(new Event('kinesis:cycle-changed'));window.dispatchEvent(new Event('kinesis:cycle-changed'))`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');if(item.getAttribute('aria-describedby')==='cycle-guard-ai-coach-description')resolve(true);else if(Date.now()>end)reject(new Error('Repeated cycle refresh did not preserve the guarded description'));else setTimeout(check,20)};check()})`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-nav-id="ai-coach"]').getAttribute('aria-describedby')`,
      ),
      'cycle-guard-ai-coach-description',
    );
    await evaluate(`document.getElementById('sidebarToggle').click()`);
    await evaluate(
      `window.__setDay=(day,available)=>{const input=document.querySelector('[data-day="'+day+'"] [data-can-train]');if(input.checked!==available){input.click()}else if(input.closest('.day-row').dataset.configured!=='true'){input.dispatchEvent(new Event('change',{bubbles:true}))}}`,
    );
    const pendingInitialGet = await initialGet;
    const pendingProtection = await evaluate(`(()=>{
      window.__prematurePutCount=0;
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PUT'&&String(input).includes('/api/ai-coach/availability'))window.__prematurePutCount+=1;return nativeFetch(input,init)};
      const save=document.getElementById('saveAvailability');
      save.click();
      document.getElementById('promptForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      return { saveDisabled:save.disabled, generateDisabled:document.getElementById('generateBtn').disabled, prompt:document.getElementById('promptOutput').textContent, putCount:window.__prematurePutCount };
    })()`);
    assert.deepEqual(
      pendingProtection,
      { saveDisabled: true, generateDisabled: true, prompt: '', putCount: 0 },
      'pending availability cannot be saved or generated',
    );
    await evaluate(
      `(()=>{const input=document.getElementById('baseLocation');input.value='Lisboa';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );
    await releaseAvailabilityResponse(pendingInitialGet);
    const initialAvailabilityLoaded = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(!document.getElementById('availabilityReview').hidden){resolve(true);return}if(Date.now()>end){reject(new Error('New-user availability review notice did not load'));return}requestAnimationFrame(check)};check()})`,
    );
    assert.equal(initialAvailabilityLoaded, true);
    const newUserState = await evaluate(
      `(()=>({review:!document.getElementById('availabilityReview').hidden,unselected:[...document.querySelectorAll('#availabilityGrid .day-row')].every(row=>!row.querySelector('input[data-can-train]:checked')),locations:[...document.querySelectorAll('[data-location]')].every(input=>input.value==='')}))()`,
    );
    assert.deepEqual(newUserState, {
      review: true,
      unselected: true,
      locations: true,
    });

    const initialDayControls = await evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#availabilityGrid .day-row')];
      const saturday=document.querySelector('[data-day="saturday"]');
      const before=saturday.querySelector('[data-can-train]').checked;
      saturday.querySelector('.day-label').click();
      const afterLabelClick=saturday.querySelector('[data-can-train]').checked;
      const expand=saturday.querySelector('[data-expand]');
      const closedHeader=saturday.querySelector('.day-summary').getBoundingClientRect();
      const closedButton=expand.getBoundingClientRect();
      const closedIcon=expand.querySelector('.day-expand-icon').getBoundingClientRect();
      expand.click();
      const openHeader=saturday.querySelector('.day-summary').getBoundingClientRect();
      const openButton=expand.getBoundingClientRect();
      const openIcon=expand.querySelector('.day-expand-icon').getBoundingClientRect();
      const openStyle=getComputedStyle(expand.querySelector('.day-expand-icon'));
      const expanded={hidden:saturday.querySelector('.day-details').hidden,disabled:[...saturday.querySelectorAll('.day-details input')].every(input=>input.disabled)};
      expand.click();
      return {days:rows.length,expanders:rows.every(row=>row.querySelector('[data-expand]')&&!row.querySelector('[data-expand]').disabled),before,afterLabelClick,expanded,reclosed:saturday.querySelector('.day-details').hidden,chevron:{sameButtonSize:closedButton.width===openButton.width&&closedButton.height===openButton.height,closedIconCentered:Math.abs((closedIcon.left+closedIcon.width/2)-(closedButton.left+closedButton.width/2))<0.5&&Math.abs((closedIcon.top+closedIcon.height/2)-(closedButton.top+closedButton.height/2))<0.5,openIconCentered:Math.abs((openIcon.left+openIcon.width/2)-(openButton.left+openButton.width/2))<0.5&&Math.abs((openIcon.top+openIcon.height/2)-(openButton.top+openButton.height/2))<0.5,closedButtonCentered:Math.abs((closedButton.top+closedButton.height/2)-(closedHeader.top+closedHeader.height/2))<0.5,openButtonCentered:Math.abs((openButton.top+openButton.height/2)-(openHeader.top+openHeader.height/2))<0.5,transformOrigin:openStyle.transformOrigin}};
    })()`);
    assert.deepEqual(initialDayControls, {
      days: 7,
      expanders: true,
      before: false,
      afterLabelClick: false,
      expanded: { hidden: false, disabled: true },
      reclosed: true,
      chevron: {
        sameButtonSize: true,
        closedIconCentered: true,
        openIconCentered: true,
        closedButtonCentered: true,
        openButtonCentered: true,
        transformOrigin: '8px 8px',
      },
    });

    const firstUseState = await evaluate(`(()=>{
      for(const day of ['monday','wednesday','friday']){
        window.__setDay(day, true);
        const row=document.querySelector('[data-day="'+day+'"]');
        row.querySelector('[data-period="before_08"]').click();
        const duration=row.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));
        const location=row.querySelector('[data-location]');location.value='Lisboa';location.dispatchEvent(new Event('input',{bubbles:true}));
      }
      const selected=['monday','wednesday','friday'].every(day=>document.querySelector('[data-day="'+day+'"] [data-can-train]').checked);
      const untouched=['tuesday','thursday','saturday','sunday'].every(day=>!document.querySelector('[data-day="'+day+'"] [data-can-train]').checked);
      return { selected, untouched, generateEnabled:!document.getElementById('generateBtn').disabled };
    })()`);
    assert.deepEqual(
      firstUseState,
      { selected: true, untouched: true, generateEnabled: true },
      'a new user can select only the days they intend to train',
    );
    const firstSaveResponsePending = waitForAvailabilityResponse('PUT');
    await evaluate(`document.getElementById('saveAvailability').click()`);
    const firstSaveResponse = await firstSaveResponsePending;
    const firstSavePayload = JSON.parse(
      firstSaveResponse.params.request.postData,
    );
    assert.deepEqual(
      firstSavePayload.days.map((day) => ({
        day: day.day,
        can_train: day.can_train,
      })),
      [
        { day: 'monday', can_train: true },
        { day: 'tuesday', can_train: false },
        { day: 'wednesday', can_train: true },
        { day: 'thursday', can_train: false },
        { day: 'friday', can_train: true },
        { day: 'saturday', can_train: false },
        { day: 'sunday', can_train: false },
      ],
      'the first save sends explicit false values for untouched days',
    );
    await releaseAvailabilityResponse(firstSaveResponse);
    await waitForText('#availabilityStatus', 'Agenda semanal salva.');

    const overlongPrefill = await evaluate(`(()=>{
      const base=document.getElementById('baseLocation');
      base.value='L'.repeat(201);base.dispatchEvent(new Event('change',{bubbles:true}));
      const monday=document.querySelector('[data-day="monday"]');
      window.__setDay('monday', true);
      monday.querySelector('[data-period="12_14"]').click();
      const duration=monday.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const location=monday.querySelector('[data-location]');location.value='L'.repeat(201);location.dispatchEvent(new Event('input',{bubbles:true}));
      const nativeFetch=window.fetch.bind(window);window.__locationPutCount=0;
      window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PUT'&&String(input).includes('/api/ai-coach/availability'))window.__locationPutCount+=1;return nativeFetch(input,init)};
      document.getElementById('saveAvailability').click();
      document.getElementById('promptForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      return {valueLength:location.value.length,error:monday.querySelector('[data-day-error]').textContent,invalid:location.getAttribute('aria-invalid'),generateDisabled:document.getElementById('generateBtn').disabled,putCount:window.__locationPutCount,prompt:document.getElementById('promptOutput').textContent};
    })()`);
    assert.deepEqual(overlongPrefill, {
      valueLength: 201,
      error: 'A localização deve ter no máximo 200 caracteres.',
      invalid: 'true',
      generateDisabled: true,
      putCount: 0,
      prompt: '',
    });

    const daySummaryAndErrors = await evaluate(`(()=>{
      const row=document.querySelector('[data-day="monday"]');
      const expand=row.querySelector('[data-expand]');
      if(expand.getAttribute('aria-expanded')==='true') expand.click();
      const summary=row.querySelector('[data-day-summary]');
      const incomplete=row.querySelector('[data-day-incomplete]');
      const collapsed={summaryVisible:summary.getClientRects().length>0,incompleteVisible:incomplete?.getClientRects().length>0,separateLines:incomplete && incomplete.getBoundingClientRect().top>summary.getBoundingClientRect().bottom};
      expand.click();
      const expanded={summaryVisible:summary.getClientRects().length>0,incompleteVisible:incomplete?.getClientRects().length>0};
      const duration=row.querySelector('[data-duration]');
      const location=row.querySelector('[data-location]');
      duration.value='';duration.dispatchEvent(new Event('input',{bubbles:true}));
      location.value='';location.dispatchEvent(new Event('input',{bubbles:true}));
      const emptyLocationSummary=row.querySelector('[data-day-location-summary]');
      const emptyLocationStyle=getComputedStyle(emptyLocationSummary);
      const emptyLocation={hidden:emptyLocationSummary.hidden,display:emptyLocationStyle.display,rects:emptyLocationSummary.getClientRects().length};
      const errors=[...row.querySelectorAll('[data-day-error] > li')].map(item=>item.textContent);
      const errorVisible=!row.querySelector('[data-day-error]').hidden;
      duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));
      location.value='Lisboa';location.dispatchEvent(new Event('input',{bubbles:true}));
      const locationSummary=row.querySelector('[data-day-location-summary]');
      expand.click();
      const locationVisible=locationSummary.getClientRects().length>0 && locationSummary.textContent==='Lisboa';
      expand.click();
      const locationHiddenWhenExpanded=locationSummary.getClientRects().length===0;
      return {collapsed,expanded,errors,errorVisible,emptyLocation,locationVisible,locationHiddenWhenExpanded};
    })()`);
    assert.deepEqual(daySummaryAndErrors, {
      collapsed: {
        summaryVisible: true,
        incompleteVisible: true,
        separateLines: true,
      },
      expanded: { summaryVisible: false, incompleteVisible: true },
      errors: [
        'O tempo disponível deve ser um número inteiro entre 1 e 720 minutos.',
        'Informe a localidade deste dia disponível.',
      ],
      errorVisible: true,
      emptyLocation: { hidden: true, display: 'none', rects: 0 },
      locationVisible: true,
      locationHiddenWhenExpanded: true,
    });

    const exactLimitLocation = await evaluate(`(()=>{
      const monday=document.querySelector('[data-day="monday"]');
      window.__setDay('monday', false);
      const exactTrimmedLimit='  '+'B'.repeat(200)+'  ';
      const base=document.getElementById('baseLocation');base.value=exactTrimmedLimit;base.dispatchEvent(new Event('change',{bubbles:true}));
      window.__setDay('monday', true);
      monday.querySelector('[data-period="12_14"]').click();
      const duration=monday.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const location=monday.querySelector('[data-location]');
      for(const day of ['tuesday','wednesday','thursday','friday','saturday','sunday'])window.__setDay(day, false);
      return {valueLength:location.value.length,trimmedLength:location.value.trim().length,errorHidden:monday.querySelector('[data-day-error]').hidden,invalid:location.getAttribute('aria-invalid'),generateDisabled:document.getElementById('generateBtn').disabled};
    })()`);
    assert.deepEqual(exactLimitLocation, {
      valueLength: 204,
      trimmedLength: 200,
      errorHidden: true,
      invalid: 'false',
      generateDisabled: false,
    });
    await command('Fetch.disable');
    await evaluate(`document.getElementById('saveAvailability').click()`);
    const exactLimitSaveStatus = await evaluate(
      `new Promise(resolve=>{const end=Date.now()+8000;const check=()=>{const status=document.getElementById('availabilityStatus').textContent.trim();if(status||Date.now()>end){resolve(status);return}requestAnimationFrame(check)};check()})`,
    );
    assert.equal(exactLimitSaveStatus, 'Agenda semanal salva.');
    const saveVisualState = await evaluate(
      `(()=>{const button=document.getElementById('saveAvailability');const status=document.getElementById('availabilityStatus');const style=getComputedStyle(button);return {label:document.getElementById('saveAvailabilityLabel').textContent,icon:button.querySelector('[data-lucide="save"]')?.getAttribute('aria-hidden')||button.querySelector('svg')?.getAttribute('aria-hidden'),success:status.classList.contains('is-success'),error:status.classList.contains('is-error'),border:style.borderStyle,borderRadius:style.borderRadius,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}})()`,
    );
    assert.deepEqual(saveVisualState, {
      label: 'Salvar agenda semanal',
      icon: 'true',
      success: true,
      error: false,
      border: 'none',
      borderRadius: '8px',
      scrollWidth: 1280,
      clientWidth: 1280,
    });
    const exactLocationSaved = await app.inject({
      method: 'GET',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
    });
    assert.equal(
      exactLocationSaved.json().availability.days[0].location,
      `  ${'B'.repeat(200)}  `,
    );
    const desktop = await evaluate(
      `(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,language:document.documentElement.lang,reviewVisible:!document.getElementById('availabilityReview').hidden,days:document.querySelectorAll('#availabilityGrid .day-row').length}))()`,
    );
    assert.deepEqual(desktop, {
      width: 1280,
      scrollWidth: 1280,
      language: 'pt-BR',
      reviewVisible: false,
      days: 7,
    });

    const agendaGeometry = await evaluate(`(()=>{
      const row=document.querySelector('[data-day="monday"]');
      if(row.querySelector('.day-details').hidden) row.querySelector('[data-expand]').click();
      const card=row.getBoundingClientRect();
      const periodList=row.querySelector('.period-list');
      const periodItems=[...row.querySelectorAll('.period-option')].map(item=>item.getBoundingClientRect());
      const duration=row.querySelector('[data-duration]').getBoundingClientRect();
      const location=row.querySelector('[data-location]').getBoundingClientRect();
      return {card:{left:card.left,right:card.right},periodItems,periodListWidth:periodList.getBoundingClientRect().width,durationWidth:duration.width,locationWidth:location.width};
    })()`);
    assert.equal(agendaGeometry.periodItems.length, 5);
    assert.ok(
      agendaGeometry.periodItems.every(
        (item) => item.left === agendaGeometry.periodItems[0].left,
      ),
      'periods stay in one compact column',
    );
    assert.ok(
      agendaGeometry.durationWidth <
        agendaGeometry.card.right - agendaGeometry.card.left,
      'duration stays compact',
    );
    assert.ok(
      agendaGeometry.locationWidth <
        agendaGeometry.card.right - agendaGeometry.card.left,
      'location stays content-proportional',
    );

    const computedFormStyles = await evaluate(`(()=>{
      const monday=document.querySelector('[data-day="monday"]');
      const duration=monday.querySelector('[data-duration]');
      const location=monday.querySelector('[data-location]');
      const base=document.getElementById('baseLocation');
      const durationLabel=duration.previousElementSibling;
      const locationLabel=monday.querySelector('[data-location]')?.previousElementSibling;
      const baseLabel=base.previousElementSibling;
      const durationHint=monday.querySelector('[data-duration] + p');
      const baseHint=base.parentElement.querySelector('.field-hint');
      const copy=document.getElementById('applyWeekdays');
      const style=(element)=>{const s=getComputedStyle(element);return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,backgroundColor:s.backgroundColor,border:s.border,borderStyle:s.borderStyle,borderRadius:s.borderRadius,padding:s.padding,margin:s.margin,width:s.width,height:s.height}};
      return {duration:style(duration),location:style(location),base:style(base),durationLabel:style(durationLabel),locationLabel:style(locationLabel),baseLabel:style(baseLabel),durationHint:style(durationHint),baseHint:style(baseHint),copy:style(copy)};
    })()`);
    const availabilityStructure = await evaluate(`(()=>{
      const rows=[...document.querySelectorAll('.day-row')];
      const ids=[...document.querySelectorAll('#availabilityGrid [id]')].map(el=>el.id);
      return {rows:rows.length,uniqueIds:new Set(ids).size===ids.length,fields:rows.every(row=>{
        const duration=row.querySelector('[data-duration]');
        const location=row.querySelector('[data-location]');
        return duration?.id && location?.id && row.querySelector('label[for="'+duration.id+'"]') && row.querySelector('label[for="'+location.id+'"]') && row.querySelector('p.field-hint[id="'+duration.dataset.hintId+'"]');
      })};
    })()`);
    assert.deepEqual(
      availabilityStructure,
      { rows: 7, uniqueIds: true, fields: true },
      'daily fields keep unique labels and hints',
    );
    assert.deepEqual(
      ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'].map(
        (key) => computedFormStyles.duration[key],
      ),
      ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'].map(
        (key) => computedFormStyles.location[key],
      ),
      'duration and location inputs share control typography',
    );
    assert.deepEqual(
      ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'].map(
        (key) => computedFormStyles.location[key],
      ),
      ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'].map(
        (key) => computedFormStyles.base[key],
      ),
      'availability inputs match base location typography',
    );
    assert.deepEqual(
      ['fontFamily', 'fontSize', 'fontWeight', 'color'].map(
        (key) => computedFormStyles.durationLabel[key],
      ),
      ['fontFamily', 'fontSize', 'fontWeight', 'color'].map(
        (key) => computedFormStyles.locationLabel[key],
      ),
      'availability labels share label hierarchy',
    );
    assert.deepEqual(
      ['fontFamily', 'fontSize', 'fontWeight', 'color'].map(
        (key) => computedFormStyles.locationLabel[key],
      ),
      ['fontFamily', 'fontSize', 'fontWeight', 'color'].map(
        (key) => computedFormStyles.baseLabel[key],
      ),
      'availability labels match base location label hierarchy',
    );
    assert.equal(
      computedFormStyles.durationHint.fontWeight,
      computedFormStyles.baseHint.fontWeight,
      'hints stay regular',
    );
    assert.equal(
      computedFormStyles.copy.borderStyle,
      'none',
      'copy action is not input-like',
    );
    assert.equal(
      computedFormStyles.copy.backgroundColor,
      'rgba(0, 0, 0, 0)',
      'copy action is transparent',
    );

    const portugueseDurationField = await evaluate(`(()=>{
      const input=document.querySelector('[data-day="monday"] [data-duration]');
      const saved=input.value;
      input.value='';
      const style=getComputedStyle(input);
      const rect=input.getBoundingClientRect();
      const canvas=document.createElement('canvas');
      const context=canvas.getContext('2d');
      context.font=style.font;
      const textWidth=context.measureText(input.placeholder).width;
      const available=rect.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-32;
      const values=['1','60','720'].map(value=>{input.value=value;return input.value});
      input.value='';
      const state={placeholder:input.placeholder,hint:input.nextElementSibling.textContent,value:input.value,values,width:rect.width,textWidth,available,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
      input.value=saved;
      return state;
    })()`);
    assert.deepEqual(
      {
        placeholder: portugueseDurationField.placeholder,
        hint: portugueseDurationField.hint,
        value: portugueseDurationField.value,
        values: portugueseDurationField.values,
      },
      {
        placeholder: 'Ex.: 60',
        hint: 'De 1 a 720 minutos, incluindo aquecimento e volta à calma.',
        value: '',
        values: ['1', '60', '720'],
      },
    );
    assert.ok(
      portugueseDurationField.width <= 144,
      'duration input remains compact',
    );
    assert.ok(
      portugueseDurationField.textWidth < portugueseDurationField.available,
      'Portuguese placeholder fits the compact input',
    );
    assert.equal(
      portugueseDurationField.scrollWidth,
      portugueseDurationField.clientWidth,
      'Portuguese layout has no horizontal overflow',
    );

    for (const { width, height, mobile } of [
      { width: 1440, height: 900, mobile: false },
      { width: 1024, height: 768, mobile: false },
      { width: 768, height: 1024, mobile: false },
      { width: 641, height: 800, mobile: false },
      { width: 650, height: 800, mobile: false },
      { width: 700, height: 800, mobile: false },
      { width: 800, height: 800, mobile: false },
      { width: 320, height: 700, mobile: true },
    ]) {
      await command('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      await evaluate(
        `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
      );
      const intermediate = await evaluate(`(()=>{
        const row=document.querySelector('[data-day="monday"]');
        const card=row.getBoundingClientRect();
        const header=row.querySelector('.day-summary').getBoundingClientRect();
        const summary=row.querySelector('.day-summary-copy').getBoundingClientRect();
        const expand=row.querySelector('[data-expand]').getBoundingClientRect();
        const details=row.querySelector('.day-details').getBoundingClientRect();
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,inside:header.left>=card.left&&header.right<=card.right&&expand.left>=card.left&&expand.right<=card.right,summaryInside:summary.right<=card.right,detailsInside:details.left>=card.left&&details.right<=card.right};
      })()`);
      assert.equal(
        intermediate.scrollWidth,
        width,
        `no horizontal overflow at ${width}px`,
      );
      assert.equal(
        intermediate.inside,
        true,
        `day header remains inside card at ${width}px`,
      );
      assert.equal(
        intermediate.summaryInside,
        true,
        `day summary remains inside card at ${width}px`,
      );
      assert.equal(
        intermediate.detailsInside,
        true,
        `day details remain inside card at ${width}px`,
      );
    }
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );

    await evaluate(`(()=>{
      const days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      for(const day of days)window.__setDay(day, false);
      for(const day of days){
        window.__setDay(day, true);
        const row=document.querySelector('[data-day="'+day+'"]');
        row.querySelector('[data-period="12_14"]').click();
        row.querySelector('[data-period="after_18"]').click();
        const duration=row.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('change',{bubbles:true}));
        const location=row.querySelector('[data-location]');location.value='Porto';location.dispatchEvent(new Event('input',{bubbles:true}));
      }
      document.getElementById('applyWeekdays').focus();
      return {enabled:!document.getElementById('generateBtn').disabled,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length};
    })()`);
    await pressKey('Tab', 'Tab', 9);
    const tabState = await evaluate(
      `(()=>({tag:document.activeElement.tagName,value:document.activeElement.value,focusVisible:document.activeElement.matches(':focus-visible')}))()`,
    );
    assert.equal(tabState.tag, 'INPUT');
    assert.equal(tabState.focusVisible, true);
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      modifiers: 8,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
    });
    const shiftTabState = await evaluate(`document.activeElement.id`);
    assert.equal(shiftTabState, 'applyWeekdays');
    await pressKey('Enter', 'Enter', 13);
    const applyState = await evaluate(
      `(()=>({enabled:!document.getElementById('generateBtn').disabled,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,focused:document.activeElement.matches(':focus-visible')}))()`,
    );
    assert.deepEqual(applyState, { enabled: true, periods: 1, focused: true });
    await evaluate(
      `document.querySelector('[data-day="monday"] [data-period="before_08"]').focus()`,
    );
    await pressKey(' ', 'Space', 32);
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`,
      ),
      true,
    );
    await pressKey(' ', 'Space', 32);
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`,
      ),
      true,
    );
    await evaluate(
      `document.querySelector('[data-day="monday"] [data-period="08_12"]').click()`,
    );
    assert.deepEqual(
      await evaluate(
        `(()=>({selected:document.querySelector('[data-day="monday"] [data-period="08_12"]').checked,count:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length}))()`,
      ),
      { selected: true, count: 1 },
    );

    const weekdayCopy = await evaluate(`(()=>{
      const monday=document.querySelector('[data-day="monday"]');
      monday.querySelector('[data-period="before_08"]').click();
      document.getElementById('applyWeekdays').click();
      const weekdayRows=['tuesday','wednesday','thursday','friday'].map(day=>document.querySelector('[data-day="'+day+'"]').querySelectorAll('[data-period]:checked').length);
      const weekendUnchanged=['saturday','sunday'].every(day=>document.querySelector('[data-day="'+day+'"]').querySelector('input[data-can-train]').checked);
      const saturday=document.querySelector('[data-day="saturday"]');
      window.__setDay('saturday', false);
      const hidden=saturday.querySelector('.day-details');
      const disabled=[...hidden.querySelectorAll('input,select')].every(control=>control.disabled);
      const tuesday=document.querySelector('[data-day="tuesday"] [data-location]');tuesday.value='Maspalomas, Gran Canaria';tuesday.dispatchEvent(new Event('input',{bubbles:true}));
      const mondayLocation=monday.querySelector('[data-location]').value;
      const button=document.getElementById('saveAvailability');button.click();
      return {weekdayRows,weekendUnchanged,saturdayHidden:hidden.hidden,saturdayFieldsDisabled:disabled,tuesdayLocation:tuesday.value,mondayLocation};
    })()`);
    const copyState = await evaluate(
      `(()=>({weekdayRows:['tuesday','wednesday','thursday','friday'].map(day=>document.querySelector('[data-day="'+day+'"]').querySelectorAll('[data-period]:checked').length),saturdayHidden:document.querySelector('[data-day="saturday"] .day-details').hidden,saturdayDisabled:[...document.querySelectorAll('[data-day="saturday"] .day-details input,[data-day="saturday"] .day-details select')].every(control=>control.disabled),tuesdayLocation:document.querySelector('[data-day="tuesday"] [data-location]').value,mondayLocation:document.querySelector('[data-day="monday"] [data-location]').value}))()`,
    );
    assert.deepEqual(weekdayCopy.weekdayRows, [1, 1, 1, 1]);
    assert.equal(
      weekdayCopy.weekendUnchanged,
      true,
      'applying weekdays leaves Saturday and Sunday untouched',
    );
    assert.deepEqual(copyState, {
      weekdayRows: [1, 1, 1, 1],
      saturdayHidden: true,
      saturdayDisabled: true,
      tuesdayLocation: 'Maspalomas, Gran Canaria',
      mondayLocation: 'Porto',
    });
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.trim())resolve(true);else if(Date.now()>end)reject(new Error('Save status did not appear'));else setTimeout(check,30)};check()})`,
    );
    const persisted = await app.inject({
      method: 'GET',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
    });
    assert.equal(persisted.statusCode, 200);
    assert.equal(persisted.json().availability.days[0].available_minutes, 60);
    assert.equal(
      persisted.json().availability.days[1].location,
      'Maspalomas, Gran Canaria',
    );
    assert.equal(persisted.json().availability.days[5].can_train, false);
    const nonPresetDays = persisted
      .json()
      .availability.days.map((day) => ({ ...day }));
    nonPresetDays[0].available_minutes = 75;
    nonPresetDays[1].available_minutes = 137;
    const apiSave = await app.inject({
      method: 'PUT',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
      payload: { days: nonPresetDays },
    });
    assert.equal(apiSave.statusCode, 200);
    const apiGet = await app.inject({
      method: 'GET',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
    });
    assert.equal(apiGet.json().availability.days[0].available_minutes, 75);
    assert.equal(apiGet.json().availability.days[1].available_minutes, 137);

    const reloaded = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.reload');
    await Promise.race([
      reloaded,
      delay(15000).then(() => {
        throw new Error('AI Coach reload timed out.');
      }),
    ]);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='75'&&tuesday?.value==='137')resolve(true);else if(Date.now()>end)reject(new Error('Saved non-preset durations did not render after reload'));else setTimeout(check,30)};check()})`,
    );
    const renderedDurations = await evaluate(
      `(()=>({monday:document.querySelector('[data-day="monday"] [data-duration]').value,tuesday:document.querySelector('[data-day="tuesday"] [data-duration]').value,valid:!document.getElementById('generateBtn').disabled}))()`,
    );
    assert.deepEqual(renderedDurations, {
      monday: '75',
      tuesday: '137',
      valid: true,
    });
    const portugueseLimit = await evaluate(`(()=>{
      const duration=document.querySelector('[data-day="monday"] [data-duration]');
      const generate=document.getElementById('generateBtn');
      const row=duration.closest('.day-row');
      duration.value='720';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const maxValid=!generate.disabled&&duration.getAttribute('aria-invalid')==='false';
      duration.value='721';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const fieldError=row.querySelector('[data-day-error]');
      const invalid={formValid:!generate.disabled,error:fieldError.textContent,durationInvalid:duration.getAttribute('aria-invalid')};
      window.__availabilityPutCount=0;
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PUT'&&String(input).includes('/api/ai-coach/availability'))window.__availabilityPutCount+=1;return nativeFetch(input,init)};
      document.getElementById('saveAvailability').click();
      document.getElementById('promptForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      duration.value='75';duration.dispatchEvent(new Event('input',{bubbles:true}));
      return {maxValid,invalid,putCount:window.__availabilityPutCount};
    })()`);
    assert.deepEqual(portugueseLimit, {
      maxValid: true,
      invalid: {
        formValid: false,
        error:
          'O tempo disponível deve ser um número inteiro entre 1 e 720 minutos.',
        durationInvalid: 'true',
      },
      putCount: 0,
    });
    await evaluate(`document.getElementById('saveAvailability').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.trim())resolve(true);else if(Date.now()>end)reject(new Error('Round-trip save status did not appear'));else setTimeout(check,30)};check()})`,
    );
    const roundTrip = await app.inject({
      method: 'GET',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
    });
    assert.equal(roundTrip.json().availability.days[0].available_minutes, 75);
    assert.equal(roundTrip.json().availability.days[1].available_minutes, 137);
    assert.equal(
      roundTrip.json().availability.days[1].location,
      'Maspalomas, Gran Canaria',
    );

    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const savedGet = waitForAvailabilityResponse('GET');
    const savedReload = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.reload');
    await Promise.race([
      savedReload,
      delay(15000).then(() => {
        throw new Error('AI Coach reload timed out.');
      }),
    ]);
    const savedGetResponse = await savedGet;
    const existingPendingProtection = await evaluate(`(()=>{
      window.__existingPendingPutCount=0;
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PUT'&&String(input).includes('/api/ai-coach/availability'))window.__existingPendingPutCount+=1;return nativeFetch(input,init)};
      const save=document.getElementById('saveAvailability');
      save.click();
      document.getElementById('promptForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      return { saveDisabled:save.disabled, generateDisabled:document.getElementById('generateBtn').disabled, putCount:window.__existingPendingPutCount };
    })()`);
    assert.deepEqual(
      existingPendingProtection,
      { saveDisabled: true, generateDisabled: true, putCount: 0 },
      'an existing schedule cannot be overwritten while its GET is pending',
    );
    await evaluate(
      `(()=>{const daily=document.querySelector('[data-day="tuesday"] input[data-can-train]');daily.focus();window.__focusedDailyChoice=daily;const input=document.getElementById('baseLocation');input.value='Coimbra';input.dispatchEvent(new Event('change',{bubbles:true}));window.__beforeGetFocus=document.activeElement===daily})()`,
    );
    await releaseAvailabilityResponse(savedGetResponse);
    const savedGetState = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='75'&&tuesday?.value==='137'){resolve({monday:monday.value,tuesday:tuesday.value,review:!document.getElementById('availabilityReview').hidden});return}if(Date.now()>end){reject(new Error('Saved week did not load after base-location edit'));return}requestAnimationFrame(check)};check()})`,
    );
    const savedGetFocus = await evaluate(
      `(()=>{const input=document.querySelector('[data-day="tuesday"] input[data-can-train]');return {before:window.__beforeGetFocus,focused:document.activeElement===input,sameNode:window.__focusedDailyChoice===input}})()`,
    );
    assert.deepEqual(savedGetState, {
      monday: '75',
      tuesday: '137',
      review: false,
    });
    assert.deepEqual(savedGetFocus, {
      before: true,
      focused: true,
      sameNode: false,
    });

    await command('Fetch.disable');
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const failedGet = waitForAvailabilityResponse('GET');
    const failedReload = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.reload');
    await Promise.race([
      failedReload,
      delay(15000).then(() => {
        throw new Error('AI Coach failure reload timed out.');
      }),
    ]);
    const failedGetResponse = await failedGet;
    await command('Fetch.fulfillRequest', {
      requestId: failedGetResponse.params.requestId,
      responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(
        JSON.stringify({ error: 'temporary failure' }),
      ).toString('base64'),
    });
    const failureState = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const error=document.getElementById('availabilityError');if(error.textContent.includes('Não foi possível carregar')){const save=document.getElementById('saveAvailability');window.__failedPutCount=0;const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{if((init?.method||'GET').toUpperCase()==='PUT'&&String(input).includes('/api/ai-coach/availability'))window.__failedPutCount+=1;return nativeFetch(input,init)};save.click();document.getElementById('promptForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));resolve({saveDisabled:save.disabled,generateDisabled:document.getElementById('generateBtn').disabled,retryVisible:!document.getElementById('availabilityRetry').hidden,putCount:window.__failedPutCount,prompt:document.getElementById('promptOutput').textContent});return}if(Date.now()>end)reject(new Error('Availability load error was not rendered'));else requestAnimationFrame(check)};check()})`,
    );
    assert.deepEqual(
      failureState,
      {
        saveDisabled: true,
        generateDisabled: true,
        retryVisible: true,
        putCount: 0,
        prompt: '',
      },
      'a failed availability load keeps both operations blocked',
    );

    const retryGet = waitForAvailabilityResponse('GET');
    const retryEdit = await evaluate(`(()=>{
      const row=document.querySelector('[data-day="monday"]');
      row.querySelector('[data-can-train]').click();
      row.querySelector('[data-period="12_14"]').click();
      const duration=row.querySelector('[data-duration]');duration.value='90';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const location=row.querySelector('[data-location]');location.value='Local edit';location.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('availabilityRetry').click();
      return { location:location.value, duration:duration.value, saveDisabled:document.getElementById('saveAvailability').disabled, generateDisabled:document.getElementById('generateBtn').disabled };
    })()`);
    assert.deepEqual(retryEdit, {
      location: 'Local edit',
      duration: '90',
      saveDisabled: true,
      generateDisabled: true,
    });
    const retryResponse = await retryGet;
    assert.deepEqual(
      await evaluate(
        `(()=>({saveDisabled:document.getElementById('saveAvailability').disabled,generateDisabled:document.getElementById('generateBtn').disabled}))()`,
      ),
      { saveDisabled: true, generateDisabled: true },
    );
    await releaseAvailabilityResponse(retryResponse);
    const recoveredState = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='90'&&document.querySelector('[data-day="monday"] [data-location]')?.value==='Local edit'&&tuesday?.value==='137'){resolve({monday:monday.value,tuesday:tuesday.value,review:!document.getElementById('availabilityReview').hidden,saveDisabled:document.getElementById('saveAvailability').disabled});return}if(Date.now()>end)reject(new Error('Availability retry did not preserve local edits: '+JSON.stringify({monday:monday?.value,mondayLocation:document.querySelector('[data-day="monday"] [data-location]')?.value,tuesday:tuesday?.value,error:document.getElementById('availabilityError').textContent,retryHidden:document.getElementById('availabilityRetry').hidden,saveDisabled:document.getElementById('saveAvailability').disabled})));else requestAnimationFrame(check)};check()})`,
    );
    assert.deepEqual(recoveredState, {
      monday: '90',
      tuesday: '137',
      review: false,
      saveDisabled: false,
    });

    const editedGet = waitForAvailabilityResponse('GET');
    const editedReload = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.reload');
    await Promise.race([
      editedReload,
      delay(15000).then(() => {
        throw new Error('AI Coach reload timed out.');
      }),
    ]);
    const editedGetResponse = await editedGet;
    await evaluate(
      `(()=>{const row=document.querySelector('[data-day="monday"]');const inputToggle=row.querySelector('[data-can-train]');if(!inputToggle.checked)inputToggle.click();row.querySelector('[data-period="12_14"]').click();const input=row.querySelector('[data-duration]');input.value='95';input.dispatchEvent(new Event('input',{bubbles:true}));const location=row.querySelector('[data-location]');location.focus()})()`,
    );
    await command('Input.insertText', { text: 'Aveiro' });
    await evaluate(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.focus();window.__focusedGetDuration=input})()`,
    );
    await pressKey('ArrowUp', 'ArrowUp', 38);
    await releaseAvailabilityResponse(editedGetResponse);
    const mergedGetState = await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='96'&&tuesday?.value==='137'){resolve({monday:monday.value,tuesday:tuesday.value,review:!document.getElementById('availabilityReview').hidden});return}if(Date.now()>end){reject(new Error('Concurrent day edit was not merged with saved availability'));return}requestAnimationFrame(check)};check()})`,
    );
    const mergedGetFocus = await evaluate(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');return {focused:document.activeElement===input,sameNode:window.__focusedGetDuration===input,value:input.value,location:document.querySelector('[data-day="monday"] [data-location]').value}})()`,
    );
    assert.deepEqual(mergedGetState, {
      monday: '96',
      tuesday: '137',
      review: false,
    });
    assert.deepEqual(mergedGetFocus, {
      focused: true,
      sameNode: true,
      value: '96',
      location: 'Aveiro',
    });
    await pressKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-duration]').value`,
      ),
      '97',
      'duration keyboard input continues in the preserved edited row after GET reconciliation',
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-location]').value`,
      ),
      'Aveiro',
    );
    await command('Fetch.disable');
    await evaluate(`document.getElementById('saveAvailability').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.includes('salva'))resolve(true);else if(Date.now()>end)reject(new Error('Merged GET edit did not save'));else requestAnimationFrame(check)};check()})`,
    );

    await evaluate(
      `(()=>{const location=document.querySelector('[data-day="tuesday"] [data-location]');location.focus();location.setSelectionRange(2,7,'forward');document.querySelector('.lang-switch [data-lang="en-US"]').click()})()`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English language switch timed out'));else setTimeout(check,30)};check()})`,
    );
    const englishBranding = await evaluate(
      `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');return {title:document.title,heading:document.querySelector('main h1').textContent.trim(),subtitle:document.querySelector('main .ai-coach-subtitle')?.textContent.trim(),label:item.querySelector('.nav-label').textContent.trim(),ariaLabel:item.getAttribute('aria-label'),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}})()`,
    );
    assert.deepEqual(englishBranding, {
      title: 'Request Workouts - Kinesis',
      heading: 'Request Workouts',
      subtitle:
        'Organize your goals and availability to prepare an AI training request.',
      label: 'Request Workouts',
      ariaLabel: 'Request Workouts',
      scrollWidth: 1280,
      viewportWidth: 1280,
    });
    assert.deepEqual(
      await evaluate(
        `(()=>['ai-coach','calendar'].map(id=>{const item=document.querySelector('[data-nav-id="'+id+'"]');const reason=item.querySelector('.cycle-guard-badge');return {label:item.getAttribute('aria-label'),reason:reason.textContent.trim(),describedBy:(item.getAttribute('aria-describedby')||'').split(/\\s+/)}}))()`,
      ),
      [
        {
          label: 'Request Workouts',
          reason: 'No active cycle',
          describedBy: ['cycle-guard-ai-coach-description'],
        },
        {
          label: 'Workouts',
          reason: 'No active cycle',
          describedBy: ['cycle-guard-calendar-description'],
        },
      ],
    );
    await evaluate(`document.getElementById('sidebarToggle').click()`);
    assert.deepEqual(
      await evaluate(
        `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');return {collapsed:document.querySelector('.app-shell').classList.contains('collapsed'),ariaLabel:item.getAttribute('aria-label'),labelVisible:getComputedStyle(item.querySelector('.nav-label')).display!=='none'}})()`,
      ),
      { collapsed: true, ariaLabel: 'Request Workouts', labelVisible: false },
    );
    await evaluate(`document.getElementById('sidebarToggle').click()`);
    const englishState = await evaluate(
      `(()=>{const duration=document.querySelector('[data-day="monday"] [data-duration]');return {language:document.documentElement.lang,label:document.querySelector('[data-day="monday"] .period-group legend').textContent,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,location:document.querySelector('[data-day="tuesday"] [data-location]').value,durationPlaceholder:duration.placeholder,durationHint:duration.nextElementSibling.textContent,saveLabel:document.getElementById('saveAvailabilityLabel').textContent}})()`,
    );
    assert.deepEqual(englishState, {
      language: 'en-US',
      label: 'Preferred period',
      periods: 1,
      location: 'Maspalomas, Gran Canaria',
      durationPlaceholder: 'e.g. 60',
      durationHint: 'From 1 to 720 minutes, including warm-up and cool-down.',
      saveLabel: 'Save weekly schedule',
    });
    const languageFocus = await evaluate(
      `(()=>{const location=document.querySelector('[data-day="tuesday"] [data-location]');return {focused:document.activeElement===location,start:location.selectionStart,end:location.selectionEnd,direction:location.selectionDirection}})()`,
    );
    assert.equal(languageFocus.focused || languageFocus.start === 0, true);

    const englishLocationLimit = await evaluate(
      `(()=>{const location=document.querySelector('[data-day="monday"] [data-location]');const saved=location.value;location.value='E'.repeat(201);location.dispatchEvent(new Event('input',{bubbles:true}));const row=location.closest('.day-row');const state={error:row.querySelector('[data-day-error]').textContent,invalid:location.getAttribute('aria-invalid'),generateDisabled:document.getElementById('generateBtn').disabled};location.value=saved;location.dispatchEvent(new Event('input',{bubbles:true}));return state})()`,
    );
    assert.deepEqual(englishLocationLimit, {
      error: 'Location must be at most 200 characters.',
      invalid: 'true',
      generateDisabled: true,
    });

    const englishLimit = await evaluate(
      `(()=>{const duration=document.querySelector('[data-day="monday"] [data-duration]');duration.value='721';duration.dispatchEvent(new Event('input',{bubbles:true}));const error=duration.closest('.day-row').querySelector('[data-day-error]').textContent;const disabled=document.getElementById('generateBtn').disabled;duration.value='75';duration.dispatchEvent(new Event('input',{bubbles:true}));return {error,disabled}})()`,
    );
    assert.deepEqual(englishLimit, {
      error: 'Available time must be a whole number between 1 and 720 minutes.',
      disabled: true,
    });

    await evaluate(`document.getElementById('externalPromptBtn').click()`);
    assert.equal(
      simulatedProviderCalls,
      0,
      'viewing the external prompt does not start a provider generation',
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const prompt=document.getElementById('promptOutput').textContent;if(prompt.includes('Maximum session time: 60 minutes')&&prompt.includes('Maspalomas, Gran Canaria'))resolve(true);else if(Date.now()>end)reject(new Error('Structured English prompt did not appear'));else setTimeout(check,40)};check()})`,
    );
    const prompt = await evaluate(
      `document.getElementById('promptOutput').textContent`,
    );
    assert.deepEqual(
      await evaluate(`(()=>({modalOpen:!document.getElementById('externalPromptModal').hidden,oldInlineSection:!!document.getElementById('resultSection'),initialFocus:document.activeElement.id,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))()`),
      { modalOpen: true, oldInlineSection: false, initialFocus: 'externalPromptClose', scrollWidth: 1280, clientWidth: 1280 },
    );
    const desktopPromptActions = await evaluate(`(()=>{const card=document.querySelector('.external-prompt-card'),footer=document.querySelector('.external-prompt-actions'),close=document.getElementById('closePromptBtn'),copy=document.getElementById('copyBtn');return {cardWidth:card.getBoundingClientRect().width,footerRight:footer.getBoundingClientRect().right,lastActionRight:copy.getBoundingClientRect().right,closeWidth:close.getBoundingClientRect().width,copyWidth:copy.getBoundingClientRect().width,closeLabel:close.textContent.trim(),copyLabel:copy.textContent.trim()}})()`);
    assert.ok(desktopPromptActions.cardWidth > 700);
    assert.ok(desktopPromptActions.footerRight - desktopPromptActions.lastActionRight < 2);
    assert.ok(desktopPromptActions.copyWidth < 240);
    assert.equal(desktopPromptActions.closeLabel, 'Close');
    assert.equal(desktopPromptActions.copyLabel, 'Copy prompt');
    await evaluate(`new Promise((resolve)=>setTimeout(resolve,300))`);
    writeFileSync(path.join(tmpdir(), 'kinesis-external-prompt-desktop-en.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('clipboard unavailable')}}});document.getElementById('copyBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+2000;const check=()=>{if(document.getElementById('promptCopyStatus').textContent.includes('Could not copy'))resolve(true);else if(Date.now()>end)reject(new Error('Copy failure was not announced'));else setTimeout(check,20)};check()})`);
    assert.equal(await evaluate(`document.getElementById('promptOutput').textContent`), prompt, 'copy failure preserves the full prompt');
    await evaluate(`(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.__copiedPrompt=text}}});const modal=document.getElementById('externalPromptModal');modal.querySelector('#externalPromptClose').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));})()`);
    assert.equal(await evaluate(`document.activeElement.id`), 'copyBtn');
    await evaluate(`document.getElementById('copyBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+2000;const check=()=>{if(document.getElementById('promptCopyStatus').textContent==='Prompt copied.')resolve(true);else if(Date.now()>end)reject(new Error('Copy success was not announced'));else setTimeout(check,20)};check()})`);
    assert.equal(await evaluate(`window.__copiedPrompt`), prompt, 'copy keeps the full prompt byte-for-byte');
    await evaluate(`document.getElementById('closePromptBtn').click()`);
    assert.equal(await evaluate(`document.getElementById('externalPromptModal').hidden`), true);
    assert.equal(await evaluate(`document.activeElement.id`), 'externalPromptBtn');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Portuguese prompt dialog locale timed out'));else setTimeout(check,20)};check()})`);
    await evaluate(`document.getElementById('externalPromptBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(!document.getElementById('externalPromptModal').hidden)resolve(true);else if(Date.now()>end)reject(new Error('External prompt modal did not reopen'));else setTimeout(check,25)};check()})`);
    const mobilePromptDialog = await evaluate(`(()=>{const card=document.querySelector('.external-prompt-card'),body=document.getElementById('promptOutput'),close=document.getElementById('closePromptBtn'),copy=document.getElementById('copyBtn'),footer=document.querySelector('.external-prompt-actions'),closeRect=close.getBoundingClientRect(),copyRect=copy.getBoundingClientRect();return {language:document.documentElement.lang,title:document.getElementById('externalPromptTitle').textContent,close:close.textContent.trim(),copy:copy.textContent.trim(),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:card.getBoundingClientRect().width,cardHeight:card.getBoundingClientRect().height,viewportHeight:innerHeight,bodyScrollable:body.scrollHeight>body.clientHeight,overflowX:body.scrollWidth>body.clientWidth,buttonsSameRow:Math.abs((closeRect.top+closeRect.height/2)-(copyRect.top+copyRect.height/2))<2,actionsRightAligned:footer.getBoundingClientRect().right-copyRect.right<2}})()`);
    assert.equal(mobilePromptDialog.language, 'pt-BR');
    assert.equal(mobilePromptDialog.title, 'Prompt externo');
    assert.equal(mobilePromptDialog.close, 'Fechar');
    assert.equal(mobilePromptDialog.copy, 'Copiar prompt');
    assert.equal(mobilePromptDialog.width, 390);
    assert.equal(mobilePromptDialog.scrollWidth, 390);
    assert.equal(mobilePromptDialog.cardWidth, 374, 'the external prompt uses the shared modal width');
    assert.ok(mobilePromptDialog.cardHeight <= mobilePromptDialog.viewportHeight - 16);
    assert.equal(mobilePromptDialog.bodyScrollable, true);
    assert.equal(mobilePromptDialog.overflowX, false);
    assert.equal(mobilePromptDialog.buttonsSameRow, true);
    assert.equal(mobilePromptDialog.actionsRightAligned, true);
    await evaluate(`new Promise((resolve)=>setTimeout(resolve,300))`);
    writeFileSync(path.join(tmpdir(), 'kinesis-external-prompt-mobile-pt.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.getElementById('externalPromptClose').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    assert.equal(await evaluate(`document.getElementById('externalPromptModal').hidden`), true);
    assert.equal(await evaluate(`document.activeElement.id`), 'externalPromptBtn');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English prompt dialog locale reset timed out'));else setTimeout(check,20)};check()})`);
    assert.match(prompt, /highest verified temperature in that window/);
    assert.match(
      prompt,
      /Do not ask the user to confirm sources, locations, dates, times, or time zones, or to authorize research/,
    );
    assert.match(prompt, /18:00 ≤ hour < 24:00/);
    assert.match(
      prompt,
      /source time zone, including local-time indications in its header or metadata/,
    );
    assert.match(prompt, /If coverage is partial, state that limitation/);
    assert.match(
      prompt,
      /consult at least one second hourly-forecast source when tools and access are available/,
    );
    assert.match(prompt, /Cite the source, preferably with a direct link/);
    assert.match(
      prompt,
      /Do not invent data or interrupt spreadsheet preparation to ask the user for confirmation/,
    );
    assert.match(
      prompt,
      /\| Date \| Day \| Period \| Type \| Workout \| Details \| Target HR \| RPE \| Shoe \| Location \| Weather Forecast \| Notes \|/,
    );
    assert.match(prompt, /a ceiling, not a target/);
    assert.doesNotMatch(prompt, /Normal routine|Rotina normal/);

    await evaluate(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.value='96';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const durationAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.focus();window.__focusedPutDuration=input;return true})()`,
      async () => pressKey('ArrowUp', 'ArrowUp', 38),
    );
    assert.equal(durationAfterSave, true);
    assert.deepEqual(
      await evaluate(
        `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');return {value:input.value,focused:document.activeElement===input,sameNode:window.__focusedPutDuration===input}})()`,
      ),
      { value: '97', focused: true, sameNode: true },
    );
    await pressKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-duration]').value`,
      ),
      '98',
      'duration keyboard input continues after PUT reconciliation',
    );
    await command('Fetch.disable');
    await saveCurrentForm();
    await evaluate(
      `document.querySelector('.prompt-submit-actions').scrollIntoView({block:'center'})`,
    );
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-actions-desktop-en.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );

    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const periodAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-period="before_08"]');input.click();document.getElementById('optionalContext').focus();return {checked:input.checked,focus:document.activeElement.id}})()`,
    );
    assert.deepEqual(periodAfterSave, {
      checked: true,
      focus: 'optionalContext',
    });
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`,
      ),
      true,
    );
    assert.equal(
      await evaluate(`document.activeElement.id`),
      'optionalContext',
      'PUT reconciliation does not steal focus moved to another control',
    );
    await command('Fetch.disable');
    await saveCurrentForm();

    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const locationAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.focus();window.__focusedPutLocation=input;return true})()`,
      async () => {
        await evaluate(
          `(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.value='';input.focus()})()`,
        );
        await command('Input.insertText', { text: 'Braga' });
        await evaluate(
          `document.querySelector('[data-day="monday"] [data-location]').setSelectionRange(1,4,'backward')`,
        );
      },
    );
    assert.equal(locationAfterSave, true);
    assert.deepEqual(
      await evaluate(
        `(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');return {value:input.value,focused:document.activeElement===input,sameNode:window.__focusedPutLocation===input,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}})()`,
      ),
      {
        value: 'Braga',
        focused: true,
        sameNode: true,
        start: 1,
        end: 4,
        direction: 'backward',
      },
    );
    await command('Input.insertText', { text: 'X' });
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-location]').value`,
      ),
      'BXa',
      'typing replaces the selected text correctly after PUT reconciliation',
    );
    await command('Fetch.disable');
    await saveCurrentForm();

    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const availabilityAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="sunday"] [data-can-train]');input.focus();if(input.checked)input.click();return {no:!input.checked,detailsHidden:document.querySelector('[data-day="sunday"] .day-details').hidden,focused:document.activeElement===input}})()`,
    );
    assert.deepEqual(availabilityAfterSave, {
      no: true,
      detailsHidden: true,
      focused: true,
    });
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="sunday"] [data-can-train]').checked`,
      ),
      false,
    );
    await command('Fetch.disable');
    await saveCurrentForm();

    const promptBeforeGenerateRace = await evaluate(
      `document.getElementById('promptOutput').textContent`,
    );
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const generateResponsePending = waitForAvailabilityResponse('PUT');
    await evaluate(`document.getElementById('generateBtn').click()`);
    const generateResponse = await generateResponsePending;
    await evaluate(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.value='Porto após gerar';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await releaseAvailabilityResponse(generateResponse);
    await waitForText(
      '#availabilityStatus',
      'Availability changed while saving. Save again before generating the proposal.',
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="monday"] [data-location]').value`,
      ),
      'Porto após gerar',
    );
    assert.equal(
      await evaluate(`document.getElementById('promptOutput').textContent`),
      promptBeforeGenerateRace,
      'Generate does not produce a prompt from the stale submitted snapshot',
    );
    await command('Fetch.disable');

    db.prepare(
      `UPDATE ai_coach_availability SET available_periods = ?, available_minutes = ?, location = ? WHERE user_id = 1 AND day_key = 'monday'`,
    ).run(JSON.stringify(['08_12', '14_18']), 75, 'Legacy Porto');
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const legacyGetPending = waitForAvailabilityResponse('GET');
    await command('Page.reload');
    const legacyGet = await legacyGetPending;
    await releaseAvailabilityResponse(legacyGet);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const summary=document.querySelector('[data-day="monday"] [data-legacy-period-summary]');if(summary&&document.documentElement.lang==='en-US'){resolve(true);return}if(Date.now()>end){reject(new Error('Legacy availability summary did not render'));return}requestAnimationFrame(check)};check()})`,
    );
    const legacyEnglish = await evaluate(
      `(()=>{const row=document.querySelector('[data-day="monday"]');return {summary:row.querySelector('[data-legacy-period-summary]').textContent,checked:row.querySelectorAll('[data-period]:checked').length,duration:row.querySelector('[data-duration]').value,location:row.querySelector('[data-location]').value,saveDisabled:document.getElementById('saveAvailability').disabled,generateDisabled:document.getElementById('generateBtn').disabled}})()`,
    );
    assert.deepEqual(legacyEnglish, {
      summary:
        'Previously saved periods08:00–12:00; 14:00–18:00These options were saved previously. Choose one preferred period to replace them.',
      checked: 0,
      duration: '75',
      location: 'Legacy Porto',
      saveDisabled: true,
      generateDisabled: true,
    });
    await evaluate(
      `document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Portuguese legacy summary switch timed out'));else setTimeout(check,30)};check()})`,
    );
    assert.deepEqual(
      await evaluate(
        `(()=>{const row=document.querySelector('[data-day="monday"]');return {summary:row.querySelector('[data-legacy-period-summary]').textContent,checked:row.querySelectorAll('[data-period]:checked').length}})()`,
      ),
      {
        summary:
          'Períodos anteriores salvos08h–12h; 14h–18hEstas opções foram salvas anteriormente. Escolha um único período preferencial para substituí-las.',
        checked: 0,
      },
    );
    await evaluate(
      `document.querySelector('.lang-switch [data-lang="en-US"]').click()`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English legacy summary switch timed out'));else setTimeout(check,30)};check()})`,
    );
    await evaluate(
      `document.querySelector('[data-day="monday"] [data-expand]').click()`,
    );
    await evaluate(
      `document.querySelector('[data-day="monday"] [data-expand]').click()`,
    );
    const legacyAfterRerender = await evaluate(
      `(()=>{const row=document.querySelector('[data-day="monday"]');return {summary:row.querySelector('[data-legacy-period-summary]').textContent,checked:row.querySelectorAll('[data-period]:checked').length,hidden:row.querySelector('.day-details').hidden}})()`,
    );
    assert.equal(legacyAfterRerender.checked, 0);
    assert.match(legacyAfterRerender.summary, /Previously saved periods/);
    assert.equal(legacyAfterRerender.hidden, true);
    const legacyPutPending = waitForAvailabilityResponse('PUT');
    const selectedLegacyPeriod = await evaluate(
      `(()=>{const row=document.querySelector('[data-day="monday"]');row.querySelector('[data-period="12_14"]').click();return {checked:row.querySelectorAll('[data-period]:checked').length,summary:row.querySelector('[data-legacy-period-summary]'),generateDisabled:document.getElementById('generateBtn').disabled}})()`,
    );
    assert.deepEqual(selectedLegacyPeriod, {
      checked: 1,
      summary: null,
      generateDisabled: false,
    });
    await evaluate(`document.getElementById('saveAvailability').click()`);
    const legacyPut = await legacyPutPending;
    const legacyBody = JSON.parse(legacyPut.params.request.postData);
    const mondayPayload = legacyBody.days.find((day) => day.day === 'monday');
    assert.deepEqual(mondayPayload, {
      day: 'monday',
      can_train: true,
      available_periods: ['12_14'],
      available_minutes: 75,
      location: 'Legacy Porto',
    });
    await releaseAvailabilityResponse(legacyPut);
    await waitForText('#availabilityStatus', 'Weekly schedule saved.');
    const persistedLegacy = await app.inject({
      method: 'GET',
      url: '/api/ai-coach/availability',
      headers: { cookie: `ta_session=${cookie}` },
    });
    const persistedMonday = persistedLegacy
      .json()
      .availability.days.find((day) => day.day === 'monday');
    assert.deepEqual(
      {
        periods: persistedMonday.available_periods,
        minutes: persistedMonday.available_minutes,
        location: persistedMonday.location,
        needsReview: persistedLegacy.json().availability.needsReview,
      },
      {
        periods: ['12_14'],
        minutes: 75,
        location: 'Legacy Porto',
        needsReview: false,
      },
    );
    await command('Fetch.disable');

    await command('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Portuguese mobile actions did not render'));else requestAnimationFrame(check)};check()})`,
    );
    await evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))`,
    );
    const mobile = await evaluate(
      `(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,days:document.querySelectorAll('#availabilityGrid .day-row').length,touchTarget:[...document.querySelectorAll('.period-option')].filter(el=>el.getClientRects().length>0).every(el=>el.getBoundingClientRect().height>=42)}))()`,
    );
    assert.deepEqual(mobile, {
      width: 390,
      scrollWidth: 390,
      days: 7,
      touchTarget: true,
    });
    const mobileActions = await evaluate(
      `(()=>{const actions=document.querySelector('.prompt-submit-actions'),primary=document.getElementById('generateBtn'),secondary=document.getElementById('externalPromptBtn');const bounds=actions.getBoundingClientRect(),p=primary.getBoundingClientRect(),s=secondary.getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,containerWidth:bounds.width,primaryWidth:p.width,secondaryWidth:s.width,primaryInside:p.left>=bounds.left&&p.right<=bounds.right,secondaryInside:s.left>=bounds.left&&s.right<=bounds.right,secondaryBelowPrimary:s.top>p.top,primaryIcon:primary.querySelector('svg')?.getAttribute('data-lucide'),secondaryIcon:secondary.querySelector('svg')?.getAttribute('data-lucide')}})()`,
    );
    assert.deepEqual(mobileActions, {
      language: 'pt-BR',
      width: 390,
      scrollWidth: 390,
      containerWidth: mobileActions.containerWidth,
      primaryWidth: mobileActions.primaryWidth,
      secondaryWidth: mobileActions.secondaryWidth,
      primaryInside: true,
      secondaryInside: true,
      secondaryBelowPrimary: true,
      primaryIcon: 'calendar-plus',
      secondaryIcon: 'sparkles',
    });
    assert.ok(mobileActions.primaryWidth < mobileActions.containerWidth);
    assert.ok(mobileActions.secondaryWidth < mobileActions.containerWidth);
    await evaluate(
      `document.querySelector('.prompt-submit-actions').scrollIntoView({block:'center'})`,
    );
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-actions-mobile-pt.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English mobile actions did not render'));else requestAnimationFrame(check)};check()})`,
    );
    assert.deepEqual(
      await evaluate(
        `(()=>({language:document.documentElement.lang,generate:document.querySelector('#generateBtn span').textContent.trim(),external:document.querySelector('#externalPromptBtn span').textContent.trim(),width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))()`,
      ),
      {
        language: 'en-US',
        generate: 'Generate weekly proposal',
        external: 'View external prompt',
        width: 390,
        scrollWidth: 390,
      },
    );
    assert.deepEqual(
      await evaluate(
        `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');return {title:document.title,heading:document.querySelector('main h1').textContent.trim(),label:item.querySelector('.nav-label').textContent.trim(),ariaLabel:item.getAttribute('aria-label'),width:innerWidth,scrollWidth:document.documentElement.scrollWidth}})()`,
      ),
      {
        title: 'Request Workouts - Kinesis',
        heading: 'Request Workouts',
        label: 'Request Workouts',
        ariaLabel: 'Request Workouts',
        width: 390,
        scrollWidth: 390,
      },
    );
    await evaluate(
      `(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');input.value='Mobile';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await command('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' },
      ],
    });
    const mobileLocationAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');input.value='Mobility';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(3,5,'backward');window.__focusedMobileLocation=input;return input.value})()`,
    );
    assert.equal(mobileLocationAfterSave, 'Mobility');
    await evaluate(`new Promise(requestAnimationFrame)`);
    assert.deepEqual(
      await evaluate(
        `(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');return {focused:document.activeElement===input,sameNode:window.__focusedMobileLocation===input,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}})()`,
      ),
      {
        focused: false,
        sameNode: true,
        start: 3,
        end: 5,
        direction: 'backward',
      },
    );
    await command('Input.insertText', { text: 'X' });
    assert.equal(
      await evaluate(
        `document.querySelector('[data-day="tuesday"] [data-location]').value`,
      ),
      'Mobility',
    );
    await command('Fetch.disable');
    await saveCurrentForm();
    const screenshot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    assert.ok(
      screenshot.data.length > 1000,
      'mobile headless rendering produced a screenshot',
    );

    const createdCycle = await app.inject({
      method: 'POST',
      url: '/api/cycles',
      headers: { cookie: `ta_session=${cookie}` },
      payload: { objective: 'Accessibility guard test' },
    });
    assert.equal(createdCycle.statusCode, 201);
    const cycleId = createdCycle.json().cycle.id;
    await evaluate(
      `(()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');item.setAttribute('aria-describedby','unrelated-description');window.dispatchEvent(new Event('kinesis:cycle-changed'))})()`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');if(!item.hasAttribute('aria-disabled'))resolve(true);else if(Date.now()>end)reject(new Error('Cycle activation did not remove navigation guard'));else setTimeout(check,20)};check()})`,
    );
    assert.deepEqual(
      await evaluate(
        `(()=>['ai-coach','calendar'].map(id=>{const item=document.querySelector('[data-nav-id="'+id+'"]');return {id,href:item.getAttribute('href'),disabled:item.hasAttribute('aria-disabled'),description:item.getAttribute('aria-describedby'),badgeHidden:item.querySelector('.cycle-guard-badge').classList.contains('hidden')}}))()`,
      ),
      [
        {
          id: 'ai-coach',
          href: '/ai-coach.html',
          disabled: false,
          description: 'unrelated-description',
          badgeHidden: true,
        },
        {
          id: 'calendar',
          href: '/calendar.html',
          disabled: false,
          description: null,
          badgeHidden: true,
        },
      ],
    );
    await evaluate(`(()=>{for(const day of ['monday','wednesday','friday']){const row=document.querySelector('[data-day="'+day+'"]');const toggle=row.querySelector('[data-can-train]');if(!toggle.checked)toggle.click();const period=row.querySelector('[data-period="12_14"]');if(!period.checked)period.click();const duration=row.querySelector('[data-duration]');duration.value='75';duration.dispatchEvent(new Event('input',{bubbles:true}));const location=row.querySelector('[data-location]');location.value='São João da Madeira, Porto, Portugal';location.dispatchEvent(new Event('input',{bubbles:true}))}document.getElementById('saveAvailability').click()})()`);
    await waitForText('#availabilityStatus', 'Weekly schedule saved.');
    db.prepare("INSERT INTO shoes(id,user_id,brand,model,status) VALUES('ui-shoe',1,?,'Training shoe with an intentionally long product name for responsive layout checks','active')").run('Kinesis Athletics');
    proposalWeekStart = await evaluate(`document.getElementById('targetDate').value`);
    const duplicate = materializePrescription(
      makeSession(proposalWeekStart, 'monday'),
      'en-US',
    ).value;
    const duplicateId = db.prepare(
      `INSERT INTO trainings(user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,fc_alvo,rpe,previsao,observacoes,location,completed,feedback_rpe,feedback_notas) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,3,?)`,
    ).run(1, cycleId, duplicate.date, duplicate.period, duplicate.type, duplicate.workout, duplicate.details, duplicate.targetHr, duplicate.rpe, duplicate.weather, duplicate.notes, duplicate.location, 'Resultado sintético preservado').lastInsertRowid;
    await evaluate(`(()=>{
      const originalFetch=window.fetch.bind(window);
      const nativeSetTimeout=window.setTimeout.bind(window);
      const nativeRandom=Math.random;
      window.__generationPosts=0;
      window.__executionReads=0;
      window.__executionReadsInFlight=0;
      window.__maxExecutionReadsInFlight=0;
      window.__transientPollFailureInjected=false;
      window.__transientServerFailureInjected=false;
      window.__holdNextExecutionRead=false;
      window.__heldExecutionRead=false;
      window.__pollDelays=[];
      window.__restorePollingTestShims=()=>{window.setTimeout=nativeSetTimeout;Math.random=nativeRandom};
      window.setTimeout=(callback,delay=0,...args)=>{
        if(delay>=900&&delay<=30000)window.__pollDelays.push(delay);
        return nativeSetTimeout(callback,delay===1800?1:delay,...args);
      };
      Math.random=()=>0.9;
      window.fetch=async(input,init={})=>{
        const url=typeof input==='string'?input:input.url;
        const method=(init.method||'GET').toUpperCase();
        const pathname=new URL(url,location.href).pathname;
        if(method==='POST'&&pathname==='/api/ai/executions'){
          window.__generationPosts++;
          const response=await originalFetch(input,init);
          window.__latestGeneratedId=(await response.clone().json()).id;
          return response;
        }
        if(method==='GET'&&/^\\/api\\/ai\\/executions\\/[^/]+$/.test(pathname)){
          window.__executionReads++;
          window.__executionReadsInFlight++;
          window.__maxExecutionReadsInFlight=Math.max(window.__maxExecutionReadsInFlight,window.__executionReadsInFlight);
          try{
            if(!window.__transientPollFailureInjected){
              window.__transientPollFailureInjected=true;
              throw new TypeError('synthetic transient progress read failure');
            }
            if(!window.__transientServerFailureInjected){
              window.__transientServerFailureInjected=true;
              return new Response(JSON.stringify({error:'synthetic server failure'}),{status:503,headers:{'content-type':'application/json'}});
            }
            const response=await originalFetch(input,init);
            if(window.__holdNextExecutionRead){
              window.__holdNextExecutionRead=false;
              window.__heldExecutionRead=true;
              await new Promise((resolve,reject)=>{
                if(init.signal?.aborted){reject(new DOMException('Aborted','AbortError'));return}
                init.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
                window.__releaseHeldExecutionRead=resolve;
              });
            }
            return response;
          }finally{window.__executionReadsInFlight--}
        }
        return originalFetch(input,init);
      };
    })()`);
    await evaluate(`document.getElementById('generateBtn').click()`);
    await delay(1500);
    await waitForText('#weeklyProposalError', 'A temporary connection problem interrupted progress checking. Kinesis will keep checking this execution; this does not start another generation.');
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(window.__executionReads>2)resolve(true);else if(Date.now()>end)reject(new Error('Automatic retries did not continue after network and server read failures'));else setTimeout(check,20)};check()})`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))`);
    assert.equal(await evaluate(`document.visibilityState`), 'hidden');
    await delay(200);
    const readsBeforeVisibilityReturn = await evaluate(`window.__executionReads`);
    await evaluate(`window.__holdNextExecutionRead=true`);
    await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))`);
    assert.equal(await evaluate(`document.visibilityState`), 'visible');
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(window.__heldExecutionRead)resolve(true);else if(Date.now()>end)reject(new Error('Returning to the tab did not start an immediate execution read'));else setTimeout(check,20)};check()})`);
    await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(window.__executionReads>${readsBeforeVisibilityReturn+1})resolve(true);else if(Date.now()>end)reject(new Error('The serialized visibility refresh did not run after aborting the older read'));else setTimeout(check,20)};check()})`);
    assert.equal(await evaluate(`window.__maxExecutionReadsInFlight`), 1, 'visibility refreshes never overlap execution reads');
    await waitForText(
      '#weeklyProposalStatus',
      'Review the proposal before applying it.',
      55000,
    );
    assert.ok(await evaluate(`window.__executionReads`) > 70, 'the long-running job continues beyond the former 70-read limit');
    assert.ok((await evaluate(`window.__pollDelays`)).includes(2520), 'transient read errors use jittered backoff');
    assert.ok((await evaluate(`window.__pollDelays`)).includes(5040), 'repeated server failures increase the bounded backoff');
    assert.equal(await evaluate(`window.__maxExecutionReadsInFlight`), 1);
    await evaluate(`window.__restorePollingTestShims()`);
    assert.equal(await evaluate(`window.__generationPosts`), 1, 'polling never posts a second generation');
    assert.equal(await evaluate(`performance.getEntriesByType('navigation').length`), 1, 'the proposal appears without reload or navigation');
    assert.deepEqual(
      await evaluate(
        `(()=>({primaryIcon:document.querySelector('#generateBtn svg')?.getAttribute('data-lucide'),secondaryIcon:document.querySelector('#externalPromptBtn svg')?.getAttribute('data-lucide'),primaryLabel:document.querySelector('#generateBtn span').textContent.trim(),secondaryLabel:document.querySelector('#externalPromptBtn span').textContent.trim(),secondaryDisabled:document.querySelector('#externalPromptBtn').disabled}))()`,
      ),
      {
        primaryIcon: 'calendar-plus',
        secondaryIcon: 'sparkles',
        primaryLabel: 'Generate weekly proposal',
        secondaryLabel: 'View external prompt',
        secondaryDisabled: false,
      },
    );
    const review = await evaluate(
      `(()=>({cards:document.querySelectorAll('.weekly-proposal-card').length,text:document.getElementById('weeklyProposalContent').textContent,applyHidden:document.getElementById('weeklyApply').hidden}))()`,
    );
    assert.equal(review.cards, 3);
    assert.match(review.text, /Easy run/);
    assert.match(review.text, /Execution: Run continuously/);
    assert.match(review.text, /Effort: Comfortable effort/);
    assert.match(review.text, /This follows the saved context/);
    assert.match(review.text, /<img src=x onerror="alert\(1\)">/);
    assert.match(review.text, /Sessão sem pressa · café ☕/);
    assert.equal(
      await evaluate(
        `document.querySelector('.weekly-proposal-notes p').textContent`,
      ),
      expectedSessionNotes,
      'the complete long multiline note is available before applying',
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('.weekly-proposal-card img').length`,
      ),
      0,
      'notes are rendered as text rather than interpreted as markup',
    );
    assert.doesNotMatch(review.text, /weather:monday:|open-meteo\.com|forecast.*hours/i);
    assert.match(review.text, /RPE principal|Main RPE/);
    assert.match(review.text, /FC alvo|Target HR/);
    assert.match(review.text, /Maximum during period: .*°C/);
    assert.equal(review.applyHidden, false);
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultModal').hidden`), true);
    const proposalPresentation = await evaluate(`(()=>{
      const cards=[...document.querySelectorAll('.weekly-proposal-card')];
      const cardValues=cards.map(card=>({
        heading:card.querySelector('h3').textContent,
        rpeLabel:card.querySelector('.weekly-summary-main-rpe dt').textContent,
        rpe:card.querySelector('.weekly-summary-main-rpe dd').textContent,
        hr:card.querySelector('.weekly-summary-hr dd').textContent,
        shoe:card.querySelector('.weekly-summary-shoe dd').textContent,
        location:card.querySelector('.weekly-summary-location dd').textContent,
        weather:card.querySelector('.weekly-summary-weather dd').textContent,
        weatherParts:[...card.querySelectorAll('.weekly-summary-weather dd > span')].map(item=>item.textContent),
        phaseTitles:[...card.querySelectorAll('.weekly-proposal-phase h4')].map(item=>item.textContent),
        phaseClasses:[...card.querySelectorAll('.weekly-proposal-phase')].map(item=>item.className),
        descriptionBeforeNotes:card.querySelector('.weekly-proposal-description').compareDocumentPosition(card.querySelector('.weekly-proposal-notes'))&Node.DOCUMENT_POSITION_FOLLOWING,
        summaryColumns:getComputedStyle(card.querySelector('.weekly-proposal-summary-primary')).gridTemplateColumns.split(' ').length,
        contextColumns:getComputedStyle(card.querySelector('.weekly-proposal-summary-context')).gridTemplateColumns.split(' ').length,
      }));
      const content=document.getElementById('weeklyProposalContent');
      const actions=document.getElementById('weeklyProposalActions');
      const button=document.getElementById('weeklyApply');
      return {cards:cardValues,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,contentToFooter:Math.round(actions.getBoundingClientRect().top-content.getBoundingClientRect().bottom),footerMargin:getComputedStyle(actions).marginTop,footerBottomPadding:getComputedStyle(actions).paddingBottom,buttonWidth:button.getBoundingClientRect().width,footerWidth:actions.getBoundingClientRect().width};
    })()`);
    assert.equal(proposalPresentation.cards[0].rpeLabel, 'Main RPE');
    assert.equal(proposalPresentation.cards[0].rpe, '2/5');
    assert.match(proposalPresentation.cards[0].hr, /By effort and breathing; no HR reference available/);
    assert.equal(proposalPresentation.cards[0].shoe, 'Kinesis Athletics Training shoe with an intentionally long product name for responsive layout checks');
    assert.equal(proposalPresentation.cards[0].location, 'São João da Madeira, Porto, Portugal');
    assert.deepEqual(proposalPresentation.cards[0].weatherParts, ['24–25 °C', 'Maximum during period: 25 °C', 'Partly cloudy', 'Light rain']);
    assert.equal(proposalPresentation.cards[1].rpe, '3–4/5');
    assert.match(proposalPresentation.cards[1].hr, /Main: 145–155 bpm, 155–165 bpm/);
    assert.match(proposalPresentation.cards[1].weather, /Partial hourly coverage; no complete-window claim/);
    assert.deepEqual(proposalPresentation.cards[1].phaseTitles, ['Warm-up', 'Main step 1', 'Main step 2', 'Cool-down']);
    assert.match(proposalPresentation.cards[1].phaseClasses[0], /phase--warmup/);
    assert.match(proposalPresentation.cards[1].phaseClasses[1], /phase--main/);
    assert.match(proposalPresentation.cards[1].phaseClasses.at(-1), /phase--cooldown/);
    assert.match(proposalPresentation.cards[2].weather, /Hourly forecast unavailable or partial/);
    assert.match(proposalPresentation.cards[2].rpe, /Comfortable effort/);
    assert.ok(proposalPresentation.cards.every((card) => card.descriptionBeforeNotes));
    assert.equal(proposalPresentation.width, 390);
    assert.equal(proposalPresentation.scrollWidth, 390);
    assert.equal(proposalPresentation.cards[0].summaryColumns, 1);
    assert.equal(proposalPresentation.cards[0].contextColumns, 1);
    assert.equal(proposalPresentation.footerMargin, '24px');
    assert.equal(proposalPresentation.contentToFooter, 24);
    assert.ok(proposalPresentation.buttonWidth < proposalPresentation.footerWidth);
    assert.ok(proposalPresentation.footerBottomPadding !== '0px');
    await evaluate(`document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-proposal-mobile-en.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Portuguese proposal rerender timed out'));else setTimeout(check,20)};check()})`);
    const ptMobileReview = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,rpeLabel:document.querySelector('.weekly-summary-main-rpe dt').textContent,rpe:document.querySelector('.weekly-summary-main-rpe dd').textContent,hrLabel:document.querySelector('.weekly-summary-hr dt').textContent,weather:[...document.querySelector('.weekly-summary-weather dd').querySelectorAll('span')].map(node=>node.textContent),description:document.querySelector('.weekly-proposal-description-title').textContent,phases:[...document.querySelectorAll('.weekly-proposal-phase h4')].slice(0,4).map(node=>node.textContent)}))()`);
    assert.deepEqual(ptMobileReview, { width: 390, scrollWidth: 390, rpeLabel: 'RPE principal', rpe: '2/5', hrLabel: 'FC alvo', weather: ['24–25 °C', 'Máxima no período: 25 °C', 'Parcialmente nublado', 'Chuva leve'], description: 'Descrição do treino', phases: ['Aquecimento', 'Principal', 'Desaquecimento', 'Aquecimento'] });
    await evaluate(`document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-proposal-mobile-pt.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English proposal rerender timed out'));else setTimeout(check,20)};check()})`);
    const reviewedDetails = await evaluate(
      `document.querySelectorAll('.weekly-proposal-details')[1].textContent`,
    );
    const reviewedWeather = proposalPresentation.cards[1].weather;
    assert.equal(simulatedProviderCalls, 1);
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(350);
    await evaluate(
      `document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'});new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const card=document.querySelector('.weekly-proposal-card');if(card&&card.getBoundingClientRect().width>400)resolve(true);else if(Date.now()>end)reject(new Error('Proposal card did not become measurable after viewport resize'));else requestAnimationFrame(check)};check()})`,
    );
    const desktopProposalGeometry = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,summaryColumns:getComputedStyle(document.querySelector('.weekly-proposal-summary-primary')).gridTemplateColumns.split(' ').length,contextColumns:getComputedStyle(document.querySelector('.weekly-proposal-summary-context')).gridTemplateColumns.split(' ').length,footerMargin:getComputedStyle(document.getElementById('weeklyProposalActions')).marginTop,contentToFooter:Math.round(document.getElementById('weeklyProposalActions').getBoundingClientRect().top-document.getElementById('weeklyProposalContent').getBoundingClientRect().bottom),rpeWidth:document.querySelector('.weekly-summary-main-rpe').getBoundingClientRect().width,hrWidth:document.querySelector('.weekly-summary-hr').getBoundingClientRect().width,shoeWidth:document.querySelector('.weekly-summary-shoe').getBoundingClientRect().width,locationWidth:document.querySelector('.weekly-summary-location').getBoundingClientRect().width,weatherWidth:document.querySelector('.weekly-summary-weather').getBoundingClientRect().width}))()`);
    assert.deepEqual(desktopProposalGeometry, { width: 1280, scrollWidth: 1280, summaryColumns: 2, contextColumns: 3, footerMargin: '24px', contentToFooter: 24, rpeWidth: desktopProposalGeometry.rpeWidth, hrWidth: desktopProposalGeometry.hrWidth, shoeWidth: desktopProposalGeometry.shoeWidth, locationWidth: desktopProposalGeometry.locationWidth, weatherWidth: desktopProposalGeometry.weatherWidth });
    assert.ok(desktopProposalGeometry.weatherWidth > desktopProposalGeometry.shoeWidth, JSON.stringify(desktopProposalGeometry));
    assert.ok(desktopProposalGeometry.weatherWidth > desktopProposalGeometry.locationWidth, JSON.stringify(desktopProposalGeometry));
    assert.ok(desktopProposalGeometry.hrWidth > desktopProposalGeometry.rpeWidth * 2.5, JSON.stringify(desktopProposalGeometry));
    assert.ok(desktopProposalGeometry.weatherWidth > desktopProposalGeometry.shoeWidth * 1.7, JSON.stringify(desktopProposalGeometry));
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-proposal-review.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );
    await command('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await delay(350);
    await evaluate(`document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const measureSummary = () => evaluate(`(()=>{const card=document.querySelector('.weekly-proposal-card'),primary=card.querySelector('.weekly-proposal-summary-primary'),context=card.querySelector('.weekly-proposal-summary-context'),weather=card.querySelector('.weekly-summary-weather'),style=getComputedStyle(card),primaryStyle=getComputedStyle(primary),contextStyle=getComputedStyle(context);return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:card.clientWidth,contentWidth:card.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),primaryColumns:primaryStyle.gridTemplateColumns.split(' ').length,contextColumns:contextStyle.gridTemplateColumns.split(' ').length,weatherGridColumn:getComputedStyle(weather).gridColumn,collapsed:document.querySelector('.app-shell').classList.contains('collapsed')}})()`);
    const expandedIntermediate = await measureSummary();
    assert.equal(expandedIntermediate.width, 900);
    assert.equal(expandedIntermediate.scrollWidth, 900);
    assert.equal(expandedIntermediate.collapsed, false);
    if (expandedIntermediate.contentWidth <= 560) {
      assert.equal(expandedIntermediate.contextColumns, 2);
      assert.equal(expandedIntermediate.weatherGridColumn, '1 / -1');
    }
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-proposal-intermediate-expanded.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.getElementById('sidebarToggle').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await delay(350);
    const collapsedIntermediate = await measureSummary();
    assert.equal(collapsedIntermediate.collapsed, true);
    assert.equal(collapsedIntermediate.scrollWidth, 900);
    assert.ok(collapsedIntermediate.contentWidth > expandedIntermediate.contentWidth);
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-proposal-intermediate-collapsed.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.getElementById('sidebarToggle').click()`);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Desktop Portuguese proposal rerender timed out'));else setTimeout(check,20)};check()})`);
    const ptDesktopRpe = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,label:document.querySelector('.weekly-summary-main-rpe dt').textContent,value:document.querySelector('.weekly-summary-main-rpe dd').textContent}))()`);
    assert.deepEqual(ptDesktopRpe, { width: 1280, scrollWidth: 1280, label: 'RPE principal', value: '2/5' });
    await evaluate(`document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'})`);
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-proposal-desktop-pt.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English desktop proposal rerender timed out'));else setTimeout(check,20)};check()})`);
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__applyRequests=0;window.__postWasLost=false;window.__failedAppliedRead=false;window.fetch=async(...args)=>{const url=typeof args[0]==='string'?args[0]:args[0].url;const method=(args[1]?.method||'GET').toUpperCase();if(url.includes('/api/ai/workouts/')&&url.endsWith('/apply')&&method==='POST'){window.__applyRequests++;if(window.__applyRequests===1)return new Response(JSON.stringify({error:'Synthetic refusal',errors:['weeklyProposalInvalid']}),{status:422,headers:{'content-type':'application/json'}});if(window.__applyRequests===2){await original(...args);window.__postWasLost=true;throw new TypeError('synthetic response lost after commit')}}if(method==='GET'&&url.includes('/api/ai/workouts/')&&url.endsWith('/proposal')&&window.__postWasLost&&!window.__failedAppliedRead){window.__failedAppliedRead=true;window.fetch=original;throw new TypeError('synthetic status read unavailable')}return original(...args)}})()`);
    await evaluate(`document.getElementById('weeklyApply').click();document.getElementById('weeklyApply').click()`);
    await waitForText('#weeklyApplyResultTitle', 'Could not add the workouts');
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultModal').hidden`), false);
    assert.match(await evaluate(`document.getElementById('weeklyApplyResultMessage').textContent`), /proposal|calendar/i);
    assert.doesNotMatch(await evaluate(`document.getElementById('weeklyApplyResultMessage').textContent`), /weeklyProposalInvalid|SQL|stack/i);
    assert.equal(await evaluate(`document.querySelectorAll('.weekly-proposal-card').length`), 3);
    assert.equal(await evaluate(`window.__applyRequests`), 1, 'a double click submits one application request');
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyApplyResultOk');
    await pressKey('Tab', 'Tab', 9, 1);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyApplyResultClose');
    await pressKey('Tab', 'Tab', 9);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyApplyResultOk');
    await pressKey('Escape', 'Escape', 27);
    await evaluate(`new Promise(resolve=>{const check=()=>document.getElementById('weeklyApplyResultModal').hidden?resolve(true):requestAnimationFrame(check);check()})`);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyApply', 'the dismiss action restores focus to the available application control');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.getElementById('weeklyApply').click();document.getElementById('weeklyApply').click()`);
    await waitForText('#weeklyApplyResultTitle', 'Could not confirm the result');
    assert.match(await evaluate(`document.getElementById('weeklyApplyResultMessage').textContent`), /Check the same proposal's status/);
    assert.equal(await evaluate(`document.getElementById('weeklyApply').hidden`), true);
    assert.equal(await evaluate(`document.getElementById('weeklyReadAgain').hidden`), false);
    assert.equal(await evaluate(`window.__applyRequests`), 2, 'a second double click still creates only one request');
    const unknownModalLayout = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:document.querySelector('.weekly-apply-result-card').getBoundingClientRect().width,ok:document.getElementById('weeklyApplyResultOk').textContent.trim(),close:document.getElementById('weeklyApplyResultClose').getAttribute('aria-label')}))()`);
    assert.deepEqual(unknownModalLayout, { width: 390, scrollWidth: 390, cardWidth: unknownModalLayout.cardWidth, ok: 'OK', close: 'Close result' });
    assert.ok(unknownModalLayout.cardWidth <= 358);
    await evaluate(`document.getElementById('weeklyApplyResultClose').click()`);
    await evaluate(`new Promise(resolve=>{const check=()=>document.getElementById('weeklyApplyResultModal').hidden?resolve(true):requestAnimationFrame(check);check()})`);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyReadAgain');
    await evaluate(`(()=>{window.__testOriginalFetch=window.fetch.bind(window);window.__retryStatusReadFailed=false;window.fetch=async(...args)=>{const url=typeof args[0]==='string'?args[0]:args[0].url;const method=(args[1]?.method||'GET').toUpperCase();if(method==='GET'&&url.includes('/api/ai/workouts/')&&url.endsWith('/proposal')&&!window.__retryStatusReadFailed){window.__retryStatusReadFailed=true;throw new TypeError('synthetic repeated status read unavailable')}return window.__testOriginalFetch(...args)}})()`);
    await evaluate(`document.getElementById('weeklyReadAgain').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{const modal=document.getElementById('weeklyApplyResultModal');if(!modal.hidden&&document.getElementById('weeklyApplyResultTitle').textContent==='Could not confirm the result')resolve(true);else if(Date.now()>end)reject(new Error('A failed status retry did not retain the uncertain result modal'));else setTimeout(check,20)};check()})`);
    assert.equal(await evaluate(`document.getElementById('weeklyApply').hidden`), true);
    await evaluate(`document.getElementById('weeklyApplyResultOk').click()`);
    await evaluate(`new Promise(resolve=>{const check=()=>document.getElementById('weeklyApplyResultModal').hidden?resolve(true):requestAnimationFrame(check);check()})`);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyReadAgain');
    await evaluate(`document.getElementById('weeklyReadAgain').click()`);
    await waitForText('#weeklyApplyResultTitle', 'Workouts added');
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultMessage').textContent`), 'Your workouts were added to the calendar.');
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultIgnored').textContent`), '1 existing workout was skipped.');
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultModal').hidden`), false);
    assert.equal(await evaluate(`document.activeElement.id`), 'weeklyApplyResultOk');
    assert.equal(await evaluate(`document.querySelectorAll('.weekly-proposal-card').length`), 0);
    assert.equal(await evaluate(`document.getElementById('weeklyProposalSection').hidden`), true);
    assert.equal(await evaluate(`document.querySelectorAll('#weeklyApplyResultModal:not([hidden])').length`), 1, 'polling/recovery opens only one result dialog');
    await evaluate(`new Promise(resolve=>setTimeout(resolve,300))`);
    writeFileSync(path.join(tmpdir(), 'kinesis-weekly-apply-success-mobile-en.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    assert.equal(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM trainings WHERE user_id=(SELECT id FROM users WHERE email=?)',
        )
        .get('availability-browser@example.test').n,
      3,
    );
    assert.equal(
      db
        .prepare(
          'SELECT observacoes FROM trainings WHERE user_id=(SELECT id FROM users WHERE email=?)',
        )
        .get('availability-browser@example.test').observacoes,
      expectedSessionNotes,
    );
    assert.deepEqual(
      db.prepare('SELECT completed,feedback_rpe,feedback_notas FROM trainings WHERE id=?').get(duplicateId),
      { completed: 1, feedback_rpe: 3, feedback_notas: 'Resultado sintético preservado' },
      'the existing concluded workout and its result remain intact when skipped',
    );
    const savedDetails = db
        .prepare(
          'SELECT detalhes FROM trainings WHERE user_id=(SELECT id FROM users WHERE email=?) AND dia=?',
        )
        .get('availability-browser@example.test', addIsoDays(proposalWeekStart, 2)).detalhes;
    const savedWeather = db.prepare('SELECT previsao FROM trainings WHERE user_id=(SELECT id FROM users WHERE email=?) AND dia=?').get('availability-browser@example.test', addIsoDays(proposalWeekStart, 2)).previsao;
    assert.match(savedWeather, /partial/i, 'the persisted forecast retains its partial-coverage status');
    assert.match(reviewedWeather, /partial hourly coverage/i, 'the panel presents the same partial status in localized display copy');
    for (const instruction of ['Start with easy jogging and relaxed strides.', 'Run each surge strong and controlled.', '4 × 3 min', 'RPE 3/5', 'RPE 4/5', 'RPE 2/5', 'Ease down with relaxed steps.', 'RPE 1/5']) {
      assert.ok(reviewedDetails.includes(instruction), `preview includes ${instruction}`);
      assert.ok(savedDetails.includes(instruction), `calendar details preserve ${instruction}`);
    }
    assert.match(reviewedDetails, /Recovery: 2 min; Jog until breathing settles\.; RPE 2\/5/);
    assert.match(review.text, /Context reviewed\./, 'long justification remains visible in the proposal review');
    assert.deepEqual(
      await evaluate(
        `(()=>({primaryIcon:document.querySelector('#generateBtn svg')?.getAttribute('data-lucide'),secondaryIcon:document.querySelector('#externalPromptBtn svg')?.getAttribute('data-lucide'),primaryLabel:document.querySelector('#generateBtn span').textContent.trim(),secondaryLabel:document.querySelector('#externalPromptBtn span').textContent.trim()}))()`,
      ),
      {
        primaryIcon: 'calendar-plus',
        secondaryIcon: 'sparkles',
        primaryLabel: 'Generate weekly proposal',
        secondaryLabel: 'View external prompt',
      },
    );
    assert.equal(await evaluate(`document.querySelectorAll('.weekly-proposal-card').length`), 0);
    await evaluate(`document.getElementById('weeklyApplyResultOk').click()`);
    await evaluate(`new Promise(resolve=>{const check=()=>document.getElementById('weeklyApplyResultModal').hidden?resolve(true):requestAnimationFrame(check);check()})`);
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultMessage').textContent`), '');
    assert.equal(await evaluate(`document.activeElement.id`), 'aiCoachTitle');
    assert.equal(await evaluate(`document.getElementById('weeklyProposalSection').hidden`), true);
    assert.equal(await evaluate(`document.getElementById('weeklyApplyResultModal').hidden`), true);
    assert.equal(await evaluate(`document.getElementById('weeklyAppliedConfirmation')`), null);
    await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='pt-BR')resolve(true);else if(Date.now()>end)reject(new Error('Post-application Portuguese switch timed out'));else setTimeout(check,30)};check()})`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))`);
    assert.equal(await evaluate(`document.querySelector('#generateBtn span').textContent.trim()`), 'Gerar proposta semanal');
    assert.equal(await evaluate(`document.querySelector('#externalPromptBtn span').textContent.trim()`), 'Ver prompt externo');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-proposal-review-pt.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );
    assert.equal(simulatedProviderCalls, 1);
    assert.equal(await evaluate(`document.getElementById('generateBtn').disabled`), false);

    // A terminal failure remains attached to its execution. A free manual read
    // can be in flight while the user explicitly starts a new request; its late
    // response must not replace the newer execution's proposal.
    await evaluate(`document.getElementById('generateBtn').click()`);
    await waitForText('#weeklyProposalStatus', 'Esta execução terminou sem gerar uma proposta. Ler novamente mostrará a mesma falha; isso não inicia outra geração. A disponibilidade salva e o calendário foram preservados.', 12000);
    assert.equal(simulatedProviderCalls, 2);
    assert.equal(await evaluate(`window.__generationPosts`), 2);
    const failedExecutionId = await evaluate(`window.__latestGeneratedId`);
    await evaluate(`(()=>{const original=window.fetch.bind(window);window.__staleReadHeld=false;window.__releaseStaleRead=null;window.fetch=async(input,init={})=>{const url=typeof input==='string'?input:input.url;const path=new URL(url,location.href).pathname;if((init.method||'GET').toUpperCase()==='GET'&&path==='/api/ai/executions/${failedExecutionId}'&&!window.__staleReadHeld){const response=await original(input,init);window.__staleReadHeld=true;await new Promise(resolve=>window.__releaseStaleRead=resolve);return response}return original(input,init)}})()`);
    await evaluate(`document.getElementById('weeklyReadAgain').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(window.__staleReadHeld)resolve(true);else if(Date.now()>end)reject(new Error('The stale execution read was not held'));else setTimeout(check,20)};check()})`);
    await evaluate(`document.getElementById('generateBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(window.__latestGeneratedId&&window.__latestGeneratedId!=='${failedExecutionId}')resolve(true);else if(Date.now()>end)reject(new Error('The next explicit generation was not submitted'));else setTimeout(check,20)};check()})`);
    await evaluate(`window.__releaseStaleRead()`);
    await waitForText('#weeklyProposalStatus', 'Revise a proposta antes de aplicá-la.', 12000);
    assert.match(await evaluate(`document.getElementById('weeklyProposalContent').textContent`), /Current simulated request marker\./);
    assert.doesNotMatch(await evaluate(`document.getElementById('weeklyProposalStatus').textContent`), /terminou sem gerar/);
    assert.equal(await evaluate(`window.__generationPosts`), 3, 'the only additional POSTs follow two explicit user requests');
    assert.equal(simulatedProviderCalls, 3, 'polling, rereading and stale-response recovery never replay the provider');
    await evaluate(`document.getElementById('weeklyApply').click()`);
    await waitForText('#weeklyApplyResultTitle', 'Treinos adicionados', 12000);
    await evaluate(`document.getElementById('weeklyApplyResultOk').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('weeklyApplyResultModal').hidden)resolve(true);else if(Date.now()>end)reject(new Error('The second applied proposal result did not close'));else requestAnimationFrame(check)};check()})`);
    assert.equal(await evaluate(`document.querySelectorAll('.weekly-proposal-card').length`), 0);
    await evaluate(`(()=>{
      const originalFetch=window.fetch.bind(window);
      window.__retryWaitReads=0;
      window.__retryWaitHeld=false;
      window.__retryWaitAborted=false;
      window.__definitiveReadCount=0;
      window.__syntheticGenerationPosts=0;
      window.fetch=async(input,init={})=>{
        const url=typeof input==='string'?input:input.url;
        const method=(init.method||'GET').toUpperCase();
        const pathname=new URL(url,location.href).pathname;
        if(method==='POST'&&pathname==='/api/ai/executions'){
          window.__syntheticGenerationPosts++;
          const id=window.__syntheticGenerationPosts===1?'retry-after-execution':'missing-weekly-execution';
          return new Response(JSON.stringify({id,purpose:'workouts',state:'queued',error:null,outdated:false,response:null}),{status:202,headers:{'content-type':'application/json'}});
        }
        if(method==='GET'&&pathname==='/api/ai/executions/retry-after-execution'){
          window.__retryWaitReads++;
          if(window.__retryWaitReads===1){
            window.__retryWaitHeld=true;
            await new Promise((resolve,reject)=>{
              init.signal?.addEventListener('abort',()=>{window.__retryWaitAborted=true;reject(new DOMException('Aborted','AbortError'))},{once:true});
            });
          }
          const state=window.__retryWaitReads<3?'queued':'failed';
          return new Response(JSON.stringify({id:'retry-after-execution',purpose:'workouts',state,error:state==='queued'?'providerRateLimited':'providerRejected',outdated:false,response:null,updatedAt:new Date(Date.now()+5000).toISOString()}),{status:200,headers:{'content-type':'application/json'}});
        }
        if(method==='GET'&&pathname==='/api/ai/workouts/retry-after-execution/proposal')
          return new Response(JSON.stringify({state:'queued',proposal:null,response:null,application:null,outdated:false}),{status:200,headers:{'content-type':'application/json'}});
        if(method==='GET'&&pathname==='/api/ai/executions/missing-weekly-execution'){
          window.__definitiveReadCount++;
          return new Response(JSON.stringify({error:'not found',errors:['executionNotFound']}),{status:404,headers:{'content-type':'application/json'}});
        }
        return originalFetch(input,init);
      };
    })()`);
    await evaluate(`document.getElementById('generateBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(window.__retryWaitHeld)resolve(true);else if(Date.now()>end)reject(new Error('The backend-reported queued execution was not read'));else setTimeout(check,20)};check()})`);
    await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(window.__retryWaitAborted)resolve(true);else if(Date.now()>end)reject(new Error('Leaving the page did not abort the execution read'));else setTimeout(check,20)};check()})`);
    await delay(2100);
    assert.equal(await evaluate(`window.__retryWaitReads`), 1, 'a departed page does not keep polling');
    await evaluate(`(()=>{const event=new Event('pageshow');Object.defineProperty(event,'persisted',{value:true});window.dispatchEvent(event)})()`);
    await waitForText('#weeklyProposalStatus', 'Aguardando a nova tentativa após limite do provedor…', 5000);
    await waitForText('#weeklyProposalStatus', 'Esta execução terminou sem gerar uma proposta. Ler novamente mostrará a mesma falha; isso não inicia outra geração. A disponibilidade salva e o calendário foram preservados.', 7000);
    assert.equal(await evaluate(`window.__retryWaitReads`), 3, 'the queued provider retry is polled until its terminal result');
    assert.equal(await evaluate(`window.__syntheticGenerationPosts`), 1);
    assert.equal(simulatedProviderCalls, 3, 'the backend-reported Retry-After wait uses no new provider call from the browser');
    await evaluate(`document.getElementById('generateBtn').click()`);
    await waitForText('#weeklyProposalError', 'Esta solicitação não está mais disponível para sua conta. Abra Solicitar Treinos novamente para recuperar a execução salva mais recente.', 5000);
    assert.equal(await evaluate(`window.__definitiveReadCount`), 1);
    assert.equal(await evaluate(`document.getElementById('weeklyReadAgain').hidden`), true);
    await delay(2100);
    assert.equal(await evaluate(`window.__definitiveReadCount`), 1, 'a definitive 404 stops polling');
    assert.equal(await evaluate(`window.__syntheticGenerationPosts`), 2, 'each new request is an explicit single POST');
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/cycles/${cycleId}`,
      headers: { cookie: `ta_session=${cookie}` },
    });
    await evaluate(
      `window.dispatchEvent(new Event('kinesis:cycle-changed'));window.dispatchEvent(new Event('kinesis:cycle-changed'))`,
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{const item=document.querySelector('[data-nav-id="ai-coach"]');if(item.getAttribute('aria-disabled')==='true'&&item.getAttribute('aria-describedby')==='unrelated-description cycle-guard-ai-coach-description')resolve(true);else if(Date.now()>end)reject(new Error('Removing the active cycle did not restore its localized guard description'));else setTimeout(check,20)};check()})`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-nav-id="calendar"]').getAttribute('aria-describedby')`,
      ),
      'cycle-guard-calendar-description',
    );
    db.prepare(
      "UPDATE users SET role='user' WHERE email='availability-browser@example.test'",
    ).run();
    const regularReload = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await command('Page.reload');
    await Promise.race([
      regularReload,
      delay(12000).then(() => {
        throw new Error('Regular-account reload timed out.');
      }),
    ]);
    await evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(!document.getElementById('saveAvailability').disabled)resolve(true);else if(Date.now()>end)reject(new Error('Regular-account availability did not load'));else setTimeout(check,25)};check()})`,
    );
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(!document.getElementById('externalPromptBtn')&&!document.getElementById('externalPromptModal'))resolve(true);else if(Date.now()>end)reject(new Error('The regular account retained administrative prompt controls'));else setTimeout(check,25)};check()})`);
    assert.deepEqual(
      await evaluate(
        `(()=>({externalPromptPresent:!!document.getElementById('externalPromptBtn'),technicalPromptPresent:!!document.getElementById('externalPromptModal'),proposalVisible:!document.getElementById('weeklyProposalSection').hidden,resultModalVisible:!document.getElementById('weeklyApplyResultModal').hidden,resultText:document.getElementById('weeklyApplyResultMessage').textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))()`,
      ),
      {
        externalPromptPresent: false,
        technicalPromptPresent: false,
        proposalVisible: false,
        resultModalVisible: false,
        resultText: '',
        width: 1280,
        scrollWidth: 1280,
      },
    );
    assert.equal(await evaluate(`document.querySelectorAll('.weekly-proposal-card').length`), 0);
    assert.equal(
      simulatedProviderCalls,
      3,
      'reload recovers the latest applied execution without replaying any provider call',
    );
    await evaluate(
      `document.getElementById('weeklyProposalSection').scrollIntoView({block:'start'})`,
    );
    writeFileSync(
      path.join(tmpdir(), 'kinesis-weekly-proposal-regular-pt.png'),
      Buffer.from(
        (
          await command('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          })
        ).data,
        'base64',
      ),
    );
  } finally {
    socket?.close();
    chromeProcess.kill('SIGTERM');
    if (chromeProcess.exitCode === null)
      await Promise.race([once(chromeProcess, 'exit'), delay(2000)]);
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    t.diagnostic(
      'Verified the unchanged external prompt for an administrator, weekly proposal review/application and PT/EN rerender in Chrome on mobile, desktop availability/keyboard behavior, and ordinary-account ownership through simulated-provider API tests.',
    );
  }
});
