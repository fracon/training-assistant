'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  first_name     TEXT,
  last_name      TEXT,
  preferred_lang TEXT    NOT NULL DEFAULT 'en-US',
  first_day_of_week TEXT NOT NULL DEFAULT 'Monday',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          TEXT,
  period       TEXT,
  type         TEXT,
  workout      TEXT,
  details      TEXT,
  target_hr    TEXT,
  rpe          INTEGER,
  shoes        TEXT,
  forecast     TEXT,
  observations TEXT,
  created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trainings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dia         TEXT NOT NULL,
  periodo     TEXT,
  tipo        TEXT NOT NULL,
  treino      TEXT,
  detalhes    TEXT,
  fc_alvo     TEXT,
  rpe         TEXT,
  tenis       TEXT,
  previsao    TEXT,
  observacoes TEXT,
  created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
`;

function resolveDatabaseFile(cwd) {
  return path.join(cwd, 'data', 'database.sqlite');
}

function migrateDatabase(db) {
  const columns = db.pragma('table_info(users)');
  if (!columns.some((column) => column.name === 'preferred_lang')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN preferred_lang TEXT NOT NULL DEFAULT 'en-US'"
    );
  }
  if (!columns.some((column) => column.name === 'first_day_of_week')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN first_day_of_week TEXT NOT NULL DEFAULT 'Monday'"
    );
  }
}

function initializeDatabase(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateDatabase(db);
  return db;
}

function createDatabase({ filename } = {}) {
  if (!filename) {
    throw new TypeError('filename is required: pass a file path or ":memory:".');
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return initializeDatabase(new Database(filename));
}

module.exports = {
  SCHEMA,
  resolveDatabaseFile,
  initializeDatabase,
  migrateDatabase,
  createDatabase,
};
