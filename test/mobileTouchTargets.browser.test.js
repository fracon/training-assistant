'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// Touch devices (pointer: coarse) at 320/360/390 px in PT/EN: every listed
// control has a 44x44 hit area, icon actions keep translated names, hover-only
// tooltips stay hidden and no page overflows horizontally; a fine pointer keeps
// the 32x32 desktop size. Set KINESIS_MOBILE_SHOTS=<dir> to keep screenshots
// for visual review. Synthetic data only.
const { mkdirSync, writeFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { completeAnamnesis } = require('./helpers/anamnesis.cjs');
const { launchChrome } = require('./helpers/chrome.cjs');

const shots = process.env.KINESIS_MOBILE_SHOTS || '';
const saveShot = (name, data) => { if (shots) writeFileSync(`${shots}/${name}.png`, Buffer.from(data, 'base64')); };

test('Chrome: mobile touch targets and overflow across PT/EN application pages', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const owner = Number(db.prepare("INSERT INTO users(email,password_hash,first_name,last_name,role,onboarding_status) VALUES ('mobile@example.test','unused','Mobile','Athlete','admin','active')").run().lastInsertRowid);
  completeAnamnesis(db, owner);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,primary_goal,status,start_date,target_date) VALUES ('mobile',?,'Half marathon','Finish comfortably','active',?,?)").run(owner, day(-30), day(60));
  const training = Number(db.prepare("INSERT INTO trainings(user_id,training_cycle_id,dia,tipo,treino,detalhes) VALUES (?,'mobile',?,'Run','Easy run','30 minutes easy')").run(owner, day(0)).lastInsertRowid);
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (?,'Example','Daily runner',100,700,'active')").run(owner);
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('Offline synthetic test'); } });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const { command, evaluate, wait } = await launchChrome(t, { extraArgs: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] });
  await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, owner).token, url: origin, httpOnly: true });
  const pages = [
    ['home', '.card-action, #nextWorkoutAction, #volumePrev, #volumeNext', "document.querySelector('#nextWorkoutBody .next-header')"],
    [`training-result?id=${training}`, '#deleteTrainingBtn', "document.getElementById('deleteTrainingBtn') && !document.getElementById('appView').hidden"],
    ['cycles', '.cycle-card-actions .btn-icon:not([hidden])', "document.querySelector('.cycle-card-actions')"],
    ['ai-coach', '.day-expand, .day-toggle', "document.querySelectorAll('.day-row').length === 7"],
    ['shoes', '.shoe-card-actions .btn-icon', "document.querySelector('.shoe-card-actions')"],
    ['records', '', "document.querySelectorAll('#recordsList > section').length === 4"],
    ['weight', '', "!document.getElementById('weightFormCard').hidden"],
    ['anamnesis', '.anamnesis-source-list a, #anamnesisOpenPreferences', "!document.getElementById('anamnesisReview').hidden"],
    ['training-memory', '.memory-source', "document.querySelector('.memory-source')"],
    ['admin-users', '.admin-page .btn-icon', "document.querySelector('.admin-page .btn-icon')"],
    ['admin-feedback', '', "document.getElementById('feedbackAdminLoading').classList.contains('hidden')"],
    ['admin-ai-history', '', "!document.getElementById('aiHistoryAccount').disabled"],
  ];
  const open = async (page, ready, language) => {
    const [name, query] = page.split('?');
    await command('Page.navigate', { url: `${origin}/${name}.html${query ? `?${query}` : ''}` });
    await wait(`document.body.classList.contains('shell-mounted') && document.documentElement.lang === '${language}' && (${ready})`);
    // Wait for the shared page entrance animation before measuring or capturing.
    await delay(400);
  };
  if (shots) mkdirSync(shots, { recursive: true });
  // Headless Chrome has no pointer by default. Start with a fine pointer,
  // then use CDP touch emulation for the mobile matrix below.
  db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run('en-US', owner);
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const [page, selector, ready] of [pages[0], pages[2], pages[4]]) {
    await t.test(`fine pointer desktop ${page}`, async () => {
      await open(page, ready, 'en-US');
      assert.equal(await evaluate("matchMedia('(pointer: fine)').matches"), true);
      const sizes = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getBoundingClientRect().height).map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height])`);
      assert.ok(sizes.length);
      for (const size of sizes) assert.deepEqual(size, [32, 32]);
    });
  }
  for (const [page, , ready] of [pages[5], pages[6], pages[10]]) {
    await open(page, ready, 'en-US');
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    saveShot(`${page}-desktop`, shot.data);
  }

  for (const language of ['pt-BR', 'en-US']) {
    db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(language, owner);
    for (const width of [320, 360, 390]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
      await command('Emulation.setEmitTouchEventsForMouse', { enabled: true });
      await command('Emulation.setTouchEmulationEnabled', { enabled: true });
      for (const [page, targets, ready] of pages) {
        await t.test(`${language} ${width}px ${page}`, async () => {
          await open(page, ready, language);
          assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), true);
          const overflow = await evaluate("(()=>{const m=document.querySelector('.main-content');return {scroll:m.scrollWidth,client:m.clientWidth};})()");
          assert.ok(overflow.scroll <= overflow.client, `${page}: ${JSON.stringify(overflow)}`);
          // The phone shell's own controls (tab bar, feedback, brand) are on every page.
          const selector = [targets, '.mobile-tabbar .tab-item', '#feedbackTrigger', '.topbar-brand'].filter(Boolean).join(', ');
          const sizes = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length && e.getBoundingClientRect().height).map(e=>({id:e.id || e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
          assert.ok(sizes.length, 'touch controls rendered');
          for (const size of sizes) assert.ok(size.width >= 44 && size.height >= 44, JSON.stringify(size));
          const unnamed = await evaluate("Array.from(document.querySelectorAll('.btn-icon, .card-action, .day-expand')).filter(e=>e.getBoundingClientRect().height && !e.getAttribute('aria-label')?.trim()).map(e=>e.id || e.className)");
          assert.deepEqual(unnamed, [], 'icon actions have translated accessible names');
          if (page === 'cycles') {
            await evaluate("document.querySelector('.cycle-card-actions .btn-icon').focus()");
            assert.equal(await evaluate("Array.from(document.querySelectorAll('.cycle-card-actions .custom-tooltip')).some(e=>getComputedStyle(e).display!=='none' && getComputedStyle(e).opacity==='1')"), false);
          }
          if (page === 'ai-coach') {
            assert.deepEqual(await evaluate("(()=>{const r=document.getElementById('targetDate').getBoundingClientRect();return [r.width,r.height]})()"), [1, 1], 'hidden ISO input stays out of layout');
            const before = await evaluate("document.querySelector('.day-toggle input').checked");
            await evaluate("document.querySelector('.day-toggle .day-label').click()");
            assert.equal(await evaluate("document.querySelector('.day-toggle input').checked"), !before, 'day text toggles checkbox');
          }
          if (page === 'admin-feedback') assert.equal(await evaluate("Array.from(document.querySelectorAll('.feedback-filters .field')).every(e=>e.querySelector('label').getBoundingClientRect().bottom <= e.querySelector('select').getBoundingClientRect().top)"), true);
          if (page === 'admin-ai-history') assert.equal(await evaluate("document.getElementById('aiHistoryAccount').getBoundingClientRect().width === document.querySelector('.ai-history-filters').getBoundingClientRect().width"), true);
          if (width === 360) {
            const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            saveShot(`${page.split('?')[0]}-${language}`, shot.data);
          }
        });
      }
    }
  }

});
