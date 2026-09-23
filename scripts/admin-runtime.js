'use strict';

const path = require('node:path');
const { createDatabase, resolveDatabaseFile } = require('../src/db/database');
const { createPrompts } = require('./admin-prompts');

async function runCommand(command) {
  const prompts = createPrompts();
  try {
    prompts.assertInteractive();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const databaseFile = process.env.DATABASE_FILE || resolveDatabaseFile(process.cwd());
  let db;
  try {
    db = createDatabase({ filename: path.resolve(databaseFile) });
    await command({ db, prompts, write: (message) => process.stdout.write(`${message}\n`) });
  } catch (error) {
    if (error.name === 'PromptCancelledError') process.stdout.write('Operation cancelled. No changes made.\n');
    else if (error.name === 'RegistrationError') process.stderr.write(`${error.message}\n`);
    else if (error.name === 'AdminOperationError') process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Administrative command failed. No credentials were written to the output.\n');
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

module.exports = { runCommand };
