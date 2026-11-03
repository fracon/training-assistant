'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createDatabase } = require('../src/db/database');
const { fitEvidence, garminActivityEvidence, findCurrentEvidenceConflict, replaceCurrentEvidence, fitSha256 } = require('../src/result-import-evidence');

test('FIT evidence accepts exact fingerprints, namespaces by source and ignores malformed values', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(fitEvidence({ fitSha256: hash, fitFileIdentity: 'b'.repeat(64), source: 'garmin_connect' }), [
    { type: 'fit_sha256', value: hash, source: 'garmin_connect' },
    { type: 'fit_file_id', value: 'b'.repeat(64), source: 'garmin_connect' },
  ]);
  assert.deepEqual(fitEvidence({ fitSha256: hash.toUpperCase(), source: 'other' }), [
    { type: 'fit_sha256', value: hash, source: 'fit_upload' },
  ]);
  assert.deepEqual(fitEvidence({ fitSha256: 'not-a-hash', fitFileIdentity: null, source: 'fit_upload' }), []);
});

test('Garmin activity evidence requires account scope and a bounded canonical ID', () => {
  assert.deepEqual(garminActivityEvidence({ accountFingerprint: 'A'.repeat(64), activityId: 42 }), {
    type: 'garmin_activity', value: `${'a'.repeat(64)}:42`, source: 'garmin_connect',
  });
  for (const input of [
    { accountFingerprint: null, activityId: 42 },
    { accountFingerprint: 'short', activityId: 42 },
    { accountFingerprint: 'a'.repeat(64), activityId: '0' },
    { accountFingerprint: 'a'.repeat(64), activityId: null },
    { accountFingerprint: 'a'.repeat(64), activityId: 'x'.repeat(21) },
  ]) assert.equal(garminActivityEvidence(input), null);
});

test('current evidence conflicts only with another session and replacement reactivates history', () => {
  const db = createDatabase({ filename: ':memory:' });
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(1,'evidence@example.test','hash')").run();
  db.prepare("INSERT INTO trainings(id,user_id,dia,tipo,treino) VALUES(1,1,'2026-11-02','run','one'),(2,1,'2026-11-03','run','two')").run();
  const item = { type: 'fit_sha256', value: 'c'.repeat(64), source: 'fit_upload' };
  assert.equal(findCurrentEvidenceConflict(db, 1, 1, []), null);
  replaceCurrentEvidence(db, 1, 1, [item]);
  assert.equal(findCurrentEvidenceConflict(db, 1, 1, [item]), null);
  assert.deepEqual(findCurrentEvidenceConflict(db, 1, 2, [item]), { trainingId: 1, type: 'fit_sha256' });
  replaceCurrentEvidence(db, 1, 1, []);
  assert.equal(findCurrentEvidenceConflict(db, 1, 2, [item]), null, 'historical rows do not block later use');
  replaceCurrentEvidence(db, 1, 1, [item]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_result_evidence WHERE training_id=1').get().n, 1,
    'A to B to A reuses the same history row');
  replaceCurrentEvidence(db, 1, 1, [{ ...item, source: 'garmin_connect' }]);
  assert.deepEqual(db.prepare('SELECT source,is_current FROM training_result_evidence WHERE training_id=1 ORDER BY source').all(), [
    { source: 'fit_upload', is_current: 0 }, { source: 'garmin_connect', is_current: 1 },
  ], 'the same evidence retains its distinct source history when the importer changes');
  db.close();
});

test('FIT byte hashing rejects invalid buffers and hashes the post-extraction bytes exactly', () => {
  assert.equal(fitSha256(null), null);
  assert.equal(fitSha256(Buffer.alloc(0)), null);
  assert.equal(fitSha256(Buffer.from('fit bytes')), createHash('sha256').update('fit bytes').digest('hex'));
});
