'use strict';
const { AiError, activeOwner, exactKeys, hash } = require('./memory');
const { contextIsCurrent } = require('./context');
const { validatePlan, rpeIssue } = require('./cycle-plan-schema');
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
function proposalIsUsable(db,userId,cycleId,proposal,baseVersion,asOf) {
  if (!proposal || proposal.applied || proposal.baseVersion!==baseVersion ||
      proposal.compatibilityError || !proposal.execution ||
      proposal.execution.state!=='completed' || proposal.execution.outdated ||
      !proposal.execution.response) return false;
  try {
    const stored=db.prepare("SELECT p.plan_json,e.context_json FROM cycle_plan_proposals p JOIN ai_executions e ON e.id=p.execution_id WHERE p.id=? AND p.user_id=? AND p.cycle_id=? AND e.purpose='cycle' AND e.resource_id=?")
      .get(proposal.id,userId,cycleId,cycleId);
    if (!stored.plan_json) return false;
    const plan=JSON.parse(stored.plan_json);
    if (JSON.stringify(plan)!==JSON.stringify(proposal.execution.response)) return false;
    const context=JSON.parse(stored.context_json);
    return plan.start>=asOf && context.resource?.id===cycleId &&
      !rpeIssue(plan) && validatePlan(plan,context);
  } catch { return false; }
}
function summarizeCyclePlanning(cycle,applied,proposals,available,selected) {
  const version=applied?.version || 0;
  const pending=proposals.find((proposal)=>proposal.execution && ['queued','running'].includes(proposal.execution.state) && proposal.baseVersion===version) || null;
  const latest=proposals[0] || null;
  const latestFailed=Boolean(latest && latest.baseVersion===version &&
    (!latest.execution || ['failed','cancelled','uncertain','outdated'].includes(latest.execution.state) ||
      (latest.execution.state==='completed' && !latest.applied && latest.id!==selected?.id)));
  let status,secondary=null;
  if (applied) {
    status=applied.compatibilityError ? 'applied_incompatible' : applied.outdated ? 'applied_outdated' : 'applied_current';
    if (pending) secondary='new_pending';
    else if (selected) secondary='new_proposal_ready';
    else if (latestFailed) secondary='update_failed';
    else if (!available) secondary='unavailable';
  } else if (selected) {
    status='proposal_ready';
    if (pending) secondary='new_pending';
    else if (latestFailed && latest.sequence>selected.sequence) secondary='update_failed';
  } else if (pending) status='pending';
  else if (!available) status='unavailable';
  else if (latest) status='failed';
  else status='none';
  return { status,secondary,available:Boolean(available),canGenerate:Boolean(available && cycle.status==='active') };
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
      ...(row.plan_json && rpeIssue(JSON.parse(row.plan_json)) ? {compatibilityError:'planningRpeIncompatible'} : {}),
      applied: Boolean(db.prepare('SELECT 1 FROM cycle_plan_versions WHERE id=? AND user_id=?').get(row.id,userId)),
    };});
    const appliedView=applied && {id:applied.id,version:applied.version,plan:applied.plan,appliedAt:applied.appliedAt,...(rpeIssue(applied.plan)?{compatibilityError:'planningRpeIncompatible'}:{}),outdated:!contextIsCurrent(db,userId,applied.fingerprint,config)};
    const selectedProposal=proposals.find((proposal)=>proposalIsUsable(db,userId,cycleId,proposal,appliedView?.version || 0,asOf));
    const summary=summarizeCyclePlanning(cycle,appliedView,proposals,config.enabled,selectedProposal);
    return { available:config.enabled,canGenerate:cycle.status==='active',cycleRevision:cycle.planning_revision,
      applied:appliedView,proposals,selectedProposalId:selectedProposal?.id || null,summary };
  })();
}
function readCyclePlanningSummary(db,userId,cycleId,service,config,asOf=new Date().toISOString().slice(0,10)) {
  return db.transaction(()=>{
    const cycle=ownCycle(db,userId,cycleId);
    const applied=appliedPlan(db,userId,cycleId);
    const appliedView=applied && {id:applied.id,version:applied.version,plan:applied.plan,appliedAt:applied.appliedAt,...(rpeIssue(applied.plan)?{compatibilityError:'planningRpeIncompatible'}:{}),outdated:!contextIsCurrent(db,userId,applied.fingerprint,config)};
    const rows=db.prepare(`SELECT p.id,p.sequence,p.base_version,p.execution_id,p.plan_json,
      e.state,e.error_code,CASE WHEN v.id IS NULL THEN 0 ELSE 1 END AS applied
      FROM cycle_plan_proposals p
      LEFT JOIN ai_executions e ON e.id=p.execution_id AND e.user_id=p.user_id
      LEFT JOIN cycle_plan_versions v ON v.id=p.id AND v.user_id=p.user_id
      WHERE p.user_id=? AND p.cycle_id=? ORDER BY p.sequence DESC LIMIT 20`).all(userId,cycleId);
    const proposals=rows.map((row)=>({
      id:row.id,sequence:row.sequence,baseVersion:row.base_version,applied:Boolean(row.applied),
      execution:row.execution_id && row.state ? {id:row.execution_id,state:row.state,error:row.error_code,response:null,outdated:false} : null,
      ...(row.plan_json && rpeIssue(JSON.parse(row.plan_json)) ? {compatibilityError:'planningRpeIncompatible'} : {}),
    }));
    const version=appliedView?.version || 0;
    let selected=null;
    for(let index=0;index<rows.length;index++) {
      const row=rows[index],proposal=proposals[index];
      if(proposal.applied || proposal.baseVersion!==version || proposal.compatibilityError ||
          proposal.execution?.state!=='completed' || !row.plan_json) continue;
      proposal.execution=service.get(userId,row.execution_id);
      if(proposal.execution.response?.start<asOf)proposal.execution.outdated=true;
      if(proposalIsUsable(db,userId,cycleId,proposal,version,asOf)){selected=proposal;break;}
    }
    return summarizeCyclePlanning(cycle,appliedView,proposals,config.enabled,selected);
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
    if (rpeIssue(plan)) throw new AiError('planningRpeIncompatible',409);
    if (plan.start < now.slice(0,10)) throw new AiError('planningOutdated',409);
    if (context.resource.id!==cycleId || !validatePlan(plan,context)) throw new AiError('invalidPlanningResponse',409);
    db.prepare('INSERT INTO cycle_plan_versions(id,user_id,cycle_id,version,plan_json,context_hash,cycle_hash,fingerprint_json,sources_json,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(proposal.id,userId,cycleId,version+1,proposal.plan_json,context.hash,hash(cycle),JSON.stringify({hash:context.hash,asOf:context.asOf,purpose:context.purpose,resource:{id:cycleId},policyVersion:context.policyVersion}),JSON.stringify(context.sources),now);
    return {appliedVersion:version+1,alreadyApplied:false};
  }).immediate();
}
module.exports={ownCycle,appliedPlan,proposalIsUsable,summarizeCyclePlanning,readCyclePlanning,readCyclePlanningSummary,applyCyclePlan};
