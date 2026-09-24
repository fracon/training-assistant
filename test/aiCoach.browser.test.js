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
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
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
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
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
    const ready = await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(document.querySelectorAll('#availabilityGrid .day-row').length===7&&!document.getElementById('availabilityReview').hidden){resolve(true);return}if(Date.now()>end){reject(new Error('Availability grid did not load'));return}setTimeout(check,30)};check()})`);
    assert.equal(ready, true);

    const desktop = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,language:document.documentElement.lang,reviewVisible:!document.getElementById('availabilityReview').hidden,days:document.querySelectorAll('#availabilityGrid .day-row').length}))()`);
    assert.deepEqual(desktop, { width: 1280, scrollWidth: 1280, language: 'pt-BR', reviewVisible: true, days: 7 });

    await evaluate(`(()=>{
      const days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      for(const day of days){
        document.querySelector('[data-day="'+day+'"] input[value="yes"]').click();
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
    assert.deepEqual(tabState, { tag: 'INPUT', value: 'yes', focusVisible: true });
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    const shiftTabState = await evaluate(`document.activeElement.id`);
    assert.equal(shiftTabState, 'applyWeekdays');
    await pressKey('Enter', 'Enter', 13);
    const applyState = await evaluate(`(()=>({enabled:!document.getElementById('generateBtn').disabled,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,focused:document.activeElement.matches(':focus-visible'),selectedMarker:getComputedStyle(document.querySelector('[data-day="monday"] [data-period="12_14"] + span'),'::before').content}))()`);
    assert.deepEqual(applyState, { enabled: true, periods: 2, focused: true, selectedMarker: '"✓"' });
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
      const weekendUnchanged=['saturday','sunday'].every(day=>document.querySelector('[data-day="'+day+'"]').querySelector('input[value="yes"]').checked);
      const saturday=document.querySelector('[data-day="saturday"]');
      saturday.querySelector('input[value="no"]').click();
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
    await evaluate(`document.getElementById('saveAvailability').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const check=()=>{if(document.getElementById('availabilityStatus').textContent.trim())resolve(true);else if(Date.now()>end)reject(new Error('Round-trip save status did not appear'));else setTimeout(check,30)};check()})`);
    const roundTrip = await app.inject({ method: 'GET', url: '/api/ai-coach/availability', headers: { cookie: `ta_session=${cookie}` } });
    assert.equal(roundTrip.json().availability.days[0].available_minutes, 75);
    assert.equal(roundTrip.json().availability.days[1].available_minutes, 137);
    assert.equal(roundTrip.json().availability.days[1].location, 'Maspalomas, Gran Canaria');

    await evaluate(`new Promise((resolve,reject)=>{document.querySelector('.lang-switch [data-lang="en-US"]').click();const end=Date.now()+8000;const check=()=>{if(document.documentElement.lang==='en-US')resolve(true);else if(Date.now()>end)reject(new Error('English language switch timed out'));else setTimeout(check,30)};check()})`);
    const englishState = await evaluate(`(()=>({language:document.documentElement.lang,label:document.querySelector('[data-day="monday"] .period-group legend').textContent,periods:document.querySelectorAll('[data-day="monday"] [data-period]:checked').length,location:document.querySelector('[data-day="tuesday"] [data-location]').value}))()`);
    assert.deepEqual(englishState, { language: 'en-US', label: 'Available periods', periods: 3, location: 'Maspalomas, Gran Canaria' });

    await evaluate(`document.getElementById('generateBtn').click()`);
    await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{const prompt=document.getElementById('promptOutput').textContent;if(prompt.includes('Maximum session time: 60 minutes')&&prompt.includes('Maspalomas, Gran Canaria'))resolve(true);else if(Date.now()>end)reject(new Error('Structured English prompt did not appear'));else setTimeout(check,40)};check()})`);
    const prompt = await evaluate(`document.getElementById('promptOutput').textContent`);
    assert.match(prompt, /Multiple periods are alternatives for one session that day/);
    assert.match(prompt, /a ceiling, not a target/);
    assert.doesNotMatch(prompt, /Normal routine|Rotina normal/);

    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))`);
    const mobile = await evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,days:document.querySelectorAll('#availabilityGrid .day-row').length,touchTarget:[...document.querySelectorAll('.period-chip span')].filter(el=>el.getClientRects().length>0).every(el=>el.getBoundingClientRect().height>=42)}))()`);
    assert.deepEqual(mobile, { width: 390, scrollWidth: 390, days: 7, touchTarget: true });
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    assert.ok(screenshot.data.length > 1000, 'mobile headless rendering produced a screenshot');
  } finally {
    socket?.close();
    chromeProcess.kill('SIGTERM');
    if (chromeProcess.exitCode === null) await Promise.race([once(chromeProcess, 'exit'), delay(2000)]);
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    t.diagnostic('Verified authenticated AI Coach at 1280×800 and 390×844 in PT/EN, with save, weekday copy, multi-period selection, keyboard focus, and prompt output.');
  }
});
