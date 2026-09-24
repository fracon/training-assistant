'use strict';

const path = require('node:path');
const { createDatabase, resolveDatabaseFile } = require('../src/db/database');
const { createPrompts } = require('./admin-prompts');
const { AdminOperationError } = require('../src/admin/operations');
const { RegistrationError } = require('../src/auth/registration');
const { PromptCancelledError } = require('./admin-prompts');

async function runCommand(command, options = {}) {
  const prompts = options.prompts || (options.createPrompts || createPrompts)();
  const writeOut = options.writeOut || ((message) => process.stdout.write(`${message}\n`));
  const writeError = options.writeError || ((message) => process.stderr.write(`${message}\n`));
  try {
    prompts.assertInteractive();
  } catch (error) {
    writeError(error.message);
    process.exitCode = 1;
    return { status: 'no-tty' };
  }
  const databaseFile = options.databaseFile || process.env.DATABASE_FILE || resolveDatabaseFile(options.cwd || process.cwd());
  let db;
  let closeDatabase = () => {};
  let outcome;
  try {
    const openDatabase = options.openDatabase || createDatabase;
    db = openDatabase({ filename: path.resolve(databaseFile) });
    closeDatabase = () => db.close();
    const result = await command({ db, prompts, write: writeOut });
    outcome = { status: 'completed', result };
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      writeOut('Operation cancelled. No changes made.');
      process.exitCode = 130;
      outcome = { status: 'cancelled' };
    } else {
      if (error instanceof RegistrationError || error instanceof AdminOperationError) writeError(error.message);
      else writeError('Administrative command failed. No credentials were written to the output.');
      process.exitCode = 1;
      outcome = { status: 'error' };
    }
  }
  closeDatabase();
  return outcome;
}

module.exports = { runCommand };
