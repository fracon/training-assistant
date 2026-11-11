'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { launchChrome } = require('./helpers/chrome.cjs');

const PT = require('../src/public/locales/pt.json').home;
const EN = require('../src/public/locales/en.json').home;

// Synthetic forecast so no request leaves the machine.
const weatherFetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname.startsWith('geocoding'))
    return { ok: true, json: async () => ({ results: [{ name: 'São Paulo', latitude: -23.5, longitude: -46.6, country_code: 'BR', timezone: 'America/Sao_Paulo', country: 'Brasil', admin1: 'São Paulo' }] }) };
  return { ok: true, json: async () => ({ daily: { time: [parsed.searchParams.get('start_date')], temperature_2m_max: [24.4], weathercode: [2], weather_code: [2] } }) };
};

async function setup(t) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, weatherFetch, unsplashFetch: async () => { throw new Error('No hero image in tests.'); } });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  t.after(async () => { await app.close(); db.close(); });
  const account = async (email) => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'dash-secret-1', first_name: 'D', last_name: 'B', preferred_lang: 'pt-BR' } });
    db.prepare("UPDATE users SET onboarding_status='active', time_zone='UTC' WHERE email=?").run(email);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'dash-secret-1' } });
    return { id: db.prepare('SELECT id FROM users WHERE email=?').get(email).id, cookie: [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1] };
  };
  return { db, origin, account };
}

function seed(db, userId) {
  const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO training_cycles(id,user_id,objective,primary_goal,status,start_date,target_date) VALUES ('c',?,'Meia Maratona','Abaixo de 2h','active',?,?)").run(userId, iso(-30), iso(50));
  const phase = (name, a, b) => ({ name, start: iso(a), end: iso(b), objective: `${name} objetivo`, volume: 'v', longRuns: 'l', quality: 'q', intensity: 'i', easyRuns: 'e', strength: 's', risks: 'r', advanceCriteria: 'c', rationale: 'r', evidence: [] });
  const plan = { schemaVersion: 'cycle-plan-v1', cycleId: 'c', start: iso(-30), end: iso(50), assessment: 'a', continuity: 'c', feasibility: 'f', confidence: 'moderate',
    phases: [phase('Base', -30, -10), phase('Construção', -9, 25), phase('Polimento', 26, 50)], indicators: ['a', 'b', 'c', 'd', 'e'],
    adaptations: { increase: 'x', maintain: 'x', reduce: 'x', replaceQuality: 'x', reduceLongRun: 'x' }, uncertainties: [], assumptions: [], questions: [] };
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES ('p',?,'c',1,?,'h','h','{}','[]',?)").run(userId, JSON.stringify(plan), new Date().toISOString());
  db.pragma('foreign_keys = ON');
  const training = db.prepare('INSERT INTO trainings(user_id,training_cycle_id,dia,periodo,tipo,treino,detalhes,rpe,location,completed,feedback_rpe,fit_distance,fit_duration) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  training.run(userId, 'c', iso(-3), null, 'Intervalado', 'Tiros', null, null, null, 1, 5, 8, '45:00');
  training.run(userId, 'c', iso(-2), null, 'Rodagem', 'Rodagem leve', null, null, null, 0, null, null, null);
  training.run(userId, 'c', iso(-1), null, 'Rodagem', 'Trote', null, null, null, 1, null, 6, '33:00');
  const next = training.run(userId, 'c', iso(0), 'Antes das 08h', 'Longão', 'Longão progressivo', '60 min progressivo', '3', 'São Paulo, SP', 0, null, null, null).lastInsertRowid;
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (?,'Asics','Novablast',99,900,'active'),(?,'Adidas','Adios',190,200,'active')").run(userId, userId);
  return { next };
}

const view = `(() => ({
  when: document.querySelector('.next-when')?.textContent,
  name: document.querySelector('.next-name')?.textContent,
  facts: [...document.querySelectorAll('.next-fact')].map((fact) => fact.textContent),
  action: (() => { const a = document.querySelector('.next-actions a'); return a && { text: a.textContent, href: a.getAttribute('href') }; })(),
  last: document.querySelector('.next-last')?.textContent,
  pendingHidden: document.getElementById('pendingCard').hidden,
  pending: [...document.querySelectorAll('.pending-text')].map((item) => item.textContent),
  more: document.querySelector('.pending-more')?.textContent ?? null,
  total: document.getElementById('pendingTotal').textContent,
  wide: document.getElementById('nextWorkoutCard').classList.contains('is-wide'),
  phase: document.getElementById('cyclePhase').hidden ? null : document.getElementById('cyclePhase').textContent,
  notice: document.getElementById('cyclePlanNotice').hidden ? null : document.getElementById('cyclePlanNotice').textContent,
  week: document.getElementById('weeklyProgress').hidden ? null : document.getElementById('weeklyProgress').textContent,
  empty: document.querySelector('.next-empty')?.textContent ?? null,
  offscreen: [...document.querySelectorAll('main *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => element.className).slice(0, 4),
}))()`;

async function open(browser, origin, cookie, width, mobile) {
  const { command, wait } = browser;
  await command('Network.clearBrowserCookies');
  await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
  await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
  await command('Page.navigate', { url: `${origin}/home.html` });
  await wait("document.body.classList.contains('shell-mounted') && document.getElementById('nextWorkoutBody').childElementCount > 0");
}

test('Chrome: the dashboard shows the next workout, pending items, cycle phase and week progress in PT/EN on desktop and phone', async (t) => {
  const { db, origin, account } = await setup(t);
  const athlete = await account('dash-browser@example.test');
  const { next } = seed(db, athlete.id);
  const browser = await launchChrome(t);
  const { evaluate, wait, key } = browser;

  for (const [width, mobile] of [[1280, false], [390, true]]) {
    await open(browser, origin, athlete.cookie, width, mobile);
    await wait("document.querySelectorAll('.next-fact').length >= 4");
    const pt = await evaluate(view);
    assert.equal(pt.when, `${PT.next.today} · Antes das 08h`);
    assert.equal(pt.name, 'Longão progressivo');
    assert.ok(pt.facts.includes(PT.next.targetRpe.replace('{value}', '3')));
    assert.ok(pt.facts.some((fact) => fact.startsWith('24')), 'the forecast for the session is shown');
    assert.ok(pt.facts.includes(PT.next.shoeSuggested.replace('{name}', 'Asics Novablast')));
    assert.deepEqual(pt.action, { text: PT.next.record, href: `/training-result.html?id=${next}` });
    assert.ok(pt.last.includes('Trote'));
    assert.equal(pt.pendingHidden, false);
    assert.deepEqual(pt.pending, [
      PT.pending.items.results.replace('{count}', '1'),
      PT.pending.items.effort.replace('{count}', '1'),
      PT.pending.items.plan_outdated,
    ]);
    assert.equal(pt.more, PT.pending.more.replace('{count}', '1'));
    assert.equal(pt.total, '4');
    assert.equal(pt.wide, false);
    assert.equal(pt.phase, PT.cycle.phase.replace('{name}', 'Construção').replace('{objective}', 'Construção objetivo'));
    assert.equal(pt.notice, PT.cycle.planOutdated);
    assert.ok(pt.week.startsWith(PT.metrics.progress.split('{')[0]) || /\d/.test(pt.week));
    assert.deepEqual(pt.offscreen, [], `${width}px: nothing leaves the screen`);
  }

  // Language switch re-renders every card in place.
  await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
  await wait(`document.querySelector('.next-when')?.textContent.startsWith(${JSON.stringify(EN.next.today)})`);
  const en = await evaluate(view);
  assert.equal(en.action.text, EN.next.record);
  assert.equal(en.pending[2], EN.pending.items.plan_outdated);
  assert.equal(en.notice, EN.cycle.planOutdated);

  // A forecast that arrives while a link is focused keeps that link focused.
  const held = await browser.intercept(`${origin}/api/weather*`);
  await browser.command('Page.navigate', { url: `${origin}/home.html` });
  const paused = await held.next;
  await wait("document.querySelector('.next-actions a') !== null && document.querySelectorAll('.next-fact').length === 3");
  await evaluate("document.querySelector('.next-actions a').focus()");
  await held.release(paused);
  await wait("document.querySelectorAll('.next-fact').length === 4");
  assert.equal(await evaluate("document.activeElement === document.querySelector('.next-actions a')"), true);

  // A language switch rebuilds the pending list without losing the focused item.
  await evaluate("document.querySelector('.pending-item').focus()");
  await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
  await wait(`document.querySelector('.pending-text')?.textContent === ${JSON.stringify(PT.pending.items.results.replace('{count}', '1'))}`);
  assert.equal(await evaluate("document.activeElement === document.querySelector('.pending-item')"), true);

  // Pending items are keyboard reachable with a visible focus ring.
  await evaluate("document.querySelector('.next-last-link').focus()");
  await key('Tab', 'Tab', 9);
  const focus = await evaluate("(() => { const style = getComputedStyle(document.activeElement); return { pending: document.activeElement.classList.contains('pending-item'), ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 }; })()");
  assert.deepEqual(focus, { pending: true, ring: true });
});

test('Chrome: an empty account gets a request-workouts call to action, no pending card, and a failed read says so', async (t) => {
  const { origin, account } = await setup(t);
  const empty = await account('dash-empty@example.test');
  const browser = await launchChrome(t);
  const { command, evaluate, wait } = browser;
  await open(browser, origin, empty.cookie, 1280, false);
  const state = await evaluate(view);
  assert.equal(state.empty, PT.next.empty);
  assert.equal(await evaluate("document.querySelector('#nextWorkoutBody .btn-primary').getAttribute('href')"), '/ai-coach.html');
  assert.equal(state.pendingHidden, true);
  assert.equal(state.wide, true, 'the next-workout card takes the row when nothing is pending');
  assert.equal(state.week, null);

  const failing = await browser.intercept(`${origin}/api/dashboard`);
  await command('Page.navigate', { url: `${origin}/home.html` });
  const paused = await failing.next;
  await command('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Failed' });
  await failing.close();
  await wait(`document.querySelector('.next-empty')?.textContent === ${JSON.stringify(PT.dashboardError)}`);
  assert.equal(await evaluate("document.getElementById('pendingCard').hidden"), true);
});
