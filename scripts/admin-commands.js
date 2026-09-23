'use strict';

const { createFirstAdmin, findAccountByEmail, hasAdministrator, promoteAccount } = require('../src/admin/operations');

const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu;

function safeTerminalField(value) {
  return String(value ?? '').replace(TERMINAL_CONTROLS, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
}

async function runBootstrap({ db, prompts, write }) {
  prompts.assertInteractive();
  if (hasAdministrator(db)) {
    write('Administrator bootstrap has already been completed. No changes made.');
    return { status: 'already-complete' };
  }
  const first_name = (await prompts.question('First name: ')).trim();
  const last_name = (await prompts.question('Last name: ')).trim();
  const email = (await prompts.question('Email: ')).trim();
  const existing = findAccountByEmail(db, email);
  if (existing) {
    write('That email belongs to an existing account. Use `npm run admin:promote` to promote it explicitly.');
    return { status: 'email-in-use' };
  }
  const password = await prompts.secret('Password (input hidden): ');
  const confirmation = await prompts.secret('Confirm password (input hidden): ');
  if (password !== confirmation) {
    write('Passwords do not match. No account was created.');
    return { status: 'password-mismatch' };
  }
  const user = await createFirstAdmin(db, { first_name, last_name, email, password });
  write(`Administrator created for ${safeTerminalField(user.email)}.`);
  return { status: 'created', user };
}

async function runPromotion({ db, prompts, write }) {
  prompts.assertInteractive();
  const email = (await prompts.question('Existing account email: ')).trim();
  const user = findAccountByEmail(db, email);
  if (!user) {
    write('No account exists with that email. No changes made.');
    return { status: 'not-found' };
  }
  write(`Account to promote: ${safeTerminalField(user.first_name)} ${safeTerminalField(user.last_name)} <${safeTerminalField(user.email)}> [${safeTerminalField(user.role)}]`.trim());
  const confirmation = (await prompts.question('Type yes to grant the admin role: ')).trim().toLowerCase();
  if (confirmation !== 'yes') {
    write('Promotion cancelled. No changes made.');
    return { status: 'cancelled' };
  }
  const result = promoteAccount(db, user.email);
  write(result.changed
    ? `Administrator role granted to ${safeTerminalField(result.user.email)}.`
    : `${safeTerminalField(result.user.email)} is already an administrator.`);
  return { status: result.changed ? 'promoted' : 'already-admin', ...result };
}

module.exports = { runBootstrap, runPromotion };
