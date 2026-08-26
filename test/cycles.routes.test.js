'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'CycleRunner@Example.com',
  password: 'super-secret-1',
  first_name: 'Cycle',
  last_name: 'Runner',
};

async function setup() {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false });

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: REGISTER_PAYLOAD,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password },
  });
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];

  const userId = db
    .prepare('SELECT id FROM users WHERE lower(email) = lower(?)')
    .get(REGISTER_PAYLOAD.email).id;

  return { db, app, cookie, userId };
}

function seedCycle(db, userId, overrides = {}) {
  const crypto = require('node:crypto');
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO training_cycles (id, user_id, objective, target_date, distance, run_before, run_count, primary_goal, secondary_goal, start_date, other_events, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    id,
    userId,
    overrides.objective ?? 'Marathon',
    overrides.target_date ?? '2026-12-01',
    overrides.distance ?? '42km',
    overrides.run_before ?? '5k',
    overrides.run_count ?? 3,
    overrides.primary_goal ?? 'Finish',
    overrides.secondary_goal ?? 'Sub 4h',
    overrides.start_date ?? '2026-09-01',
    overrides.other_events ?? '',
    overrides.status ?? 'active'
  );
  return id;
}

/* ── Authentication ── */

test('GET /api/cycles requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/cycles' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/cycles/active requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/cycles/active' });
  assert.equal(res.statusCode, 401);
});

test('POST /api/cycles requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/cycles', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('PUT /api/cycles/:id requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'PUT', url: '/api/cycles/fake', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('DELETE /api/cycles/:id requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'DELETE', url: '/api/cycles/fake' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/cycles/:id/prompt requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/cycles/fake/prompt' });
  assert.equal(res.statusCode, 401);
});

/* ── GET /api/cycles ── */

test('GET /api/cycles returns empty array for user with no cycles', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().cycles, []);
});

test('GET /api/cycles returns all cycles for the authenticated user', async () => {
  const { db, app, cookie, userId } = await setup();
  seedCycle(db, userId, { objective: 'Marathon' });
  seedCycle(db, userId, { objective: 'Half Marathon', status: 'completed' });

  const res = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycles.length, 2);
});

test("GET /api/cycles does not return another user's cycles", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  seedCycle(db, otherId, { objective: '5k' });

  const res = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(res.json().cycles.length, 0);
});

/* ── GET /api/cycles/active ── */

test('GET /api/cycles/active returns null when no active cycle exists', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/cycles/active', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle, null);
});

test('GET /api/cycles/active returns the active cycle', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { objective: 'Marathon', status: 'active' });

  const res = await app.inject({ method: 'GET', url: '/api/cycles/active', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle.id, id);
  assert.equal(res.json().cycle.objective, 'Marathon');
});

test('GET /api/cycles/active returns null when only completed cycles exist', async () => {
  const { db, app, cookie, userId } = await setup();
  seedCycle(db, userId, { status: 'completed' });

  const res = await app.inject({ method: 'GET', url: '/api/cycles/active', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle, null);
});

/* ── POST /api/cycles ── */

test('POST /api/cycles creates a cycle and returns 201', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: {
      objective: 'Marathon',
      target_date: '2026-12-01',
      distance: '42km',
      run_before: '5k',
      run_count: 3,
      primary_goal: 'Finish',
      secondary_goal: 'Sub 4h',
      start_date: '2026-09-01',
      other_events: 'Party on Nov',
      status: 'active',
    },
  });
  assert.equal(res.statusCode, 201);
  const { cycle } = res.json();
  assert.ok(cycle.id);
  assert.equal(cycle.objective, 'Marathon');
  assert.equal(cycle.target_date, '2026-12-01');
  assert.equal(cycle.distance, '42km');
  assert.equal(cycle.run_before, '5k');
  assert.equal(cycle.run_count, 3);
  assert.equal(cycle.primary_goal, 'Finish');
  assert.equal(cycle.secondary_goal, 'Sub 4h');
  assert.equal(cycle.start_date, '2026-09-01');
  assert.equal(cycle.other_events, 'Party on Nov');
  assert.equal(cycle.status, 'active');
});

test('POST /api/cycles defaults status to active', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: '5k Race' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().cycle.status, 'active');
});

test('POST /api/cycles creates a non-active cycle without conflict', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: '5k Race', status: 'completed' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().cycle.status, 'completed');
});

test('POST /api/cycles rejects missing objective', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { status: 'active' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /objective is required/);
});

test('POST /api/cycles rejects empty objective', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: '   ' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /objective is required/);
});

test('POST /api/cycles rejects invalid status', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'Marathon', status: 'wip' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status must be one of/);
});

test('POST /api/cycles rejects empty body', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/cycles rejects duplicate active cycle', async () => {
  const { db, app, cookie, userId } = await setup();
  seedCycle(db, userId, { status: 'active' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'Another Marathon', status: 'active' },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /active cycle already exists/);
});

test('POST /api/cycles rejects negative run_count', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'Marathon', run_count: -1 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /run_count must be null or a non-negative number/);
});

/* ── PUT /api/cycles/:id ── */

test('PUT /api/cycles/:id updates a cycle and returns the updated row', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { objective: 'Marathon', status: 'active' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { objective: 'Ultra Marathon', status: 'completed' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle.objective, 'Ultra Marathon');
  assert.equal(res.json().cycle.status, 'completed');
});

test('PUT /api/cycles/:id returns 404 for non-existent cycle', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'PUT',
    url: '/api/cycles/non-existent-id',
    headers: { cookie },
    payload: { objective: 'Updated' },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Cycle not found.' });
});

test("PUT /api/cycles/:id returns 404 for another user's cycle", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const id = seedCycle(db, otherId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { objective: 'Hacked' },
  });
  assert.equal(res.statusCode, 404);
});

test('PUT /api/cycles/:id rejects invalid status', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { status: 'invalid' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status must be one of/);
});

test('PUT /api/cycles/:id returns existing cycle when body is empty', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { objective: 'Marathon' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle.objective, 'Marathon');
});

test('PUT /api/cycles/:id rejects activating when another active cycle exists', async () => {
  const { db, app, cookie, userId } = await setup();
  const existingId = seedCycle(db, userId, { status: 'active' });
  const completedId = seedCycle(db, userId, { status: 'completed' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${completedId}`,
    headers: { cookie },
    payload: { status: 'active' },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /active cycle already exists/);
});

test('PUT /api/cycles/:id allows keeping the same cycle active', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { status: 'active' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { status: 'active', objective: 'Updated Marathon' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle.status, 'active');
  assert.equal(res.json().cycle.objective, 'Updated Marathon');
});

test('PUT /api/cycles/:id updates distance and dates', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { distance: '10km', start_date: '2026-01-01' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { distance: '21km', start_date: '2026-06-01', target_date: '2026-12-31' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cycle.distance, '21km');
  assert.equal(res.json().cycle.start_date, '2026-06-01');
  assert.equal(res.json().cycle.target_date, '2026-12-31');
});

/* ── DELETE /api/cycles/:id ── */

test('DELETE /api/cycles/:id removes the cycle and returns 200', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId);

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/cycles/${id}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });

  const verify = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(verify.json().cycles.length, 0);
});

test('DELETE /api/cycles/:id returns 404 for non-existent cycle', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/cycles/non-existent',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Cycle not found.' });
});

test("DELETE /api/cycles/:id returns 404 for another user's cycle", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const id = seedCycle(db, otherId);

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/cycles/${id}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);

  const stillExists = db.prepare('SELECT id FROM training_cycles WHERE id = ?').get(id);
  assert.ok(stillExists, 'other user cycle still exists in the database');
});

test('DELETE /api/cycles/:id allows creating a new active cycle after deletion', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, { status: 'active' });

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/cycles/${id}`,
    headers: { cookie },
  });
  assert.equal(del.statusCode, 200);

  const create = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'New Marathon', status: 'active' },
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().cycle.status, 'active');
});

/* ── GET /api/cycles/:id/prompt ── */

test('GET /api/cycles/:id/prompt returns prompt text for an existing cycle', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId, {
    objective: 'Marathon',
    target_date: '2026-12-01',
    distance: '42km',
    run_before: '5k',
    run_count: 3,
    primary_goal: 'Finish',
    secondary_goal: 'Sub 4h',
    start_date: '2026-09-01',
    other_events: 'Party on Nov',
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/cycles/${id}/prompt`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const { prompt } = res.json();
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('Marathon'));
  assert.ok(prompt.includes('42km'));
});

test('GET /api/cycles/:id/prompt returns 404 for non-existent cycle', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'GET',
    url: '/api/cycles/non-existent/prompt',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Cycle not found.' });
});

test("GET /api/cycles/:id/prompt returns 404 for another user's cycle", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const id = seedCycle(db, otherId);

  const res = await app.inject({
    method: 'GET',
    url: `/api/cycles/${id}/prompt`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/cycles/:id/prompt uses pt-BR template when user prefers pt-BR', async () => {
  const { db, app, cookie, userId } = await setup();
  db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run('pt-BR', userId);
  const id = seedCycle(db, userId, { objective: 'Maratona', distance: null });

  const res = await app.inject({
    method: 'GET',
    url: `/api/cycles/${id}/prompt`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const { prompt } = res.json();
  assert.ok(prompt.includes('Maratona'));
});

test('GET /api/cycles/:id/prompt uses fallback dashes when cycle fields are empty', async () => {
  const { db, app, cookie, userId } = await setup();
  const crypto = require('node:crypto');
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO training_cycles (id, user_id, objective, target_date, distance, run_before, run_count, primary_goal, secondary_goal, start_date, other_events, status, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, NULL, NULL, '', '', NULL, NULL, 'active', datetime('now'), datetime('now'))`
  ).run(id, userId);

  const res = await app.inject({
    method: 'GET',
    url: `/api/cycles/${id}/prompt`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const { prompt } = res.json();
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 0);
});

/* ── Error propagation ── */

test('POST /api/cycles surfaces unexpected errors as HTTP 500', async () => {
  const { db, app, cookie } = await setup();
  db.exec('DROP TABLE training_cycles');

  const res = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'Marathon' },
  });
  assert.equal(res.statusCode, 500);
});

test('PUT /api/cycles/:id surfaces unexpected errors as HTTP 500', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedCycle(db, userId);
  db.exec('DROP TABLE training_cycles');

  const res = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${id}`,
    headers: { cookie },
    payload: { objective: 'Updated' },
  });
  assert.equal(res.statusCode, 500);
});

/* ── Full CRUD lifecycle ── */

test('full CRUD lifecycle: create, list, get active, update, prompt, delete', async () => {
  const { app, cookie } = await setup();

  const create = await app.inject({
    method: 'POST',
    url: '/api/cycles',
    headers: { cookie },
    payload: { objective: 'Marathon', distance: '42km', status: 'active' },
  });
  assert.equal(create.statusCode, 201);
  const cycleId = create.json().cycle.id;

  const list = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(list.json().cycles.length, 1);

  const active = await app.inject({ method: 'GET', url: '/api/cycles/active', headers: { cookie } });
  assert.equal(active.json().cycle.id, cycleId);

  const prompt = await app.inject({
    method: 'GET',
    url: `/api/cycles/${cycleId}/prompt`,
    headers: { cookie },
  });
  assert.equal(prompt.statusCode, 200);
  assert.ok(prompt.json().prompt.includes('Marathon'));

  const update = await app.inject({
    method: 'PUT',
    url: `/api/cycles/${cycleId}`,
    headers: { cookie },
    payload: { status: 'completed' },
  });
  assert.equal(update.json().cycle.status, 'completed');

  const noActive = await app.inject({ method: 'GET', url: '/api/cycles/active', headers: { cookie } });
  assert.equal(noActive.json().cycle, null);

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/cycles/${cycleId}`,
    headers: { cookie },
  });
  assert.equal(del.statusCode, 200);

  const finalList = await app.inject({ method: 'GET', url: '/api/cycles', headers: { cookie } });
  assert.equal(finalList.json().cycles.length, 0);
});
