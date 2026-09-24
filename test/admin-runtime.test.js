'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RegistrationError } = require('../src/auth/registration');
const { AdminOperationError } = require('../src/admin/operations');
const { createDatabase } = require('../src/db/database');
const { PromptCancelledError } = require('../scripts/admin-prompts');
const { runCommand } = require('../scripts/admin-runtime');

function prompts(assertInteractive = () => {}) {
  return { assertInteractive };
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-admin-runtime-'));
}

function trackClose(database) {
  let closed = 0;
  const close = database.close.bind(database);
  database.close = () => { closed += 1; return close(); };
  return { database, closeCount: () => closed };
}

async function withRuntimeState(run) {
  const exitCode = process.exitCode;
  const databaseFile = process.env.DATABASE_FILE;
  process.exitCode = 0;
  try {
    return await run();
  } finally {
    if (databaseFile === undefined) delete process.env.DATABASE_FILE;
    else process.env.DATABASE_FILE = databaseFile;
    process.exitCode = exitCode;
  }
}

test('runtime rejects a missing TTY before opening the database', async () => withRuntimeState(async () => {
  const errors = [];
  let opened = false;
  const result = await runCommand(async () => {}, {
    prompts: prompts(() => { throw new Error('This command requires an interactive TTY.'); }),
    openDatabase() { opened = true; },
    writeError: (message) => errors.push(message),
  });
  assert.deepEqual(result, { status: 'no-tty' });
  assert.equal(opened, false);
  assert.deepEqual(errors, ['This command requires an interactive TTY.']);
  assert.equal(process.exitCode, 1);
}));

test('runtime creates its default prompt reader and default error writer for a non-TTY process', async () => withRuntimeState(async () => {
  const errors = [];
  const stderr = process.stderr.write;
  process.stderr.write = function captureError(chunk) { errors.push(String(chunk)); return true; };
  try {
    const result = await runCommand(async () => {}, {
      createPrompts: () => prompts(() => { throw new Error('TTY required.'); }),
    });
    assert.deepEqual(result, { status: 'no-tty' });
    assert.equal(process.exitCode, 1);
    assert.match(errors.join(''), /TTY required/);
  } finally {
    process.stderr.write = stderr;
  }
}));

test('runtime uses the built-in prompt reader when no prompt dependency is injected', async () => withRuntimeState(async () => {
  const errors = [];
  const result = await runCommand(async () => {}, { writeError: (message) => errors.push(message) });
  assert.deepEqual(result, { status: 'no-tty' });
  assert.match(errors.join(''), /interactive TTY/);
  assert.equal(process.exitCode, 1);
}));

test('runtime opens and closes the initialized database using DATABASE_FILE and default output writers', async () => withRuntimeState(async () => {
  const directory = temporaryDirectory();
  const filename = path.join(directory, 'app.sqlite');
  process.env.DATABASE_FILE = filename;
  const captured = { stdout: '', stderr: '' };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = function captureOut(chunk) { captured.stdout += String(chunk); return true; };
  process.stderr.write = function captureErr(chunk) { captured.stderr += String(chunk); return true; };
  try {
    const result = await runCommand(async ({ db, write }) => {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
      write('command complete');
      return 42;
    }, { prompts: prompts() });
    assert.deepEqual(result, { status: 'completed', result: 42 });
    assert.match(captured.stdout, /command complete/);
    assert.equal(captured.stderr, '');
    assert.equal(fs.existsSync(filename), true);
    const reopened = createDatabase({ filename });
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    reopened.close();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test('runtime uses the application default database path when no override exists', async () => withRuntimeState(async () => {
  const directory = temporaryDirectory();
  const previousDirectory = process.cwd();
  process.env.DATABASE_FILE = '';
  process.chdir(directory);
  try {
    const opened = [];
    const result = await runCommand(async ({ db }) => {
      opened.push(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get() !== undefined);
    }, { prompts: prompts(), writeOut() {}, writeError() {} });
    assert.equal(result.status, 'completed');
    assert.deepEqual(opened, [true]);
    assert.equal(fs.existsSync(path.join(directory, 'data', 'database.sqlite')), true);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test('runtime closes the database and uses cancellation exit status without leaking errors', async () => withRuntimeState(async () => {
  const directory = temporaryDirectory();
  const output = [];
  let tracked;
  try {
    const result = await runCommand(async () => { throw new PromptCancelledError(); }, {
      prompts: prompts(),
      databaseFile: path.join(directory, 'cancel.sqlite'),
      openDatabase: ({ filename }) => {
        tracked = trackClose(createDatabase({ filename }));
        return tracked.database;
      },
      writeOut: (message) => output.push(message), writeError: (message) => output.push(message),
    });
    assert.deepEqual(result, { status: 'cancelled' });
    assert.equal(process.exitCode, 130);
    assert.equal(tracked.closeCount(), 1);
    assert.deepEqual(output, ['Operation cancelled. No changes made.']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test('runtime reports validation, administrative, and unexpected failures safely and closes each database', async () => withRuntimeState(async () => {
  const directory = temporaryDirectory();
  const cases = [
    { error: new RegistrationError(400, 'Invalid email address.'), message: 'Invalid email address.' },
    { error: new AdminOperationError('ADMIN_EXISTS', 'An administrator already exists.'), message: 'An administrator already exists.' },
    { error: new Error('SensitivePassword-should-not-appear'), message: 'Administrative command failed. No credentials were written to the output.' },
  ];
  try {
    for (const [index, item] of cases.entries()) {
      const errors = [];
      const tracked = trackClose(createDatabase({ filename: path.join(directory, `${index}.sqlite`) }));
      const result = await runCommand(async () => { throw item.error; }, {
        prompts: prompts(), openDatabase: () => tracked.database,
        writeOut() {}, writeError: (message) => errors.push(message),
      });
      assert.deepEqual(result, { status: 'error' });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(errors, [item.message]);
      assert.equal(errors.join('').includes('SensitivePassword'), false);
      assert.equal(tracked.closeCount(), 1);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test('runtime handles database initialization failure without exposing details', async () => withRuntimeState(async () => {
  const errors = [];
  const result = await runCommand(async () => {}, {
    prompts: prompts(), openDatabase: () => { throw new Error('private database path'); },
    writeOut() {}, writeError: (message) => errors.push(message),
  });
  assert.deepEqual(result, { status: 'error' });
  assert.equal(process.exitCode, 1);
  assert.deepEqual(errors, ['Administrative command failed. No credentials were written to the output.']);
}));
