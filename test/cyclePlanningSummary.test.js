'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readCyclePlanning,readCyclePlanningSummary,applyCyclePlan}=require('../src/ai/cycle-plans');
const {buildContext}=require('../src/ai/context');
const {AiError}=require('../src/ai/memory');
const {fixture,planFor,harness,complete,today,future}=require('./fixtures/ai/cycle-planning.cjs');
let serial=0;
function enqueue(service){return service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:`summary-${++serial}`});}
async function waitFor(service,id,state){for(let i=0;i<100;i++){if(service.get(1,id).state===state)return;await new Promise(r=>setTimeout(r,5));}throw new Error(`Execution did not reach ${state}`);}

test('cycle planning summary distinguishes empty, unavailable and inactive without exposing artifacts',async(t)=>{
 const db=fixture();const {config,service}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const initial=readCyclePlanning(db,1,'cycle',service,config);
 assert.deepEqual(initial.summary,{status:'none',secondary:null,available:true,canGenerate:true});
 assert.equal(JSON.stringify(initial.summary).includes('Synthetic planning recommendation'),false);
 const unavailable=structuredClone(config);unavailable.enabled=false;
 assert.equal(readCyclePlanning(db,1,'cycle',service,unavailable).summary.status,'unavailable');
 db.prepare("UPDATE training_cycles SET status='completed' WHERE id='cycle'").run();
 const inactive=readCyclePlanning(db,1,'cycle',service,config);
 assert.equal(inactive.summary.status,'none');assert.equal(inactive.summary.canGenerate,false);
});

test('pending execution and safe retry wait are summarized as generating without a provider call in tests',async(t)=>{
 const db=fixture();let release;const held=new Promise(r=>release=r);let calls=0;
 const {config,service}=harness(db,async(payload)=>{calls++;await held;return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:null,error:null};});
 t.after(async()=>{release();await service.stop();db.close();});
 const row=enqueue(service);await waitFor(service,row.id,'running');
 db.prepare("UPDATE ai_executions SET state='queued',error_code='providerRateLimited',updated_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),row.id);
 const result=readCyclePlanning(db,1,'cycle',service,config);
 assert.equal(result.summary.status,'pending');assert.equal(result.proposals[0].execution.error,'providerRateLimited');
 service.cancel(1,row.id);release();await complete(service,row.id);assert.equal(calls,1);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).summary.status,'failed');
});

test('failed, uncertain and cancelled attempts without usable artifacts are not shown as empty or ready',async(t)=>{
 for(const kind of ['failed','uncertain','cancelled']){
  const db=fixture();let release;const held=new Promise(r=>release=r);
  const {config,service}=harness(db,async()=>{
   await held;
   if(kind==='uncertain')throw new AiError('providerOutcomeUncertain',502);
   return {value:null,usage:null,error:kind==='failed'?'providerRefused':null};
  });
  const row=enqueue(service);await waitFor(service,row.id,'running');
  if(kind==='cancelled')service.cancel(1,row.id);
  release();await complete(service,row.id);
  const state=readCyclePlanning(db,1,'cycle',service,config);
  assert.equal(state.summary.status,'failed',kind);assert.equal(state.selectedProposalId,null,kind);
  await service.stop();db.close();
 }
});

test('proposal selection remains deterministic and keeps an earlier usable proposal after a newer failure',async(t)=>{
 const db=fixture();let shouldFail=false;let calls=0;
 const {config,service}=harness(db,async(payload)=>{
  calls++;if(shouldFail)return {value:null,usage:{input:10,output:5,cached:0},error:'providerRefused'};
  return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:10,output:50,cached:0},error:null};
 });t.after(async()=>{await service.stop();db.close();});
 const first=enqueue(service);await complete(service,first.id);
 let state=readCyclePlanning(db,1,'cycle',service,config);
 assert.equal(state.summary.status,'proposal_ready');assert.equal(state.selectedProposalId,first.id);
 shouldFail=true;const second=enqueue(service);await complete(service,second.id);
 state=readCyclePlanning(db,1,'cycle',service,config);
 assert.equal(state.proposals[0].id,second.id);assert.equal(state.selectedProposalId,first.id);
 assert.equal(state.summary.status,'proposal_ready');assert.equal(state.summary.secondary,'update_failed');
 assert.equal(calls,2);
});

test('stale, incompatible, conflicting and invalid proposals never receive the ready status',async(t)=>{
 const db=fixture();const {config,service}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const row=enqueue(service);await complete(service,row.id);
 const plan=planFor(buildContext(db,1,{purpose:'cycle',resourceId:'cycle',config}));
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(JSON.stringify({...plan,phases:[{...plan.phases[0],intensity:'easy RPE 2–4/10',evidence:plan.phases[0].evidence}]}),row.id);
 let state=readCyclePlanning(db,1,'cycle',service,config);
 assert.equal(state.proposals[0].compatibilityError,'planningRpeIncompatible');assert.equal(state.summary.status,'failed');
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(JSON.stringify(plan),row.id);
 db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino) VALUES(1,?,'Run','Changed source')").run(today);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'failed');
 db.prepare('DELETE FROM trainings WHERE user_id=1').run();
 db.prepare('UPDATE cycle_plan_proposals SET base_version=1 WHERE id=?').run(row.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'failed');
 db.prepare('UPDATE cycle_plan_proposals SET base_version=0,plan_json=? WHERE id=?').run('{}',row.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'failed');
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=NULL WHERE id=?').run(row.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'failed');
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(JSON.stringify(plan),row.id);
 const corruptContextService={...service,get(userId,id){const execution=service.get(userId,id);db.prepare("UPDATE ai_executions SET context_json='{' WHERE id=?").run(id);return execution;}};
 state=readCyclePlanning(db,1,'cycle',corruptContextService,config);assert.equal(state.summary.status,'failed');
});

test('planning summary revalidates expired and RPE-incompatible artifacts',async(t)=>{
 const db=fixture();const {config,service}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const expired=enqueue(service);await complete(service,expired.id);
 const later=new Date(Date.now()+45*86400000).toISOString().slice(0,10);
 assert.equal(readCyclePlanningSummary(db,1,'cycle',service,config,later).status,'failed');

 db.prepare('DELETE FROM cycle_plan_proposals').run();
 const invalid=enqueue(service);await complete(service,invalid.id);
 const invalidPlan=JSON.parse(db.prepare('SELECT plan_json FROM cycle_plan_proposals WHERE id=?').get(invalid.id).plan_json);
 invalidPlan.phases[0].intensity='RPE 8/10';
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(JSON.stringify(invalidPlan),invalid.id);
 db.prepare('UPDATE ai_executions SET response_json=? WHERE id=?').run(JSON.stringify(invalidPlan),invalid.id);
 const summary=readCyclePlanningSummary(db,1,'cycle',service,config);
 assert.equal(summary.status,'failed');
});

test('planning summary preserves applied-plan compatibility and distinguishes unavailability',async(t)=>{
 const db=fixture();const {config,service}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const proposal=enqueue(service);await complete(service,proposal.id);
 applyCyclePlan(db,1,'cycle',proposal.id,{expected_version:0},service);
 assert.equal(readCyclePlanningSummary(db,1,'cycle',service,config).status,'applied_current');
 const disabled={...config,enabled:false};
 assert.deepEqual(readCyclePlanningSummary(db,1,'cycle',service,disabled),{status:'applied_current',secondary:'unavailable',available:false,canGenerate:false});
 const applied=JSON.parse(db.prepare('SELECT plan_json FROM cycle_plan_versions WHERE id=?').get(proposal.id).plan_json);
 applied.phases[0].intensity='RPE 9/10';
 db.prepare('UPDATE cycle_plan_versions SET plan_json=? WHERE id=?').run(JSON.stringify(applied),proposal.id);
 assert.equal(readCyclePlanningSummary(db,1,'cycle',service,config).status,'applied_incompatible');
});

test('a usable proposal remains visible while a later proposal is pending',async(t)=>{
 const db=fixture();let release;const {config,service}=harness(db,async(payload)=>{
  if(release)await new Promise(resolve=>release=resolve);
  return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:null,error:null};
 });t.after(async()=>{release?.();await service.stop();db.close();});
 const ready=enqueue(service);await complete(service,ready.id);
 release=()=>{};
 const pending=enqueue(service);await waitFor(service,pending.id,'running');
 const summary=readCyclePlanning(db,1,'cycle',service,config).summary;
 assert.equal(summary.status,'proposal_ready');assert.equal(summary.secondary,'new_pending');
 service.cancel(1,pending.id);release();await complete(service,pending.id);
});

test('applied plan remains primary through updates, failure, source changes and RPE incompatibility',async(t)=>{
 const db=fixture();let phase='success',release;let held=Promise.resolve();
 const {config,service}=harness(db,async(payload)=>{
  if(phase==='pending')await held;
  if(phase==='failed')return {value:null,usage:null,error:'providerRefused'};
  return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:null,error:null};
 });t.after(async()=>{release?.();await service.stop();db.close();});
 const first=enqueue(service);await complete(service,first.id);applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).summary.status,'applied_current');
 phase='pending';held=new Promise(r=>release=r);const pending=enqueue(service);await waitFor(service,pending.id,'running');
 let state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'applied_current');assert.equal(state.summary.secondary,'new_pending');
 phase='failed';release();await complete(service,pending.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'applied_current');assert.equal(state.summary.secondary,'update_failed');assert.equal(state.applied.version,1);
 phase='success';const next=enqueue(service);await complete(service,next.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.secondary,'new_proposal_ready');assert.equal(state.summary.status,'applied_current');
 updateCycleForTest(db);state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'applied_outdated');
 const incompatible=JSON.parse(db.prepare('SELECT plan_json FROM cycle_plan_versions WHERE id=?').get(first.id).plan_json);
 incompatible.phases[0].intensity='RPE 8/10';db.prepare('UPDATE cycle_plan_versions SET plan_json=? WHERE id=?').run(JSON.stringify(incompatible),first.id);
 state=readCyclePlanning(db,1,'cycle',service,config);assert.equal(state.summary.status,'applied_incompatible');
 const disabled=structuredClone(config);disabled.enabled=false;state=readCyclePlanning(db,1,'cycle',service,disabled);
 assert.equal(state.summary.status,'applied_incompatible');
});
function updateCycleForTest(db){db.prepare("UPDATE training_cycles SET primary_goal='Changed source',planning_revision=planning_revision+1 WHERE id='cycle'").run();}
