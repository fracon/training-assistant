'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { launchChrome } = require('./helpers/chrome.cjs');

const PT = require('../src/public/locales/pt.json').home;
const EN = require('../src/public/locales/en.json').home;
const EN_PERIOD = require('../src/public/locales/en.json').aiCoach.periods['08_12'];

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
  const next = training.run(userId, 'c', iso(0), '08_12', 'Longão', 'Longão progressivo', '60 min progressivo', '3', 'São Paulo, SP', 0, null, null, null).lastInsertRowid;
  db.prepare("INSERT INTO shoes(user_id,brand,model,mileage,target_mileage,status) VALUES (?,'Asics','Novablast',99,900,'active'),(?,'Adidas','Adios',190,200,'active')").run(userId, userId);
  return { next };
}

const view = `(() => {
  const body = document.getElementById('nextWorkoutBody');
  const action = document.getElementById('nextWorkoutAction');
  const inside = (card) => [...card.querySelectorAll('*')].filter((element) => element.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).map((element) => element.className);
  const grid = document.querySelector('.dashboard-grid');
  return {
    order: [...grid.children].map((card) => card.id || card.getAttribute('aria-labelledby')),
    name: body.querySelector('.next-name')?.textContent ?? null,
    when: body.querySelector('.next-when')?.textContent ?? null,
    meta: [...body.querySelectorAll('.next-meta')].map((line) => line.textContent),
    tiles: [...body.querySelectorAll('.metric-tile')].map((tile) => [tile.querySelector('.metric-label').textContent, tile.querySelector('.metric-value').textContent]),
    buttons: body.querySelectorAll('.btn-primary, .btn-secondary').length,
    action: { href: action.getAttribute('href'), label: action.getAttribute('aria-label') },
    pendingHidden: document.getElementById('pendingCard').hidden,
    pending: [...document.querySelectorAll('.pending-text')].map((item) => item.textContent),
    more: document.querySelector('.pending-more')?.textContent ?? null,
    total: document.getElementById('pendingTotal').textContent,
    wide: document.getElementById('nextWorkoutCard').classList.contains('is-wide'),
    empty: body.querySelector('.empty-state')?.textContent.trim() ?? null,
    overflow: [...inside(document.getElementById('nextWorkoutCard')), ...inside(document.getElementById('pendingCard'))],
  };
})()`;

async function open(browser, origin, cookie, width, mobile) {
  const { command, wait } = browser;
  await command('Network.clearBrowserCookies');
  await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
  await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
  await command('Page.navigate', { url: `${origin}/home.html` });
  await wait("document.body.classList.contains('shell-mounted') && document.getElementById('nextWorkoutBody').childElementCount > 0");
}

test('Chrome: the next-workout and pending row follows the existing widgets in PT/EN on desktop and phone', async (t) => {
  const { db, origin, account } = await setup(t);
  const athlete = await account('dash-browser@example.test');
  const { next } = seed(db, athlete.id);
  const browser = await launchChrome(t);
  const { evaluate, wait, key } = browser;

  for (const [width, mobile] of [[1280, false], [390, true]]) {
    await open(browser, origin, athlete.cookie, width, mobile);
    await wait("document.querySelectorAll('#nextWorkoutBody .metric-tile').length === 2");
    const pt = await evaluate(view);
    assert.deepEqual(pt.order.slice(-2), ['nextWorkoutCard', 'pendingCard'], 'the new row comes after the existing widgets');
    assert.equal(pt.name, 'Longão progressivo');
    assert.equal(pt.when, PT.next.today);
    assert.deepEqual(pt.meta, ['08h–12h · São Paulo, SP', PT.next.shoeSuggested.replace('{name}', 'Asics Novablast')]);
    assert.deepEqual(pt.tiles, [[PT.next.targetRpe, 'RPE 3'], [PT.next.forecast, '24 °C, Parcialmente nublado']]);
    assert.equal(pt.buttons, 0, 'the card navigates through its header action only');
    assert.deepEqual(pt.action, { href: `/training-result.html?id=${next}`, label: PT.next.open });
    assert.equal(pt.pendingHidden, false);
    assert.deepEqual(pt.pending, [PT.pending.items.results_one, PT.pending.items.effort_one, PT.pending.items.plan_outdated]);
    assert.equal(pt.more, PT.pending.more_one);
    assert.equal(pt.total, '4');
    assert.equal(pt.wide, false);
    assert.deepEqual(pt.overflow, [], `${width}px: the new cards keep their content inside`);
  }

  // Language switch re-renders both cards in place.
  await evaluate(`document.querySelector('.lang-switch [data-lang="en-US"]').click()`);
  await wait(`document.querySelector('.next-when')?.textContent === ${JSON.stringify(EN.next.today)}`);
  const en = await evaluate(view);
  assert.equal(en.meta[0], `${EN_PERIOD} · São Paulo, SP`);
  assert.equal(en.action.label, EN.next.open);
  assert.deepEqual(en.pending, [EN.pending.items.results_one, EN.pending.items.effort_one, EN.pending.items.plan_outdated]);
  assert.equal(en.more, EN.pending.more_one);

  // A forecast that arrives while a link is focused keeps that link focused.
  const held = await browser.intercept(`${origin}/api/weather*`);
  await browser.command('Page.navigate', { url: `${origin}/home.html` });
  const paused = await held.next;
  await wait("document.querySelector('.pending-item') !== null && document.querySelectorAll('#nextWorkoutBody .metric-tile').length === 1");
  await evaluate("document.getElementById('nextWorkoutAction').focus()");
  await held.release(paused);
  await wait("document.querySelectorAll('#nextWorkoutBody .metric-tile').length === 2");
  assert.equal(await evaluate("document.activeElement.id"), 'nextWorkoutAction');

  // A language switch rebuilds the pending list without losing the focused item.
  await evaluate("document.querySelector('.pending-item').focus()");
  await evaluate(`document.querySelector('.lang-switch [data-lang="pt-BR"]').click()`);
  await wait(`document.querySelector('.pending-text')?.textContent === ${JSON.stringify(PT.pending.items.results_one)}`);
  assert.equal(await evaluate("document.activeElement === document.querySelector('.pending-item')"), true);

  // Pending items are keyboard reachable with a visible focus ring.
  await evaluate("document.getElementById('nextWorkoutAction').focus()");
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
  assert.equal(await evaluate("document.querySelector('#nextWorkoutBody .empty-state h3').textContent"), PT.next.emptyTitle);
  assert.equal(await evaluate("document.querySelector('#nextWorkoutBody .empty-state .btn-primary').getAttribute('href')"), '/ai-coach.html',
    'the empty state is the same structure as the cycle and shoe cards');
  assert.deepEqual(state.action, { href: '/calendar.html', label: PT.actions.goToTrainings });
  assert.equal(state.pendingHidden, true);
  assert.equal(state.wide, true, 'the next-workout card takes the row when nothing is pending');

  const failing = await browser.intercept(`${origin}/api/dashboard`);
  await command('Page.navigate', { url: `${origin}/home.html` });
  const paused = await failing.next;
  await command('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Failed' });
  await failing.close();
  await wait(`document.querySelector('#nextWorkoutBody .empty-state')?.textContent === ${JSON.stringify(PT.dashboardError)}`);
  assert.equal(await evaluate("document.getElementById('pendingCard').hidden"), true);
});
