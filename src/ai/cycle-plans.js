'use strict';
const { AiError, activeOwner, exactKeys, hash } = require('./memory');
const { contextIsCurrent } = require('./context');
const { validatePlan } = require('./cycle-plan-schema');
function ownCycle(db,userId,cycleId) {
  activeOwner(db,userId);
  const cycle=db.prepare('SELECT * FROM training_cycles WHERE id=? AND user_id=?').get(cycleId,userId);
  if (!cycle) throw new AiError('resourceNotFound',404);
  return cycle;
}
function appliedPlan(db,userId,cycleId) {
  const row=db.prepare('SELECT * FROM cycle_plan_versions WHERE user_id=? AND cycle_id=? ORDER BY version DESC LIMIT 1').get(userId,cycleId);
  if (!row) return null;
  return { id:row.id,version:row.version,plan:JSON.parse(row.plan_json),appliedAt:row.applied_at,cycleHash:row.cycle_hash,contextHash:row.context_hash,fingerprint:JSON.parse(row.fingerprint_json) };
}
function readCyclePlanning(db,userId,cycleId,service,config,asOf=new Date().toISOString().slice(0,10)) {
  return db.transaction(()=>{
    const cycle=ownCycle(db,userId,cycleId);
    const applied=appliedPlan(db,userId,cycleId);
    const proposals=db.prepare('SELECT * FROM cycle_plan_proposals WHERE user_id=? AND cycle_id=? ORDER BY sequence DESC LIMIT 20').all(userId,cycleId).map((row)=>{
      const execution=row.execution_id ? service.get(userId,row.execution_id) : null;
      if (execution && execution.state==='completed' && execution.response.start < asOf) execution.outdated=true;
      return {
      id:row.id,sequence:row.sequence,baseVersion:row.base_version,createdAt:row.created_at,
      execution,
      applied: Boolean(db.prepare('SELECT 1 FROM cycle_plan_versions WHERE id=? AND user_id=?').get(row.id,userId)),
    };});
    return { available:config.enabled,canGenerate:cycle.status==='active',cycleRevision:cycle.planning_revision,
      applied:applied && {id:applied.id,version:applied.version,plan:applied.plan,appliedAt:applied.appliedAt,outdated:!contextIsCurrent(db,userId,applied.fingerprint,config)},proposals };
  })();
}
function applyCyclePlan(db,userId,cycleId,proposalId,body,service,now=new Date().toISOString()) {
  exactKeys(body,['expected_version']);
  if (!Number.isInteger(body.expected_version) || body.expected_version<0) throw new AiError('invalidVersion');
  return db.transaction(()=>{
    const cycle=ownCycle(db,userId,cycleId);
    const proposal=db.prepare('SELECT * FROM cycle_plan_proposals WHERE id=? AND cycle_id=? AND user_id=?').get(proposalId,cycleId,userId);
    if (!proposal) throw new AiError('proposalNotFound',404);
    const already=db.prepare('SELECT version FROM cycle_plan_versions WHERE id=? AND user_id=?').get(proposalId,userId);
    if (already) return {appliedVersion:already.version,alreadyApplied:true};
    const applied=appliedPlan(db,userId,cycleId);
    const version=applied ? applied.version : 0;
    if (body.expected_version!==version || proposal.base_version!==version) throw new AiError('planningConflict',409);
    if (!proposal.execution_id) throw new AiError('proposalExpired',409);
    const execution=service.get(userId,proposal.execution_id);
    if (cycle.status!=='active' || execution.state!=='completed' || execution.outdated || !proposal.plan_json) throw new AiError('planningOutdated',409);
    const row=db.prepare('SELECT context_json FROM ai_executions WHERE id=? AND user_id=?').get(proposal.execution_id,userId);
    const context=JSON.parse(row.context_json);
    const plan=JSON.parse(proposal.plan_json);
    if (plan.start < now.slice(0,10)) throw new AiError('planningOutdated',409);
    if (context.resource.id!==cycleId || !validatePlan(plan,context)) throw new AiError('invalidPlanningResponse',409);
    db.prepare('INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(proposal.id,userId,cycleId,version+1,proposal.plan_json,context.hash,hash(cycle),JSON.stringify({hash:context.hash,asOf:context.asOf,purpose:context.purpose,resource:{id:cycleId},policyVersion:context.policyVersion}),JSON.stringify(context.sources),now);
    return {appliedVersion:version+1,alreadyApplied:false};
  }).immediate();
}
module.exports={ownCycle,appliedPlan,readCyclePlanning,applyCyclePlan};
