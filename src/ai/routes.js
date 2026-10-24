'use strict';
const {
  AiError,
  saveProfile,
  readLegacyMemory,
  activeOwner,
  exactKeys,
} = require('./memory');
const { buildContext } = require('./context');
const { memoryOverview } = require('./overview');
const { readAiConfig } = require('./config');
const { createExecutionService } = require('./executions');
const { createCyclePlanAdapter } = require('./cycle-plan-adapter');
const { readCyclePlanning, applyCyclePlan } = require('./cycle-plans');
const {
  createWeeklyWorkoutAdapter,
  collectWeeklyWeather,
  readWeeklyProposal,
  applyWeeklyProposal,
  monday,
} = require('./weekly-workouts');
const { getAvailabilityWeek } = require('../availability');
const {
  validateAvailabilityDay,
} = require('../public/shared/workout-prompts.js');
function logUnexpectedError(error, request) {
  const frames =
    typeof error?.stack === 'string'
      ? error.stack
          .split('\n')
          .slice(1, 8)
          .map((frame) => frame.trim().slice(0, 240))
      : [];
  const diagnostic = {
    event: 'ai_route_unexpected_error',
    method: request.method,
    route: request.routeOptions?.url || 'unknown',
    errorName: /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error?.name || '')
      ? error.name
      : 'Error',
    errorCode: /^[A-Z0-9_]{1,40}$/.test(error?.code || '') ? error.code : null,
    frames,
  };
  // Do not log error.message, SQL, request values, prompts, response bodies,
  // account identifiers or credentials. Stack frames retain code locations.
  console.error(`[Kinesis] ${JSON.stringify(diagnostic)}`);
}
function registerAiRoutes(
  app,
  {
    db,
    requireAuth,
    config = readAiConfig(),
    operations: providedOperations,
    client,
    weatherFetch,
  },
) {
  const operations = {
    cycle: createCyclePlanAdapter(db),
    workouts: createWeeklyWorkoutAdapter(db),
    ...(providedOperations || {}),
  };
  const service = createExecutionService({ db, config, operations, client });
  const route = (method, path, handler) =>
    app[method](path, { preHandler: requireAuth }, async (request, reply) => {
      try {
        service.cleanup();
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof AiError)
          return reply
            .code(error.status)
            .send({ error: error.code, errors: [error.code] });
        logUnexpectedError(error, request);
        return reply
          .code(500)
          .send({ error: 'aiInternalError', errors: ['aiInternalError'] });
      }
    });
  route('get', '/api/cycles/:id/planning', (r) =>
    readCyclePlanning(db, r.user.id, r.params.id, service, config),
  );
  route('post', '/api/cycles/:id/planning/:proposalId/apply', (r) =>
    applyCyclePlan(
      db,
      r.user.id,
      r.params.id,
      r.params.proposalId,
      r.body,
      service,
    ),
  );
  route('get', '/api/ai/memory', (r) => memoryOverview(db, r.user.id, config));
  route('put', '/api/ai/profile', (r) => saveProfile(db, r.user.id, r.body));
  route('get', '/api/ai/memory/legacy', (r) => readLegacyMemory(db, r.user.id));
  route('get', '/api/ai/context', (r) => {
    if (activeOwner(db, r.user.id).role !== 'admin')
      throw new AiError('adminRequired', 403);
    exactKeys(r.query, ['purpose', 'resource_id', 'as_of']);
    return buildContext(db, r.user.id, {
      purpose: r.query.purpose,
      resourceId: r.query.resource_id ?? null,
      asOf: r.query.as_of,
      config,
    });
  });
  route('get', '/api/ai/executions', (r) => ({
    executions: service.list(r.user.id),
  }));
  route('post', '/api/ai/executions', async (r, reply) => {
    let evidence = {};
    if (r.body?.purpose === 'workouts') {
      if (!config.enabled) throw new AiError('aiUnavailable', 503);
      const weekStart = monday(r.body.target_date);
      if (
        !db
          .prepare(
            "SELECT 1 FROM training_cycles WHERE user_id=? AND status='active'",
          )
          .get(r.user.id)
      )
        throw new AiError('resourceNotFound', 404);
      const availability = getAvailabilityWeek(db, r.user.id);
      if (
        availability.needsReview ||
        availability.days.some((day) => validateAvailabilityDay(day).length > 0)
      )
        throw new AiError('availabilityNeedsReview');
      evidence = {
        weekStart,
        weather: await collectWeeklyWeather(
          db,
          r.user.id,
          weekStart,
          weatherFetch,
        ),
        userId: r.user.id,
      };
    }
    return reply.code(202).send(service.enqueue(r.user.id, r.body, evidence));
  });
  route('get', '/api/ai/workouts/:id/proposal', (r) =>
    readWeeklyProposal(db, r.user.id, r.params.id, service),
  );
  route('post', '/api/ai/workouts/:id/apply', (r) =>
    applyWeeklyProposal(db, r.user.id, r.params.id, r.body, service),
  );
  route('get', '/api/ai/executions/:id', (r) =>
    service.get(r.user.id, r.params.id),
  );
  route('post', '/api/ai/executions/:id/cancel', (r) => {
    exactKeys(r.body || {}, []);
    return service.cancel(r.user.id, r.params.id);
  });
  route('get', '/api/ai/admin/executions/:id', (r) =>
    service.get(r.user.id, r.params.id, true),
  );
  route('post', '/api/ai/admin/preview', (r) =>
    service.preview(r.user.id, r.body),
  );
  route('get', '/api/ai/admin/usage', (r) => {
    if (r.user.role !== 'admin') throw new AiError('adminRequired', 403);
    return {
      usage: service.usage(r.user.id),
      enabled: config.enabled,
      configurationErrors: config.errors,
    };
  });
  app.addHook('onClose', () => service.stop());
  service.recover();
  return service;
}
module.exports = { registerAiRoutes, logUnexpectedError };
