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

function findChrome() {
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((file) => existsSync(file));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('authenticated AI Coach availability works in PT/EN on desktop/mobile with keyboard controls', async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome is required for AI Coach browser verification.');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    email: 'availability-browser@example.test', password: 'runner-secret-1',
    first_name: 'Coach', last_name: 'Runner', preferred_lang: 'pt-BR',
  } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
    email: 'availability-browser@example.test', password: 'runner-secret-1',
  } });
  const cookie = [].concat(login.headers['set-cookie'] || [])[0].split(';')[0].split('=')[1];
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'kinesis-availability-chrome-'));
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
      try { versionResponse = await fetch(`${debugUrl}/json/version`); if (versionResponse.ok) break; } catch {}
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
    const cdpEvents = [];
    const cdpEventWaiters = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        const waiterIndex = cdpEventWaiters.findIndex((waiter) => waiter.method === message.method && waiter.predicate(message));
        if (waiterIndex >= 0) cdpEventWaiters.splice(waiterIndex, 1)[0].resolve(message);
        else cdpEvents.push(message);
        return;
      }
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
    const waitForCdpEvent = (method, predicate = () => true) => {
      const queuedIndex = cdpEvents.findIndex((event) => event.method === method && predicate(event));
      if (queuedIndex >= 0) return Promise.resolve(cdpEvents.splice(queuedIndex, 1)[0]);
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
        waiter.resolve = (event) => { clearTimeout(timeout); resolve(event); };
        cdpEventWaiters.push(waiter);
      });
    };
    const waitForAvailabilityResponse = (method) => waitForCdpEvent('Fetch.requestPaused', (event) =>
      event.params.request.method === method && event.params.request.url.includes('/api/ai-coach/availability'));
    const releaseAvailabilityResponse = (event) => command('Fetch.continueRequest', { requestId: event.params.requestId });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitForText = (selector, expected) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(element?.textContent.trim()===${JSON.stringify(expected)}){resolve(true);return}if(Date.now()>end){reject(new Error('Timed out waiting for expected text'));return}requestAnimationFrame(check)};check()})`);
    const saveWithDelayedResponse = async (editExpression, afterSubmitEdit = null) => {
      const responsePending = waitForAvailabilityResponse('PUT');
      await evaluate(`document.getElementById('saveAvailability').click()`);
      const response = await responsePending;
      const edit = await evaluate(editExpression);
      if (afterSubmitEdit) await afterSubmitEdit();
      await releaseAvailabilityResponse(response);
      await waitForText('#availabilityStatus', 'Availability changed while saving. Save again before generating the prompt.');
      return edit;
    };
    const saveCurrentForm = async () => {
      await evaluate(`document.getElementById('saveAvailability').click()`);
      await waitForText('#availabilityStatus', 'Availability saved.');
    };
    const pressKey = async (key, code, keyCode, modifiers = 0) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    };
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    const origin = new URL(baseUrl).origin;
    const cookieResult = await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin });
    assert.equal(cookieResult.success, true);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
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
    await Promise.race([loaded, delay(15000).then(() => { throw new Error('AI Coach page load timed out.'); })]);
    const ready = await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(document.querySelectorAll('#availabilityGrid .day-row').length===7){resolve(true);return}if(Date.now()>end){reject(new Error('Availability grid did not render'));return}requestAnimationFrame(check)};check()})`);
    assert.equal(ready, true);
    await evaluate(`window.__setDay=(day,available)=>{const input=document.querySelector('[data-day="'+day+'"] [data-can-train]');if(input.checked!==available){input.click()}else if(input.closest('.day-row').dataset.configured!=='true'){input.dispatchEvent(new Event('change',{bubbles:true}))}}`);
    const pendingInitialGet = await initialGet;
    await evaluate(`(()=>{const input=document.getElementById('baseLocation');input.value='Lisboa';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await releaseAvailabilityResponse(pendingInitialGet);
    const initialAvailabilityLoaded = await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(!document.getElementById('availabilityReview').hidden){resolve(true);return}if(Date.now()>end){reject(new Error('New-user availability review notice did not load'));return}requestAnimationFrame(check)};check()})`);
    assert.equal(initialAvailabilityLoaded, true);
    const newUserState = await evaluate(`(()=>({review:!document.getElementById('availabilityReview').hidden,unselected:[...document.querySelectorAll('#availabilityGrid .day-row')].every(row=>!row.querySelector('input[data-can-train]:checked')),locations:[...document.querySelectorAll('[data-location]')].every(input=>input.value==='')}))()`);
    assert.deepEqual(newUserState, { review: true, unselected: true, locations: true });

    const overlongPrefill = await evaluate(`(()=>{
      const base=document.getElementById('baseLocation');
      base.value='L'.repeat(201);base.dispatchEvent(new Event('change',{bubbles:true}));
      const monday=document.querySelector('[data-day="monday"]');
      window.__setDay('monday', true);
      monday.querySelector('[data-period="12_14"]').click();
      const duration=monday.querySelector('[data-duration]');duration.value='60';duration.dispatchEvent(new Event('input',{bubbles:true}));
      const location=monday.querySelector('[data-location]');
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
    assert.deepEqual(exactLimitLocation, { valueLength: 204, trimmedLength: 200, errorHidden: true, invalid: 'false', generateDisabled: false });
    await command('Fetch.disable');
    await evaluate(`document.getElementById('saveAvailability').click()`);
    const exactLimitSaveStatus = await evaluate(`new Promise(resolve=>{const end=Date.now()+8000;const check=()=>{const status=document.getElementById('availabilityStatus').textContent.trim();if(status||Date.now()>end){resolve(status);return}requestAnimationFrame(check)};check()})`);
    assert.equal(exactLimitSaveStatus, 'Disponibilidade salva.');
    const exactLocationSaved = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` } });
    assert.equal(exactLocationSaved.json().availability.days[0].location, `  ${'B'.repeat(200)}  `);
    const desktop = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,language:document.documentElement.lang,reviewVisible:!document.getElementById('availabilityReview').hidden,days:document.querySelectorAll('#availabilityGrid .day-row').length}))()`);
    assert.deepEqual(desktop, { width: 1280, scrollWidth: 1280, language: 'pt-BR', reviewVisible: false, days: 7 });

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
    const tabState = await evaluate(`(()=>({tag:document.activeElement.tagName,value:document.activeElement.value,focusVisible:document.activeElement.matches(':focus-visible')}))()`);
    assert.equal(tabState.tag, 'INPUT');
    assert.equal(tabState.focusVisible, true);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    const shiftTabState = await evaluate(`document.activeElement.id`);
    assert.equal(shiftTabState, 'applyWeekdays');
    await pressKey('Enter', 'Enter', 13);
    const applyState = await evaluate(`(()=>({enabled:!document.getElementById('generateBtn').disabled,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,focused:document.activeElement.matches(':focus-visible')}))()`);
    assert.deepEqual(applyState, { enabled: true, periods: 2, focused: true });
    await evaluate(`document.querySelector('[data-day="monday"] [data-period="before_08"]').focus()`);
    await pressKey(' ', 'Space', 32);
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`), true);
    await pressKey(' ', 'Space', 32);
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`), false);

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
    const copyState = await evaluate(`(()=>({weekdayRows:['tuesday','wednesday','thursday','friday'].map(day=>document.querySelector('[data-day="'+day+'"]').querySelectorAll('[data-period]:checked').length),saturdayHidden:document.querySelector('[data-day="saturday"] .day-details').hidden,saturdayDisabled:[...document.querySelectorAll('[data-day="saturday"] .day-details input,[data-day="saturday"] .day-details select')].every(control=>control.disabled),tuesdayLocation:document.querySelector('[data-day="tuesday"] [data-location]').value,mondayLocation:document.querySelector('[data-day="monday"] [data-location]').value}))()`);
    assert.deepEqual(weekdayCopy.weekdayRows, [3, 3, 3, 3]);
    assert.equal(weekdayCopy.weekendUnchanged, true, 'applying weekdays leaves Saturday and Sunday untouched');
    assert.deepEqual(copyState, { weekdayRows: [3, 3, 3, 3], saturdayHidden: true, saturdayDisabled: true, tuesdayLocation: 'Maspalomas, Gran Canaria', mondayLocation: 'Porto' });
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.trim())resolve(true);else if(Date.now()>end)reject(new Error('Save status did not appear'));else setTimeout(check,30)};check()})`);
    const persisted = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` } });
    assert.equal(persisted.statusCode, 200);
    assert.equal(persisted.json().availability.days[0].available_minutes, 60);
    assert.equal(persisted.json().availability.days[1].location, 'Maspalomas, Gran Canaria');
    assert.equal(persisted.json().availability.days[5].can_train, false);
    const nonPresetDays = persisted.json().availability.days.map((day) => ({ ...day }));
    nonPresetDays[0].available_minutes = 75;
    nonPresetDays[1].available_minutes = 137;
    const apiSave = await app.inject({ method: 'PUT', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` }, payload: { days: nonPresetDays } });
    assert.equal(apiSave.statusCode, 200);
    const apiGet = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` } });
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
    await Promise.race([reloaded, delay(15000).then(() => { throw new Error('AI Coach reload timed out.'); })]);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='75'&&tuesday?.value==='137')resolve(true);else if(Date.now()>end)reject(new Error('Saved non-preset durations did not render after reload'));else setTimeout(check,30)};check()})`);
    const renderedDurations = await evaluate(`(()=>({monday:document.querySelector('[data-day="monday"] [data-duration]').value,tuesday:document.querySelector('[data-day="tuesday"] [data-duration]').value,valid:!document.getElementById('generateBtn').disabled}))()`);
    assert.deepEqual(renderedDurations, { monday: '75', tuesday: '137', valid: true });
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
      invalid: { formValid: false, error: 'O tempo disponível deve ser um número inteiro entre 1 e 720 minutos.', durationInvalid: 'true' },
      putCount: 0,
    });
    await evaluate(`document.getElementById('saveAvailability').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.trim())resolve(true);else if(Date.now()>end)reject(new Error('Round-trip save status did not appear'));else setTimeout(check,30)};check()})`);
    const roundTrip = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` } });
    assert.equal(roundTrip.json().availability.days[0].available_minutes, 75);
    assert.equal(roundTrip.json().availability.days[1].available_minutes, 137);
    assert.equal(roundTrip.json().availability.days[1].location, 'Maspalomas, Gran Canaria');

    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
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
    await Promise.race([savedReload, delay(15000).then(() => { throw new Error('AI Coach reload timed out.'); })]);
    const savedGetResponse = await savedGet;
    await evaluate(`(()=>{const daily=document.querySelector('[data-day="tuesday"] input[data-can-train]');daily.focus();window.__focusedDailyChoice=daily;const input=document.getElementById('baseLocation');input.value='Coimbra';input.dispatchEvent(new Event('change',{bubbles:true}));window.__beforeGetFocus=document.activeElement===daily})()`);
    await releaseAvailabilityResponse(savedGetResponse);
    const savedGetState = await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='75'&&tuesday?.value==='137'){resolve({monday:monday.value,tuesday:tuesday.value,review:!document.getElementById('availabilityReview').hidden});return}if(Date.now()>end){reject(new Error('Saved week did not load after base-location edit'));return}requestAnimationFrame(check)};check()})`);
    const savedGetFocus = await evaluate(`(()=>{const input=document.querySelector('[data-day="tuesday"] input[data-can-train]');return {before:window.__beforeGetFocus,focused:document.activeElement===input,sameNode:window.__focusedDailyChoice===input}})()`);
    assert.deepEqual(savedGetState, { monday: '75', tuesday: '137', review: false });
    assert.deepEqual(savedGetFocus, { before: true, focused: true, sameNode: false });

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
    await Promise.race([editedReload, delay(15000).then(() => { throw new Error('AI Coach reload timed out.'); })]);
    const editedGetResponse = await editedGet;
    await evaluate(`(()=>{const row=document.querySelector('[data-day="monday"]');const inputToggle=row.querySelector('[data-can-train]');if(!inputToggle.checked)inputToggle.click();row.querySelector('[data-period="12_14"]').click();const input=row.querySelector('[data-duration]');input.value='95';input.dispatchEvent(new Event('input',{bubbles:true}));const location=row.querySelector('[data-location]');location.focus()})()`);
    await command('Input.insertText', { text: 'Aveiro' });
    await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.focus();window.__focusedGetDuration=input})()`);
    await pressKey('ArrowUp', 'ArrowUp', 38);
    await releaseAvailabilityResponse(editedGetResponse);
    const mergedGetState = await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{const monday=document.querySelector('[data-day="monday"] [data-duration]');const tuesday=document.querySelector('[data-day="tuesday"] [data-duration]');if(monday?.value==='96'&&tuesday?.value==='137'){resolve({monday:monday.value,tuesday:tuesday.value,review:!document.getElementById('availabilityReview').hidden});return}if(Date.now()>end){reject(new Error('Concurrent day edit was not merged with saved availability'));return}requestAnimationFrame(check)};check()})`);
    const mergedGetFocus = await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');return {focused:document.activeElement===input,sameNode:window.__focusedGetDuration===input,value:input.value,location:document.querySelector('[data-day="monday"] [data-location]').value}})()`);
    assert.deepEqual(mergedGetState, { monday: '96', tuesday: '137', review: false });
    assert.deepEqual(mergedGetFocus, { focused: true, sameNode: true, value: '96', location: 'Aveiro' });
    await pressKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-duration]').value`), '97',
      'duration keyboard input continues in the preserved edited row after GET reconciliation');
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-location]').value`), 'Aveiro');
    await command('Fetch.disable');
    await evaluate(`document.getElementById('saveAvailability').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.includes('salva'))resolve(true);else if(Date.now()>end)reject(new Error('Merged GET edit did not save'));else requestAnimationFrame(check)};check()})`);

    await evaluate(`(()=>{const location=document.querySelector('[data-day="tuesday"] [data-location]');location.focus();location.setSelectionRange(2,7,'forward');document.querySelector('.lang-switch [data-lang="en-US"]').click()})()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English language switch timed out'));else setTimeout(check,30)};check()})`);
    const englishState = await evaluate(`(()=>({language:document.documentElement.lang,label:document.querySelector('[data-day="monday"] .period-group legend').textContent,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,location:document.querySelector('[data-day="tuesday"] [data-location]').value}))()`);
    assert.deepEqual(englishState, { language: 'en-US', label: 'Available periods', periods: 1, location: 'Maspalomas, Gran Canaria' });
    const languageFocus = await evaluate(`(()=>{const location=document.querySelector('[data-day="tuesday"] [data-location]');return {focused:document.activeElement===location,start:location.selectionStart,end:location.selectionEnd,direction:location.selectionDirection}})()`);
    assert.equal(languageFocus.focused || languageFocus.start === 0, true);

    const englishLocationLimit = await evaluate(`(()=>{const location=document.querySelector('[data-day="monday"] [data-location]');const saved=location.value;location.value='E'.repeat(201);location.dispatchEvent(new Event('input',{bubbles:true}));const row=location.closest('.day-row');const state={error:row.querySelector('[data-day-error]').textContent,invalid:location.getAttribute('aria-invalid'),generateDisabled:document.getElementById('generateBtn').disabled};location.value=saved;location.dispatchEvent(new Event('input',{bubbles:true}));return state})()`);
    assert.deepEqual(englishLocationLimit, { error: 'Location must be at most 200 characters.', invalid: 'true', generateDisabled: true });

    const englishLimit = await evaluate(`(()=>{const duration=document.querySelector('[data-day="monday"] [data-duration]');duration.value='721';duration.dispatchEvent(new Event('input',{bubbles:true}));const error=duration.closest('.day-row').querySelector('[data-day-error]').textContent;const disabled=document.getElementById('generateBtn').disabled;duration.value='75';duration.dispatchEvent(new Event('input',{bubbles:true}));return {error,disabled}})()`);
    assert.deepEqual(englishLimit, { error: 'Available time must be a whole number between 1 and 720 minutes.', disabled: true });

    await evaluate(`document.getElementById('generateBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const prompt=document.getElementById('promptOutput').textContent;if(prompt.includes('Maximum session time: 60 minutes')&&prompt.includes('Maspalomas, Gran Canaria'))resolve(true);else if(Date.now()>end)reject(new Error('Structured English prompt did not appear'));else setTimeout(check,40)};check()})`);
    const prompt = await evaluate(`document.getElementById('promptOutput').textContent`);
    assert.match(prompt, /Multiple periods are alternatives for one session that day/);
    assert.match(prompt, /a ceiling, not a target/);
    assert.doesNotMatch(prompt, /Normal routine|Rotina normal/);

    await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.value='96';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const durationAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');input.focus();window.__focusedPutDuration=input;return true})()`,
      async () => pressKey('ArrowUp', 'ArrowUp', 38),
    );
    assert.equal(durationAfterSave, true);
    assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-duration]');return {value:input.value,focused:document.activeElement===input,sameNode:window.__focusedPutDuration===input}})()`),
      { value: '97', focused: true, sameNode: true });
    await pressKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-duration]').value`), '98',
      'duration keyboard input continues after PUT reconciliation');
    await command('Fetch.disable');
    await saveCurrentForm();

    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const periodAfterSave = await saveWithDelayedResponse(`(()=>{const input=document.querySelector('[data-day="monday"] [data-period="before_08"]');input.click();document.getElementById('optionalContext').focus();return {checked:input.checked,focus:document.activeElement.id}})()`);
    assert.deepEqual(periodAfterSave, { checked: true, focus: 'optionalContext' });
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-period="before_08"]').checked`), true);
    assert.equal(await evaluate(`document.activeElement.id`), 'optionalContext', 'PUT reconciliation does not steal focus moved to another control');
    await command('Fetch.disable');
    await saveCurrentForm();

    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const locationAfterSave = await saveWithDelayedResponse(
      `(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.focus();window.__focusedPutLocation=input;return true})()`,
      async () => {
        await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.value='';input.focus()})()`);
        await command('Input.insertText', { text: 'Braga' });
        await evaluate(`document.querySelector('[data-day="monday"] [data-location]').setSelectionRange(1,4,'backward')`);
      },
    );
    assert.equal(locationAfterSave, true);
    assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');return {value:input.value,focused:document.activeElement===input,sameNode:window.__focusedPutLocation===input,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}})()`),
      { value: 'Braga', focused: true, sameNode: true, start: 1, end: 4, direction: 'backward' });
    await command('Input.insertText', { text: 'X' });
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-location]').value`), 'BXa',
      'typing replaces the selected text correctly after PUT reconciliation');
    await command('Fetch.disable');
    await saveCurrentForm();

    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const availabilityAfterSave = await saveWithDelayedResponse(`(()=>{const input=document.querySelector('[data-day="sunday"] [data-can-train]');input.focus();if(input.checked)input.click();return {no:!input.checked,detailsHidden:document.querySelector('[data-day="sunday"] .day-details').hidden,focused:document.activeElement===input}})()`);
    assert.deepEqual(availabilityAfterSave, { no: true, detailsHidden: true, focused: true });
    assert.equal(await evaluate(`document.querySelector('[data-day="sunday"] [data-can-train]').checked`), false);
    await command('Fetch.disable');
    await saveCurrentForm();

    const promptBeforeGenerateRace = await evaluate(`document.getElementById('promptOutput').textContent`);
    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const generateResponsePending = waitForAvailabilityResponse('PUT');
    await evaluate(`document.getElementById('generateBtn').click()`);
    const generateResponse = await generateResponsePending;
    await evaluate(`(()=>{const input=document.querySelector('[data-day="monday"] [data-location]');input.value='Porto após gerar';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await releaseAvailabilityResponse(generateResponse);
    await waitForText('#availabilityStatus', 'Availability changed while saving. Save again before generating the prompt.');
    assert.equal(await evaluate(`document.querySelector('[data-day="monday"] [data-location]').value`), 'Porto após gerar');
    assert.equal(await evaluate(`document.getElementById('promptOutput').textContent`), promptBeforeGenerateRace,
      'Generate does not produce a prompt from the stale submitted snapshot');
    await command('Fetch.disable');

    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))`);
    const mobile = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,days:document.querySelectorAll('#availabilityGrid .day-row').length,touchTarget:[...document.querySelectorAll('.period-option span')].filter(el=>el.getClientRects().length>0).every(el=>el.getBoundingClientRect().height>=42)}))()`);
    assert.deepEqual(mobile, { width: 390, scrollWidth: 390, days: 7, touchTarget: true });
    await evaluate(`(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');input.value='Mobile';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/ai-coach/availability*', requestStage: 'Response' }] });
    const mobileLocationAfterSave = await saveWithDelayedResponse(`(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');input.value='Mobility';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(3,5,'backward');window.__focusedMobileLocation=input;return input.value})()`);
    assert.equal(mobileLocationAfterSave, 'Mobility');
    await evaluate(`new Promise(requestAnimationFrame)`);
    assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('[data-day="tuesday"] [data-location]');return {focused:document.activeElement===input,sameNode:window.__focusedMobileLocation===input,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}})()`),
      { focused: false, sameNode: true, start: 3, end: 5, direction: 'backward' });
    await command('Input.insertText', { text: 'X' });
    assert.equal(await evaluate(`document.querySelector('[data-day="tuesday"] [data-location]').value`), 'Mobility');
    await command('Fetch.disable');
    await saveCurrentForm();
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    assert.ok(screenshot.data.length > 1000, 'mobile headless rendering produced a screenshot');
  } finally {
    socket?.close();
    chromeProcess.kill('SIGTERM');
    if (chromeProcess.exitCode === null) await Promise.race([once(chromeProcess, 'exit'), delay(2000)]);
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    t.diagnostic('Verified authenticated AI Coach at 1280×800 and 390×844 in PT/EN, including focus/caret preservation across delayed GET/PUT responses and language rerender, plus availability validation.');
  }
});
