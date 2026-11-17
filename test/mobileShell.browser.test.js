'use strict';

// Phone shell (owner decision 2026-11-17) in real Chrome: below 641px the
// sidebar gives way to a bottom tab bar (Home, Workouts, Request Workouts,
// Cycles, More) and the More sheet carries the remaining sections, the
// administration group (admins only, absent from the DOM otherwise), the
// account menu, language and sign-out. Checks PT/EN, focus containment,
// Escape/backdrop, focus restoration, the cycle guard and the anamnesis lock,
// and that the desktop shell is unchanged. Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { SESSION_COOKIE_NAME, createSession } = require('../src/auth/sessions');
const { completeAnamnesis } = require('./helpers/anamnesis.cjs');
const { launchChrome } = require('./helpers/chrome.cjs');
const en = require('../src/public/locales/en.json');
const pt = require('../src/public/locales/pt.json');

const visible = (selector) => `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden';})()`;

test('Chrome PT/EN phone/desktop: bottom tab bar, More sheet, guards and the anamnesis lock', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const insertUser = db.prepare("INSERT INTO users (email, password_hash, first_name, last_name, onboarding_status, preferred_lang, role) VALUES (?, 'unused', ?, 'Runner', 'active', ?, ?)");
  const admin = Number(insertUser.run('admin@example.test', 'Ada', 'pt-BR', 'admin').lastInsertRowid);
  const regular = Number(insertUser.run('regular@example.test', 'Rui', 'en-US', 'user').lastInsertRowid);
  const pending = Number(insertUser.run('pending@example.test', 'Pia', 'pt-BR', 'user').lastInsertRowid);
  completeAnamnesis(db, admin, regular);
  db.prepare("INSERT INTO training_cycles (id, user_id, objective, target_date, status, start_date) VALUES ('cycle-admin', ?, 'Synthetic race', '2027-03-08', 'active', '2026-10-01')").run(admin);

  const app = await buildServer({ db, sessionCookieSecure: false });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const { command, evaluate, wait, key, socket } = await launchChrome(t);
  const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  await command('Runtime.enable');

  const signIn = async (userId) => {
    await command('Network.clearBrowserCookies');
    await command('Network.setCookie', { name: SESSION_COOKIE_NAME, value: createSession(db, userId).token, url: origin, httpOnly: true });
  };
  const viewport = (width, height = 800) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 641 });
  const open = async (path, language) => {
    await command('Page.navigate', { url: `${origin}${path}` });
    await wait(`document.body.classList.contains('shell-mounted') && document.documentElement.lang === '${language}' && !!document.getElementById('mobileMoreBtn')`);
  };
  const openSheet = async () => {
    await evaluate("document.getElementById('mobileMoreBtn').click()");
    await wait("!document.getElementById('mobileMoreSheet').hidden && document.activeElement?.id === 'mobileMoreTitle'");
  };
  const tabs = "[...document.querySelectorAll('.mobile-tabbar > .tab-item')].map((e)=>({id:e.dataset.navId||e.id,label:e.querySelector('.tab-label').textContent,current:e.getAttribute('aria-current'),active:e.classList.contains('active'),h:Math.round(e.getBoundingClientRect().height)}))";

  for (const [language, messages, userId, width] of [['pt-BR', pt, admin, 390], ['en-US', en, regular, 360]]) {
    const s = messages.shell;
    await signIn(userId);
    await viewport(width);
    await open('/home.html', language);

    // Phone chrome: no sidebar or version footer, a compact top bar, the tab bar.
    assert.equal(await evaluate(visible('.app-shell > .sidebar')), false, 'the sidebar is not shown on phones');
    assert.equal(await evaluate(visible('.main-column > .bottom-bar')), false, 'the version footer moves into More');
    assert.equal(await evaluate(visible('.topbar-brand')), true);
    assert.equal(await evaluate(visible('#feedbackTrigger')), true, 'feedback stays one tap away');
    for (const id of ['userBadge', 'logoutBtn']) assert.equal(await evaluate(visible(`#${id}`)), false, `${id} lives in More on phones`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page scroll');
    const tabBar = await evaluate("(()=>{const r=document.querySelector('.mobile-tabbar').getBoundingClientRect();return {bottom:Math.round(r.bottom),width:Math.round(r.width)};})()");
    assert.deepEqual(tabBar, { bottom: 800, width }, 'the tab bar spans the bottom edge');
    const homeTabs = await evaluate(tabs);
    assert.deepEqual(homeTabs.map((tab) => tab.id), ['dashboard', 'calendar', 'ai-coach', 'cycles', 'mobileMoreBtn']);
    assert.deepEqual(homeTabs.map((tab) => tab.label), [s.tabs.home, s.tabs.workouts, s.tabs.request, s.tabs.cycles, s.tabs.more]);
    assert.ok(homeTabs.every((tab) => tab.h >= 44), 'every tab is a comfortable touch target');
    assert.deepEqual(homeTabs.filter((tab) => tab.active).map((tab) => [tab.id, tab.current]), [['dashboard', 'page']]);
    // Visible short labels stay inside the full accessible names.
    for (const [id, labelKey] of [['calendar', 'workouts'], ['ai-coach', 'requestWorkouts'], ['cycles', 'cycles']]) {
      const name = await evaluate(`document.querySelector('.mobile-tabbar [data-nav-id="${id}"]').getAttribute('aria-label')`);
      assert.equal(name, s.nav[labelKey]);
    }

    // The cycle guard covers the tabs: only the admin has an active cycle.
    const guarded = await evaluate("['calendar','ai-coach'].map((id)=>{const e=document.querySelector(`.mobile-tabbar [data-nav-id=\"${id}\"]`);return [e.getAttribute('aria-disabled'),e.hasAttribute('href'),(e.getAttribute('aria-describedby')||'')];})");
    if (userId === admin) assert.deepEqual(guarded.map(([disabled, href]) => [disabled, href]), [[null, true], [null, true]]);
    else assert.deepEqual(guarded, [['true', false, 'cycle-guard-calendar-tab-description'], ['true', false, 'cycle-guard-ai-coach-tab-description']]);

    // More: a modal sheet with its heading focused and the app inert behind it.
    await openSheet();
    assert.equal(await evaluate("document.getElementById('mobileMoreBtn').getAttribute('aria-expanded')"), 'true');
    assert.equal(await evaluate("document.querySelector('.app-shell').hasAttribute('inert')"), true);
    assert.equal(await evaluate("document.getElementById('mobileMoreTitle').textContent"), s.tabs.more);
    assert.equal(await evaluate("document.getElementById('mobileSheetIdentity').textContent"), userId === admin ? 'Ada Runner' : 'Rui Runner');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-sheet-nav > .nav-item')].map((e)=>e.getAttribute('href'))"), ['/shoes.html', '/records.html', '/weight.html']);
    assert.equal(await evaluate("document.querySelector('.mobile-sheet [data-nav-group]') !== null"), userId === admin, 'the administration group exists only for admins');
    if (userId === admin) {
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-sheet [data-nav-group] .nav-item')].map((e)=>e.getAttribute('href'))"), ['/admin-users.html', '/admin-feedback.html', '/admin-ai-history.html']);
    }
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-sheet-section .user-menu-item')].map((e)=>e.textContent.trim())"),
      [s.setupGuide, s.anamnesis, messages.memory.title, s.changePassword, s.preferences]);
    assert.equal(await evaluate("document.getElementById('mobileAppVersion').textContent"), `v${require('../package.json').version}`);
    const small = await evaluate("[...document.querySelectorAll('.mobile-sheet a[href], .mobile-sheet button')].filter((e)=>e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e)=>e.className||e.id)");
    assert.deepEqual(small, [], 'every sheet control is at least 44px tall');

    // Tab stays inside the sheet in both directions.
    await key('Tab', 'Tab', 9);
    assert.equal(await evaluate("document.activeElement?.id"), 'mobileMoreClose');
    await key('Tab', 'Tab', 9, 8);
    assert.equal(await evaluate("!!document.activeElement?.closest('.mobile-sheet-footer')"), true, 'Shift+Tab wraps to the last control');
    await key('Tab', 'Tab', 9);
    assert.equal(await evaluate("document.activeElement?.id"), 'mobileMoreClose', 'Tab wraps back to the first control');

    // Escape closes and returns focus to More; the backdrop and close button also close.
    await key('Escape', 'Escape', 27);
    await wait("document.getElementById('mobileMoreSheet').hidden && document.activeElement?.id === 'mobileMoreBtn'");
    assert.equal(await evaluate("document.getElementById('mobileMoreBtn').getAttribute('aria-expanded')"), 'false');
    assert.equal(await evaluate("document.querySelector('.app-shell').hasAttribute('inert')"), false);
    await openSheet();
    await evaluate("document.getElementById('mobileMoreSheet').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    await wait("document.getElementById('mobileMoreSheet').hidden && document.activeElement?.id === 'mobileMoreBtn'");
    await openSheet();
    await evaluate("document.getElementById('mobileMoreClose').click()");
    await wait("document.getElementById('mobileMoreSheet').hidden && document.activeElement?.id === 'mobileMoreBtn'");

    // Account actions forward to the shell's existing controls.
    await openSheet();
    await evaluate("document.querySelector('.mobile-sheet [data-shell-proxy=\"userPreferences\"]').click()");
    await wait("document.getElementById('preferencesModal') && !document.getElementById('preferencesModal').classList.contains('hidden')");
    assert.equal(await evaluate("document.getElementById('mobileMoreSheet').hidden"), true);
    await key('Escape', 'Escape', 27);
    await wait("document.getElementById('preferencesModal').classList.contains('hidden')");

    // The sheet's language switch drives the whole application.
    const other = language === 'pt-BR' ? ['en-US', en] : ['pt-BR', pt];
    await openSheet();
    await evaluate(`document.querySelector('.mobile-sheet-footer [data-lang="${other[0]}"]').click()`);
    await wait(`document.documentElement.lang === '${other[0]}'`);
    assert.equal(await evaluate("document.querySelector('#mobileMoreBtn .tab-label').textContent"), other[1].shell.tabs.more);
    assert.equal(await evaluate("document.getElementById('mobileMoreTitle').textContent"), other[1].shell.tabs.more);
    assert.equal(await evaluate(`document.querySelector('.mobile-sheet-footer [data-lang="${other[0]}"]').classList.contains('active')`), true);
    await evaluate(`document.querySelector('.mobile-sheet-footer [data-lang="${language}"]').click()`);
    await wait(`document.documentElement.lang === '${language}'`);

    // Widening past the phone breakpoint closes the sheet; the desktop shell is unchanged.
    await viewport(1280);
    await wait("document.getElementById('mobileMoreSheet').hidden");
    assert.equal(await evaluate("document.querySelector('.app-shell').hasAttribute('inert')"), false);
    assert.equal(await evaluate(visible('.app-shell > .sidebar')), true);
    assert.equal(await evaluate(visible('.main-column > .bottom-bar')), true);
    assert.equal(await evaluate(visible('.mobile-tabbar')), false);
    assert.equal(await evaluate(visible('.topbar-brand')), false);
    assert.equal(await evaluate(visible('#userBadge')), true);

    // A page that lives in the sheet marks More as the current section.
    await viewport(width);
    await open('/shoes.html', language);
    const shoeTabs = await evaluate(tabs);
    assert.deepEqual(shoeTabs.filter((tab) => tab.active).map((tab) => tab.id), ['mobileMoreBtn']);
    await openSheet();
    assert.equal(await evaluate("document.querySelector('.mobile-sheet-nav .nav-item.active')?.getAttribute('aria-current')"), 'page');
  }

  // The anamnesis lock reaches the tabs and the sheet; More, the account,
  // language and sign-out stay available.
  await signIn(pending);
  await viewport(390);
  await open('/anamnesis.html', 'pt-BR');
  await wait("!!document.getElementById('anamnesisLockNoteSheet')");
  const lockedTabs = await evaluate("[...document.querySelectorAll('.mobile-tabbar .nav-item, .mobile-sheet .nav-item')].map((e)=>[e.dataset.navId,e.getAttribute('aria-disabled'),e.hasAttribute('href'),(e.getAttribute('aria-describedby')||'').split(' ').includes(e.closest('.mobile-sheet')?'anamnesisLockNoteSheet':'anamnesisLockNote')])");
  assert.ok(lockedTabs.length === 7 && lockedTabs.every(([, disabled, href, described]) => disabled === 'true' && !href && described), JSON.stringify(lockedTabs));
  assert.equal(await evaluate("document.getElementById('mobileMoreBtn').disabled || document.getElementById('mobileMoreBtn').getAttribute('aria-disabled')"), null);
  await openSheet();
  assert.equal(await evaluate(visible('#anamnesisLockNoteSheet')), true);
  assert.equal(await evaluate("document.querySelector('#anamnesisLockNoteSheet .nav-lock-title').textContent"), pt.shell.anamnesisLockTitle);
  assert.equal(await evaluate("[...document.querySelectorAll('.mobile-sheet-section .user-menu-item, .mobile-sheet-footer button')].every((e)=>!e.disabled && e.getAttribute('aria-disabled')!=='true')"), true);
  await key('Escape', 'Escape', 27);
  await wait("document.getElementById('mobileMoreSheet').hidden");
  // Completing releases every entry and removes both notes.
  await evaluate("import('/shared/shell.js').then((m)=>m.releaseAnamnesisLock())");
  await wait("!document.getElementById('anamnesisLockNoteSheet') && !document.getElementById('anamnesisLockNote')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-sheet .nav-item')].map((e)=>[e.getAttribute('href'),e.getAttribute('aria-disabled'),e.getAttribute('aria-describedby')])"),
    [['/shoes.html', null, null], ['/records.html', null, null], ['/weight.html', null, null]]);

  assert.deepEqual(exceptions, []);
});
