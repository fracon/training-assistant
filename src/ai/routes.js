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
function registerAiRoutes(
  app,
  { db, requireAuth, config = readAiConfig(), operations = { cycle:createCyclePlanAdapter(db) }, client },
) {
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
        return reply
          .code(500)
          .send({ error: 'aiInternalError', errors: ['aiInternalError'] });
      }
    });
  route('get', '/api/cycles/:id/planning', (r) => readCyclePlanning(db,r.user.id,r.params.id,service,config));
  route('post', '/api/cycles/:id/planning/:proposalId/apply', (r) => applyCyclePlan(db,r.user.id,r.params.id,r.params.proposalId,r.body,service));
  route('get', '/api/ai/memory', (r) => memoryOverview(db, r.user.id, config));
  route('put', '/api/ai/profile', (r) => saveProfile(db, r.user.id, r.body));
  route('get', '/api/ai/memory/legacy', (r) => readLegacyMemory(db, r.user.id));
  route('get', '/api/ai/context', (r) => {
    if (activeOwner(db, r.user.id).role !== 'admin') throw new AiError('adminRequired', 403);
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
  route('post', '/api/ai/executions', (r, reply) =>
    reply.code(202).send(service.enqueue(r.user.id, r.body)),
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
module.exports = { registerAiRoutes };
