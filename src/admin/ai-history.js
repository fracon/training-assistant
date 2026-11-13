'use strict';

// Administration AI prompt history (issue #113).
//
// This is the one deliberate exception to "admin status never bypasses
// ownership": an administrator may READ the AI execution history of any
// account, grouped by account. The exception is narrow:
//
// - read only — nothing here cancels, applies, regenerates or dispatches work,
//   and the ordinary AI routes stay scoped to their owner;
// - lists carry execution metadata only; prompt, context, payload, response and
//   raw output are returned only by the single-execution detail;
// - every detail read of another account's execution writes one
//   `ai_execution_viewed` audit row in the same immediate transaction that reads
//   it, with copied identities and only the execution ID and purpose. Reading
//   one's own execution matches the pre-existing owner-scoped admin debug and is
//   not audited;
// - the actor's role and activity are re-read inside that transaction, so a
//   demotion committed after the route guard ran refuses the read.

const { executionDebugFields } = require('../ai/executions');

const AI_PURPOSES = ['cycle', 'workouts', 'analysis'];
const AI_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'uncertain',
  'cancelled',
  'outdated',
];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

class AiHistoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AiHistoryError';
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value, code, message) {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < 1 || !Number.isSafeInteger(number))
    throw new AiHistoryError(400, code, message);
  return number;
}

function rejectUnknown(query, allowed) {
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key))
      throw new AiHistoryError(400, 'unknownField', `Unsupported field: ${key}.`);
  }
}

function accountIdentity(row) {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    is_active: Boolean(row.is_active),
  };
}

function findAccount(db, userId) {
  const row = db
    .prepare(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = ?',
    )
    .get(userId);
  if (!row) throw new AiHistoryError(404, 'accountNotFound', 'Account not found.');
  return row;
}

// Every account, with how many AI executions it has and when the latest one
// was created. Accounts with history come first, newest activity first.
function listAiAccounts(db) {
  const accounts = db
    .prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.is_active,
              COUNT(e.id) AS execution_count, MAX(e.created_at) AS last_execution_at
         FROM users u LEFT JOIN ai_executions e ON e.user_id = u.id
        GROUP BY u.id
        ORDER BY last_execution_at IS NULL, last_execution_at DESC, u.email COLLATE NOCASE, u.id`,
    )
    .all()
    .map((row) => ({
      ...accountIdentity(row),
      execution_count: row.execution_count,
      last_execution_at: row.last_execution_at,
    }));
  return { accounts };
}

function publicExecutionSummary(row) {
  return {
    id: row.id,
    purpose: row.purpose,
    resource_id: row.resource_id,
    state: row.state,
    error_code: row.error_code,
    prompt_version: row.prompt_version,
    attempts: row.attempts,
    charged_tokens: row.charged_tokens,
    charged_cost: row.charged_cost,
    reserved_tokens: row.reserved_tokens,
    settled: Boolean(row.settled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// One account's executions, metadata only: the heavy and sensitive columns
// (prompt, context, payload, response) never leave through the list.
function listAiExecutions(db, userIdParam, query = {}) {
  rejectUnknown(query, ['purpose', 'state', 'page', 'limit']);
  const userId = positiveInteger(userIdParam, 'invalidAccountId', 'Account id is invalid.');
  if (query.purpose !== undefined && !AI_PURPOSES.includes(query.purpose))
    throw new AiHistoryError(400, 'invalidPurpose', 'Purpose is invalid.');
  if (query.state !== undefined && !AI_STATES.includes(query.state))
    throw new AiHistoryError(400, 'invalidState', 'State is invalid.');
  const page =
    query.page === undefined
      ? 1
      : positiveInteger(query.page, 'invalidPage', 'Pagination value is invalid.');
  const limit =
    query.limit === undefined
      ? DEFAULT_LIMIT
      : Math.min(
        positiveInteger(query.limit, 'invalidLimit', 'Pagination value is invalid.'),
        MAX_LIMIT,
      );
  const account = accountIdentity(findAccount(db, userId));
  const clauses = ['user_id = ?'];
  const params = [userId];
  if (query.purpose) { clauses.push('purpose = ?'); params.push(query.purpose); }
  if (query.state) { clauses.push('state = ?'); params.push(query.state); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM ai_executions ${where}`)
    .get(...params).count;
  const executions = db
    .prepare(
      `SELECT id, purpose, resource_id, state, error_code, prompt_version, attempts,
              charged_tokens, charged_cost, reserved_tokens, settled, created_at, updated_at
         FROM ai_executions ${where}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, (page - 1) * limit)
    .map(publicExecutionSummary);
  return { account, executions, page, limit, total };
}

// The complete trace of one execution of any account. Reading, the actor
// recheck and the audit row are a single immediate transaction: the trace is
// returned only if its audit record was committed.
function getAiExecution(db, actor, executionId, now = () => new Date().toISOString()) {
  if (typeof executionId !== 'string' || !/^[\w-]{1,100}$/.test(executionId))
    throw new AiHistoryError(400, 'invalidExecutionId', 'Execution id is invalid.');
  return db.transaction(() => {
    const current = db
      .prepare('SELECT id, email, role, is_active FROM users WHERE id = ?')
      .get(actor.id);
    if (!current || current.role !== 'admin' || current.is_active !== 1)
      throw new AiHistoryError(403, 'adminRequired', 'Administrator access required.');
    const row = db.prepare('SELECT * FROM ai_executions WHERE id = ?').get(executionId);
    if (!row) throw new AiHistoryError(404, 'executionNotFound', 'Execution not found.');
    const owner = findAccount(db, row.user_id);
    if (owner.id !== current.id) {
      db.prepare(
        `INSERT INTO admin_audit_log
          (actor_user_id, actor_email, target_user_id, target_email, action, details)
         VALUES (?, ?, ?, ?, 'ai_execution_viewed', ?)`,
      ).run(
        current.id,
        current.email,
        owner.id,
        owner.email,
        JSON.stringify({ execution_id: row.id, purpose: row.purpose }),
      );
    }
    return {
      execution: {
        ...publicExecutionSummary(row),
        account: accountIdentity(owner),
        response: row.response_json ? JSON.parse(row.response_json) : null,
        ...executionDebugFields(db, row, now()),
      },
    };
  }).immediate();
}

module.exports = {
  AI_PURPOSES,
  AI_STATES,
  AiHistoryError,
  getAiExecution,
  listAiAccounts,
  listAiExecutions,
};
