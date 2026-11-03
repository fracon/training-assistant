'use strict';

const crypto = require('node:crypto');

function fitEvidence({ fitSha256, fitFileIdentity, source }) {
  const allowedSource = source === 'garmin_connect' ? 'garmin_connect' : 'fit_upload';
  const items = [];
  if (typeof fitSha256 === 'string' && /^[a-f0-9]{64}$/i.test(fitSha256)) {
    items.push({ type: 'fit_sha256', value: fitSha256.toLowerCase() });
  }
  if (typeof fitFileIdentity === 'string' && /^[a-f0-9]{64}$/i.test(fitFileIdentity)) {
    items.push({ type: 'fit_file_id', value: fitFileIdentity.toLowerCase() });
  }
  return items.map((item) => ({ ...item, source: allowedSource }));
}

function garminActivityEvidence({ accountFingerprint, activityId }) {
  if (typeof accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(accountFingerprint)
      || !/^[1-9]\d{0,19}$/.test(String(activityId ?? ''))) return null;
  return { type: 'garmin_activity', value: `${accountFingerprint.toLowerCase()}:${activityId}`, source: 'garmin_connect' };
}

function findCurrentEvidenceConflict(db, userId, trainingId, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const find = db.prepare(`SELECT training_id FROM training_result_evidence
    WHERE user_id=? AND evidence_type=? AND evidence_value=? AND is_current=1 LIMIT 1`);
  for (const item of items) {
    const row = find.get(userId, item.type, item.value);
    if (row && row.training_id !== trainingId) return { trainingId: row.training_id, type: item.type };
  }
  return null;
}

function replaceCurrentEvidence(db, userId, trainingId, items) {
  db.prepare('UPDATE training_result_evidence SET is_current=0 WHERE user_id=? AND training_id=? AND is_current=1')
    .run(userId, trainingId);
  const upsert = db.prepare(`INSERT INTO training_result_evidence
    (user_id,training_id,evidence_type,evidence_value,source,is_current)
    VALUES(?,?,?,?,?,1)
    ON CONFLICT(user_id,training_id,evidence_type,evidence_value,source)
    DO UPDATE SET is_current=1,created_at=datetime('now')`);
  for (const item of items) upsert.run(userId, trainingId, item.type, item.value, item.source);
}

function fitSha256(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { fitEvidence, garminActivityEvidence, findCurrentEvidenceConflict, replaceCurrentEvidence, fitSha256 };
