'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { readAiConfig } = require('../src/ai/config');
const { buildContext, projectContextForModel } = require('../src/ai/context');
const { isValidTimeZone, localDate, userToday, MAX_TIME_ZONE_LENGTH } = require('../src/time-zone');

test('time zones are validated as IANA names and "today" follows the zone, with UTC as the fallback', (t) => {
  assert.equal(isValidTimeZone('America/Sao_Paulo'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  for (const value of ['Not/AZone', '', null, 42, 'A'.repeat(MAX_TIME_ZONE_LENGTH + 1)])
    assert.equal(isValidTimeZone(value), false);
  // 01:30 UTC on Nov 12 is still Nov 11 in São Paulo (UTC-3) and already Nov 12 in Tokyo.
  const instant = new Date('2026-11-12T01:30:00Z');
  assert.equal(localDate('America/Sao_Paulo', instant), '2026-11-11');
  assert.equal(localDate('Asia/Tokyo', instant), '2026-11-12');
  assert.equal(localDate(null, instant), '2026-11-12');
  assert.equal(localDate('Not/AZone', instant), '2026-11-12');
  assert.equal(typeof localDate('UTC'), 'string');

  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash,time_zone) VALUES (1,'zone@example.invalid','x','America/Sao_Paulo'),(2,'utc@example.invalid','x',NULL)").run();
  assert.equal(userToday(db, 1, instant), '2026-11-11');
  assert.equal(userToday(db, 2, instant), '2026-11-12');
  assert.equal(userToday(db, 99, instant), '2026-11-12');
  assert.equal(typeof userToday(db, 1), 'string');
});

test('the AI context defaults "today" to the account time zone and an explicit date still wins', (t) => {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash,time_zone) VALUES (1,'ctx@example.invalid','x','Pacific/Kiritimati')").run();
  const config = readAiConfig({});
  const context = buildContext(db, 1, { purpose: 'cycle', config });
  assert.equal(context.asOf, localDate('Pacific/Kiritimati'));
  assert.equal(buildContext(db, 1, { purpose: 'cycle', config, asOf: '2026-10-14' }).asOf, '2026-10-14');
});

test('the model projection drops empty session fields, snapshot hashes and source versions but never mutates the snapshot', () => {
  const snapshot = {
    purpose: 'analysis',
    hash: 'internal',
    _freshnessExecutionId: 'execution',
    resource: {
      source: { type: 'training', id: '1', version: 'v' },
      planned: { authority: 'planned', treino: 'Run', detalhes: null, rpe: '' },
      actual: { authority: 'recorded_fact', completed: false, fit_distance: null },
      report: { authority: 'user_report', feedback_rpe: 3, feedback_pain: undefined },
      gaps: ['fit_distance'],
    },
    weekly: [{ authority: 'derived_fact', averageRpe: null }],
  };
  const projected = projectContextForModel(snapshot);
  assert.equal(projected.hash, undefined);
  assert.equal(projected._freshnessExecutionId, undefined);
  assert.deepEqual(projected.resource, {
    source: { type: 'training', id: '1' },
    planned: { authority: 'planned', treino: 'Run' },
    actual: { authority: 'recorded_fact', completed: false },
    report: { authority: 'user_report', feedback_rpe: 3 },
    gaps: ['fit_distance'],
  });
  // Outside session views an explicit null keeps its meaning (unknown average).
  assert.deepEqual(projected.weekly, [{ authority: 'derived_fact', averageRpe: null }]);
  assert.equal(snapshot.hash, 'internal');
  assert.equal(snapshot.resource.planned.detalhes, null);
  assert.equal(projectContextForModel(undefined), undefined);
});

test('PUT /api/users/me/time-zone stores a valid IANA zone for the signed-in account only', async (t) => {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });
  t.after(async () => { await app.close(); db.close(); });
  const anonymous = await app.inject({ method: 'PUT', url: '/api/users/me/time-zone', payload: { time_zone: 'UTC' } });
  assert.equal(anonymous.statusCode, 401);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'tz@example.test', password: 'zone-secret-1', first_name: 'T', last_name: 'Z' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tz@example.test', password: 'zone-secret-1' } });
  const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/users/me/time-zone', headers: { cookie }, payload });
  for (const payload of [{ time_zone: 'Not/AZone' }, { time_zone: 'UTC', extra: 1 }, {}, ['UTC']]) {
    const refused = await put(payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
  }
  const empty = await app.inject({ method: 'PUT', url: '/api/users/me/time-zone', headers: { cookie } });
  assert.equal(empty.statusCode, 400);
  const saved = await put({ time_zone: 'America/Sao_Paulo' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { time_zone: 'America/Sao_Paulo' });
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().user.time_zone, 'America/Sao_Paulo');
});

test('Chrome: the shell stores the browser time zone once and leaves a matching zone untouched', async (t) => {
  const { launchChrome } = require('./helpers/chrome.cjs');
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No hero image in tests.'); } });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  t.after(async () => { await app.close(); db.close(); });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'shell-zone@example.test', password: 'zone-secret-1', first_name: 'S', last_name: 'Z' } });
  db.prepare("UPDATE users SET onboarding_status='active'").run();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shell-zone@example.test', password: 'zone-secret-1' } });
  const token = [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1];
  const browser = await launchChrome(t);
  let writes = 0;
  browser.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/api/users/me/time-zone')) writes += 1;
  });
  await browser.command('Emulation.setTimezoneOverride', { timezoneId: 'America/Sao_Paulo' });
  await browser.command('Network.setCookie', { name: 'ta_session', value: token, url: origin, httpOnly: true });
  for (let visit = 0; visit < 2; visit += 1) {
    await browser.command('Page.navigate', { url: `${origin}/home.html` });
    await browser.wait("document.body.classList.contains('shell-mounted')");
  }
  assert.equal(db.prepare('SELECT time_zone FROM users').get().time_zone, 'America/Sao_Paulo');
  assert.equal(writes, 1, 'the second visit already matches and writes nothing');
});

test('prior experience is dated with the athlete civil date', (t) => {
  const { saveProfile } = require('../src/ai/memory');
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash,time_zone) VALUES (1,'exp@example.invalid','x','America/Sao_Paulo')").run();
  const saved = saveProfile(db, 1, { fields: { experience: 'Two 10 km races.' }, expected_version: 0 }, '2026-11-12T01:30:00.000Z');
  assert.equal(saved.profile.fields.experience.observedOn, '2026-11-11');
});
