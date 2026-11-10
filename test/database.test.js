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
const { buildServer } = require('../src/server');
const { replaceCurrentEvidence } = require('../src/result-import-evidence');
const { installLegacyEvidenceSchema } = require('./helpers/legacyEvidenceSchema');
const { registerUser } = require('../src/auth/registration');
const { createSession } = require('../src/auth/sessions');
const {
  buildLapsMarkdown,
  formatCadence,
} = require('../src/public/training-result.js');

test('resolveDatabaseFile joins cwd with the data directory and file name', () => {
  const result = resolveDatabaseFile('/srv/app');
  const expected = path.join('/srv/app', 'data', 'database.sqlite');
  assert.equal(result, expected);
});

test('createDatabase requires a filename', () => {
  assert.throws(() => createDatabase(), TypeError);
  assert.throws(() => createDatabase({}), TypeError);
});

test('Garmin operation identity migration is idempotent and excludes generated occurrence IDs from retry identity', () => {
  const db = createDatabase({ filename: ':memory:' });
  const marker = db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-10-garmin-session-publish-v4'").get();
  assert.ok(marker);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='garmin_operation_identity_v4'").get();
  assert.match(index.sql, /COALESCE\(source_operation_id/);
  assert.doesNotMatch(index.sql, /occurrence_id/);
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'garmin-migration@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,workout_id,occurrence_id)
    VALUES ('kept-operation',1,1,1,1,'fingerprint',1,'scheduled','complete','2026-11-02','42','84')`).run();
  db.exec(`DROP INDEX IF EXISTS garmin_operation_identity_v4;
    DROP INDEX IF EXISTS garmin_operation_identity_v3;
    CREATE UNIQUE INDEX garmin_operation_identity_v2 ON garmin_training_operations
      (user_id,training_id,connection_generation,prescription_revision,scheduled_date,action);
    DELETE FROM schema_migrations WHERE name IN ('2026-10-garmin-session-publish-v3','2026-10-garmin-session-publish-v4');`);
  migrateDatabase(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name='2026-10-garmin-session-publish-v4'").get().count, 1);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='garmin_operation_identity_v4'").get().sql, index.sql);
  assert.deepEqual(db.prepare("SELECT status,stage,workout_id,occurrence_id FROM garmin_training_operations WHERE operation_id='kept-operation'").get(),
    { status: 'scheduled', stage: 'complete', workout_id: '42', occurrence_id: '84' });
  const insertReschedule = db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,scheduled_date,action,source_operation_id,workout_id,occurrence_id)
    VALUES (?,1,1,1,1,'fingerprint',1,'scheduled','complete','2026-11-03','reschedule',?,'42',?)`);
  insertReschedule.run('move-a', 'source-a', '84');
  insertReschedule.run('move-b', 'source-b', '84');
  assert.throws(() => insertReschedule.run('move-a-retry', 'source-a', '85'), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM garmin_training_operations WHERE source_operation_id='source-a'").get().count, 1);
  db.close();
});

test('Garmin activity provenance migration is idempotent and enforces one current activity per session and account-qualified IDs', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'activity-migration@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  db.prepare(`INSERT INTO garmin_activity_imports
    (user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
    VALUES (1,1,?,?,?,1,1)`).run('a'.repeat(64), '72', 'b'.repeat(64));
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v1'").run();
  migrateDatabase(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v1'").get().n, 1);
  assert.equal(db.prepare('SELECT is_current FROM garmin_activity_imports WHERE activity_id=?').get('72').is_current, 1);
  assert.throws(() => db.prepare(`INSERT INTO garmin_activity_imports
    (user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
    VALUES (1,1,?,?,?,1,1)`).run('c'.repeat(64), '73', 'd'.repeat(64)), /UNIQUE constraint failed/);
  db.prepare('UPDATE garmin_pilot_connections SET identity_fingerprint=NULL').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM garmin_activity_imports').get().n, 1,
    'disconnect or account replacement keeps historical activity provenance');
  db.close();
});

test('result evidence migration backfills only qualified Garmin IDs and preserves historic/current state idempotently', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'result-evidence@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','one'),(2,1,'2026-11-03','run','two')").run();
  db.prepare(`INSERT INTO garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
    VALUES(1,1,?,?,?,1,0),(1,2,?,?,?,1,1)`).run('a'.repeat(64),'91','b'.repeat(64),'c'.repeat(64),'92','d'.repeat(64));
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-training-result-evidence-v1'").run();
  db.prepare('DROP TABLE training_result_evidence').run();
  migrateDatabase(db);
  const rows = db.prepare('SELECT training_id,evidence_type,evidence_value,source,is_current FROM training_result_evidence ORDER BY training_id').all();
  assert.deepEqual(rows, [
    { training_id: 1, evidence_type: 'garmin_activity', evidence_value: `${'a'.repeat(64)}:91`, source: 'garmin_connect', is_current: 0 },
    { training_id: 2, evidence_type: 'garmin_activity', evidence_value: `${'c'.repeat(64)}:92`, source: 'garmin_connect', is_current: 1 },
  ]);
  assert.equal(rows.some((row) => ['fit_sha256','fit_file_id'].includes(row.evidence_type)), false,
    'legacy imports receive no invented FIT identity');
  const before = JSON.stringify(rows);
  migrateDatabase(db);
  assert.equal(JSON.stringify(db.prepare('SELECT training_id,evidence_type,evidence_value,source,is_current FROM training_result_evidence ORDER BY training_id').all()), before);
  assert.throws(() => db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(1,1,'garmin_activity',?,'garmin_connect',1)`).run(`${'c'.repeat(64)}:92`), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-11-training-result-evidence-v1'").get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(training_result_evidence)').all().map((key) => [key.table,key.from,key.to,key.on_delete]).sort(), [
    ['trainings','training_id','id','CASCADE'], ['users','user_id','id','CASCADE'],
  ]);
  assert.equal(db.prepare('PRAGMA index_list(training_result_evidence)').all().some((index) => index.name === 'idx_training_result_evidence_current_identity' && index.unique && index.partial), true);
  db.close();
});

test('result evidence repair evolves the persisted v1 key, preserves rows, and makes its UPSERT usable', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'evidence-repair@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','repair')").run();
  db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(1,1,'fit_sha256','${'a'.repeat(64)}','fit_upload',1)`).run();
  installLegacyEvidenceSchema(db);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v1'").get());
  const before = db.prepare('SELECT id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at FROM training_result_evidence').all();
  assert.deepEqual(db.prepare('PRAGMA index_xinfo(sqlite_autoindex_training_result_evidence_1)').all()
    .filter((column) => column.key).map((column) => column.name),
  ['user_id','training_id','evidence_type','evidence_value']);
  let failure;
  try {
    db.transaction(() => replaceCurrentEvidence(db, 1, 1,
      [{ type:'fit_sha256', value:'a'.repeat(64), source:'garmin_connect' }])).immediate();
  } catch (error) { failure = error; }
  assert.equal(failure?.code,'SQLITE_ERROR');
  assert.equal(failure?.message,'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint');
  assert.match(failure?.stack,/replaceCurrentEvidence/);
  assert.deepEqual(db.prepare('SELECT id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at FROM training_result_evidence').all(), before);

  migrateDatabase(db);
  assert.deepEqual(db.prepare('SELECT id,user_id,training_id,evidence_type,evidence_value,source,is_current,created_at FROM training_result_evidence').all(), before);
  const identityIndexes = db.prepare('PRAGMA index_list(training_result_evidence)').all()
    .filter((index) => index.unique && !index.partial)
    .map((index) => db.prepare(`PRAGMA index_xinfo("${index.name}")`).all().filter((column) => column.key).map((column) => column.name));
  assert.ok(identityIndexes.some((key) => JSON.stringify(key) === JSON.stringify(['user_id','training_id','evidence_type','evidence_value','source'])));
  replaceCurrentEvidence(db, 1, 1, [{ type:'fit_sha256', value:'a'.repeat(64), source:'garmin_connect' }]);
  assert.deepEqual(db.prepare('SELECT evidence_type,evidence_value,source,is_current FROM training_result_evidence ORDER BY id').all(), [
    { evidence_type:'fit_sha256', evidence_value:'a'.repeat(64), source:'fit_upload', is_current:0 },
    { evidence_type:'fit_sha256', evidence_value:'a'.repeat(64), source:'garmin_connect', is_current:1 },
  ]);
  const afterFirst = db.prepare('SELECT id,evidence_type,evidence_value,source,is_current,created_at FROM training_result_evidence ORDER BY id').all();
  migrateDatabase(db);
  assert.deepEqual(db.prepare('SELECT id,evidence_type,evidence_value,source,is_current,created_at FROM training_result_evidence ORDER BY id').all(), afterFirst);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get().n, 1);
  db.close();
});

test('result evidence repair refuses duplicate keys atomically without discarding history', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'evidence-ambiguous@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','repair')").run();
  db.exec(`DROP INDEX idx_training_result_evidence_training;
    DROP INDEX idx_training_result_evidence_current_identity;
    ALTER TABLE training_result_evidence RENAME TO training_result_evidence_new;
    CREATE TABLE training_result_evidence (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,training_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,evidence_value TEXT NOT NULL,source TEXT NOT NULL,
      is_current INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO training_result_evidence VALUES
      (1,1,1,'fit_sha256','${'a'.repeat(64)}','fit_upload',0,'2026-11-03'),
      (2,1,1,'fit_sha256','${'a'.repeat(64)}','fit_upload',0,'2026-11-04');
    DROP TABLE training_result_evidence_new;`);
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").run();
  const before = db.prepare('SELECT * FROM training_result_evidence ORDER BY id').all();
  assert.throws(() => migrateDatabase(db), /duplicate identity group.*No evidence rows were changed/i);
  assert.deepEqual(db.prepare('SELECT * FROM training_result_evidence ORDER BY id').all(), before);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_training_result_evidence_identity_v2'").get(), undefined);
  db.close();
});

test('result evidence repair fails actionably when its reserved index name is occupied', () => {
  const db = createDatabase({ filename: ':memory:' });
  installLegacyEvidenceSchema(db,{includeLegacyUnique:false});
  db.exec('CREATE INDEX idx_training_result_evidence_identity_v2 ON training_result_evidence(evidence_value)');
  assert.throws(() => migrateDatabase(db), /identity_v2 exists with an incompatible definition/i);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_training_result_evidence_identity_v2'").get());
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(), undefined);
  db.close();
});

test('result evidence repair creates its missing unique key when the table has no prior identity constraint', () => {
  const db = createDatabase({ filename: ':memory:' });
  installLegacyEvidenceSchema(db,{includeLegacyUnique:false});
  migrateDatabase(db);
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_training_result_evidence_identity_v2'").get();
  assert.ok(index);
  assert.deepEqual(db.prepare('PRAGMA index_xinfo(idx_training_result_evidence_identity_v2)').all()
    .filter((column) => column.key).map((column) => column.name),['user_id','training_id','evidence_type','evidence_value','source']);
  db.close();
});

test('result evidence repair refuses unrecognized unique constraints without rewriting indexes', () => {
  const db = createDatabase({ filename: ':memory:' });
  installLegacyEvidenceSchema(db,{includeLegacyUnique:false});
  db.exec('CREATE UNIQUE INDEX unexpected_evidence_key ON training_result_evidence(evidence_value)');
  assert.throws(()=>migrateDatabase(db),/unrecognized UNIQUE constraint/i);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='unexpected_evidence_key'").get());
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(),undefined);
  db.close();
});

test('result evidence repair refuses incompatible legacy columns and missing ownership foreign keys', () => {
  const incomplete = createDatabase({ filename: ':memory:' });
  incomplete.exec(`DROP INDEX idx_training_result_evidence_training;
    DROP INDEX idx_training_result_evidence_current_identity;
    ALTER TABLE training_result_evidence RENAME TO training_result_evidence_new;
    CREATE TABLE training_result_evidence(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,training_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,evidence_value TEXT NOT NULL,source TEXT NOT NULL,is_current INTEGER NOT NULL,
      UNIQUE(user_id,training_id,evidence_type,evidence_value));
    DROP TABLE training_result_evidence_new;
    DELETE FROM schema_migrations WHERE name IN ('2026-11-training-result-evidence-v2','2026-11-training-result-evidence-v3');`);
  assert.throws(()=>migrateDatabase(incomplete),/legacy columns differ/i);
  incomplete.close();

  const noForeignKeys = createDatabase({ filename: ':memory:' });
  installLegacyEvidenceSchema(noForeignKeys,{includeForeignKeys:false});
  assert.throws(()=>migrateDatabase(noForeignKeys),/ownership foreign keys or row references are invalid/i);
  assert.equal(noForeignKeys.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(),undefined);
  noForeignKeys.close();
});

test('result evidence repair refuses invalid foreign-key rows before table rebuild', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.pragma('foreign_keys = OFF');
  installLegacyEvidenceSchema(db);
  db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(999,999,'fit_sha256','${'e'.repeat(64)}','fit_upload',0)`).run();
  db.pragma('foreign_keys = ON');
  assert.throws(()=>migrateDatabase(db),/ownership foreign keys or row references are invalid/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_result_evidence').get().n,1);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(),undefined);
  db.close();
});

test('result evidence repair refuses custom indexes and a preexisting repair table', () => {
  const db = createDatabase({ filename: ':memory:' });
  installLegacyEvidenceSchema(db);
  db.exec('CREATE INDEX custom_evidence_lookup ON training_result_evidence(evidence_value)');
  assert.throws(() => migrateDatabase(db), /additional custom indexes/i);
  db.exec('DROP INDEX custom_evidence_lookup; CREATE TABLE training_result_evidence_repair_v1 (id INTEGER)');
  assert.throws(() => migrateDatabase(db), /prior repair table exists/i);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(),undefined);
  db.close();
});

test('result evidence repair refuses duplicate current identities without changing evidence or marker', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'evidence-current-duplicate@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','one'),(2,1,'2026-11-03','run','two')").run();
  installLegacyEvidenceSchema(db,{includeCurrentIndex:false});
  db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(1,1,'fit_sha256','${'c'.repeat(64)}','fit_upload',1),(1,2,'fit_sha256','${'c'.repeat(64)}','fit_upload',1)`).run();
  const before=db.prepare('SELECT id,training_id,evidence_type,evidence_value,source,is_current FROM training_result_evidence ORDER BY id').all();
  assert.throws(()=>migrateDatabase(db),/duplicate current identity group/i);
  assert.deepEqual(db.prepare('SELECT id,training_id,evidence_type,evidence_value,source,is_current FROM training_result_evidence ORDER BY id').all(),before);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(),undefined);
  db.close();
});

test('follow-up evidence repair removes the stricter v1 key even when an early v2 marker exists', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'evidence-followup@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','repair')").run();
  db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(1,1,'fit_sha256','${'f'.repeat(64)}','fit_upload',1)`).run();
  installLegacyEvidenceSchema(db);
  db.exec(`CREATE UNIQUE INDEX idx_training_result_evidence_identity_v2
      ON training_result_evidence(user_id,training_id,evidence_type,evidence_value,source);
    INSERT INTO schema_migrations(name) VALUES('2026-11-training-result-evidence-v2');`);
  migrateDatabase(db);
  const keys = db.prepare('PRAGMA index_list(training_result_evidence)').all()
    .filter((index) => index.unique && !index.partial)
    .map((index) => db.prepare(`PRAGMA index_xinfo("${index.name}")`).all().filter((column) => column.key).map((column) => column.name));
  assert.ok(keys.some((key) => JSON.stringify(key) === JSON.stringify(['user_id','training_id','evidence_type','evidence_value','source'])));
  assert.equal(keys.some((key) => JSON.stringify(key) === JSON.stringify(['user_id','training_id','evidence_type','evidence_value'])), false);
  replaceCurrentEvidence(db,1,1,[{type:'fit_sha256',value:'f'.repeat(64),source:'garmin_connect'}]);
  assert.deepEqual(db.prepare('SELECT source,is_current FROM training_result_evidence ORDER BY source').all(),[
    {source:'fit_upload',is_current:0},{source:'garmin_connect',is_current:1},
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-11-training-result-evidence-v3'").get().n,1);
  db.close();
});

test('result evidence repair refuses absent or incomplete tables without recording its marker', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.exec("DROP TABLE training_result_evidence; DELETE FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2';");
  assert.throws(() => migrateDatabase(db), /required table or identity columns are missing/i);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(), undefined);
  db.exec('CREATE TABLE training_result_evidence (id INTEGER PRIMARY KEY, user_id INTEGER, training_id INTEGER, evidence_type TEXT, evidence_value TEXT)');
  assert.throws(() => migrateDatabase(db), /required table or identity columns are missing/i);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get(), undefined);
  db.close();
});

test('result evidence migration rechecks markers acquired by another initializer before its transaction starts', () => {
  const db = createDatabase({ filename: ':memory:' });
  const originalTransaction = db.transaction.bind(db);
  const raceMarker = (callbackName, marker) => {
    db.transaction = (callback,...args) => {
      const transaction = originalTransaction(callback,...args);
      if (callback.toString().includes(callbackName)) {
        const wrapped = (...values) => transaction(...values);
        Object.defineProperty(wrapped,'immediate',{value:()=>{
          db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(marker);
          return transaction.immediate();
        }});
        return wrapped;
      }
      return transaction;
    };
  };
  try {
    db.prepare("DELETE FROM schema_migrations WHERE name IN ('2026-11-training-result-evidence-v2','2026-11-training-result-evidence-v3')").run();
    raceMarker('evidenceRepairMarker','2026-11-training-result-evidence-v2');
    migrateDatabase(db);
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get());
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v3'").get());

    db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-training-result-evidence-v3'").run();
    raceMarker('evidenceRepairFollowup','2026-11-training-result-evidence-v3');
    migrateDatabase(db);
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v3'").get());
  } finally { db.transaction=originalTransaction; db.close(); }
});

test('createDatabase repairs the legacy file schema before a complete server build', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-evidence-repair-'));
  const filename = path.join(directory, 'database.sqlite');
  let db = createDatabase({ filename });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'file-repair@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','persisted')").run();
  db.prepare(`INSERT INTO training_result_evidence(user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(1,1,'garmin_activity','account:99','garmin_connect',1)`).run();
  installLegacyEvidenceSchema(db);
  db.close();
  try {
    db = createDatabase({ filename });
    assert.equal(db.prepare('SELECT evidence_value FROM training_result_evidence WHERE training_id=1').get().evidence_value, 'account:99');
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-training-result-evidence-v2'").get());
    const app = await buildServer({ db, sessionCookieSecure:false });
    await app.close();
    const indexesBefore = db.prepare('PRAGMA index_list(training_result_evidence)').all().map((row) => [row.name,row.unique,row.partial]).sort();
    migrateDatabase(db);
    assert.deepEqual(db.prepare('PRAGMA index_list(training_result_evidence)').all().map((row) => [row.name,row.unique,row.partial]).sort(), indexesBefore);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

function replaceWithLegacyActivityImports(db, { rows = [], currentColumn = false, uniqueIdentity = true } = {}) {
  db.exec('DROP TABLE garmin_activity_imports');
  db.exec(`CREATE TABLE garmin_activity_imports (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    account_fingerprint TEXT NOT NULL CHECK (length(account_fingerprint)=64),
    activity_id TEXT NOT NULL,
    file_sha256 TEXT NOT NULL CHECK (length(file_sha256)=64),
    importer_version INTEGER NOT NULL CHECK (importer_version>0),
    ${currentColumn ? 'is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),' : ''}
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    ${uniqueIdentity ? ',UNIQUE(account_fingerprint,activity_id)' : ''}
  )`);
  const columns = ['id','user_id','training_id','account_fingerprint','activity_id','file_sha256','importer_version'];
  if (currentColumn) columns.push('is_current');
  columns.push('imported_at');
  const values = rows.map((row) => `(${columns.map(() => '?').join(',')})`).join(',');
  if (rows.length) {
    const parameters = rows.flatMap((row) => [row.id, row.user_id, row.training_id, row.account_fingerprint,
      row.activity_id, row.file_sha256, row.importer_version, ...(currentColumn ? [row.is_current] : []), row.imported_at]);
    db.prepare(`INSERT INTO garmin_activity_imports (${columns.join(',')}) VALUES ${values}`).run(...parameters);
  }
}

test('Garmin activity v2 repair preserves legacy rows as history and completes startup after upgrade', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesis-activity-migration-'));
  const filename = path.join(temp, 'database.sqlite');
  try {
    let db = createDatabase({ filename });
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-upgrade@example.test','hash')").run();
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino,result_data_source) VALUES(1,1,'2026-11-02','run','tempo','garmin_connect')").run();
    replaceWithLegacyActivityImports(db, { rows: [
      { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'b'.repeat(64),importer_version: 1,imported_at: '2026-11-01 10:00:00' },
      { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '73',file_sha256: 'c'.repeat(64),importer_version: 1,imported_at: '2026-11-01 11:00:00' },
    ] });
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v1'").get());
    db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();
    db.close();

    db = createDatabase({ filename });
    assert.deepEqual(db.prepare('SELECT id,user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(), [
      { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 10:00:00' },
      { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '73',file_sha256: 'c'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 11:00:00' },
    ]);
    const tableInfo = db.prepare('PRAGMA table_info(garmin_activity_imports)').all();
    const current = tableInfo.find((column) => column.name === 'is_current');
    assert.equal(current.type, 'INTEGER');
    assert.equal(current.notnull, 1);
    assert.equal(current.dflt_value, '0');
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='garmin_activity_imports'").get().sql, /CHECK \(is_current IN \(0,1\)\)/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(garmin_activity_imports)').all().map((key) => [key.table,key.from,key.to,key.on_delete]).sort(), [
      ['trainings','training_id','id','CASCADE'],['users','user_id','id','CASCADE'],
    ]);
    const indexes = db.prepare('PRAGMA index_list(garmin_activity_imports)').all();
    assert.ok(indexes.some((index) => index.name === 'idx_garmin_activity_import_training' && !index.unique));
    assert.ok(indexes.some((index) => index.name === 'idx_garmin_activity_import_current_training' && index.unique && index.partial));
    db.prepare('UPDATE garmin_activity_imports SET is_current=1 WHERE id=1').run();
    assert.throws(() => db.prepare('UPDATE garmin_activity_imports SET is_current=1 WHERE id=2').run(), /UNIQUE constraint failed/);
    db.prepare('UPDATE garmin_activity_imports SET is_current=0 WHERE id=1').run();
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").get());

    const beforeSecondRun = {
      rows: db.prepare('SELECT id,activity_id,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(),
      indexes: db.prepare('PRAGMA index_list(garmin_activity_imports)').all().map(({name,unique,partial})=>({name,unique,partial})).sort((a,b)=>a.name.localeCompare(b.name)),
    };
    migrateDatabase(db);
    assert.deepEqual({
      rows: db.prepare('SELECT id,activity_id,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(),
      indexes: db.prepare('PRAGMA index_list(garmin_activity_imports)').all().map(({name,unique,partial})=>({name,unique,partial})).sort((a,b)=>a.name.localeCompare(b.name)),
    }, beforeSecondRun);

    const app = await buildServer({ db, sessionCookieSecure: false });
    await app.close();
    db.close();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Garmin activity v3 preserves history while allowing one current account activity and reactivation', async () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-history@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','first')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-03','run','second')").run();
  replaceWithLegacyActivityImports(db, { currentColumn: true, rows: [
    { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 10:00:00' },
    { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '43',file_sha256: 'c'.repeat(64),importer_version: 1,is_current: 1,imported_at: '2026-11-01 11:00:00' },
  ] });
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v3'").run();
  migrateDatabase(db);
  assert.deepEqual(db.prepare('SELECT id,training_id,activity_id,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(), [
    { id: 1,training_id: 1,activity_id: '42',is_current: 0,imported_at: '2026-11-01 10:00:00' },
    { id: 2,training_id: 1,activity_id: '43',is_current: 1,imported_at: '2026-11-01 11:00:00' },
  ]);
  const unique = db.prepare('PRAGMA index_list(garmin_activity_imports)').all().filter((row) => row.unique);
  assert.ok(unique.some((row) => row.name === 'idx_garmin_activity_import_current_identity' && row.partial));
  assert.ok(unique.some((row) => row.name === 'idx_garmin_activity_import_current_training' && row.partial));
  assert.ok(unique.some((row) => row.name === 'idx_garmin_activity_import_training_activity' && !row.partial));
  assert.equal(unique.some((row) => row.origin === 'u'), false, 'the legacy table-wide account/activity unique constraint was removed by the rebuild');

  db.prepare(`INSERT INTO garmin_activity_imports
    (user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current,imported_at)
    VALUES(1,2,?,?,?,1,0,'2026-11-02 10:00:00')`).run('a'.repeat(64),'42','d'.repeat(64));
  db.prepare('UPDATE garmin_activity_imports SET is_current=1 WHERE training_id=2 AND activity_id=\'42\'').run();
  db.prepare('UPDATE garmin_activity_imports SET is_current=0 WHERE training_id=1 AND activity_id=\'43\'').run();
  assert.throws(() => db.prepare('UPDATE garmin_activity_imports SET is_current=1 WHERE training_id=1 AND activity_id=\'42\'').run(), /UNIQUE constraint failed/,
    'an activity currently linked to another session cannot feed both sessions');
  db.prepare('UPDATE garmin_activity_imports SET is_current=0 WHERE training_id=2 AND activity_id=\'42\'').run();
  db.prepare('UPDATE garmin_activity_imports SET is_current=1 WHERE training_id=1 AND activity_id=\'42\'').run();
  assert.deepEqual(db.prepare("SELECT training_id,is_current FROM garmin_activity_imports WHERE activity_id='42' ORDER BY training_id").all(), [
    { training_id: 1,is_current: 1 }, { training_id: 2,is_current: 0 },
  ]);
  const beforeRepeat = {
    rows: db.prepare('SELECT id,training_id,activity_id,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(),
    indexes: db.prepare('PRAGMA index_list(garmin_activity_imports)').all().map(({name,unique,partial})=>({name,unique,partial})).sort((a,b)=>a.name.localeCompare(b.name)),
  };
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v3'").run();
  migrateDatabase(db);
  assert.deepEqual({
    rows: db.prepare('SELECT id,training_id,activity_id,is_current,imported_at FROM garmin_activity_imports ORDER BY id').all(),
    indexes: db.prepare('PRAGMA index_list(garmin_activity_imports)').all().map(({name,unique,partial})=>({name,unique,partial})).sort((a,b)=>a.name.localeCompare(b.name)),
  }, beforeRepeat, 'a second evolution run preserves history and does not rebuild or duplicate rows');
  const app = await buildServer({ db, sessionCookieSecure: false });
  await app.close();
  db.close();
});

test('Garmin activity v3 rolls back before marking ambiguous links or incompatible schemas', () => {
  for (const scenario of ['multiple_current', 'duplicate_history', 'foreign_key', 'incompatible_foreign_key', 'intermediate_table', 'missing_column']) {
    const db = createDatabase({ filename: ':memory:' });
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,?, 'hash')").run(`activity-v3-${scenario}@example.test`);
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','one')").run();
    db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(2,1,'2026-11-03','run','two')").run();
    if (scenario === 'multiple_current') {
      replaceWithLegacyActivityImports(db, { currentColumn: true, uniqueIdentity: false, rows: [
        { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 1,imported_at: '2026-11-01 10:00:00' },
        { id: 2,user_id: 1,training_id: 2,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'c'.repeat(64),importer_version: 1,is_current: 1,imported_at: '2026-11-01 11:00:00' },
      ] });
    } else if (scenario === 'duplicate_history') {
      replaceWithLegacyActivityImports(db, { currentColumn: true, uniqueIdentity: false, rows: [
        { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 10:00:00' },
        { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'c'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 11:00:00' },
      ] });
    } else if (scenario === 'foreign_key') {
      db.pragma('foreign_keys = OFF');
      replaceWithLegacyActivityImports(db, { currentColumn: true, rows: [
        { id: 1,user_id: 99,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 10:00:00' },
      ] });
      db.pragma('foreign_keys = ON');
    } else if (scenario === 'incompatible_foreign_key') {
      db.exec(`DROP TABLE garmin_activity_imports;
        CREATE TABLE garmin_activity_imports (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
          training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
          account_fingerprint TEXT NOT NULL, activity_id TEXT NOT NULL, file_sha256 TEXT NOT NULL,
          importer_version INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 0,
          imported_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(account_fingerprint,activity_id)
        );`);
      db.prepare(`INSERT INTO garmin_activity_imports
        (id,user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
        VALUES(1,1,1,?,?,?,1,0)`).run('a'.repeat(64),'42','b'.repeat(64));
    } else if (scenario === 'intermediate_table') {
      db.exec('CREATE TABLE garmin_activity_imports_v3 (id INTEGER PRIMARY KEY)');
      replaceWithLegacyActivityImports(db, { currentColumn: true, rows: [
        { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 0,imported_at: '2026-11-01 10:00:00' },
      ] });
    } else {
      replaceWithLegacyActivityImports(db, { currentColumn: false, rows: [
        { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '42',file_sha256: 'b'.repeat(64),importer_version: 1,imported_at: '2026-11-01 10:00:00' },
      ] });
    }
    db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v3'").run();
    const beforeColumns = scenario === 'missing_column' ? 'id,user_id,training_id,activity_id' : 'id,user_id,training_id,activity_id,is_current';
    const before = db.prepare(`SELECT ${beforeColumns} FROM garmin_activity_imports ORDER BY id`).all();
    const expectedError = scenario === 'multiple_current' ? /currently linked to multiple sessions/
      : scenario === 'duplicate_history' ? /duplicate activity history/
        : scenario === 'foreign_key' ? /invalid owner or training reference/
          : scenario === 'incompatible_foreign_key' ? /incompatible ownership foreign keys/
            : scenario === 'intermediate_table' ? /unexpected intermediate table/ : /missing columns: is_current/;
    assert.throws(() => migrateDatabase(db), expectedError);
    assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v3'").get(), undefined);
    if (scenario !== 'intermediate_table') assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='garmin_activity_imports_v3'").get(), undefined);
    assert.deepEqual(db.prepare(`SELECT ${beforeColumns} FROM garmin_activity_imports ORDER BY id`).all(), before);
    db.close();
  }
});

test('Garmin activity v2 repair fixes incompatible named indexes and preserves an explicit current link', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-index@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino,result_data_source) VALUES(1,1,'2026-11-02','run','tempo','garmin_connect')").run();
  db.prepare(`INSERT INTO garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version,is_current)
    VALUES(1,1,?,?,?,1,1)`).run('a'.repeat(64),'72','b'.repeat(64));
  db.exec(`DROP INDEX idx_garmin_activity_import_training;
    DROP INDEX idx_garmin_activity_import_current_training;
    CREATE INDEX idx_garmin_activity_import_training ON garmin_activity_imports(activity_id);
    CREATE UNIQUE INDEX idx_garmin_activity_import_current_training ON garmin_activity_imports(user_id,training_id) WHERE is_current=0;
    CREATE UNIQUE INDEX idx_garmin_activity_import_identity ON garmin_activity_imports(file_sha256);`);
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();
  migrateDatabase(db);
  assert.equal(db.prepare('SELECT is_current FROM garmin_activity_imports WHERE activity_id=?').get('72').is_current, 1);
  const indexes = db.prepare('PRAGMA index_list(garmin_activity_imports)').all();
  assert.ok(indexes.some((index) => index.name === 'idx_garmin_activity_import_training' && !index.unique));
  assert.ok(indexes.some((index) => index.name === 'idx_garmin_activity_import_current_training' && index.unique && index.partial));
  const uniqueIndexes = db.prepare('PRAGMA index_list(garmin_activity_imports)').all().filter((index) => index.unique);
  assert.ok(uniqueIndexes.some((index) => db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map((row) => row.name)
    .join(',') === 'account_fingerprint,activity_id'));
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_garmin_activity_import_training)').all().map((row) => row.name), ['user_id','training_id','imported_at']);
  db.close();
});

test('Garmin activity v2 creates the missing identity index when legacy metadata lacks uniqueness', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-identity-index@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','tempo')").run();
  replaceWithLegacyActivityImports(db, { uniqueIdentity: false, rows: [
    { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'b'.repeat(64),importer_version: 1,imported_at: '2026-11-01 10:00:00' },
  ] });
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();

  migrateDatabase(db);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_garmin_activity_import_identity'").get();
  assert.match(index.sql, /CREATE UNIQUE INDEX .*\(account_fingerprint,activity_id\)/);
  assert.throws(() => db.prepare(`INSERT INTO garmin_activity_imports(user_id,training_id,account_fingerprint,activity_id,file_sha256,importer_version)
    VALUES(1,1,?,?,?,1)`).run('a'.repeat(64),'72','c'.repeat(64)), /UNIQUE constraint failed/);
  db.close();
});

test('Garmin activity v2 refuses ambiguous multiple current legacy rows without partial changes', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-current-index@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','tempo')").run();
  replaceWithLegacyActivityImports(db, { currentColumn: true, rows: [
    { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'b'.repeat(64),importer_version: 1,is_current: 1,imported_at: '2026-11-01 10:00:00' },
    { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '73',file_sha256: 'c'.repeat(64),importer_version: 1,is_current: 1,imported_at: '2026-11-01 11:00:00' },
  ] });
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();

  assert.throws(() => migrateDatabase(db), /multiple current activities/);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").get(), undefined);
  assert.deepEqual(db.prepare('SELECT id,is_current FROM garmin_activity_imports ORDER BY id').all(), [
    { id: 1,is_current: 1 }, { id: 2,is_current: 1 },
  ]);
  assert.equal(db.prepare('PRAGMA index_list(garmin_activity_imports)').all().filter((index) => index.origin === 'c').length, 0);
  db.close();
});

test('Garmin activity v2 fails actionably for missing, partial, foreign-key-incompatible and invalid-current schemas', () => {
  const variants = [
    { name: 'missing table', create: null, error: /cannot find its v1 table/ },
    { name: 'partial table', create: 'CREATE TABLE garmin_activity_imports(id INTEGER PRIMARY KEY)', error: /incomplete v1 table/ },
    { name: 'foreign keys', create: `CREATE TABLE garmin_activity_imports (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,training_id INTEGER NOT NULL,
      account_fingerprint TEXT NOT NULL,activity_id TEXT NOT NULL,file_sha256 TEXT NOT NULL,
      importer_version INTEGER NOT NULL,imported_at TEXT NOT NULL)`, error: /incompatible ownership foreign keys/ },
    { name: 'invalid is_current', create: `CREATE TABLE garmin_activity_imports (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      account_fingerprint TEXT NOT NULL,activity_id TEXT NOT NULL,file_sha256 TEXT NOT NULL,
      importer_version INTEGER NOT NULL,is_current TEXT NOT NULL DEFAULT '0',imported_at TEXT NOT NULL)`, error: /invalid is_current constraint/ },
    { name: 'nullable is_current', create: `CREATE TABLE garmin_activity_imports (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      account_fingerprint TEXT NOT NULL,activity_id TEXT NOT NULL,file_sha256 TEXT NOT NULL,
      importer_version INTEGER NOT NULL,is_current INTEGER CHECK (is_current IN (0,1)),imported_at TEXT NOT NULL)`, error: /invalid is_current constraint/ },
    { name: 'is_current without range check', create: `CREATE TABLE garmin_activity_imports (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      account_fingerprint TEXT NOT NULL,activity_id TEXT NOT NULL,file_sha256 TEXT NOT NULL,
      importer_version INTEGER NOT NULL,is_current INTEGER NOT NULL DEFAULT 0,imported_at TEXT NOT NULL)`, error: /invalid is_current constraint/ },
  ];
  for (const variant of variants) {
    const db = createDatabase({ filename: ':memory:' });
    if (variant.create) {
      db.exec('DROP TABLE garmin_activity_imports');
      db.exec(variant.create);
    } else db.exec('DROP TABLE garmin_activity_imports');
    db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();
    const columnsBefore = db.prepare('PRAGMA table_info(garmin_activity_imports)').all().map((column) => column.name);
    assert.throws(() => migrateDatabase(db), variant.error, variant.name);
    assert.deepEqual(db.prepare('PRAGMA table_info(garmin_activity_imports)').all().map((column) => column.name), columnsBefore, variant.name);
    assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").get(), undefined, variant.name);
    db.close();
  }
});

test('Garmin activity v2 migration failure rolls back its added column, indexes, and marker', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'activity-failure@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','tempo')").run();
  replaceWithLegacyActivityImports(db, { uniqueIdentity: false, rows: [
    { id: 1,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'b'.repeat(64),importer_version: 1,imported_at: '2026-11-01 10:00:00' },
    { id: 2,user_id: 1,training_id: 1,account_fingerprint: 'a'.repeat(64),activity_id: '72',file_sha256: 'c'.repeat(64),importer_version: 1,imported_at: '2026-11-01 11:00:00' },
  ] });
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").run();
  assert.throws(() => migrateDatabase(db), /duplicate identities exist/);
  assert.equal(db.prepare('PRAGMA table_info(garmin_activity_imports)').all().some((column) => column.name === 'is_current'), false);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-activity-import-v2'").get(), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM garmin_activity_imports').get().count, 2);
  assert.equal(db.prepare('PRAGMA index_list(garmin_activity_imports)').all().length, 0);
  db.close();
});

test('Garmin v2 upgrade preserves a v1 journal row and adds identity and cleanup columns', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users (id,email,password_hash) VALUES (1,'migration@example.test','hash')").run();
  db.prepare("INSERT INTO trainings (id,user_id,dia,tipo,treino) VALUES (1,1,'2026-11-02','run','tempo')").run();
  db.prepare(`INSERT INTO garmin_training_operations
    (operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,status,stage,workout_id,occurrence_id,scheduled_date)
    VALUES ('legacy-op',1,1,1,1,'fingerprint',1,'outcome_unknown','schedule','42','77','2026-11-02')`).run();

  db.pragma('foreign_keys = OFF');
  db.exec(`DROP INDEX IF EXISTS garmin_operation_identity_v4;
    DROP INDEX IF EXISTS garmin_operation_identity_v3;
    ALTER TABLE garmin_training_operations RENAME TO garmin_operations_newer;
    CREATE TABLE garmin_training_operations (
      operation_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      connection_generation INTEGER NOT NULL, prescription_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      converter_version INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, workout_id TEXT,
      occurrence_id TEXT, scheduled_date TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO garmin_training_operations (operation_id,user_id,training_id,connection_generation,prescription_revision,
      fingerprint,converter_version,status,stage,workout_id,occurrence_id,scheduled_date,error_code,created_at,updated_at)
      SELECT operation_id,user_id,training_id,connection_generation,prescription_revision,fingerprint,converter_version,
      status,stage,workout_id,occurrence_id,scheduled_date,error_code,created_at,updated_at FROM garmin_operations_newer;
    DROP TABLE garmin_operations_newer;
    ALTER TABLE garmin_pilot_connections RENAME TO garmin_connections_newer;
    CREATE TABLE garmin_pilot_connections (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      connection_generation INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    DROP TABLE garmin_connections_newer;
    ALTER TABLE garmin_cleanup_state RENAME TO garmin_cleanup_newer;
    CREATE TABLE garmin_cleanup_state (id INTEGER PRIMARY KEY CHECK (id=1), pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0,1)), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO garmin_cleanup_state (id,pending) VALUES (1,1);
    DROP TABLE garmin_cleanup_newer;
    DELETE FROM schema_migrations WHERE name IN ('2026-10-garmin-session-publish-v2','2026-10-garmin-session-publish-v3','2026-10-garmin-session-publish-v4');`);
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  assert.deepEqual(db.prepare(`SELECT action,source_operation_id,workout_id,occurrence_id FROM garmin_training_operations
    WHERE operation_id='legacy-op'`).get(), { action: 'publish', source_operation_id: null, workout_id: '42', occurrence_id: '77' });
  assert.deepEqual(db.prepare('SELECT identity_fingerprint,cleanup_pending FROM garmin_pilot_connections WHERE user_id=1').get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-10-garmin-session-publish-v3'").get() !== undefined, true);
  assert.deepEqual(db.prepare('SELECT pending,preserve_identity FROM garmin_cleanup_state WHERE id=1').get(), { pending: 1, preserve_identity: 0 });
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name='2026-11-garmin-cleanup-identity-v1'").get());
  db.close();
});

test('initializeDatabase applies pragmas and creates the schema', () => {
  const db = initializeDatabase(new Database(':memory:'));

  assert.deepEqual(db.pragma('journal_mode', { simple: true }), 'memory');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  const objects = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(objects, [
    'admin_audit_log',
    'ai_coach_availability',
    'ai_execution_raw_outputs',
    'ai_executions',
    'ai_global_usage',
    'ai_interpretation_replacements',
    'ai_interpretations',
    'ai_memory',
    'ai_profiles',
    'ai_usage',
    'cycle_plan_proposals',
    'cycle_plan_versions',
    'feedback',
    'garmin_activity_imports',
    'garmin_cleanup_state',
    'garmin_connection_cleanup',
    'garmin_legacy_cleanup_quarantine',
    'garmin_pilot_connections',
    'garmin_training_operations',
    'garmin_workout_prescriptions',
    'schema_migrations',
    'sessions',
    'shoes',
    'training_cycles',
    'training_result_evidence',
    'training_shoe_mileage',
    'trainings',
    'users',
    'weekly_workout_proposals',
    'workout_analysis_versions',
  ]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workouts'",
      )
      .get(),
    undefined,
    'new databases do not create the legacy workouts table',
  );
  const trainingColumns = db
    .pragma('table_info(trainings)')
    .map((column) => column.name);
  assert.ok(trainingColumns.includes('result_data_source'));
  assert.ok(trainingColumns.includes('fit_calories'));
  assert.ok(trainingColumns.includes('feedback_shoe_id'));
  assert.equal(db.prepare('SELECT role FROM users LIMIT 1').get(), undefined);
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('role-check@example.com', 'x')",
  ).run();
  assert.equal(
    db
      .prepare('SELECT role FROM users WHERE email = ?')
      .get('role-check@example.com').role,
    'user',
  );
  assert.throws(() =>
    db
      .prepare("UPDATE users SET role = 'owner' WHERE email = ?")
      .run('role-check@example.com'),
  );

  db.close();
});

test('role migration assigns existing accounts user, preserves records, is repeatable, and retains admins', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      first_name TEXT, last_name TEXT, preferred_lang TEXT NOT NULL DEFAULT 'en-US',
      first_day_of_week TEXT NOT NULL DEFAULT 'Monday', distance_unit TEXT NOT NULL DEFAULT 'km',
      temperature_unit TEXT NOT NULL DEFAULT 'C', onboarding_status TEXT NOT NULL DEFAULT 'active',
      onboarding_guide_hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE trainings (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      training_cycle_id TEXT, dia TEXT NOT NULL, tipo TEXT NOT NULL, treino TEXT, location TEXT
    );
    INSERT INTO users (id, email, password_hash, first_name, preferred_lang, distance_unit, onboarding_status, onboarding_guide_hidden)
      VALUES (41, 'old@example.com', 'existing-hash', 'Old', 'pt-BR', 'mi', 'active', 1);
    INSERT INTO sessions (id, user_id, expires_at) VALUES ('old-session', 41, '2999-01-01T00:00:00.000Z');
    INSERT INTO trainings (id, user_id, dia, tipo, treino, location)
      VALUES (501, 41, '2026-09-21', 'Run', 'Easy run', 'Porto');
  `);
  initializeDatabase(db);
  const existing = db
    .prepare(
      'SELECT id, email, password_hash, first_name, preferred_lang, distance_unit, onboarding_status, onboarding_guide_hidden, role FROM users WHERE id = 41',
    )
    .get();
  assert.deepEqual(existing, {
    id: 41,
    email: 'old@example.com',
    password_hash: 'existing-hash',
    first_name: 'Old',
    preferred_lang: 'pt-BR',
    distance_unit: 'mi',
    onboarding_status: 'active',
    onboarding_guide_hidden: 1,
    role: 'user',
  });
  assert.equal(
    db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('old-session')
      .user_id,
    41,
  );
  assert.deepEqual(
    db
      .prepare('SELECT id, treino, location FROM trainings WHERE id = 501')
      .get(),
    {
      id: 501,
      treino: 'Easy run',
      location: 'Porto',
    },
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM schema_migrations WHERE name = '2026-09-structured-ai-coach-availability-v1'",
      )
      .get(),
  );
  assert.ok(
    db.prepare('SELECT 1 FROM ai_coach_availability LIMIT 1').get() ===
      undefined,
  );
  db.prepare("UPDATE users SET role = 'admin' WHERE id = 41").run();
  migrateDatabase(db);
  migrateDatabase(db);
  assert.equal(
    db.prepare('SELECT role FROM users WHERE id = 41').get().role,
    'admin',
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-09-user-roles-v1'",
      )
      .get().count,
    1,
  );
  db.close();
});

test('shoe mileage migration links unique labels without changing authoritative production totals', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('runner@test', 'x'), ('peer@test', 'x')",
  ).run();
  db.prepare(
    `INSERT INTO shoes (id, user_id, brand, model, mileage, status) VALUES
    ('unique', 1, 'Acme', 'Fast', 5, 'active'),
    ('dup1', 1, 'Acme', 'Same', 1, 'active'), ('dup2', 1, 'Acme', 'Same', 2, 'active'),
    ('peer', 2, 'Acme', 'Fast', 30, 'active')`,
  ).run();
  db.prepare(
    `INSERT INTO trainings
    (user_id, dia, tipo, feedback_shoe, completed, fit_distance, result_data_source)
    VALUES (1, '2026-01-01', 'Run', 'Acme Fast', 1, 10, 'manual'),
           (1, '2026-01-02', 'Run', 'Acme Same', 1, 8, 'manual'),
           (1, '2026-01-03', 'Run', 'Acme Fast', 0, 6, 'manual')`,
  ).run();
  db.prepare(
    "DELETE FROM schema_migrations WHERE name = '2026-09-shoe-mileage-accounting-v1'",
  ).run();
  migrateDatabase(db);
  migrateDatabase(db);
  const rows = db
    .prepare('SELECT feedback_shoe_id FROM trainings ORDER BY id')
    .all();
  assert.deepEqual(rows, [
    { feedback_shoe_id: 'unique' },
    { feedback_shoe_id: null },
    { feedback_shoe_id: 'unique' },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT mileage, base_mileage FROM shoes WHERE id = 'unique'")
      .get(),
    { mileage: 5, base_mileage: 5 },
  );
  assert.equal(
    db.prepare("SELECT mileage FROM shoes WHERE id = 'peer'").get().mileage,
    30,
  );
  assert.deepEqual(db.prepare('SELECT * FROM training_shoe_mileage').all(), []);
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM schema_migrations WHERE name = '2026-09-shoe-mileage-ledger-v2'",
      )
      .get(),
  );
  db.close();
});

test('migrateDatabase classifies existing FIT rows and leaves result-less rows as none', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('source@example.com', 'hash')",
  ).run();
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo, fit_duration, fit_distance, fit_summary_json) VALUES (1, '2026-08-20', 'Run', '30:00', 5, '{\"laps\":[]}')",
  ).run();
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo) VALUES (1, '2026-08-21', 'Run')",
  ).run();
  db.prepare(
    "INSERT INTO trainings (user_id, dia, tipo, result_data_source, fit_distance) VALUES (1, '2026-08-22', 'Run', 'manual', 8)",
  ).run();
  db.prepare(
    "UPDATE trainings SET result_data_source = 'none' WHERE id IN (1, 2)",
  ).run();
  migrateDatabase(db);
  const rows = db
    .prepare(
      'SELECT result_data_source, fit_distance FROM trainings ORDER BY id',
    )
    .all();
  assert.deepEqual(rows, [
    { result_data_source: 'fit_upload', fit_distance: 5 },
    { result_data_source: 'none', fit_distance: null },
    { result_data_source: 'manual', fit_distance: 8 },
  ]);
  assert.doesNotThrow(() => migrateDatabase(db));
  db.close();
});

test('corrective FIT cadence migration repairs proven historical fields independently and is idempotent', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('cadence@example.test', 'hash')",
  ).run();
  const sourceTagged = JSON.stringify({
    activity: { sport: 'running' },
    laps: [
      {
        avgCadenceSpm: 82,
        avgCadenceSource: 'avg_cadence_running',
        maxCadenceSpm: 88,
        maxCadenceSource: 'max_cadence_running',
      },
      {
        avgCadenceSpm: 82,
        avgCadenceSource: 'avg_running_cadence',
        maxCadenceSpm: 90,
        maxCadenceSource: 'max_running_cadence',
      },
      {
        avgCadenceSpm: 82,
        avgCadenceSource: 'avg_cadence_running',
        maxCadenceSpm: 90,
        maxCadenceSource: 'vendor_unknown',
      },
      {
        avgCadenceSpm: null,
        avgCadenceSource: 'avg_cadence_running',
        maxCadenceSpm: null,
      },
      {
        avgCadenceSpm: 82,
        avgCadenceSource: 'vendor_unknown',
        maxCadenceSpm: 90,
        maxCadenceSource: 'max_cadence_running',
      },
      { avgCadenceSpm: 81, maxCadenceSpm: null },
      {
        avgCadenceSpm: 80,
        avgCadenceSource: 'avg_cadence_running',
        avgCadenceUnit: 'vendor-unit',
        maxCadenceSpm: 90,
        maxCadenceSource: 'max_cadence_running',
      },
      null,
      [],
    ],
  });
  const alreadyNormalized = JSON.stringify({
    cadenceNormalization: 'two-foot-spm-v1',
    activity: { sport: 'running' },
    laps: [{ avgCadenceSpm: 164, avgCadenceSource: 'avg_cadence_running' }],
  });
  const fieldNormalized = JSON.stringify({
    activity: { sport: 'running' },
    laps: [
      {
        avgCadenceSpm: 164,
        avgCadenceUnit: 'two-foot-spm-v1',
        maxCadenceSpm: 90,
        maxCadenceSource: 'max_running_cadence',
      },
    ],
  });
  const fieldNormalizedOnly = JSON.stringify({
    activity: { sport: 'running' },
    laps: [{ avgCadenceSpm: 164, avgCadenceUnit: 'two-foot-spm-v1' }],
  });
  const nonRunning = JSON.stringify({
    activity: { sport: 'cycling' },
    laps: [{ avgCadenceSpm: 82, avgCadenceSource: 'avg_cadence_running' }],
  });
  const malformed = '{not-json';
  db.prepare(
    `INSERT INTO trainings (user_id, dia, tipo, result_data_source, fit_summary_json) VALUES
    (1, '2026-09-01', 'Run', 'fit_upload', ?),
    (1, '2026-09-02', 'Ride', 'fit_upload', ?),
    (1, '2026-09-03', 'Run', 'fit_upload', ?),
    (1, '2026-09-04', 'Run', 'fit_upload', ?),
    (1, '2026-09-05', 'Run', 'fit_upload', ?),
    (1, '2026-09-06', 'Run', 'fit_upload', ?)`,
  ).run(
    sourceTagged,
    nonRunning,
    malformed,
    alreadyNormalized,
    fieldNormalized,
    fieldNormalizedOnly,
  );

  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-10-fit-cadence-two-foot-v1'",
      )
      .get().count,
    1,
    'models a database that already applied the original migration',
  );
  db.prepare(
    "DELETE FROM schema_migrations WHERE name = '2026-10-fit-cadence-source-v2'",
  ).run();
  migrateDatabase(db);
  const rows = db
    .prepare('SELECT fit_summary_json FROM trainings ORDER BY id')
    .all()
    .map((row) => {
      try {
        return JSON.parse(row.fit_summary_json);
      } catch {
        return row.fit_summary_json;
      }
    });
  assert.deepEqual(rows[0].laps[0], {
    avgCadenceSpm: 164,
    avgCadenceSource: 'avg_cadence_running',
    avgCadenceUnit: 'two-foot-spm-v1',
    maxCadenceSpm: 176,
    maxCadenceSource: 'max_cadence_running',
    maxCadenceUnit: 'two-foot-spm-v1',
  });
  assert.deepEqual(rows[0].laps[1], {
    avgCadenceSpm: 164,
    avgCadenceSource: 'avg_running_cadence',
    avgCadenceUnit: 'two-foot-spm-v1',
    maxCadenceSpm: 180,
    maxCadenceSource: 'max_running_cadence',
    maxCadenceUnit: 'two-foot-spm-v1',
  });
  assert.equal(
    Object.hasOwn(rows[0], 'cadenceNormalization'),
    false,
    'mixed known and unknown values do not receive a misleading summary-wide marker',
  );
  assert.deepEqual(
    rows[0].laps[2],
    {
      avgCadenceSpm: 164,
      avgCadenceSource: 'avg_cadence_running',
      avgCadenceUnit: 'two-foot-spm-v1',
      maxCadenceSpm: 90,
      maxCadenceSource: 'vendor_unknown',
    },
    'the known average is corrected while the unknown maximum stays unchanged',
  );
  assert.equal(rows[0].laps[2].avgCadenceUnit, 'two-foot-spm-v1');
  assert.equal(rows[0].laps[3].avgCadenceSpm, null);
  assert.equal(rows[0].laps[3].maxCadenceSpm, null);
  assert.deepEqual(
    rows[0].laps[4],
    {
      avgCadenceSpm: 82,
      avgCadenceSource: 'vendor_unknown',
      maxCadenceSpm: 180,
      maxCadenceSource: 'max_cadence_running',
      maxCadenceUnit: 'two-foot-spm-v1',
    },
    'the known maximum converts independently while the unknown average remains raw',
  );
  assert.deepEqual(
    rows[0].laps[5],
    {
      avgCadenceSpm: 162,
      maxCadenceSpm: null,
      avgCadenceUnit: 'two-foot-spm-v1',
    },
    'the historical no-metadata format is recognized as raw running cadence',
  );
  assert.deepEqual(
    rows[0].laps[6],
    {
      avgCadenceSpm: 80,
      avgCadenceSource: 'avg_cadence_running',
      avgCadenceUnit: 'vendor-unit',
      maxCadenceSpm: 180,
      maxCadenceSource: 'max_cadence_running',
      maxCadenceUnit: 'two-foot-spm-v1',
    },
    'an explicit unknown unit is preserved while the other cadence field is normalized',
  );
  assert.equal(rows[0].laps[7], null);
  assert.deepEqual(rows[0].laps[8], []);
  assert.equal(
    rows[1].laps[0].avgCadenceSpm,
    82,
    'a known source does not override non-running sport context',
  );
  assert.equal(rows[2], malformed);
  assert.equal(
    rows[3].laps[0].avgCadenceSpm,
    164,
    'the exact normalized marker prevents a second conversion',
  );
  assert.deepEqual(
    rows[4].laps[0],
    {
      avgCadenceSpm: 164,
      avgCadenceUnit: 'two-foot-spm-v1',
      maxCadenceSpm: 180,
      maxCadenceSource: 'max_running_cadence',
      maxCadenceUnit: 'two-foot-spm-v1',
    },
    'field-level normalized values are not doubled when another metric is still raw',
  );
  assert.equal(rows[5].cadenceNormalization, undefined);
  assert.equal(
    rows[5].laps[0].avgCadenceSpm,
    164,
    'an already normalized field without other changes is left untouched',
  );

  const first = db
    .prepare('SELECT fit_summary_json FROM trainings WHERE id = 1')
    .get().fit_summary_json;
  migrateDatabase(db);
  assert.equal(
    db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 1').get()
      .fit_summary_json,
    first,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-10-fit-cadence-source-v2'",
      )
      .get().count,
    1,
  );
  db.close();
});

test('original FIT cadence migration converts the historical running summary without source metadata', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('cadence-legacy@example.test', 'hash')",
  ).run();
  const summary = {
    activity: { sport: 'running' },
    laps: [
      { avgCadenceSpm: 81, maxCadenceSpm: 92 },
      { avgCadenceSpm: null, maxCadenceSpm: null },
      { avgCadenceSpm: null, maxCadenceSpm: 0 },
    ],
  };
  db.prepare(
    `INSERT INTO trainings (user_id, dia, tipo, result_data_source, fit_summary_json)
    VALUES (1, '2026-09-01', 'Run', 'fit_upload', ?),
      (1, '2026-09-02', 'Run', 'fit_upload', '{invalid-json'),
      (1, '2026-09-03', 'Run', 'fit_upload', ?),
      (1, '2026-09-04', 'Run', 'fit_upload', ?),
      (1, '2026-09-05', 'Run', 'fit_upload', ?),
      (1, '2026-09-06', 'Run', 'fit_upload', ?)`,
  ).run(
    JSON.stringify(summary),
    JSON.stringify({
      activity: { sport: 'running' },
      laps: [{ avgCadenceSpm: 82, avgCadenceSource: 'avg_cadence_running' }],
    }),
    JSON.stringify({
      cadenceNormalization: 'two-foot-spm-v1',
      activity: { sport: 'running' },
      laps: [{ avgCadenceSpm: 164 }],
    }),
    JSON.stringify({
      activity: { sport: 'cycling' },
      laps: [{ avgCadenceSpm: 82 }],
    }),
    JSON.stringify({ activity: { sport: 'running' }, laps: {} }),
  );
  db.prepare(
    `DELETE FROM schema_migrations
    WHERE name IN ('2026-10-fit-cadence-two-foot-v1', '2026-10-fit-cadence-source-v2')`,
  ).run();

  migrateDatabase(db);
  const persisted = JSON.parse(
    db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 1').get()
      .fit_summary_json,
  );
  assert.equal(persisted.laps[0].avgCadenceSpm, 162);
  assert.equal(persisted.laps[0].maxCadenceSpm, 184);
  assert.equal(persisted.laps[1].avgCadenceSpm, null);
  assert.equal(persisted.laps[1].maxCadenceSpm, null);
  assert.equal(persisted.laps[2].maxCadenceSpm, 0);
  assert.equal(persisted.cadenceNormalization, 'two-foot-spm-v1');
  assert.equal(
    db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 2').get()
      .fit_summary_json,
    '{invalid-json',
  );
  assert.equal(
    JSON.parse(
      db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 3').get()
        .fit_summary_json,
    ).laps[0].avgCadenceSpm,
    164,
    'source metadata is skipped by the original migration and handled by the corrective one',
  );
  assert.equal(
    JSON.parse(
      db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 4').get()
        .fit_summary_json,
    ).laps[0].avgCadenceSpm,
    164,
    'the summary-level marker prevents an old value from being converted again',
  );
  assert.equal(
    JSON.parse(
      db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 5').get()
        .fit_summary_json,
    ).laps[0].avgCadenceSpm,
    82,
    'non-running cadence is preserved',
  );
  assert.deepEqual(
    JSON.parse(
      db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 6').get()
        .fit_summary_json,
    ).laps,
    {},
  );
  migrateDatabase(db);
  const repeated = JSON.parse(
    db.prepare('SELECT fit_summary_json FROM trainings WHERE id = 1').get()
      .fit_summary_json,
  );
  assert.deepEqual(repeated, persisted);
  db.close();
});

test('legacy parser summary is persisted, corrected by migration, and served to the result page', async () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = await registerUser(db, {
    email: 'legacy-cadence@example.test',
    password: 'cadence-secret-1',
    first_name: 'Legacy',
    last_name: 'Runner',
  });
  const legacyParserSummary = {
    activity: { sport: 'running' },
    totals: { durationSeconds: 60, distanceKm: 0.2, ascentMeters: 0 },
    laps: [
      {
        lap: 1,
        stepType: 'Run',
        durationLabel: '1:00',
        distanceLabel: '0.20',
        avgPaceLabel: '5:00',
        avgCadenceSpm: 82,
        avgCadenceSource: 'avg_cadence_running',
        maxCadenceSpm: 91,
        maxCadenceSource: 'max_cadence_running',
      },
    ],
  };
  const trainingId = Number(
    db
      .prepare(
        `INSERT INTO trainings
    (user_id, dia, tipo, fit_duration, fit_distance, fit_elevation_gain, fit_summary_json, result_data_source)
    VALUES (?, '2026-09-28', 'Corrida', '1:00', 0.2, 0, ?, 'fit_upload')`,
      )
      .run(user.id, JSON.stringify(legacyParserSummary)).lastInsertRowid,
  );
  db.prepare(
    "DELETE FROM schema_migrations WHERE name = '2026-10-fit-cadence-source-v2'",
  ).run();
  migrateDatabase(db);

  const app = await buildServer({ db, sessionCookieSecure: false });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      email: 'legacy-cadence@example.test',
      password: 'cadence-secret-1',
    },
  });
  assert.equal(login.statusCode, 200);
  const cookie = [].concat(login.headers['set-cookie'] ?? [])[0].split(';')[0];
  const response = await app.inject({
    method: 'GET',
    url: `/api/trainings/${trainingId}`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const summary = JSON.parse(response.json().training.fit_summary_json);
  assert.equal(summary.laps[0].avgCadenceSpm, 164);
  assert.equal(summary.laps[0].maxCadenceSpm, 182);
  assert.equal(summary.cadenceNormalization, 'two-foot-spm-v1');
  assert.equal(formatCadence(summary.laps[0].avgCadenceSpm), '164');
  assert.match(
    buildLapsMarkdown(summary.laps),
    /\| 1 \| Run \| 0\.20 km \| 1:00 \| 5:00 min\/km \| - \| 164 \| - \|/,
  );
  await app.close();
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
      "INSERT INTO users (email, password_hash, preferred_lang) VALUES (?, ?, 'pt-BR')",
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
    'hash',
  );

  migrateDatabase(db);

  const row = db
    .prepare(
      'SELECT email, preferred_lang, first_day_of_week FROM users WHERE email = ?',
    )
    .get('legacy@example.com');
  assert.equal(row.preferred_lang, 'en-US');
  assert.equal(row.first_day_of_week, 'Monday');

  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(
    'post-migration@example.com',
    'hash',
  );
  const defaulted = db
    .prepare(
      'SELECT preferred_lang, first_day_of_week FROM users WHERE email = ?',
    )
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
    "INSERT INTO users (email, password_hash, preferred_lang, first_day_of_week) VALUES (?, ?, 'pt-BR', 'Sunday')",
  ).run('partial@example.com', 'hash');

  assert.doesNotThrow(() => migrateDatabase(db));
  assert.doesNotThrow(() => migrateDatabase(db));

  const columns = db.pragma('table_info(users)').map((column) => column.name);
  assert.ok(columns.includes('first_day_of_week'));

  const row = db
    .prepare(
      'SELECT preferred_lang, first_day_of_week, onboarding_status, onboarding_guide_hidden FROM users WHERE email = ?',
    )
    .get('partial@example.com');
  assert.equal(row.preferred_lang, 'pt-BR');
  assert.equal(
    row.first_day_of_week,
    'Sunday',
    'existing values are preserved',
  );
  assert.equal(
    row.onboarding_status,
    'active',
    'a representative pre-onboarding user table migrates to active',
  );
  assert.equal(
    row.onboarding_guide_hidden,
    0,
    'the new presentation preference gets a default without altering other user data',
  );

  const fresh = db
    .prepare(
      'INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING first_day_of_week',
    )
    .get('fresh@example.com', 'hash');
  assert.equal(fresh.first_day_of_week, 'Monday');

  db.close();
});

test('initializeDatabase is safe to run on already-migrated databases', () => {
  const first = createDatabase({ filename: ':memory:' });
  assert.doesNotThrow(() => initializeDatabase(first));
  first.close();
});

test('onboarding migration converts legacy accounts to active idempotently without changing their data', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('old-account@example.com', 'hash')",
  ).run();
  db.prepare(
    "UPDATE users SET onboarding_status = 'legacy', onboarding_guide_hidden = 1 WHERE email = 'old-account@example.com'",
  ).run();
  db.prepare(
    "INSERT INTO shoes (id, user_id, brand, model, mileage) VALUES ('old-shoe', 1, 'Acme', 'Runner', 27)",
  ).run();
  db.prepare(
    "INSERT INTO training_cycles (id, user_id, objective) VALUES ('old-cycle', 1, 'Race')",
  ).run();
  db.prepare(
    "INSERT INTO trainings (user_id, training_cycle_id, dia, tipo, fit_duration, fit_distance, result_data_source) VALUES (1, 'old-cycle', '2026-09-20', 'Run', '30:00', 5, 'manual')",
  ).run();

  migrateDatabase(db);
  migrateDatabase(db);

  assert.deepEqual(
    db
      .prepare(
        'SELECT onboarding_status, onboarding_guide_hidden FROM users WHERE id = 1',
      )
      .get(),
    {
      onboarding_status: 'active',
      onboarding_guide_hidden: 1,
    },
  );
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM shoes').get(), {
    count: 1,
  });
  assert.deepEqual(
    db.prepare('SELECT COUNT(*) AS count FROM training_cycles').get(),
    { count: 1 },
  );
  assert.deepEqual(
    db
      .prepare(
        'SELECT fit_duration, fit_distance, result_data_source FROM trainings',
      )
      .get(),
    {
      fit_duration: '30:00',
      fit_distance: 5,
      result_data_source: 'manual',
    },
  );
  db.close();
});

test('database migration converts old decimal-minute FIT paces into idempotent mm:ss values', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users (email, password_hash) VALUES ('pace@example.com', 'hash')",
  ).run();
  db.prepare(
    `INSERT INTO trainings (user_id, dia, tipo, result_data_source, fit_avg_pace)
    VALUES (1, '2026-09-20', 'Run', 'fit_upload', '6.53'),
           (1, '2026-09-20', 'Run', 'fit_upload', '5.00'),
           (1, '2026-09-20', 'Run', 'manual', '6.53'),
           (1, '2026-09-20', 'Run', 'fit_upload', '6:32'),
           (1, '2026-09-20', 'Run', 'none', '7.20')`,
  ).run();
  migrateDatabase(db);
  migrateDatabase(db);
  assert.deepEqual(
    db
      .prepare(
        'SELECT result_data_source, fit_avg_pace FROM trainings ORDER BY id',
      )
      .all(),
    [
      { result_data_source: 'fit_upload', fit_avg_pace: '6:32' },
      { result_data_source: 'fit_upload', fit_avg_pace: '5:00' },
      { result_data_source: 'manual', fit_avg_pace: '6.53' },
      { result_data_source: 'fit_upload', fit_avg_pace: '6:32' },
      { result_data_source: 'fit_upload', fit_avg_pace: '7:12' },
    ],
  );
  db.close();
});

test('in-memory database stores users and sessions via prepared statements', () => {
  const db = createDatabase({ filename: ':memory:' });

  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
  );
  const { lastInsertRowid: userId } = insertUser.run(
    'runner@example.com',
    'argon2-hash',
  );

  const user = db
    .prepare(
      'SELECT id, email, password_hash, created_at FROM users WHERE id = ?',
    )
    .get(userId);
  assert.equal(user.email, 'runner@example.com');
  assert.equal(user.password_hash, 'argon2-hash');
  assert.match(user.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  assert.throws(
    () => insertUser.run('runner@example.com', 'other-hash'),
    /UNIQUE constraint failed: users\.email/,
  );

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
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
        .prepare(
          'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
        )
        .run('orphan-token', 99999, '2026-12-31T23:59:59Z'),
    /FOREIGN KEY constraint failed/,
  );

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('cascade@example.com', 'hash');
  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
  ).run('cascade-token', userId, '2026-12-31T23:59:59Z');

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  const session = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get('cascade-token');
  assert.equal(session, undefined);

  db.close();
});

test('users store first and last names via prepared statements', () => {
  const db = createDatabase({ filename: ':memory:' });

  const { lastInsertRowid: userId } = db
    .prepare(
      'INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)',
    )
    .run('rafael@example.com', 'argon2-hash', 'Rafael', 'Vilaça');

  const user = db
    .prepare('SELECT first_name, last_name FROM users WHERE id = ?')
    .get(userId);
  assert.equal(user.first_name, 'Rafael');
  assert.equal(user.last_name, 'Vilaça');

  db.close();
});

test('migrateDatabase removes the obsolete workouts table from existing databases', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      preferred_lang TEXT NOT NULL DEFAULT 'en-US',
      first_day_of_week TEXT NOT NULL DEFAULT 'Monday',
      distance_unit TEXT NOT NULL DEFAULT 'km',
      temperature_unit TEXT NOT NULL DEFAULT 'C'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
    CREATE TABLE training_cycles (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
    CREATE TABLE trainings (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      training_cycle_id TEXT,
      dia TEXT NOT NULL,
      tipo TEXT NOT NULL
    );
    CREATE TABLE shoes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE workouts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      day TEXT
    );
  `);
  db.prepare(
    'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)',
  ).run(1, 'legacy-workout@example.com', 'hash');
  db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(
    'legacy-session',
    1,
  );
  db.prepare('INSERT INTO training_cycles (id, user_id) VALUES (?, ?)').run(
    'legacy-cycle',
    1,
  );
  db.prepare(
    'INSERT INTO trainings (id, user_id, training_cycle_id, dia, tipo) VALUES (?, ?, ?, ?, ?)',
  ).run(1, 1, 'legacy-cycle', '2026-08-24', 'Corrida');
  db.prepare(
    'INSERT INTO shoes (id, user_id, brand, model) VALUES (?, ?, ?, ?)',
  ).run('legacy-shoe', 1, 'Asics', 'Novablast');
  db.prepare('INSERT INTO workouts (id, user_id, day) VALUES (?, ?, ?)').run(
    1,
    1,
    '2026-08-24',
  );

  migrateDatabase(db);

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(
    tables,
    [
      'admin_audit_log',
      'ai_coach_availability',
      'ai_execution_raw_outputs',
      'ai_executions',
      'ai_global_usage',
      'ai_interpretation_replacements',
      'ai_interpretations',
      'ai_memory',
      'ai_profiles',
      'ai_usage',
      'cycle_plan_proposals',
      'cycle_plan_versions',
      'feedback',
      'garmin_activity_imports',
      'garmin_cleanup_state',
      'garmin_connection_cleanup',
      'garmin_legacy_cleanup_quarantine',
      'garmin_pilot_connections',
      'garmin_training_operations',
      'garmin_workout_prescriptions',
      'schema_migrations',
      'sessions',
      'shoes',
      'training_cycles',
      'training_result_evidence',
      'training_shoe_mileage',
      'trainings',
      'users',
      'weekly_workout_proposals',
      'workout_analysis_versions',
    ],
    'only the obsolete workouts table is removed',
  );
  assert.deepEqual(
    {
      users: db.prepare('SELECT COUNT(*) AS total FROM users').get().total,
      sessions: db.prepare('SELECT COUNT(*) AS total FROM sessions').get()
        .total,
      training_cycles: db
        .prepare('SELECT COUNT(*) AS total FROM training_cycles')
        .get().total,
      trainings: db.prepare('SELECT COUNT(*) AS total FROM trainings').get()
        .total,
      shoes: db.prepare('SELECT COUNT(*) AS total FROM shoes').get().total,
    },
    { users: 1, sessions: 1, training_cycles: 1, trainings: 1, shoes: 1 },
    'current tables and their unrelated data are retained',
  );

  assert.doesNotThrow(
    () => migrateDatabase(db),
    'the cleanup migration is idempotent',
  );
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workouts'",
      )
      .get(),
    undefined,
  );

  db.close();
});

test('trainings enforce foreign keys, require dia/tipo and cascade on user delete', () => {
  const db = createDatabase({ filename: ':memory:' });

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO trainings (user_id, dia, tipo) VALUES (?, ?, ?)')
        .run(99999, '2026-08-23', 'Corrida'),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO trainings (user_id, dia, tipo) VALUES (?, ?, ?)')
        .run(null, '2026-08-23', 'Corrida'),
    /NOT NULL constraint failed/,
  );

  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('cascade-trainings@example.com', 'hash');
  db.prepare(
    "INSERT INTO trainings (user_id, dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes) VALUES (?, ?, 'Manhã', 'Corrida', 'Longão', 'Zona 2', '150', '3', 'Adizero', '90 min', 'Leve')",
  ).run(userId, '2026-08-23');

  const stored = db
    .prepare(
      'SELECT dia, periodo, tipo, treino, detalhes, fc_alvo, rpe, tenis, previsao, observacoes FROM trainings WHERE user_id = ?',
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
      'hash',
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
    CREATE TABLE training_cycles (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      objective  TEXT,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    "INSERT INTO trainings (user_id, dia, tipo) VALUES (1, '2026-08-20', 'Corrida')",
  ).run();

  migrateDatabase(db);

  const columns = db
    .pragma('table_info(trainings)')
    .map((column) => column.name);
  for (const name of [
    'feedback_rpe',
    'feedback_notas',
    'completed',
    'has_smartwatch',
    'feedback_shoe',
    'feedback_hr_source',
    'feedback_weather',
    'feedback_terrain',
    'feedback_breathing',
    'feedback_muscle',
    'feedback_energy',
    'feedback_has_pain',
    'feedback_pain',
    'training_cycle_id',
    'location',
  ]) {
    assert.ok(columns.includes(name), `${name} column added`);
  }

  // The new migration wipes legacy rows before adding training_cycle_id.
  // Verify that the columns were added and the table is empty.
  const rowCount = db.prepare('SELECT count(*) AS count FROM trainings').get();
  assert.equal(
    rowCount.count,
    0,
    'legacy rows wiped by training_cycle_id migration',
  );

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
    CREATE TABLE training_cycles (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      objective  TEXT,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    "INSERT INTO trainings (user_id, dia, tipo) VALUES (1, '2026-08-21', 'Bike')",
  ).run();

  assert.doesNotThrow(() => migrateDatabase(db));

  // The new migration wipes legacy rows before adding training_cycle_id.
  const rowCount = db.prepare('SELECT count(*) AS count FROM trainings').get();
  assert.equal(
    rowCount.count,
    0,
    'legacy rows wiped by training_cycle_id migration',
  );

  // Verify the columns are present.
  const columns = db.pragma('table_info(trainings)').map((c) => c.name);
  assert.ok(columns.includes('feedback_rpe'));
  assert.ok(columns.includes('training_cycle_id'));

  db.close();
});

test('the activity migration adds is_active, keeps every account active and preserves the audit trail', () => {
  // A database from before the activity state: no `is_active` column and an
  // audit table whose CHECK does not know the new action yet.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
    CREATE TABLE training_cycles (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
    CREATE TABLE trainings (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      training_cycle_id TEXT,
      dia TEXT NOT NULL,
      tipo TEXT NOT NULL
    );
    CREATE TABLE shoes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY,
      actor_user_id INTEGER,
      actor_email TEXT NOT NULL DEFAULT '',
      target_user_id INTEGER,
      target_email TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL CHECK (action IN (
        'account_created', 'account_updated', 'account_role_changed', 'account_deleted'
      )),
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role) VALUES (1, 'keep@example.com', 'hash-1', 'admin')",
  ).run();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role) VALUES (2, 'keep2@example.com', 'hash-2', 'user')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (id, user_id) VALUES ('keep-session', 1)",
  ).run();
  db.prepare(
    `INSERT INTO admin_audit_log (id, actor_user_id, actor_email, target_user_id, target_email, action, details)
     VALUES (7, 1, 'keep@example.com', 2, 'keep2@example.com', 'account_created', '{"role":"user"}')`,
  ).run();

  migrateDatabase(db);
  migrateDatabase(db);

  // The column exists, defaults to the active state and preserved every account
  // exactly as it was, including ids, hashes, roles and sessions.
  assert.deepEqual(
    db
      .prepare(
        'SELECT id, email, password_hash, role, is_active FROM users ORDER BY id',
      )
      .all(),
    [
      {
        id: 1,
        email: 'keep@example.com',
        password_hash: 'hash-1',
        role: 'admin',
        is_active: 1,
      },
      {
        id: 2,
        email: 'keep2@example.com',
        password_hash: 'hash-2',
        role: 'user',
        is_active: 1,
      },
    ],
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE id = 'keep-session'",
      )
      .get().count,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-09-account-activity-v1'",
      )
      .get().count,
    1,
    'the marker is written once, so a repeated migration rewrites nothing',
  );

  // The rebuilt audit table keeps the earlier rows and accepts the new action.
  assert.deepEqual(
    db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all(),
    [
      {
        id: 7,
        actor_user_id: 1,
        actor_email: 'keep@example.com',
        target_user_id: 2,
        target_email: 'keep2@example.com',
        action: 'account_created',
        details: '{"role":"user"}',
        created_at: db
          .prepare('SELECT created_at FROM admin_audit_log WHERE id = 7')
          .get().created_at,
      },
    ],
  );
  db.prepare(
    `INSERT INTO admin_audit_log (actor_user_id, actor_email, target_user_id, target_email, action, details)
     VALUES (1, 'keep@example.com', 2, 'keep2@example.com', 'account_activity_changed', '{"from":"active","to":"inactive"}')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO admin_audit_log (actor_email, target_email, action) VALUES ('', '', 'account_suspended')`,
        )
        .run(),
    /CHECK constraint failed/,
  );

  // The state is constrained to the two real values, and only the administration
  // domain writes the column.
  assert.throws(
    () => db.prepare('UPDATE users SET is_active = 2 WHERE id = 1').run(),
    /CHECK constraint failed/,
  );
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 2').run();
  assert.equal(
    db.prepare('SELECT is_active FROM users WHERE id = 2').get().is_active,
    0,
  );
  db.close();
});

test('weekly workout migration upgrades an older database idempotently without changing user data', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare(
    "INSERT INTO users(id,email,password_hash) VALUES(501,'weekly-migration@example.invalid','hash')",
  ).run();
  db.prepare(
    "INSERT INTO training_cycles(id,user_id,objective,status) VALUES('weekly-cycle',501,'Existing goal','active')",
  ).run();
  db.prepare(
    "INSERT INTO trainings(user_id,training_cycle_id,dia,tipo,treino,completed,feedback_rpe) VALUES(501,'weekly-cycle','2026-10-20','Run','Preserved training',1,3)",
  ).run();
  const before = {
    user: db
      .prepare('SELECT id,email,password_hash FROM users WHERE id=501')
      .get(),
    cycle: db
      .prepare('SELECT * FROM training_cycles WHERE id=?')
      .get('weekly-cycle'),
    training: db.prepare('SELECT * FROM trainings WHERE user_id=501').get(),
  };
  db.exec('DROP TABLE weekly_workout_proposals');
  db.prepare(
    "DELETE FROM schema_migrations WHERE name='2026-10-weekly-workouts-v1'",
  ).run();
  migrateDatabase(db);
  migrateDatabase(db);
  assert.deepEqual(
    db.prepare('SELECT id,email,password_hash FROM users WHERE id=501').get(),
    before.user,
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM training_cycles WHERE id=?').get('weekly-cycle'),
    before.cycle,
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM trainings WHERE user_id=501').get(),
    before.training,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='2026-10-weekly-workouts-v1'",
      )
      .get().n,
    1,
  );
  assert.ok(
    db
      .pragma('table_info(weekly_workout_proposals)')
      .some((column) => column.name === 'application_json'),
  );
  db.close();
});

test('a fresh database already carries the activity state and the audit action', () => {
  const db = createDatabase({ filename: ':memory:' });
  const user = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run('fresh@example.com', 'hash');
  assert.equal(
    db
      .prepare('SELECT is_active FROM users WHERE id = ?')
      .get(user.lastInsertRowid).is_active,
    1,
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM schema_migrations WHERE name = '2026-09-account-activity-v1'",
      )
      .get(),
    'the migration is recorded for a new database as well',
  );
  db.prepare(
    `INSERT INTO admin_audit_log (actor_user_id, actor_email, target_user_id, target_email, action)
     VALUES (?, ?, ?, ?, 'account_activity_changed')`,
  ).run(
    user.lastInsertRowid,
    'fresh@example.com',
    user.lastInsertRowid,
    'fresh@example.com',
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'account_activity_changed'",
      )
      .get().count,
    1,
  );
  db.close();
});

test('AI raw-output expiry repair adds a missing expired column, preserves rows, and is idempotent', () => {
  const { repairAiRawOutputExpiry } = require('../src/ai/schema');
  const marker = '2026-11-ai-raw-output-expired-v1';
  const db = createDatabase({ filename: ':memory:' });
  try {
    // Recreate the table as an earlier release left it: no `expired` column.
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE ai_execution_raw_outputs;
      CREATE TABLE ai_execution_raw_outputs (
        execution_id TEXT NOT NULL REFERENCES ai_executions(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        output_text TEXT,
        output_bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
        expires_at TEXT NOT NULL,
        PRIMARY KEY(execution_id,attempt)
      );`);
    db.prepare('INSERT INTO ai_execution_raw_outputs (execution_id, attempt, output_text, output_bytes, truncated, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-execution', 1, '{"synthetic":true}', 18, 0, '2026-12-01T00:00:00.000Z');
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(marker);
    const columns = () => db.pragma('table_info(ai_execution_raw_outputs)').map((column) => column.name);
    assert.equal(columns().includes('expired'), false);

    repairAiRawOutputExpiry(db);
    assert.equal(columns().includes('expired'), true, 'the missing column is added');
    assert.deepEqual(db.prepare('SELECT execution_id, attempt, output_text, output_bytes, truncated, expired, expires_at FROM ai_execution_raw_outputs').all(), [{
      execution_id: 'legacy-execution', attempt: 1, output_text: '{"synthetic":true}', output_bytes: 18, truncated: 0, expired: 0, expires_at: '2026-12-01T00:00:00.000Z',
    }], 'existing rows are preserved and default to not expired');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ai_raw_output_expiry'").get());
    assert.throws(() => db.prepare('UPDATE ai_execution_raw_outputs SET expired = 2').run(), /CHECK constraint failed/);

    repairAiRawOutputExpiry(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?').get(marker).n, 1, 'a rerun records the marker once');
    assert.equal(columns().filter((name) => name === 'expired').length, 1, 'a rerun does not add the column twice');
  } finally {
    db.close();
  }
});
