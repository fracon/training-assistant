'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { launchChrome } = require('./helpers/chrome.cjs');

const LOCALES = { 'pt-BR': require('../src/public/locales/pt.json').memory, 'en-US': require('../src/public/locales/en.json').memory };
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'short', width: 1280, height: 520, mobile: false },
];

async function setup(t) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No hero image in tests.'); } });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  t.after(async () => { await app.close(); db.close(); });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'layout@example.test', password: 'layout-secret-1', first_name: 'Lay', last_name: 'Out', preferred_lang: 'pt-BR' } });
  db.prepare("UPDATE users SET onboarding_status='active', time_zone='UTC'").run();
  const today = new Date().toISOString().slice(0, 10);
  const day = (n) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date,primary_goal) VALUES ('c',1,'Meia maratona','active',?,?,'Abaixo de 2h')").run(day(-60), day(60));
  const insert = db.prepare('INSERT INTO trainings(user_id,dia,tipo,treino,detalhes,completed,feedback_rpe,feedback_has_pain,feedback_pain,fit_distance,fit_duration) VALUES (1,?,?,?,?,?,?,?,?,?,?)');
  for (let n = -40; n <= 6; n += 2) {
    const done = n < 0;
    insert.run(day(n), 'Run', n % 6 === 0 ? 'Longão' : 'Rodagem leve', '45 min leve', done ? 1 : 0, done ? 3 + (n % 3 === 0 ? 1 : 0) : null,
      n === -4 ? 'yes' : done ? 'no' : null, n === -4 ? 'Canela' : null, done ? 9 : null, done ? '50:00' : null);
  }
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (1,'Nike','Pegasus',410,700,'active')").run();
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const availability = db.prepare('INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES (1,?,?,?,?,?)');
  days.forEach((name, i) => availability.run(name, i % 2 ? 0 : 1, i % 2 ? '[]' : '["before_08"]', i % 2 ? null : 60, i % 2 ? '' : 'São Paulo, SP'));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'layout@example.test', password: 'layout-secret-1' } });
  return { origin, cookie: [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1] };
}

const layout = `(() => {
  const cards = [...document.querySelectorAll('.memory-summary-grid > .memory-section')].map((card) => {
    const box = card.getBoundingClientRect();
    return { height: Math.round(box.height), top: Math.round(box.top), updated: Math.round(card.querySelector('.memory-updated')?.getBoundingClientRect().bottom ?? -1) };
  });
  const wide = [...document.querySelectorAll('main *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => element.className).slice(0, 5);
  return {
    overflow: document.documentElement.scrollWidth > innerWidth, wide, cards,
    stats: [...document.querySelectorAll('.memory-stat-label')].map((label) => label.textContent),
    quality: document.querySelectorAll('.memory-quality-item').length,
    title: document.querySelector('main h1').textContent.trim(),
  };
})()`;

test('Chrome: the training memory layout holds in PT/EN on desktop, phone and short screens, with visible keyboard focus', async (t) => {
  const { origin, cookie } = await setup(t);
  const browser = await launchChrome(t);
  const { command, evaluate, wait, key } = browser;
  await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const [language, messages] of Object.entries(LOCALES)) {
    for (const viewport of VIEWPORTS) {
      await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
      await command('Page.navigate', { url: `${origin}/training-memory.html` });
      await wait("document.body.classList.contains('shell-mounted') && !!document.querySelector('.lang-switch')");
      await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
      await wait(`document.documentElement.lang === '${language}' && document.querySelectorAll('.memory-stat').length === 4`);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const view = await evaluate(layout);
      const label = `${language} ${viewport.name}`;
      assert.equal(view.overflow, false, `${label}: no horizontal page scroll (${view.wide.join(', ')})`);
      assert.equal(view.title, messages.title, label);
      assert.deepEqual(view.stats, [messages.stats.volume, messages.stats.consistency, messages.stats.effort, messages.stats.alerts], label);
      assert.ok(view.quality >= 5, label);
      if (!viewport.mobile) {
        const [goals, availability] = view.cards;
        assert.equal(goals.top, availability.top, `${label}: goals and availability side by side`);
        assert.equal(goals.height, availability.height, `${label}: one shared height`);
        assert.equal(goals.updated, availability.updated, `${label}: aligned "Updated" lines`);
      }
    }
  }

  // Keyboard: tabs and checklist links are reachable and show a visible focus ring.
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.getElementById('purposeTab-cycle').blur(); document.querySelector('.memory-header h1').focus()");
  const ring = async () => evaluate(`(() => { const style = getComputedStyle(document.activeElement); return { id: document.activeElement.id, link: document.activeElement.dataset.memoryLink ?? null, visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 }; })()`);
  let focused = null;
  for (let step = 0; step < 40; step += 1) {
    await key('Tab', 'Tab', 9);
    focused = await ring();
    if (focused.id === 'purposeTab-cycle') break;
  }
  assert.equal(focused.id, 'purposeTab-cycle');
  assert.equal(focused.visible, true, 'the selected tab shows a focus ring');
  for (let step = 0; step < 40; step += 1) {
    await key('Tab', 'Tab', 9);
    focused = await ring();
    if (focused.link?.startsWith('quality:')) break;
  }
  assert.ok(focused.link?.startsWith('quality:'), 'a checklist action is keyboard reachable');
  assert.equal(focused.visible, true, 'checklist actions show a focus ring');
});
