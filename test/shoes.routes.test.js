'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');

const REGISTER_PAYLOAD = {
  email: 'ShoeRunner@Example.com',
  password: 'super-secret-1',
  first_name: 'Shoe',
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

function seedShoe(db, userId, overrides = {}) {
  const crypto = require('node:crypto');
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO shoes (id, user_id, brand, model, mileage, target_mileage, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    overrides.brand ?? 'Nike',
    overrides.model ?? 'Pegasus 41',
    overrides.mileage ?? 100,
    overrides.target_mileage ?? 800,
    overrides.status ?? 'active'
  );
  return id;
}

/* ── Authentication ── */

test('GET /api/shoes requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/shoes' });
  assert.equal(res.statusCode, 401);
});

test('POST /api/shoes requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/shoes', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('PUT /api/shoes/:id requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'PUT', url: '/api/shoes/fake', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('DELETE /api/shoes/:id requires authentication', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'DELETE', url: '/api/shoes/fake' });
  assert.equal(res.statusCode, 401);
});

/* ── GET /api/shoes ── */

test('GET /api/shoes returns empty array for user with no shoes', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().shoes, []);
});

test('GET /api/shoes returns all shoes for the authenticated user', async () => {
  const { db, app, cookie, userId } = await setup();
  seedShoe(db, userId, { brand: 'Nike' });
  seedShoe(db, userId, { brand: 'Asics' });

  const res = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().shoes.length, 2);
});

test("GET /api/shoes does not return another user's shoes", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  seedShoe(db, otherId, { brand: 'Hoka' });

  const res = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(res.json().shoes.length, 0);
});

/* ── POST /api/shoes ── */

test('POST /api/shoes creates a shoe and returns 201', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike', model: 'Pegasus 41', mileage: 50, target_mileage: 800, status: 'active' },
  });
  assert.equal(res.statusCode, 201);
  const { shoe } = res.json();
  assert.ok(shoe.id);
  assert.equal(shoe.brand, 'Nike');
  assert.equal(shoe.model, 'Pegasus 41');
  assert.equal(shoe.mileage, 50);
  assert.equal(shoe.target_mileage, 800);
  assert.equal(shoe.status, 'active');
});

test('POST /api/shoes applies defaults when optional fields are omitted', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Asics', model: 'Nimbus 26' },
  });
  assert.equal(res.statusCode, 201);
  const { shoe } = res.json();
  assert.equal(shoe.mileage, 0);
  assert.equal(shoe.target_mileage, null);
  assert.equal(shoe.status, 'active');
});

test('POST /api/shoes rejects missing brand', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { model: 'Pegasus' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /brand is required/);
});

test('POST /api/shoes rejects missing model', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /model is required/);
});

test('POST /api/shoes rejects negative mileage', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike', model: 'Pegasus', mileage: -10 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /mileage must be a non-negative number/);
});

test('POST /api/shoes rejects invalid status', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike', model: 'Pegasus', status: 'worn-out' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status must be one of/);
});

test('POST /api/shoes rejects empty body', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

/* ── PUT /api/shoes/:id ── */

test('PUT /api/shoes/:id updates a shoe and returns the updated row', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId, { mileage: 100 });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { mileage: 250, status: 'retired' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().shoe.mileage, 250);
  assert.equal(res.json().shoe.status, 'retired');
});

test('PUT /api/shoes/:id returns 404 for non-existent shoe', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'PUT',
    url: '/api/shoes/non-existent-id',
    headers: { cookie },
    payload: { mileage: 50 },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Shoe not found.' });
});

test("PUT /api/shoes/:id returns 404 for another user's shoe", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const id = seedShoe(db, otherId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { mileage: 999 },
  });
  assert.equal(res.statusCode, 404);
});

test('PUT /api/shoes/:id rejects invalid mileage', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { mileage: -5 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /mileage/);
});

test('PUT /api/shoes/:id rejects invalid status', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { status: 'bad' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status must be one of/);
});

test('PUT /api/shoes/:id rejects empty brand', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { brand: '  ' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /brand is required/);
});

test('PUT /api/shoes/:id rejects empty model', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { model: '' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /model is required/);
});

test('PUT /api/shoes/:id rejects negative target_mileage', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { target_mileage: -1 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /target_mileage/);
});

test('PUT /api/shoes/:id returns existing shoe when body is empty', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId, { brand: 'Nike', model: 'Pegasus' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().shoe.brand, 'Nike');
});

test('PUT /api/shoes/:id updates brand and model', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId, { brand: 'Nike', model: 'Pegasus 41' });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { brand: 'Asics', model: 'Nimbus 27' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().shoe.brand, 'Asics');
  assert.equal(res.json().shoe.model, 'Nimbus 27');
});

test('PUT /api/shoes/:id updates target_mileage', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId, { target_mileage: null });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { target_mileage: 500 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().shoe.target_mileage, 500);
});

/* ── DELETE /api/shoes/:id ── */

test('DELETE /api/shoes/:id removes the shoe and returns 200', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/shoes/${id}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });

  const verify = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(verify.json().shoes.length, 0);
});

test('DELETE /api/shoes/:id returns 404 for non-existent shoe', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/shoes/non-existent',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Shoe not found.' });
});

test("DELETE /api/shoes/:id returns 404 for another user's shoe", async () => {
  const { db, app, cookie } = await setup();
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('other@test.com', 'hash')"
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'other@test.com'").get().id;
  const id = seedShoe(db, otherId);

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/shoes/${id}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 404);

  const stillExists = db.prepare('SELECT id FROM shoes WHERE id = ?').get(id);
  assert.ok(stillExists, 'other user shoe still exists in the database');
});

/* ── Error propagation ── */

test('POST /api/shoes surfaces unexpected errors as HTTP 500', async () => {
  const { db, app, cookie } = await setup();
  db.exec('DROP TABLE shoes');

  const res = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike', model: 'Pegasus' },
  });
  assert.equal(res.statusCode, 500);
});

test('PUT /api/shoes/:id surfaces unexpected errors as HTTP 500', async () => {
  const { db, app, cookie, userId } = await setup();
  const id = seedShoe(db, userId);
  db.exec('DROP TABLE shoes');

  const res = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${id}`,
    headers: { cookie },
    payload: { mileage: 50 },
  });
  assert.equal(res.statusCode, 500);
});

/* ── Full CRUD lifecycle ── */

test('full CRUD lifecycle: create, list, update, delete', async () => {
  const { app, cookie } = await setup();

  const create = await app.inject({
    method: 'POST',
    url: '/api/shoes',
    headers: { cookie },
    payload: { brand: 'Nike', model: 'Pegasus 41', mileage: 10, target_mileage: 800 },
  });
  assert.equal(create.statusCode, 201);
  const shoeId = create.json().shoe.id;

  const list = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(list.json().shoes.length, 1);

  const update = await app.inject({
    method: 'PUT',
    url: `/api/shoes/${shoeId}`,
    headers: { cookie },
    payload: { mileage: 200, status: 'retired' },
  });
  assert.equal(update.json().shoe.mileage, 200);
  assert.equal(update.json().shoe.status, 'retired');

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/shoes/${shoeId}`,
    headers: { cookie },
  });
  assert.equal(del.statusCode, 200);

  const final = await app.inject({ method: 'GET', url: '/api/shoes', headers: { cookie } });
  assert.equal(final.json().shoes.length, 0);
});
