'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,planFor,harness,complete}=require('./fixtures/ai/cycle-planning.cjs');
const {incompatiblePlan}=require('./fixtures/ai/rpe-planning.cjs');
const {buildContext}=require('../src/ai/context');
const {validatePlan,diagnosePlan,rpeIssue,phaseFields}=require('../src/ai/cycle-plan-schema');
const {readCyclePlanning,applyCyclePlan}=require('../src/ai/cycle-plans');
const {createCyclePlanAdapter}=require('../src/ai/cycle-plan-adapter');
const {sanitizeDiagnostic}=require('../src/ai/diagnostics');
const request=(key)=>({purpose:'cycle',resource_id:'cycle',idempotency_key:key});

test('synthetic observed RPE 2–4/10 is refused with a value-free field diagnostic',()=>{
 const db=fixture(),context=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'}),bad=incompatiblePlan(context);
 assert.equal(validatePlan(bad,context),false);
 assert.deepEqual(diagnosePlan(bad,context),{code:'rpe_scale',path:'$.phases[0].intensity'});
 assert.deepEqual(sanitizeDiagnostic({stage:'domain',code:'planningRpeIncompatible',validation:rpeIssue(bad)}),{stage:'domain',code:'planningRpeIncompatible',validation:{code:'rpe_scale',path:'$.phases[0].intensity'}});
 db.close();
});

test('PT/EN numeric RPE syntax is bounded to its explicit label without confusing other units',()=>{
 const db=fixture(),context=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'}),plan=planFor(context);
 const valid=['RPE','2026-10-18 RPE 3/5','18/10/2026 RPE 3','RPE 3 e 10 km','RPE 3 and 80% HRmax','perceived exertion (RPE): 3/5','RPE 3 (scale of 5)','RPE 2 (escala 1–5)','RPE 2 (scale from 1 to 5)','esforço 3/5','effort 2–4/5','effort 80% HRmax','esforço 80% da FC máxima','RPE leve, FC 150 bpm; 10 km; 80%; 2030-01-10; pace 6:10/km.','RPE 1–5','RPE 3/5','RPE: 2 a 4 de 5','RPE between 2 and 4 out of 5','RPE entre 1 e 5','RPE 2.5/5','RPE 2,5/5','3/5 RPE','RPE/5','esforço percebido 2 a 4','perceived exertion: 3 out of 5','perceived effort 2 to 4','RPE 3; 10 km a 80% FC.','Percepção subjetiva de esforço: 4/5','RPE 3/5; HR 160 bpm, 90% HRmax, 12 km, 2026-10-18, 6:10/km.','FC 150 bpm, RPE confortável. Volume 10 km.','RPE 1. A próxima avaliação será em 10 dias.','RPE 1–5 (não FC 120–160 bpm).'];
 const invalid=['RPE/10','perceived exertion (RPE): 7/10','Percepção subjetiva de esforço (RPE) 2–4/10','RPE 3 (scale of 10)','RPE 2 (escala de 0–10)','RPE 2 (scale from 1 to 10)','RPE aproximado de 2–4/10','RPE approximately 2–4/10','esforço 3/10','effort 7/5','RPE 3 on a scale of 10','RPE 3 numa escala de 10','RPE 3/10','RPE 2–4/10','RPE 2 - 4 / 10','RPE de 6 a 8','RPE: 7','RPE = 5 to 6','RPE 0–10','RPE (escala de 0 a 10)','RPE between 6 and 8','RPE até 6','RPE at 7','RPE target: 8','RPE 5,5/5','RPE -1','RPE 0','RPE 2 out of 10','RPE 3 em 10','RPE de 7 pontos em 10','3/10 RPE','6–8 RPE','escala de esforço 0-10','perceived effort 7','percepção de esforço 6','perceived exertion 2–4/10','RPE 3/5; RPE 7','RPE 4; esforço percebido 2–4/10'];
 for(const text of valid){plan.phases[0].intensity=text;assert.equal(validatePlan(plan,context),true,text);}
 for(const text of invalid){plan.phases[0].intensity=text;assert.equal(validatePlan(plan,context),false,text);}
 db.close();
});

test('scale protection covers every generated narrative field but not identity/evidence numbers',()=>{
 const db=fixture(),context=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'});
 for(const key of ['assessment','continuity','feasibility']){const plan=planFor(context);plan[key]='RPE 8/10';assert.deepEqual(rpeIssue(plan),{code:'rpe_scale',path:`$.${key}`});}
 for(const key of phaseFields){const plan=planFor(context);plan.phases[0][key]='RPE 6';assert.deepEqual(rpeIssue(plan),{code:'rpe_scale',path:`$.phases[0].${key}`});}
 for(const key of ['indicators','uncertainties','assumptions','questions']){const plan=planFor(context);plan[key]=['RPE 3/5','RPE 0–10','Synthetic condition','Synthetic review','Synthetic follow-up'];assert.deepEqual(rpeIssue(plan),{code:'rpe_scale',path:`$.${key}[1]`});}
 for(const key of ['increase','maintain','reduce','replaceQuality','reduceLongRun']){const plan=planFor(context);plan.adaptations[key]='RPE 10';assert.deepEqual(rpeIssue(plan),{code:'rpe_scale',path:`$.adaptations.${key}`});}
 assert.equal(rpeIssue({}),null);
 const good=planFor(context);assert.equal(rpeIssue(good),null);assert.equal(validatePlan(good,context),true);
 db.close();
});

test('API adapter v3 declares Kinesis RPE units without changing external templates',()=>{
 const db=fixture(),adapter=createCyclePlanAdapter(db);assert.equal(adapter.version,'cycle-delivery-v3');
 assert.match(adapter.instructions,/RPE.*1 to 5/);assert.match(adapter.instructions,/0.to.10|0–10/);assert.match(adapter.instructions,/heart rate.*pace/i);
 db.close();
});

test('incompatible output is never proposed/applied/retried and known provider usage is settled',async(t)=>{
 const db=fixture();let calls=0;
 const {config,service}=harness(db,async payload=>{calls++;return {value:incompatiblePlan(JSON.parse(payload.input[0].content[0].text).context),usage:{input:100,output:200,cached:0},error:null};});
 t.after(async()=>{await service.stop();db.close();});
 assert.equal(config.limits.AI_RETRIES,1);
 const execution=service.enqueue(1,request('rpe-invalid'));const result=await complete(service,execution.id);
 assert.equal(result.state,'failed');assert.equal(result.error,'planningRpeIncompatible');assert.equal(result.response,null);assert.equal(calls,1);
 assert.equal(service.enqueue(1,request('rpe-invalid')).id,execution.id);
 const debug=service.get(1,execution.id,true);assert.equal(debug.attempts,1);assert.equal(debug.costBasis,'reported_usage_estimate');assert.deepEqual(debug.usage,{input:100,output:200,cached:0});assert.equal(debug.estimatedCostUsd,0.0035);assert.deepEqual(debug.diagnostics[0].validation,{code:'rpe_scale',path:'$.phases[0].intensity'});
 assert.equal(db.prepare('SELECT plan_json FROM cycle_plan_proposals').get().plan_json,null);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',execution.id,{expected_version:0},service),/planningOutdated/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);
 assert.equal(db.prepare('SELECT status FROM training_cycles WHERE id=?').get('cycle').status,'active');
});

function oldOutput(db,id,plan){const json=JSON.stringify(plan);db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(json,id);db.prepare('UPDATE ai_executions SET response_json=? WHERE id=?').run(json,id);return json;}
test('existing affected proposal is blocked on read/apply while compatible proposals remain valid',async(t)=>{
 const db=fixture(),{service,config}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request('old-unapplied'));const completed=await complete(service,row.id);const bad=structuredClone(completed.response);bad.indicators[0]='RPE 2–4/10';const json=oldOutput(db,row.id,bad);
 const view=readCyclePlanning(db,1,'cycle',service,config);assert.equal(view.proposals[0].compatibilityError,'planningRpeIncompatible');assert.equal(view.proposals[0].execution.state,'completed');
 assert.throws(()=>applyCyclePlan(db,1,'cycle',row.id,{expected_version:0},service),/planningRpeIncompatible/);
 assert.equal(db.prepare('SELECT plan_json FROM cycle_plan_proposals WHERE id=?').get(row.id).plan_json,json);
 const fresh=service.enqueue(1,request('compatible-unapplied'));await complete(service,fresh.id);assert.equal(readCyclePlanning(db,1,'cycle',service,config).proposals[0].compatibilityError,undefined);applyCyclePlan(db,1,'cycle',fresh.id,{expected_version:0},service);assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,1);
});

test('only affected applied planning is excluded from future guidance; originals and unrelated freshness stay intact',async(t)=>{
 const db=fixture(),{service,config}=harness(db);t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request('old-applied'));const result=await complete(service,row.id);applyCyclePlan(db,1,'cycle',row.id,{expected_version:0},service);
 const good=buildContext(db,1,{purpose:'workouts',config});assert.equal(good.appliedPlan.compatibilityError,undefined);assert.ok(good.appliedPlan.architecture.length);assert.equal(good.appliedPlan.outdated,false);
 const bad=structuredClone(result.response);bad.adaptations.reduce='RPE 7/10';const json=oldOutput(db,row.id,bad);db.prepare('UPDATE cycle_plan_versions SET plan_json=? WHERE id=?').run(json,row.id);
 const before=db.prepare('SELECT * FROM cycle_plan_versions WHERE id=?').get(row.id);
 const view=readCyclePlanning(db,1,'cycle',service,config);assert.equal(view.applied.compatibilityError,'planningRpeIncompatible');assert.deepEqual(view.applied.plan,bad);assert.equal(view.applied.outdated,false);
 for(const purpose of ['workouts','analysis']){const context=buildContext(db,1,{purpose,config});assert.equal(context.appliedPlan.compatibilityError,'planningRpeIncompatible');assert.deepEqual(context.appliedPlan.architecture,[]);assert.deepEqual(context.appliedPlan.phases,[]);assert.deepEqual(context.appliedPlan.indicators,[]);assert.equal(context.appliedPlan.adaptations,null);assert.ok(!JSON.stringify(context).includes('7/10'));assert.ok(context.sources.some(s=>s.type==='cycle_plan' && s.id===row.id));assert.ok(context.omissions.some(o=>o.reason==='incompatible_rpe_scale'));}
 assert.deepEqual(applyCyclePlan(db,1,'cycle',row.id,{expected_version:0},service),{appliedVersion:1,alreadyApplied:true});
 assert.deepEqual(db.prepare('SELECT * FROM cycle_plan_versions WHERE id=?').get(row.id),before);
 const replacement=service.enqueue(1,request('explicit-replacement'));await complete(service,replacement.id);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied.compatibilityError,'planningRpeIncompatible');
 applyCyclePlan(db,1,'cycle',replacement.id,{expected_version:1},service);
 const restored=buildContext(db,1,{purpose:'workouts',config});assert.equal(restored.appliedPlan.version,2);assert.equal(restored.appliedPlan.compatibilityError,undefined);assert.ok(restored.appliedPlan.phases.length);assert.equal(restored.appliedPlan.outdated,false);
 assert.deepEqual(db.prepare('SELECT * FROM cycle_plan_versions WHERE id=?').get(row.id),before);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,2);
});

test('HTTP preserves ownership and returns the RPE refusal for a stored proposal without a provider call',async(t)=>{
 const db=fixture(),{service,config}=harness(db);
 const old=service.enqueue(1,request('rpe-http-legacy'));const result=await complete(service,old.id);await service.stop();
 const bad=structuredClone(result.response);bad.questions=['Perceived exertion 7/10'];oldOutput(db,old.id,bad);
 const {buildServer}=require('../src/server'),{createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');let calls=0;
 const app=await buildServer({db,aiConfig:config,aiClient:async()=>{calls++;throw Error('unexpected simulated provider call');}});
 t.after(async()=>{await app.close();db.close();});
 const cookies=[1,2].map(id=>({[SESSION_COOKIE_NAME]:createSession(db,id).token}));
 const read=await app.inject({method:'GET',url:'/api/cycles/cycle/planning',cookies:cookies[0]});assert.equal(read.statusCode,200);assert.equal(read.json().proposals[0].compatibilityError,'planningRpeIncompatible');
 const url=`/api/cycles/cycle/planning/${old.id}/apply`;
 assert.equal((await app.inject({method:'POST',url,payload:{expected_version:0}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url,cookies:cookies[1],payload:{expected_version:0}})).statusCode,404);
 const refused=await app.inject({method:'POST',url,cookies:cookies[0],payload:{expected_version:0}});
 assert.equal(refused.statusCode,409);assert.deepEqual(refused.json().errors,['planningRpeIncompatible']);
 assert.equal(calls,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);
});
