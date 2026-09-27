'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { buildServer } = require('../src/server');
const {
  FeedbackError, createFeedback, deleteFeedback, getFeedback, listFeedback, normalizeInternalNote, publicFeedback, updateFeedback,
} = require('../src/feedback');

const PASSWORD = 'feedback-password';

async function setup() {
  const db = createDatabase({ filename: ':memory:' });
  const author = await registerUser(db, { email: 'author@example.test', password: PASSWORD, first_name: 'A', last_name: 'User' });
  const admin = await registerUser(db, { email: 'admin@example.test', password: PASSWORD, first_name: 'An', last_name: 'Admin' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const cookie = (user) => `${SESSION_COOKIE_NAME}=${createSession(db, user.id).token}`;
  return { db, author, admin, authorCookie: cookie(author), adminCookie: cookie(admin) };
}

test('feedback domain validates, snapshots identity, filters, triages and deletes', async () => {
  const { db, author } = await setup();
  assert.throws(() => createFeedback(db, { id: author.id, email: author.email }, { type: 'bug', description: '  Broken button  ', pathname: '/home.html?secret=x' }), FeedbackError);
});

test('feedback domain stores the authenticated snapshot and supports admin triage', async () => {
  const { db, author } = await setup();
  const created = createFeedback(db, { id: author.id, email: author.email }, { type: 'bug', description: 'Broken button', pathname: '/home.html' });
  assert.equal(created.author_email, author.email);
  assert.equal(created.status, 'new');
  assert.equal(listFeedback(db, { type: 'bug' }).total, 1);
  const updated = updateFeedback(db, created.id, { status: 'in_progress', internal_note: 'Investigate' });
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.internal_note, 'Investigate');
  assert.equal(getFeedback(db, created.id).description, 'Broken button');
  assert.deepEqual(deleteFeedback(db, created.id), { id: created.id });
  assert.throws(() => getFeedback(db, created.id), (error) => error.code === 'feedbackNotFound');
});

test('feedback validation rejects unknown identity fields, unsafe paths and oversized text', async () => {
  const { db, author } = await setup();
  const call = (body) => assert.throws(() => createFeedback(db, { id: author.id, email: author.email }, body), FeedbackError);
  call(null);
  call([]);
  call({ type: 'bug', description: 'x', pathname: '/home.html?x=1' });
  call({ type: 'bug', description: 'x', pathname: '/home.html', author_email: 'other@test' });
  call({ type: 'nope', description: 'x', pathname: '/home.html' });
  call({ type: 'bug', description: 'x', pathname: '/home.html' , extra: true });
  call({ type: 'bug', description: 'x'.repeat(5001), pathname: '/home.html' });
  call({ type: 'bug', description: undefined, pathname: '/home.html' });
  call({ type: 'bug', description: '   ', pathname: '/home.html' });
  assert.throws(() => listFeedback(db, { status: 'nope' }), /Feedback status/);
  assert.throws(() => updateFeedback(db, 'x', { status: 'new' }), /Feedback id/);
  const row = createFeedback(db, { id: author.id, email: author.email }, { type: 'other', description: 'x', pathname: '/home.html' });
  assert.throws(() => updateFeedback(db, row.id, {}), /No triage/);
  assert.throws(() => updateFeedback(db, row.id, { internal_note: 'x'.repeat(5001) }), /Internal note/);
  assert.throws(() => updateFeedback(db, 999, { status: 'new' }), /Feedback not found/);
  assert.throws(() => deleteFeedback(db, 999), /Feedback not found/);
  assert.throws(() => getFeedback(db, null), /Feedback id/);
  assert.equal(listFeedback(db).page, 1);
  assert.equal(listFeedback(db, { page: 0, limit: 101 }).limit, 100);
  assert.deepEqual(listFeedback(db, { page: 2, limit: 50 }), { feedback: [], page: 2, limit: 50, total: 1 });
  assert.equal(normalizeInternalNote(undefined), '');
  assert.equal(publicFeedback({ id: 1, author_user_id: null, author_email: 'x', type: 'other', description: 'x', pathname: '/home.html', status: 'new', internal_note: null, created_at: 'now', updated_at: null }).internal_note, '');
});

test('feedback author snapshot survives account deletion', async () => {
  const { db, author } = await setup();
  const row = createFeedback(db, { id: author.id, email: author.email }, { type: 'other', description: 'Keep this record', pathname: '/shoes.html' });
  db.prepare('DELETE FROM users WHERE id = ?').run(author.id);
  const persisted = getFeedback(db, row.id);
  assert.equal(persisted.author_user_id, null);
  assert.equal(persisted.author_email, author.email);
});

test('feedback routes enforce authentication and admin authorization', async () => {
  const { app, db, author, adminCookie, authorCookie } = await setupServer();
  const payload = { type: 'suggestion', description: 'A useful idea', pathname: '/cycles.html' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/feedback', payload })).statusCode, 401);
  const created = await app.inject({ method: 'POST', url: '/api/feedback', headers: { cookie: authorCookie }, payload });
  assert.equal(created.statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/feedback', headers: { cookie: authorCookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/feedback?page=no', headers: { cookie: adminCookie } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/feedback?unexpected=x', headers: { cookie: adminCookie } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/feedback?page=2&limit=50', headers: { cookie: adminCookie } })).statusCode, 200);
  const listed = await app.inject({ method: 'GET', url: '/api/admin/feedback?status=new', headers: { cookie: adminCookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().feedback[0].author_email, author.email);
  const id = listed.json().feedback[0].id;
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie }, payload: { status: 'resolved' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie }, payload: { status: 'new' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/feedback/${id}`, headers: { cookie: adminCookie } })).statusCode, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback').get().count, 0);
});

test('feedback creation does not disguise unexpected persistence failures', async () => {
  const { app, db, authorCookie } = await setupServer();
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (String(sql).includes('INSERT INTO feedback')) throw new Error('persistence failure');
    return prepare(sql);
  };
  const response = await app.inject({
    method: 'POST', url: '/api/feedback', headers: { cookie: authorCookie },
    payload: { type: 'bug', description: 'x', pathname: '/home.html' },
  });
  assert.equal(response.statusCode, 500);
});

async function setupServer() {
  const db = createDatabase({ filename: ':memory:' });
  const author = await registerUser(db, { email: 'route-author@example.test', password: PASSWORD, first_name: 'A', last_name: 'User' });
  const admin = await registerUser(db, { email: 'route-admin@example.test', password: PASSWORD, first_name: 'An', last_name: 'Admin' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const app = await buildServer({ db, sessionCookieSecure: false });
  const adminPage = await app.inject({ method: 'GET', url: '/admin-feedback.html', headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, admin.id).token}` } });
  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.body, /feedbackAdmin\.title/);
  assert.equal((await app.inject({ method: 'GET', url: '/admin-feedback.html' })).statusCode, 302);
  assert.equal((await app.inject({ method: 'GET', url: '/admin-feedback.html', headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(db, author.id).token}` } })).statusCode, 302);
  return { app, db, author, authorCookie: `${SESSION_COOKIE_NAME}=${createSession(db, author.id).token}`, adminCookie: `${SESSION_COOKIE_NAME}=${createSession(db, admin.id).token}` };
}
