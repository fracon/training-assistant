'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, copyFileSync } = require('node:fs');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { completeAnamnesis } = require('./helpers/anamnesis.cjs');
const { launchChrome } = require('./helpers/chrome.cjs');
const pt = require('../src/public/locales/pt.json');
const en = require('../src/public/locales/en.json');

const shots = process.env.KINESIS_CALENDAR_SHOTS;

test('Chrome calendar agenda: PT/EN, phone widths, keyboard, move dialog and desktop grid', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const owner = Number(db.prepare("INSERT INTO users (email, password_hash, first_name, onboarding_status, preferred_lang) VALUES ('agenda@example.test', 'unused', 'Ana', 'active', 'pt-BR')").run().lastInsertRowid);
  completeAnamnesis(db, owner);
  db.prepare("INSERT INTO training_cycles (id, user_id, objective, target_date, status, start_date) VALUES ('agenda-cycle', ?, 'Synthetic race', '2027-03-08', 'active', '2026-10-01')").run(owner);
  const insert = db.prepare('INSERT INTO trainings (user_id, dia, tipo, treino, detalhes, completed, feedback_rpe) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < 4; index++) insert.run(owner, '2026-11-05', index === 0 ? 'LONGO LEVE' : 'CONTROLADO', `Longo reduzido — até 17 km (aprox. 1h53–1h55) ${index + 1}`, 'Corrida confortável e controlada. Mantenha o esforço estável durante toda a sessão. '.repeat(3), index === 0 ? 1 : 0, index === 0 ? 3 : null);
  insert.run(owner, '2026-11-12', 'LEVE', 'Outra semana', '', 0, null);
  const app = await buildServer({ db, sessionCookieSecure: false });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const { command, evaluate, wait, key, capture, socket } = await launchChrome(t);
  const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  await command('Runtime.enable');
  await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner).token, url: origin, httpOnly: true });
  const viewport = (width) => command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 640 });
  const open = async (language, week = '2026-11-02', count = 4) => {
    await command('Page.navigate', { url: `${origin}/calendar.html?week=${week}` });
    await wait(`document.documentElement.lang === '${language}' && document.querySelectorAll('.agenda-card').length === ${count}`);
  };
  const snap = async (name) => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await capture(`calendar-${name}`);
    copyFileSync(`/tmp/kinesis-flow-calendar-${name}.png`, `${shots}/${name}.png`);
  };
  const choose = async (iso) => {
    await evaluate(`document.querySelector('#miniMonth [data-date="${iso}"]').click()`);
  };
  for (const [language, messages] of [['pt-BR', pt], ['en-US', en]]) {
    db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(language, owner);
    for (const width of [320, 360, 390]) {
      await viewport(width);
      await open(language);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await evaluate("[...document.querySelectorAll('.agenda-card')].every(e => {const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})"), true);
      assert.equal(await evaluate("getComputedStyle(document.getElementById('calendarGrid')).display"), 'none');
      assert.equal(await evaluate("document.getElementById('calendarGrid').inert"), true);
      assert.equal(await evaluate("document.querySelectorAll('#miniMonth button').length"), 42);
      assert.equal(await evaluate("[...document.querySelectorAll('#miniMonth button')].every(b => Math.round(b.getBoundingClientRect().height) >= 44 && !!b.getAttribute('aria-label'))"), true);
      assert.equal(await evaluate("document.querySelectorAll('#miniMonth [aria-pressed=true]').length"), 7);
      assert.equal(await evaluate("document.querySelectorAll('.agenda-card').length"), 4);
      assert.equal(await evaluate("document.querySelector('.agenda-card a').getAttribute('href')"), '/training-result.html?id=1');
      assert.equal(await evaluate("document.querySelector('.agenda-status').textContent"), `${messages.calendar.agenda.completed} · RPE 3/5`);
      assert.equal(await evaluate("document.querySelectorAll('#miniMonth [data-date=\"2026-11-05\"] .session-dot').length"), 2);
      assert.equal(await evaluate('location.search'), '', '?week is consumed');
      await snap(`${language}-${width}-agenda`);
      if (shots && width !== 320) {
        await evaluate("document.querySelector('.agenda-card:last-child').scrollIntoView({block:'end'})");
        await snap(`${language}-${width}-four-sessions`);
      }
      await choose('2026-11-12');
      assert.equal(await evaluate("document.querySelectorAll('.agenda-card').length"), 1);
      await key('ArrowLeft', 'ArrowLeft', 37);
      assert.equal(await evaluate('document.activeElement.dataset.date'), '2026-11-11');
      await key('ArrowDown', 'ArrowDown', 40);
      assert.equal(await evaluate('document.activeElement.dataset.date'), '2026-11-18');
      await key('Enter', 'Enter', 13);
      await wait("!!document.querySelector('.agenda-empty')");
      assert.equal(await evaluate("document.querySelector('.agenda-empty').textContent"), messages.calendar.agenda.empty);
      assert.deepEqual(await evaluate("(()=>{const e=document.querySelector('.main-content');return {left:e.scrollLeft,overflow:e.scrollWidth>e.clientWidth,heading:Math.round(document.getElementById('agendaWeekTitle').getBoundingClientRect().left)};})()"), {left:0,overflow:false,heading:16});
      await snap(`${language}-${width}-empty`);
      await choose('2026-11-05');
      await evaluate("document.querySelector('.agenda-move').click()");
      assert.equal(await evaluate('document.activeElement.id'), 'moveTitle');
      assert.equal(await evaluate("document.getElementById('appView').closest('[inert]') !== null"), true);
      assert.equal(await evaluate("document.getElementById('moveDate').dataset.iso"), '2026-11-05');
      await snap(`${language}-${width}-move`);
      await key('Tab', 'Tab', 9, 8);
      for (let index = 0; index < 7; index++) {
        await key('Tab', 'Tab', 9);
        assert.equal(await evaluate("document.getElementById('moveModal').contains(document.activeElement)"), true);
      }
      // A DatePicker is the first Escape layer; the second closes the dialog.
      await evaluate("document.getElementById('moveDate').click()");
      await wait("document.getElementById('moveDate').getAttribute('aria-expanded') === 'true'");
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await key('Escape', 'Escape', 27);
      assert.equal(await evaluate("document.getElementById('moveModal').classList.contains('hidden')"), false);
      await key('Escape', 'Escape', 27);
      assert.equal(await evaluate('document.activeElement.classList.contains("agenda-move")'), true);
      // A same-date submit does not call the route.
      const calls = await evaluate("window.rescheduleCalls = 0; const original = window.fetch; window.fetch = (...args) => { if (String(args[0]).includes('/reschedule')) window.rescheduleCalls++; return original(...args); }; window.rescheduleCalls");
      assert.equal(calls, 0);
      await evaluate("document.querySelector('.agenda-move').click(); document.querySelector('#moveForm [type=submit]').click()");
      assert.equal(await evaluate('window.rescheduleCalls'), 0);
    }
    await viewport(1280);
    await open(language);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('calendarGrid')).display"), 'grid');
    assert.equal(await evaluate("document.getElementById('phoneCalendar').inert"), true);
    assert.equal(await evaluate("document.querySelector('.training-chip[data-training-id]').draggable"), true);
    await snap(`${language}-1280-grid`);
    if (await evaluate("matchMedia('(hover: hover)').matches")) {
      for (const selector of ['.training-chip[data-training-id]', '.chip-more']) {
        const point = await evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await wait(`getComputedStyle(document.querySelector('${selector} .chip-tooltip, ${selector} .custom-tooltip')).opacity === '1'`);
        const fits = await evaluate(`(()=>{const r=document.querySelector('${selector} .chip-tooltip, ${selector} .custom-tooltip').getBoundingClientRect();const bounds=document.querySelector('.main-content').getBoundingClientRect();return r.left>=bounds.left && r.right<=innerWidth && r.top>=bounds.top;})()`);
        assert.equal(fits, true, 'desktop tooltips stay within the scroll container and viewport');
      }
    }
  }
  // Default selection is today's week; month navigation selects today or the first.
  await viewport(390);
  await command('Page.navigate', { url: `${origin}/calendar.html` });
  await wait("!!document.querySelector('#miniMonth [aria-current=date]')");
  assert.equal(await evaluate("document.querySelector('#miniMonth [aria-current=date]').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.getElementById('nextMonthBtn').click()");
  assert.equal(await evaluate(`document.querySelector('#miniMonth [data-date$="-01"]:not(.outside)').getAttribute('aria-pressed')`), 'true');
  await evaluate("document.getElementById('prevMonthBtn').click()");
  assert.equal(await evaluate("document.querySelector('#miniMonth [aria-current=date]').getAttribute('aria-pressed')"), 'true');
  await open('en-US');

  // The live language switch rerenders a mounted calendar, as do week preferences.
  await viewport(390);
  await evaluate("document.getElementById('mobileMoreBtn').click()");
  await wait("!document.getElementById('mobileMoreSheet').hidden");
  await evaluate("document.querySelector('#mobileMoreSheet [data-lang=\"pt-BR\"]').click()");
  await wait(`document.querySelector('.agenda-status').textContent.includes(${JSON.stringify(pt.calendar.agenda.completed)})`);
  await key('Escape', 'Escape', 27);
  await evaluate("document.dispatchEvent(new CustomEvent('kinesis:preferences-changed', {detail:{first_day_of_week:'Sunday'}}))");
  assert.equal(await evaluate("document.querySelector('#miniMonth button').dataset.date"), '2026-11-01');
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate("document.querySelector('.agenda-move').click()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.move-card')).animationName"), 'none');
  // Cancel and backdrop restore focus; a rejected move reloads and keeps the dialog closed.
  await evaluate("document.getElementById('moveCancel').click()");
  assert.equal(await evaluate("document.activeElement.classList.contains('agenda-move')"), true);
  await evaluate("document.querySelector('.agenda-move').click(); document.getElementById('moveModal').click()");
  assert.equal(await evaluate("document.activeElement.classList.contains('agenda-move')"), true);
  await evaluate("window.savedFetch = window.fetch; window.fetch = (...args) => String(args[0]).includes('/reschedule') ? Promise.resolve(new Response(JSON.stringify({error:'Training not found.'}), {status:404, headers:{'content-type':'application/json'}})) : window.savedFetch(...args); document.querySelector('.agenda-move').click(); document.getElementById('moveDate').datePicker.setValue('2026-11-12'); document.querySelector('#moveForm [type=submit]').click()");
  await wait(`document.querySelector('.toast.visible')?.textContent.includes(${JSON.stringify(pt.calendar.reschedule.error)})`);
  assert.equal(db.prepare('SELECT dia FROM trainings WHERE id = 1').get().dia, '2026-11-05');
  assert.equal(await evaluate("document.getElementById('moveModal').classList.contains('hidden')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.agenda-card').length"), 4);
  assert.equal(await evaluate("document.getElementById('phoneCalendar').contains(document.activeElement)"), true);
  await evaluate("window.fetch = window.savedFetch; document.querySelector('.agenda-move').click()");
  await evaluate("document.getElementById('moveDate').datePicker.setValue('2026-11-12'); document.querySelector('#moveForm [type=submit]').click()");
  await wait("document.querySelector('.toast.visible')?.textContent.includes('12/11/2026')");
  assert.equal(db.prepare('SELECT dia FROM trainings WHERE id = 1').get().dia, '2026-11-12');
  assert.equal(await evaluate("document.querySelectorAll('.agenda-card').length"), 3, 'selection stays in current week');
  await open('pt-BR', '2026-11-09', 2); // two sessions now on Thursday
  assert.equal(await evaluate("document.querySelectorAll('.agenda-card').length"), 2);
  // Reference screens for the visual consistency check, using synthetic content.
  if (shots) {
    db.prepare("INSERT INTO shoes (id, user_id, brand, model) VALUES ('agenda-shoe', ?, 'Synthetic', 'Daily trainer')").run(owner);
    insert.run(owner, '2027-01-05', 'LEVE', 'Corrida confortável', 'Mantenha um ritmo confortável.', 0, null);
    for (const page of ['home', 'shoes']) {
      await command('Page.navigate', { url: `${origin}/${page}.html` });
      await wait("document.body.classList.contains('shell-mounted')");
      if (page === 'shoes') await wait("!!document.querySelector('.shoe-card')");
      else await wait("!!document.querySelector('.next-card')");
      await snap(`reference-${page}`);
      if (page === 'home') {
        await wait("!!document.querySelector('.next-name')");
        await evaluate("document.querySelector('.next-card').scrollIntoView({block:'center'})");
        await snap('reference-next-workout');
      }
    }
  }
  assert.deepEqual(exceptions, []);
});
