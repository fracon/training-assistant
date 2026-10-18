'use strict';

const { sanitizeDiagnostic, saveDiagnostic } = require('./diagnostics');
const { randomUUID } = require('node:crypto');
const { AiError, hash, activeOwner, exactKeys } = require('./memory');
const { buildContext, contextIsCurrent, tokenBound } = require('./context');
const {
  renderPrompt,
  promptSources,
  PROMPT_VERSION,
} = require('./prompt-service');
const { RATES } = require('./config');
const { buildPayload, createResponsesClient } = require('./client');
const TERMINAL = ['completed', 'failed', 'uncertain', 'cancelled', 'outdated'];
function createExecutionService({
  db,
  config,
  operations = {},
  client,
  now = () => new Date().toISOString(),
}) {
  const limits = config.limits;
  const call =
    client ||
    createResponsesClient({
      apiKey: config.apiKey,
      timeoutMs: limits.AI_TIMEOUT_MS,
    });
  let stopped = false;
  let scheduled = false;
  const inFlight = new Map();
  function promptIsCurrent(row) {
    try {
      const settings = JSON.parse(row.configuration_json);
      return (
        hash(promptSources(db, row.user_id, settings.promptRequest)) ===
        hash(settings.promptSources)
      );
    } catch {
      return false;
    }
  }
  function get(userId, id, debug = false) {
    const user = activeOwner(db, userId);
    if (debug && user.role !== 'admin') throw new AiError('adminRequired', 403);
    const row = db
      .prepare('SELECT * FROM ai_executions WHERE user_id = ? AND id = ?')
      .get(userId, id);
    if (!row) throw new AiError('executionNotFound', 404);
    const context = JSON.parse(row.context_json);
    const current =
      contextIsCurrent(db, userId, context, config) && promptIsCurrent(row);
    const result = {
      id: row.id,
      purpose: row.purpose,
      state: row.state,
      outdated: !current,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error_code,
      response: row.response_json ? JSON.parse(row.response_json) : null,
    };
    if (debug)
      Object.assign(result, {
        context,
        diagnostics: JSON.parse(row.diagnostics_json),
        usage: row.usage_json ? JSON.parse(row.usage_json) : null,
        estimatedCostUsd: row.charged_cost,
        costBasis: row.usage_json ? 'reported_usage_estimate' : !row.settled ? 'reservation_pending' : row.charged_tokens===0 ? 'known_unbilled' : 'reserved_unknown_usage',
        externalPrompt: row.external_prompt,
        payload: JSON.parse(row.payload_json),
        configuration: JSON.parse(row.configuration_json),
        inputHash: row.input_hash,
        promptVersion: row.prompt_version,
        attempts: row.attempts,
        reservedTokens: row.reserved_tokens,
        reservedCostUsd: row.reserved_cost,
      });
    return result;
  }
  function list(userId) {
    activeOwner(db, userId);
    return db
      .prepare(
        'SELECT id,purpose,state,created_at,updated_at FROM ai_executions WHERE user_id = ? ORDER BY created_at DESC,id LIMIT 50',
      )
      .all(userId);
  }
  function preview(userId, body) {
    exactKeys(body, ['purpose', 'resource_id', 'target_date']);
    const user = activeOwner(db, userId);
    if (user.role !== 'admin') throw new AiError('adminRequired', 403);
    const context = buildContext(db, userId, {
      purpose: body.purpose,
      resourceId: body.resource_id ?? null,
      config,
    });
    const prompt = renderPrompt(db, userId, {
      purpose: body.purpose,
      resourceId: body.resource_id ?? null,
      targetDate: body.target_date ?? null,
    });
    return {
      prompt,
      context,
      promptVersion: PROMPT_VERSION,
      adapterVersion: null,
      paid: false,
    };
  }
  function reserve(userId, reservedTokens, reservedCost, at) {
    const day = at.slice(0, 10);
    const user = db
      .prepare(
        'SELECT tokens,cost,calls FROM ai_usage WHERE user_id = ? AND day = ?',
      )
      .get(userId, day) || { tokens: 0, cost: 0, calls: 0 };
    const global = db
      .prepare('SELECT tokens,cost,calls FROM ai_global_usage WHERE day = ?')
      .get(day) || { tokens: 0, cost: 0, calls: 0 };
    const calls = limits.AI_RETRIES + 1;
    if (
      user.tokens + reservedTokens > limits.AI_DAILY_TOKENS_USER ||
      global.tokens + reservedTokens > limits.AI_DAILY_TOKENS_GLOBAL ||
      user.cost + reservedCost > limits.AI_DAILY_USD_USER ||
      global.cost + reservedCost > limits.AI_DAILY_USD_GLOBAL ||
      user.calls + calls > limits.AI_DAILY_CALLS_USER ||
      global.calls + calls > limits.AI_DAILY_CALLS_GLOBAL
    )
      throw new AiError('usageLimit', 429);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM ai_executions WHERE (state IN ('queued','running') OR (state='cancelled' AND settled=0))",
      )
      .get().count;
    const ownerCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM ai_executions WHERE user_id = ? AND (state IN ('queued','running') OR (state='cancelled' AND settled=0))",
      )
      .get(userId).count;
    if (
      count >= limits.AI_CONCURRENCY_GLOBAL ||
      ownerCount >= limits.AI_CONCURRENCY_USER
    )
      throw new AiError('executionLimit', 429);
    db.prepare(
      'INSERT INTO ai_global_usage(day,tokens,cost,calls) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens,cost=cost+excluded.cost,calls=calls+excluded.calls',
    ).run(day, reservedTokens, reservedCost, calls);
    db.prepare(
      `INSERT INTO ai_usage(user_id,day,tokens,cost,calls) VALUES (?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET tokens=tokens+excluded.tokens,cost=cost+excluded.cost,calls=calls+excluded.calls`,
    ).run(userId, day, reservedTokens, reservedCost, calls);
  }
  function enqueue(userId, body) {
    exactKeys(body, [
      'purpose',
      'resource_id',
      'target_date',
      'idempotency_key',
    ]);
    if (
      typeof body.idempotency_key !== 'string' ||
      !/^[\w-]{8,100}$/.test(body.idempotency_key)
    )
      throw new AiError('invalidIdempotencyKey');
    if (!['cycle', 'workouts', 'analysis'].includes(body.purpose))
      throw new AiError('invalidPurpose');
    if (body.purpose === 'workouts' && body.resource_id != null)
      throw new AiError('invalidFields');
    return db
      .transaction(() => {
        activeOwner(db, userId);
        const prior = db
          .prepare(
            'SELECT * FROM ai_executions WHERE user_id = ? AND idempotency_key = ?',
          )
          .get(userId, body.idempotency_key);
        const requestHash = hash({
          purpose: body.purpose,
          resourceId: body.resource_id ?? null,
          targetDate: body.target_date ?? null,
        });
        if (prior) {
          if (JSON.parse(prior.configuration_json).requestHash !== requestHash)
            throw new AiError('idempotencyConflict', 409);
          return get(userId, prior.id);
        }
        if (!config.enabled) throw new AiError('aiUnavailable', 503);
        const operation = operations[body.purpose];
        if (!operation) throw new AiError('phaseNotAvailable', 409);
        const context = buildContext(db, userId, {
          purpose: body.purpose,
          resourceId: body.resource_id ?? null,
          config,
        });
        operation.prepare?.(context);
        const prompt = renderPrompt(db, userId, {
          purpose: body.purpose,
          resourceId: body.resource_id ?? null,
          targetDate: body.target_date ?? null,
        });
        const model = config.models[body.purpose];
        const rate = RATES[model];
        const payload = buildPayload({
          model,
          context,
          prompt,
          adapter: operation,
          maxOutputTokens: limits.AI_MAX_OUTPUT_TOKENS,
        });
        const input = tokenBound(payload) + 1024;
        if (input > 50000) throw new AiError('inputTooLarge', 413);
        const reservedTokens = input + limits.AI_MAX_OUTPUT_TOKENS;
        const reservedCost =
          (input * Math.max(rate.input, rate.cacheWrite) +
            limits.AI_MAX_OUTPUT_TOKENS * rate.output) /
          1e6;
        const at = now();
        reserve(userId, reservedTokens, reservedCost, at);
        const id = randomUUID();
        const configuration = {
          model,
          reasoning: 'medium',
          maxOutputTokens: limits.AI_MAX_OUTPUT_TOKENS,
          adapterVersion: operation.version,
          rate,
          rateVersion: '2026-10-14-conservative-ceiling',
          requestHash,
          promptRequest: {
            purpose: body.purpose,
            resourceId: body.resource_id ?? null,
            targetDate: body.target_date ?? null,
          },
          promptSources: promptSources(db, userId, {
            purpose: body.purpose,
            resourceId: body.resource_id ?? null,
            targetDate: body.target_date ?? null,
          }),
          retries: limits.AI_RETRIES,
          timeoutMs: limits.AI_TIMEOUT_MS,
          applicationVersion: require('../../package.json').version,
        };
        db.prepare(
          `INSERT INTO ai_executions(id,user_id,idempotency_key,purpose,resource_id,input_hash,prompt_version,external_prompt,context_json,payload_json,configuration_json,state,reserved_tokens,reserved_cost,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`,
        ).run(
          id,
          userId,
          body.idempotency_key,
          body.purpose,
          body.resource_id ?? null,
          hash(payload),
          PROMPT_VERSION,
          prompt,
          JSON.stringify(context),
          JSON.stringify(payload),
          JSON.stringify(configuration),
          reservedTokens,
          reservedCost,
          at,
          at,
        );
        operation.onEnqueued?.(db.prepare('SELECT * FROM ai_executions WHERE id=?').get(id),context);
        schedule();
        return get(userId, id);
      })
      .immediate();
  }
  function finish(
    row,
    state,
    {
      value = null,
      usage = null,
      error = null,
      knownUnbilled = false,
      verifySources = false,
      diagnostic = null,
    } = {},
  ) {
    db.transaction(() => {
      const current = db
        .prepare('SELECT * FROM ai_executions WHERE id = ? AND user_id = ?')
        .get(row.id, row.user_id);
      if (!current || current.settled) return;
      const cfg = JSON.parse(row.configuration_json);
      if (verifySources) {
        let currentSources = false;
        try {
          currentSources =
            contextIsCurrent(
              db,
              row.user_id,
              JSON.parse(row.context_json),
              config,
            ) && promptIsCurrent(row);
        } catch {
          currentSources = false;
        }
        if (!currentSources) {
          state = 'outdated';
          value = null;
          error = 'sourceChanged';
          diagnostic={...diagnostic,stage:'sources',code:error};
        }
      }
      if(diagnostic || error)saveDiagnostic(db,row.id,current.attempts,diagnostic || {stage:'lifecycle',code:error});
      const rate = cfg.rate;
      const tokens = usage
        ? usage.input + usage.output
        : knownUnbilled
          ? 0
          : row.reserved_tokens;
      const cost = usage
        ? ((usage.input - usage.cached) *
            Math.max(rate.input, rate.cacheWrite) +
            usage.cached * rate.cached +
            usage.output * rate.output) /
          1e6
        : knownUnbilled
          ? 0
          : row.reserved_cost;
      // Cancellation does not erase billed or uncertain usage. The result is discarded.
      const cancelled = current.state === 'cancelled';
      if (!cancelled && state === 'completed') operations[row.purpose].onCompleted?.(row,value);
      db.prepare(
        'UPDATE ai_global_usage SET tokens=tokens+?,cost=cost+?,calls=calls+? WHERE day = ?',
      ).run(
        tokens - row.reserved_tokens,
        cost - row.reserved_cost,
        current.attempts - (cfg.retries + 1),
        row.created_at.slice(0, 10),
      );
      db.prepare(
        'UPDATE ai_usage SET tokens=tokens+?,cost=cost+?,calls=calls+? WHERE user_id = ? AND day = ?',
      ).run(
        tokens - row.reserved_tokens,
        cost - row.reserved_cost,
        current.attempts - (cfg.retries + 1),
        row.user_id,
        row.created_at.slice(0, 10),
      );
      db.prepare(
        'UPDATE ai_executions SET settled=1,state=?,response_json=?,usage_json=?,error_code=?,charged_tokens=?,charged_cost=?,updated_at=? WHERE id = ? AND user_id = ?',
      ).run(
        cancelled ? 'cancelled' : state,
        cancelled ? null : value === null ? null : JSON.stringify(value),
        usage ? JSON.stringify(usage) : null,
        error,
        tokens,
        cost,
        now(),
        row.id,
        row.user_id,
      );
    }).immediate();
  }
  function claim(id) {
    return db
      .transaction(() => {
        let row = db
          .prepare('SELECT * FROM ai_executions WHERE id = ?')
          .get(id);
        if (!row || row.state !== 'queued') return;
        if (
          !config.enabled ||
          row.created_at.slice(0, 10) !== now().slice(0, 10)
        ) {
          finish(row, 'failed', {
            error: config.enabled ? 'reservationExpired' : 'aiUnavailable',
            knownUnbilled: true,
          });
          return;
        }
        const context = JSON.parse(row.context_json);
        try {
          activeOwner(db, row.user_id);
        } catch {
          finish(row, 'cancelled', {
            error: 'accountUnavailable',
            knownUnbilled: true,
          });
          return;
        }
        if (
          !contextIsCurrent(db, row.user_id, context, config) ||
          !promptIsCurrent(row)
        ) {
          finish(row, 'outdated', {
            error: 'sourceChanged',
            knownUnbilled: true,
          });
          return;
        }
        const operation = operations[row.purpose];
        const cfg = JSON.parse(row.configuration_json);
        if (!operation || operation.version !== cfg.adapterVersion) {
          finish(row, 'failed', {
            error: 'adapterUnavailable',
            knownUnbilled: true,
          });
          return;
        }
        if (
          !db
            .prepare(
              "UPDATE ai_executions SET state='running',attempts=attempts+1,updated_at=? WHERE id = ? AND state='queued'",
            )
            .run(now(), id).changes
        )
          return;
        const claimed=db.prepare('SELECT * FROM ai_executions WHERE id = ?').get(id);
        saveDiagnostic(db,id,claimed.attempts,{stage:'transport',clientRequestId:`kin_${id}_${claimed.attempts}`});
        return claimed;
      })
      .immediate();
  }
  async function dispatch(id) {
    const row = claim(id);
    if (!row) return;
    const operation = operations[row.purpose];
    const cfg = JSON.parse(row.configuration_json);
    const clientRequestId=`kin_${row.id}_${row.attempts}`;
    const started=Date.now();
    let response;
    try {
      response = await call(JSON.parse(row.payload_json),{clientRequestId});
    } catch (error) {
      const code=error instanceof AiError?error.code:'providerOutcomeUncertain';
      const diagnostic=sanitizeDiagnostic({...error?.diagnostic,stage:error?.diagnostic?.stage || (['providerOutcomeUncertain','providerTimeout'].includes(code)?'transport':'provider_http'),clientRequestId,code,durationMs:Date.now()-started});
      db.transaction(()=>{
        const current=db.prepare('SELECT state FROM ai_executions WHERE id = ?').get(id);
        if(code==='providerRateLimited' && row.attempts<=cfg.retries && current?.state==='running' && !stopped) {
          saveDiagnostic(db,id,row.attempts,diagnostic);
          db.prepare("UPDATE ai_executions SET state='queued',updated_at=? WHERE id=? AND state='running'").run(now(),id);
        } else finish(row,['providerOutcomeUncertain','providerTimeout'].includes(code)?'uncertain':'failed',{
          error:code,diagnostic,knownUnbilled:['providerRateLimited','providerRejected'].includes(code),
        });
      }).immediate();
      return;
    }
    let valid=false,validation=null;
    try {
      valid=!response.error && operation.validate(response.value,JSON.parse(row.context_json))===true;
      if(!valid && !response.error)validation=operation.diagnose?.(response.value,JSON.parse(row.context_json)) || {code:'domain_invalid',path:'$'};
    } catch { validation={code:'validator_exception',path:'$'}; }
    const code=valid?null:response.error || (validation?.code==='rpe_scale'?'planningRpeIncompatible':'invalidDomainResponse');
    const diagnostic=sanitizeDiagnostic({...response.diagnostic,clientRequestId,durationMs:Date.now()-started,
      code:code || 'completed',stage:validation?(validation.code.startsWith('shape_')?'schema':'domain'):response.diagnostic?.stage || (valid?'completed':'provider_response'),validation});
    try {
      finish(row,valid?'completed':'failed',{value:valid?response.value:null,usage:response.usage,error:code,diagnostic,verifySources:true});
    } catch {
      // A rolled-back proposal write must not erase already known provider usage.
      finish(row,'failed',{usage:response.usage,error:'resultPersistenceFailed',diagnostic:{...diagnostic,stage:'persistence',code:'resultPersistenceFailed'}});
    }
  }

  function schedule() {
    if (stopped || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      pump();
    });
  }
  function pump() {
    if (stopped || !db.open) return;
    const rows = db
      .prepare(
        "SELECT id,user_id FROM ai_executions WHERE state='queued' ORDER BY created_at,id",
      )
      .all();
    for (const row of rows) {
      if (inFlight.size >= limits.AI_CONCURRENCY_GLOBAL) break;
      const activeForUser = [...inFlight.values()].filter(
        (job) => job.userId === row.user_id,
      ).length;
      if (activeForUser >= limits.AI_CONCURRENCY_USER) continue;
      const task = dispatch(row.id).finally(() => {
        inFlight.delete(row.id);
        schedule();
      });
      inFlight.set(row.id, { task, userId: row.user_id });
    }
  }
  function cancel(userId, id) {
    return db
      .transaction(() => {
        const result = get(userId, id);
        const row = db
          .prepare('SELECT * FROM ai_executions WHERE id = ? AND user_id = ?')
          .get(id, userId);
        if (row.state === 'queued')
          finish(row, 'cancelled', { knownUnbilled: true });
        else if (row.state === 'running')
          db.prepare(
            "UPDATE ai_executions SET state='cancelled',updated_at=? WHERE id = ? AND user_id = ? AND state='running'",
          ).run(now(), id, userId);
        return {
          ...result,
          state: TERMINAL.includes(row.state) ? row.state : 'cancelled',
        };
      })
      .immediate();
  }
  function recover() {
    for (const row of db
      .prepare(
        "SELECT * FROM ai_executions WHERE settled=0 AND state IN ('running','cancelled')",
      )
      .all())
      finish(row, 'uncertain', { error: 'restartOutcomeUncertain' });
    cleanup();
    schedule();
  }
  function cleanup() {
    const cutoff = new Date(
      Date.parse(now()) - limits.AI_RETENTION_DAYS * 86400000,
    ).toISOString();
    db.prepare(
      "DELETE FROM ai_executions WHERE updated_at < ? AND state IN ('completed','failed','uncertain','cancelled','outdated')",
    ).run(cutoff);
    db.prepare('DELETE FROM ai_usage WHERE day < ?').run(cutoff.slice(0, 10));
    db.prepare('DELETE FROM ai_global_usage WHERE day < ?').run(
      cutoff.slice(0, 10),
    );
    for (const operation of Object.values(operations)) operation.cleanup?.();
  }
  function usage(userId) {
    activeOwner(db, userId);
    return db
      .prepare(
        'SELECT day,tokens,cost,calls FROM ai_usage WHERE user_id = ? ORDER BY day DESC LIMIT 90',
      )
      .all(userId);
  }
  async function stop() {
    stopped = true;
    await Promise.allSettled([...inFlight.values()].map((job) => job.task));
  }
  return {
    enqueue,
    get,
    list,
    preview,
    cancel,
    recover,
    cleanup,
    usage,
    stop,
    dispatch,
  };
}
module.exports = { createExecutionService, TERMINAL };
