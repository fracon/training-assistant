'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  SCHEMA,
  resolveDatabaseFile,
  initializeDatabase,
  migrateDatabase,
  createDatabase,
} = require('../src/db/database');

test('resolveDatabaseFile joins cwd with the data directory and file name', () => {
  const result = resolveDatabaseFile('/srv/app');
  const expected = path.join('/srv/app', 'data', 'database.sqlite');
  assert.equal(result, expected);
});

test('createDatabase requires a filename', () => {
  assert.throws(() => createDatabase(), TypeError);
  assert.throws(() => createDatabase({}), TypeError);
});

test('initializeDatabase applies pragmas and creates the schema', () => {
  const db = initializeDatabase(new Database(':memory:'));

  assert.deepEqual(db.pragma('journal_mode', { simple: true }), 'memory');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  const objects = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(objects, ['sessions', 'trainings', 'users', 'workouts']);

  db.close();
});

test('SCHEMA is idempotent when executed twice', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  assert.doesNotThrow(() => db.exec(SCHEMA));
  db.close();
});

test('new users default to en-US preferred language', () => {
  const db = createDatabase({ filename: ':memory:' });

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('default-lang@example.com', 'hash');
  const explicit = db
    .prepare(
      "INSERT INTO users (email, password_hash, preferred_lang) VALUES (?, ?, 'pt-BR')"
    )
    .run('pt-user@example.com', 'hash');

  const languages = db
    .prepare('SELECT id, preferred_lang FROM users ORDER BY id')
    .all();
  assert.deepEqual(languages, [
    { id: Number(userId), preferred_lang: 'en-US' },
    { id: Number(explicit.lastInsertRowid), preferred_lang: 'pt-BR' },
  ]);

  const columns = db.pragma('table_info(users)').map((column) => column.name);
  assert.ok(columns.includes('preferred_lang'));

  db.close();
});

test('migrateDatabase adds preferred_lang to legacy users tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      first_name    TEXT,
      last_name     TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE trainings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      dia         TEXT NOT NULL,
      tipo        TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(
    'legacy@example.com',
    'hash'
  );

  migrateDatabase(db);

  const row = db
    .prepare('SELECT email, preferred_lang, first_day_of_week FROM users WHERE email = ?')
    .get('legacy@example.com');
  assert.equal(row.preferred_lang, 'en-US');
  assert.equal(row.first_day_of_week, 'Monday');

  db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(
    'post-migration@example.com',
    'hash'
  );
  const defaulted = db
    .prepare('SELECT preferred_lang, first_day_of_week FROM users WHERE email = ?')
    .get('post-migration@example.com');
  assert.equal(defaulted.preferred_lang, 'en-US');
  assert.equal(defaulted.first_day_of_week, 'Monday');

  db.close();
});

test('migrateDatabase adds first_day_of_week to partially migrated tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      first_name    TEXT,
      last_name     TEXT,
      preferred_lang TEXT   NOT NULL DEFAULT 'en-US',
      first_day_of_week TEXT NOT NULL DEFAULT 'Monday',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE trainings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      dia         TEXT NOT NULL,
      tipo        TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO users (email, password_hash, preferred_lang, first_day_of_week) VALUES (?, ?, 'pt-BR', 'Sunday')"
  ).run('partial@example.com', 'hash');

  assert.doesNotThrow(() => migrateDatabase(db));
  assert.doesNotThrow(() => migrateDatabase(db));

  const columns = db.pragma('table_info(users)').map((column) => column.name);
  assert.ok(columns.includes('first_day_of_week'));

  const row = db
    .prepare('SELECT preferred_lang, first_day_of_week FROM users WHERE email = ?')
    .get('partial@example.com');
  assert.equal(row.preferred_lang, 'pt-BR');
  assert.equal(row.first_day_of_week, 'Sunday', 'existing values are preserved');

  const fresh = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING first_day_of_week')
    .get('fresh@example.com', 'hash');
  assert.equal(fresh.first_day_of_week, 'Monday');

  db.close();
});

test('initializeDatabase is safe to run on already-migrated databases', () => {
  const first = createDatabase({ filename: ':memory:' });
  assert.doesNotThrow(() => initializeDatabase(first));
  first.close();
});

test('in-memory database stores users and sessions via prepared statements', () => {
  const db = createDatabase({ filename: ':memory:' });

  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  );
  const { lastInsertRowid: userId } = insertUser.run(
    'runner@example.com',
    'argon2-hash'
  );

  const user = db
    .prepare('SELECT id, email, password_hash, created_at FROM users WHERE id = ?')
    .get(userId);
  assert.equal(user.email, 'runner@example.com');
  assert.equal(user.password_hash, 'argon2-hash');
  assert.match(user.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  assert.throws(() => insertUser.run('runner@example.com', 'other-hash'), /UNIQUE constraint failed: users\.email/);

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  );
  insertSession.run('session-token', userId, '2026-12-31T23:59:59Z');

  const session = db
    .prepare('SELECT * FROM sessions WHERE user_id = ?')
    .get(userId);
  assert.equal(session.id, 'session-token');
  assert.equal(session.expires_at, '2026-12-31T23:59:59Z');
  assert.match(session.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  db.close();
});

test('foreign keys are enforced and cascade on user delete', () => {
  const db = createDatabase({ filename: ':memory:' });

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .run('orphan-token', 99999, '2026-12-31T23:59:59Z'),
    /FOREIGN KEY constraint failed/
  );

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('cascade@example.com', 'hash');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    'cascade-token',
    userId,
    '2026-12-31T23:59:59Z'
  );

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('cascade-token');
  assert.equal(session, undefined);

  db.close();
});

test('users store first and last names via prepared statements', () => {
  const db = createDatabase({ filename: ':memory:' });

  const { lastInsertRowid: userId } = db
    .prepare(
      'INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)'
    )
    .run('rafael@example.com', 'argon2-hash', 'Rafael', 'Vilaça');

  const user = db
    .prepare('SELECT first_name, last_name FROM users WHERE id = ?')
    .get(userId);
  assert.equal(user.first_name, 'Rafael');
  assert.equal(user.last_name, 'Vilaça');

  db.close();
});

test('workouts persist the full training plan row per user via prepared statements', () => {
  const db = createDatabase({ filename: ':memory:' });

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('planner@example.com', 'hash');

  const insertWorkout = db.prepare(`
    INSERT INTO workouts
      (user_id, day, period, type, workout, details, target_hr, rpe, shoes, forecast, observations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const { lastInsertRowid: workoutId } = insertWorkout.run(
    userId,
    '2026-08-24',
    'Manhã',
    'Intervalado',
    '10x400m',
    'Descanso de 90s entre as repetições',
    '145–155 bpm',
    4,
    'Nimbus 26',
    '22°C, céu aberto',
    'Última série opcional'
  );

  const workout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
  assert.equal(workout.user_id, userId);
  assert.equal(workout.day, '2026-08-24');
  assert.equal(workout.period, 'Manhã');
  assert.equal(workout.type, 'Intervalado');
  assert.equal(workout.workout, '10x400m');
  assert.equal(workout.details, 'Descanso de 90s entre as repetições');
  assert.equal(workout.target_hr, '145–155 bpm');
  assert.strictEqual(workout.rpe, 4);
  assert.equal(workout.shoes, 'Nimbus 26');
  assert.equal(workout.forecast, '22°C, céu aberto');
  assert.equal(workout.observations, 'Última série opcional');
  assert.match(workout.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  insertWorkout.run(userId, '2026-08-25', 'Tarde', 'Regenerativo', '8km fácil', null, null, 2, null, null, null);
  const plan = db
    .prepare('SELECT day FROM workouts WHERE user_id = ? ORDER BY day')
    .all(userId)
    .map((row) => row.day);
  assert.deepEqual(plan, ['2026-08-24', '2026-08-25']);

  db.close();
});

test('workouts enforce foreign keys and cascade on user delete', () => {
  const db = createDatabase({ filename: ':memory:' });

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO workouts (user_id, day) VALUES (?, ?)')
        .run(99999, '2026-08-24'),
    /FOREIGN KEY constraint failed/
  );

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('cascade-plan@example.com', 'hash');
  db.prepare('INSERT INTO workouts (user_id, day) VALUES (?, ?)').run(userId, '2026-08-24');

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  const remaining = db.prepare('SELECT COUNT(*) AS total FROM workouts').get();
  assert.equal(remaining.total, 0);

  db.close();
});

test('trainings enforce foreign keys, require dia/tipo and cascade on user delete', () => {
  const db = createDatabase({ filename: ':memory:' });

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO trainings (user_id, dia, tipo) VALUES (?, ?, ?)')
        .run(99999, '2026-08-23', 'Corrida'),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO trainings (user_id, dia, tipo) VALUES (?, ?, ?)')
        .run(null, '2026-08-23', 'Corrida'),
    /NOT NULL constraint failed/
  );

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('cascade-trainings@example.com', 'hash');
  db.prepare(
    "INSERT INTO trainings (user_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes) VALUES (?, ?, 'Manhã', 'Corrida', 'Longão', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Leve')"
  ).run(userId, '2026-08-23');

  const stored = db
    .prepare(
      'SELECT dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes FROM trainings WHERE user_id = ?'
    )
    .get(userId);
  assert.deepEqual(stored, {
    dia: '2026-08-23',
    periodo: 'Manhã',
    tipo: 'Corrida',
    treino: 'Longão',
    detalhes: 'Zona 2',
    fc_alvo: '150',
    rpe: '3',
    tenis: 'Adizero',
    previsao: '90 min',
    observacoes: 'Leve',
  });

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  const remaining = db.prepare('SELECT COUNT(*) AS total FROM trainings').get();
  assert.equal(remaining.total, 0);

  db.close();
});

test('file-backed database is created in a nested directory with WAL mode and persists data', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-db-'));
  try {
    const filename = path.join(tmpRoot, 'nested', 'data', 'database.sqlite');
    const db = createDatabase({ filename });

    assert.equal(fs.existsSync(filename), true);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(
      'persisted@example.com',
      'hash'
    );
    db.close();

    const reopened = createDatabase({ filename });
    const row = reopened
      .prepare('SELECT email FROM users WHERE email = ?')
      .get('persisted@example.com');
    assert.equal(row.email, 'persisted@example.com');
    reopened.close();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('migrateDatabase adds feedback columns to legacy trainings tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL
    );
    CREATE TABLE trainings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      dia         TEXT NOT NULL,
      tipo        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo) VALUES (1, '2026-08-20', 'Corrida')"
  ).run();

  migrateDatabase(db);

  const columns = db.pragma('table_info(trainings)').map((column) => column.name);
  for (const name of ['feedback_rpe', 'feedback_notas', 'completed']) {
    assert.ok(columns.includes(name), `${name} column added`);
  }

  const row = db
    .prepare('SELECT feedback_rpe, feedback_notas, completed FROM trainings')
    .get();
  assert.equal(row.feedback_rpe, null);
  assert.equal(row.feedback_notas, null);
  assert.equal(row.completed, 0);

  assert.doesNotThrow(() => migrateDatabase(db), 'migration is idempotent');

  db.close();
});

test('migrateDatabase tops up partially migrated trainings tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      preferred_lang TEXT   NOT NULL DEFAULT 'en-US',
      first_day_of_week TEXT NOT NULL DEFAULT 'Monday'
    );
    CREATE TABLE trainings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      dia         TEXT NOT NULL,
      tipo        TEXT NOT NULL,
      completed   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo) VALUES (1, '2026-08-21', 'Bike')"
  ).run();

  assert.doesNotThrow(() => migrateDatabase(db));

  const row = db
    .prepare('SELECT feedback_rpe, feedback_notas, completed FROM trainings')
    .get();
  assert.equal(row.completed, 1, 'existing values are preserved');
  assert.equal(row.feedback_rpe, null);
  assert.equal(row.feedback_notas, null);

  db.close();
});
