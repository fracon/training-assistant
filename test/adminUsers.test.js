'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db/database');
const { registerUser } = require('../src/auth/registration');
const { createSession } = require('../src/auth/sessions');
const {
  ACCOUNT_ROLES,
  AdminUserError,
  countAdministrators,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  publicAccount,
  updateAccount,
} = require('../src/admin/users');

const ADMIN = {
  email: 'root.admin@example.com',
  password: 'root-admin-secret',
  first_name: 'Root',
  last_name: 'Admin',
};

/* ── Fixtures ── */

async function seed(db, overrides = {}) {
  const user = await registerUser(db, { ...ADMIN, ...overrides });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(overrides.role ?? 'admin', user.id);
  return { ...user, role: overrides.role ?? 'admin' };
}

async function setup({ admins = 1, users = 2 } = {}) {
  const db = createDatabase({ filename: ':memory:' });
  const adminList = [];
  for (let index = 0; index < admins; index += 1) {
    adminList.push(await seed(db, {
      email: `admin${index}@example.com`,
      first_name: `Admin${index}`,
      role: 'admin',
    }));
  }
  const userList = [];
  for (let index = 0; index < users; index += 1) {
    userList.push(await seed(db, {
      email: `user${index}@example.com`,
      first_name: `User${index}`,
      role: 'user',
    }));
  }
  return { db, admins: adminList, users: userList };
}

function actorOf(account) {
  return { id: account.id, email: account.email };
}

function auditRows(db) {
  return db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all();
}

function auditRowsFor(db, action) {
  return db.prepare('SELECT * FROM admin_audit_log WHERE action = ? ORDER BY id').all(action);
}

/**
 * Wraps a database so the statement matching `pattern` reports a chosen
 * `changes` count. This reaches the defensive "row vanished" branches that a
 * single synchronous transaction cannot otherwise produce.
 */
function stubbingChanges(db, pattern, changes) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          if (!pattern.test(sql)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'run') {
                return (...args) => ({ ...statementTarget.run(...args), changes });
              }
              const value = statementTarget[statementProperty];
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Makes the second and later email lookups report a conflict, reproducing the
// race between the pre-check and the atomic re-check inside the transaction.
function stubbingEmailConflictAfter(db, lookups) {
  let seen = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          if (!/FROM users WHERE email = \?/.test(sql)) return target.prepare(sql);
          const statement = target.prepare(sql);
          seen += 1;
          if (seen <= lookups) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'get') {
                return () => ({ id: 999, email: 'taken@example.com', first_name: 'T', last_name: 'T', role: 'user' });
              }
              const value = statementTarget[statementProperty];
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// The domain functions are a mix of synchronous (update, delete) and promise
// returning (create, because password hashing is async) entry points, so the
// helper awaits the result and asserts on the rejection either way.
async function assertAdminError(run, status, code) {
  let thrown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected AdminUserError(${status}, ${code}) but nothing was thrown`);
  assert.ok(thrown instanceof AdminUserError, `expected AdminUserError, got ${thrown?.name}`);
  assert.equal(thrown.status, status);
  assert.equal(thrown.code, code);
}

/* ── Exposed constants and helpers ── */

test('ACCOUNT_ROLES is the constrained pair used by the database', () => {
  assert.deepEqual(ACCOUNT_ROLES, ['user', 'admin']);
});

test('publicAccount exposes identification only and tolerates a missing timestamp', () => {
  const account = publicAccount({
    id: 7,
    email: 'someone@example.com',
    first_name: 'Some',
    last_name: 'One',
    role: 'user',
    password_hash: 'never-exposed',
    onboarding_status: 'new',
  });
  assert.deepEqual(Object.keys(account).sort(), [
    'created_at', 'email', 'first_name', 'id', 'last_name', 'role',
  ]);
  assert.equal(account.created_at, null);
  assert.equal('password_hash' in account, false);
});

/* ── Listing and reading ── */

test('listAccounts returns every account ordered by creation without private data', async () => {
  const { db, admins, users } = await setup();
  const list = listAccounts(db);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((account) => account.email), [
    admins[0].email, users[0].email, users[1].email,
  ]);
  for (const account of list) {
    assert.deepEqual(Object.keys(account).sort(), [
      'created_at', 'email', 'first_name', 'id', 'last_name', 'role',
    ]);
  }
});

test('getAccount reads one account and rejects an unknown one', async () => {
  const { db, users } = await setup();
  assert.equal(getAccount(db, users[0].id).email, users[0].email);
  assert.equal(getAccount(db, String(users[0].id)).email, users[0].email);
  await assertAdminError(() => getAccount(db, 4242), 404, 'accountNotFound');
});

test('getAccount accepts only positive integer identifiers', async () => {
  const { db, users } = await setup();
  assert.equal(getAccount(db, users[0].id).id, users[0].id);
  for (const invalid of [
    0, -1, 1.5, '0', '-1', '1.5', 'abc', '', ' ', '1e3', '0x1', ' 1 2 ',
    '99999999999999999999', null, undefined, true, {}, [], Number.NaN,
  ]) {
    await assertAdminError(() => getAccount(db, invalid), 400, 'invalidId');
  }
  // Surrounding whitespace is tolerated because route params arrive as text.
  assert.equal(getAccount(db, ` ${users[0].id} `).id, users[0].id);
});

test('countAdministrators counts only the admin role', async () => {
  const { db, users } = await setup();
  assert.equal(countAdministrators(db), 1);
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', users[0].id);
  assert.equal(countAdministrators(db), 2);
});

/* ── Creating ── */

test('createAccount registers an account with the requested role and records the actor', async () => {
  const { db, admins } = await setup();
  const created = await createAccount(db, actorOf(admins[0]), {
    first_name: 'New',
    last_name: 'Person',
    email: '  New.Person@Example.com ',
    password: 'new-person-secret',
    role: 'admin',
  });

  assert.equal(created.email, 'new.person@example.com');
  assert.equal(created.role, 'admin');
  assert.equal(created.first_name, 'New');

  const stored = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
  assert.equal(stored.role, 'admin');
  assert.notEqual(stored.password_hash, 'new-person-secret');
  assert.match(stored.password_hash, /^scrypt\$/);
  // A new account starts onboarding and never inherits another account's state.
  assert.equal(stored.onboarding_status, 'new');

  const [entry] = auditRows(db);
  assert.equal(entry.action, 'account_created');
  assert.equal(entry.actor_user_id, admins[0].id);
  assert.equal(entry.actor_email, admins[0].email);
  assert.equal(entry.target_user_id, created.id);
  assert.equal(entry.target_email, 'new.person@example.com');
  assert.deepEqual(JSON.parse(entry.details), { role: 'admin' });
});

test('createAccount requires an explicit role and applies the account defaults', async () => {
  const { db, admins } = await setup();
  const actor = actorOf(admins[0]);
  const base = {
    first_name: 'Plain', last_name: 'Person', email: 'plain@example.com',
    password: 'plain-person-secret',
  };
  // The role is never inferred: an omitted or unknown value is refused instead
  // of silently granting or assuming a privilege level.
  await assertAdminError(() => createAccount(db, actor, { ...base }), 400, 'invalidRole');

  const created = await createAccount(db, actor, { ...base, role: 'user' });
  assert.equal(created.role, 'user');
  const stored = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
  assert.equal(stored.distance_unit, 'km');
  assert.equal(stored.temperature_unit, 'C');
  assert.equal(stored.preferred_lang, 'en-US');
  assert.equal(stored.onboarding_guide_hidden, 0);
});

test('createAccount rejects unsupported fields, roles and registration failures', async () => {
  const { db, admins } = await setup();
  const actor = actorOf(admins[0]);
  const base = {
    first_name: 'New', last_name: 'Person', email: 'new@example.com',
    password: 'new-person-secret', role: 'user',
  };

  await assertAdminError(() => createAccount(db, actor, { ...base, onboarding_status: 'active' }),
    400, 'unknownField',
  );
  await assertAdminError(() => createAccount(db, actor, { ...base, role: 'root' }), 400, 'invalidRole');
  await assertAdminError(() => createAccount(db, actor, { ...base, role: 1 }), 400, 'invalidRole');

  // A padded or differently cased role is normalized rather than rejected.
  const normalized = await createAccount(db, actor, { ...base, email: 'ok@example.com', role: ' ADMIN ' });
  assert.equal(normalized.role, 'admin');

  await assertAdminError(() => createAccount(db, actor, { ...base, email: 'not-an-email' }),
    400, 'invalidRegistration',
  );
  await assertAdminError(() => createAccount(db, actor, { ...base, email: 'short@example.com', password: 'short' }),
    400, 'invalidRegistration',
  );
  await assertAdminError(() => createAccount(db, actor, { ...base, email: 'blank@example.com', first_name: '   ' }),
    400, 'invalidRegistration',
  );
  await assertAdminError(() => createAccount(db, actor, { ...base, email: 'blank2@example.com', last_name: '' }),
    400, 'invalidRegistration',
  );
  // Missing body and empty body both fail validation rather than creating a row.
  await assertAdminError(() => createAccount(db, actor, null), 400, 'invalidRegistration');
  await assertAdminError(() => createAccount(db, actor, {}), 400, 'invalidRegistration');
});

test('createAccount never stores a submitted role outside the constrained pair', async () => {
  const { db, admins } = await setup();
  const created = await createAccount(db, actorOf(admins[0]), {
    first_name: 'Escalate', last_name: 'Attempt', email: 'esc@example.com',
    password: 'escalate-secret', role: 'ADMIN',
  });
  assert.equal(created.role, 'admin');
  const stored = db.prepare('SELECT role FROM users WHERE id = ?').get(created.id);
  assert.equal(stored.role, 'admin');
});

test('createAccount reports an email that is already registered', async () => {
  const { db, admins, users } = await setup();
  await assertAdminError(() => createAccount(db, actorOf(admins[0]), {
      first_name: 'Dup', last_name: 'Licate', email: users[0].email,
      password: 'duplicate-secret', role: 'user',
    }),
    409, 'emailInUse',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 3);
});

test('createAccount rechecks the email inside the write transaction', async () => {
  const { db, admins, users } = await setup();
  const racing = stubbingEmailConflictAfter(db, 1);
  await assertAdminError(() => createAccount(racing, actorOf(admins[0]), {
      first_name: 'Race', last_name: 'Condition', email: 'race@example.com',
      password: 'race-secret-1', role: 'user',
    }),
    409, 'emailInUse',
  );
  // The atomic re-check refuses the insert instead of writing a duplicate.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('race@example.com').count,
    0,
  );
  assert.ok(users[0].email);
});

// A falsy or unidentified actor cannot be a current administrator, so the
// create path refuses it instead of writing an unattributable audit row.
test('createAccount requires an identified administrator actor', async () => {
  const { db } = await setup();
  for (const actor of [{}, null, undefined, { id: null, email: 'ghost@example.com' }]) {
    await assertAdminError(
      () => createAccount(db, actor, {
        first_name: 'No', last_name: 'Actor', email: 'noactor@example.com',
        password: 'no-actor-secret', role: 'user',
      }),
      403, 'adminAuthorityRevoked',
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('noactor@example.com').count, 0);
  assert.deepEqual(auditRowsFor(db, 'account_created'), [], 'an unattributable write is never audited');
});

/*
 * The scrypt `await` in `createAccount` yields the event loop, so a concurrent
 * administrator can revoke the actor's role while the hash is still pending.
 * `createAccount` is called without being awaited so the revocation below runs
 * on the main thread while scrypt runs on the thread pool — the same ordering a
 * real concurrent request would produce.
 */
test('createAccount refuses the insert when the actor is demoted while the hash is pending', async () => {
  const { db, admins, users } = await setup({ admins: 2 });
  const [creator, other] = admins;

  const pending = createAccount(db, actorOf(creator), {
    first_name: 'Late', last_name: 'Arrival', email: 'late@example.com',
    password: 'late-arrival-secret', role: 'admin',
  });
  // The guard's role is now stale: the actor is demoted mid-hash.
  updateAccount(db, actorOf(other), creator.id, { role: 'user' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(creator.id).role, 'user');

  // Even a request to mint another administrator is refused.
  await assertAdminError(() => pending, 403, 'adminAuthorityRevoked');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('late@example.com').count, 0);
  assert.equal(countAdministrators(db), 1);
  // The demotion is audited; the refused creation is not.
  assert.deepEqual(auditRowsFor(db, 'account_created'), [], 'the refusal writes no partial audit row');
  assert.equal(auditRowsFor(db, 'account_role_changed').length, 1);
  assert.ok(users[0].email);
});

test('createAccount refuses the insert when the actor is deleted while the hash is pending', async () => {
  const { db, admins } = await setup({ admins: 2 });
  const [creator, other] = admins;

  const pending = createAccount(db, actorOf(creator), {
    first_name: 'Ghost', last_name: 'Writer', email: 'ghost-writer@example.com',
    password: 'ghost-writer-secret', role: 'user',
  });
  deleteAccount(db, actorOf(other), creator.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(creator.id).count, 0);

  await assertAdminError(() => pending, 403, 'adminAuthorityRevoked');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('ghost-writer@example.com').count, 0);
  // The deletion is audited; the refused creation is not.
  assert.deepEqual(auditRowsFor(db, 'account_created'), [], 'the refusal writes no partial audit row');
  assert.equal(auditRowsFor(db, 'account_deleted').length, 1);
});

test('createAccount records the actor identity as it stands at write time', async () => {
  const { db, admins } = await setup({ admins: 2 });
  const [creator, other] = admins;

  // The actor's email changes while the hash is pending, so the audit row must
  // carry the identity that actually performed the write.
  const pending = createAccount(db, actorOf(creator), {
    first_name: 'Fresh', last_name: 'Writer', email: 'fresh-writer@example.com',
    password: 'fresh-writer-secret', role: 'user',
  });
  updateAccount(db, actorOf(other), creator.id, { email: 'renamed.admin@example.com' });

  const created = await pending;
  assert.equal(created.email, 'fresh-writer@example.com');
  const [entry] = auditRowsFor(db, 'account_created');
  assert.equal(entry.action, 'account_created');
  assert.equal(entry.actor_user_id, creator.id);
  assert.equal(entry.actor_email, 'renamed.admin@example.com');
});

/* ── Updating ── */

test('updateAccount changes the requested fields only and audits them', async () => {
  const { db, admins, users } = await setup();
  const updated = updateAccount(db, actorOf(admins[0]), users[0].id, {
    first_name: '  Renamed  ',
    last_name: 'Person',
  });

  assert.equal(updated.first_name, 'Renamed');
  assert.equal(updated.last_name, 'Person');
  assert.equal(updated.email, users[0].email);
  assert.equal(updated.role, 'user');

  const stored = db.prepare('SELECT * FROM users WHERE id = ?').get(users[0].id);
  assert.equal(stored.first_name, 'Renamed');
  // Untouched columns keep their values, including preferences and onboarding.
  assert.equal(stored.onboarding_status, 'new');
  assert.equal(stored.distance_unit, 'km');

  const [entry] = auditRows(db);
  assert.equal(entry.action, 'account_updated');
  assert.deepEqual(JSON.parse(entry.details).fields, ['first_name', 'last_name']);
  assert.equal('role' in JSON.parse(entry.details), false);
});

test('updateAccount normalizes and validates the email address', async () => {
  const { db, admins, users } = await setup();
  const updated = updateAccount(db, actorOf(admins[0]), users[0].id, {
    email: '  MOVED@Example.com  ',
  });
  assert.equal(updated.email, 'moved@example.com');

  // Re-submitting the account's own address is not a conflict.
  const same = updateAccount(db, actorOf(admins[0]), users[0].id, { email: 'moved@example.com' });
  assert.equal(same.email, 'moved@example.com');

  await assertAdminError(() => updateAccount(db, actorOf(admins[0]), users[0].id, { email: 'nope' }),
    400, 'invalidRegistration',
  );
  await assertAdminError(() => updateAccount(db, actorOf(admins[0]), users[0].id, { email: users[1].email }),
    409, 'emailInUse',
  );
});

test('updateAccount rejects unsupported payloads and unknown accounts', async () => {
  const { db, admins, users } = await setup();
  const actor = actorOf(admins[0]);
  await assertAdminError(() => updateAccount(db, actor, users[0].id, {}), 400, 'noChanges');
  await assertAdminError(() => updateAccount(db, actor, users[0].id, null), 400, 'noChanges');
  await assertAdminError(() => updateAccount(db, actor, users[0].id, { password: 'new-secret-1' }),
    400, 'unknownField',
  );
  await assertAdminError(() => updateAccount(db, actor, users[0].id, { role: 'owner' }),
    400, 'invalidRole',
  );
  await assertAdminError(() => updateAccount(db, actor, 'abc', { first_name: 'X' }),
    400, 'invalidId',
  );
  await assertAdminError(() => updateAccount(db, actor, 9999, { first_name: 'X' }),
    404, 'accountNotFound',
  );
  // Non-string names are normalized to an empty string rather than stored raw.
  const blanked = updateAccount(db, actor, users[0].id, { first_name: 42, last_name: null });
  assert.equal(blanked.first_name, '');
  assert.equal(blanked.last_name, '');
});

test('updateAccount refuses to change the signed-in administrator role', async () => {
  const { db, admins } = await setup();
  await assertAdminError(() => updateAccount(db, actorOf(admins[0]), admins[0].id, { role: 'user' }),
    400, 'selfRoleChangeForbidden',
  );
  assert.equal(countAdministrators(db), 1);
  // Sending the same role is not a change and stays allowed.
  const unchanged = updateAccount(db, actorOf(admins[0]), admins[0].id, { role: 'admin' });
  assert.equal(unchanged.role, 'admin');
});

test('updateAccount refuses to demote the last administrator', async () => {
  const { db, admins, users } = await setup({ admins: 2 });
  // Demoting the other administrator is allowed while a second one remains.
  const demoted = updateAccount(db, actorOf(admins[0]), admins[1].id, { role: 'user' });
  assert.equal(demoted.role, 'user');
  assert.equal(countAdministrators(db), 1);

  // Re-submitting an unchanged role is not a demotion at all.
  const unchanged = updateAccount(db, actorOf(admins[0]), admins[0].id, { role: 'admin' });
  assert.equal(unchanged.role, 'admin');

  // Defence in depth: even when a caller other than the sole administrator
  // reaches the domain function, removing the last admin role is refused.
  await assertAdminError(
    () => updateAccount(db, actorOf(users[0]), admins[0].id, { role: 'user' }),
    409, 'lastAdministrator',
  );
  assert.equal(countAdministrators(db), 1);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(admins[0].id).role, 'admin');
});

test('updateAccount revokes the target sessions when the role changes', async () => {
  const { db, admins, users } = await setup();
  const session = createSession(db, users[0].id);
  assert.ok(session);

  const untouched = updateAccount(db, actorOf(admins[0]), users[0].id, { first_name: 'Keeps' });
  assert.equal(untouched.first_name, 'Keeps');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(users[0].id).count,
    1,
  );

  const promoted = updateAccount(db, actorOf(admins[0]), users[0].id, { role: 'admin' });
  assert.equal(promoted.role, 'admin');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(users[0].id).count,
    0,
  );

  const [first, last] = auditRows(db);
  assert.equal(first.action, 'account_updated');
  assert.equal(last.action, 'account_role_changed');
  assert.deepEqual(JSON.parse(last.details).role, { from: 'user', to: 'admin' });
});

test('updateAccount reports a row that disappears before the write', async () => {
  const { db, admins, users } = await setup();
  const stubbed = stubbingChanges(db, /^UPDATE users SET/, 0);
  await assertAdminError(() => updateAccount(stubbed, actorOf(admins[0]), users[0].id, { first_name: 'Ghost' }),
    404, 'accountNotFound',
  );
});

/* ── Deleting ── */

test('deleteAccount removes the account with its dependent data and keeps the audit row', async () => {
  const { db, admins, users } = await setup();
  const target = users[0];
  createSession(db, target.id);
  db.prepare(
    `INSERT INTO training_cycles (id, user_id, objective, target_date, start_date, status)
     VALUES ('cycle-1', ?, 'Maratona', '2026-12-06', '2026-09-01', 'active')`
  ).run(target.id);
  db.prepare(
    `INSERT INTO shoes (id, user_id, brand, model, mileage, target_mileage, status)
     VALUES ('shoe-1', ?, 'Nike', 'Pegasus 41', 100, 800, 'active')`
  ).run(target.id);

  const result = deleteAccount(db, actorOf(admins[0]), target.id);
  assert.equal(result.deleted.email, target.email);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(target.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(target.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM training_cycles WHERE user_id = ?').get(target.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shoes WHERE user_id = ?').get(target.id).count, 0);

  const [entry] = auditRows(db);
  assert.equal(entry.action, 'account_deleted');
  assert.equal(entry.target_user_id, target.id);
  assert.equal(entry.target_email, target.email);
  assert.deepEqual(JSON.parse(entry.details), { role: 'user' });
  // The audit trail must never carry credentials or training values.
  const serialized = JSON.stringify(entry);
  assert.equal(/password|hash|token|secret/i.test(serialized), false);
});

test('deleteAccount refuses the signed-in account and the last administrator', async () => {
  const { db, admins, users } = await setup({ admins: 2, users: 1 });
  await assertAdminError(() => deleteAccount(db, actorOf(admins[0]), admins[0].id), 400, 'selfDeleteForbidden',
  );
  await assertAdminError(() => deleteAccount(db, actorOf(admins[0]), 'abc'), 400, 'invalidId',
  );
  await assertAdminError(() => deleteAccount(db, actorOf(admins[0]), 9999), 404, 'accountNotFound',
  );

  // The other administrator can go while the signed-in one remains.
  assert.equal(deleteAccount(db, actorOf(admins[0]), admins[1].id).deleted.email, admins[1].email);
  assert.equal(countAdministrators(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(admins[1].id).count, 0);

  // Defence in depth: the sole administrator cannot be removed by any other
  // caller, so the installation always keeps a way back in.
  await assertAdminError(() => deleteAccount(db, actorOf(users[0]), admins[0].id), 409, 'lastAdministrator',
  );
  assert.equal(countAdministrators(db), 1);
});

test('deleteAccount reports a row that disappears before the delete', async () => {
  const { db, admins, users } = await setup();
  const stubbed = stubbingChanges(db, /^DELETE FROM users/, 0);
  await assertAdminError(() => deleteAccount(stubbed, actorOf(admins[0]), users[0].id), 404, 'accountNotFound',
  );
});
