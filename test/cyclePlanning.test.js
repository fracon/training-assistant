'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createDatabase,initializeDatabase}=require('../src/db/database');
const {readAiConfig}=require('../src/ai/config');
const {createExecutionService}=require('../src/ai/executions');
const {createCyclePlanAdapter,adaptPrompt,DELIVERY}=require('../src/ai/cycle-plan-adapter');
const {schema,phaseFields,planningWindow,validatePlan,validShape}=require('../src/ai/cycle-plan-schema');
const {readCyclePlanning,applyCyclePlan}=require('../src/ai/cycle-plans');
const {buildContext}=require('../src/ai/context');
const {buildMacrocyclePrompt}=require('../src/ai/prompts');
const {updateCycle}=require('../src/cycles');
const {AiError}=require('../src/ai/memory');
const {setTimeout:delay}=require('node:timers/promises');
const {fixture,planFor,harness,complete,today,future}=require('./fixtures/ai/cycle-planning.cjs');
let counter=0;
function enqueue(s,resource='cycle'){return s.enqueue(1,{purpose:'cycle',resource_id:resource,idempotency_key:`planning-${++counter}`});}

test('delivery adapter changes exactly three delivery instructions in PT/EN, preserving all other prompt bytes',()=>{
 for(const lang of ['pt-BR','en-US']){
  const prompt=buildMacrocyclePrompt({objective:'Synthetic'},lang);let adapted=adaptPrompt(prompt);
  const from=DELIVERY[lang==='pt-BR'?'pt':'en'];
  assert.equal(adapted.includes(from[0]),false);assert.equal(adapted.includes(from[1]),false);assert.equal(adapted.includes(from[2]),false);
  let cursor=0;for(const segment of prompt.split(new RegExp(from.map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')))){const index=adapted.indexOf(segment,cursor);assert.ok(index>=cursor);cursor=index+segment.length;}
  assert.equal((adapted.match(/\n\d+\. /g)||[]).length,22);
 }
 for(const [language,lang] of [['pt','pt-BR'],['en','en-US']]) {
  const injected=DELIVERY[language].join(' ');
  const original=buildMacrocyclePrompt({objective:'Synthetic',other_events:injected},lang);
  const adapted=adaptPrompt(original);
  assert.equal(adapted.slice(0,adapted.indexOf('\n2.')),original.slice(0,original.indexOf('\n2.')));
  for(const phrase of DELIVERY[language])assert.equal(adapted.split(phrase).length,2);
 }
 assert.throws(()=>adaptPrompt('Quero invalid'),/promptAdapterMismatch/);
 assert.throws(()=>adaptPrompt('Invalid'),/promptAdapterMismatch/);
});

test('planning validator rejects malformed shape, unknown fields, gaps, overlaps, invalid dates and source references',()=>{
 const db=fixture();const context=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'});const good=planFor(context);
 assert.equal(validatePlan(good,context),true);
 for(const invalid of [null,[],{},'text',42,{...good,extra:true}])assert.equal(validatePlan(invalid,context),false);
 for(const key of Object.keys(good)){
  const missing=structuredClone(good);delete missing[key];assert.equal(validatePlan(missing,context),false,key);
  const invalid=structuredClone(good);invalid[key]=null;assert.equal(validatePlan(invalid,context),false,key);
 }
 for(const [key,value] of [['assessment',''],['assessment',' '.repeat(4)],['assessment','x'.repeat(1601)],['confidence','invented'],['cycleId','wrong'],['start',future(1)],['end',future(29)],['phases',[]],['phases',Array(13).fill(good.phases[0])],['indicators',[]],['indicators',Array(11).fill('a')],['indicators',[2]],['uncertainties',Array(13).fill('x')]])assert.equal(validatePlan({...good,[key]:value},context),false,key);
 for(const patch of [{start:'2026-02-30'},{end:'bad'},{start:future(2)},{end:future(-1)},{end:future(40)},{end:future(20)},{evidence:[]},{evidence:['training:private'] }]){const p=structuredClone(good);Object.assign(p.phases[0],patch);assert.equal(validatePlan(p,context),false,JSON.stringify(patch));}
 const two=structuredClone(good);two.phases[0].end=future(10);two.phases.push({...good.phases[0],start:future(11)});assert.equal(validatePlan(two,context),true);
 two.phases[1].start=future(10);assert.equal(validatePlan(two,context),false);
 assert.equal(validShape('',schema.properties.cycleId),false);
 assert.throws(()=>planningWindow({...context,resource:null}),/cycleNotActive/);
 assert.throws(()=>planningWindow({...context,resource:{...context.resource,status:'completed'}}),/cycleNotActive/);
 assert.throws(()=>planningWindow({...context,resource:{...context.resource,target_date:future(-1)}}),/invalidPlanningDates/);
 assert.throws(()=>planningWindow({...context,resource:{...context.resource,start_date:'bad'}}),/invalidDate/);
 assert.equal(planningWindow({...context,resource:{...context.resource,start_date:null}}).start,today);
 assert.equal(planningWindow({...context,resource:{...context.resource,start_date:future(5)}}).start,future(5));
 assert.equal(validatePlan(good,{...context,resource:null}),false);db.close();
});

test('existing cycles migrate idempotently; generation, application, regeneration and applied context are separate',async()=>{
 const db=fixture();const {config,service}=harness(db);
 initializeDatabase(db);initializeDatabase(db);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied,null);
 const first=enqueue(service);const result=await complete(service,first.id);assert.equal(result.state,'completed');
 assert.equal(service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:`planning-${counter}`}).id,first.id);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config,future(1)).proposals[0].execution.outdated,true);
 const before=readCyclePlanning(db,1,'cycle',service,config);assert.equal(before.proposals[0].execution.id,first.id);assert.equal(before.applied,null);
 assert.deepEqual(applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),{appliedVersion:1,alreadyApplied:false});
 assert.deepEqual(applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),{appliedVersion:1,alreadyApplied:true});
 for(const purpose of ['workouts','analysis']){
  const context=buildContext(db,1,{purpose,config});assert.equal(context.appliedPlan.version,1);assert.equal(context.appliedPlan.authority,'applied_planning');assert.equal(context.appliedPlan.assessment,undefined);assert.equal(context.appliedPlan.assumptions,undefined);assert.equal(context.appliedPlan.feasibility,undefined);assert.equal(context.appliedPlan.continuity,undefined);assert.equal(context.appliedPlan.outdated,false);
 }
 const second=enqueue(service);await complete(service,second.id);const third=enqueue(service);await complete(service,third.id);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied.version,1);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',second.id,{expected_version:0},service),/planningConflict/);
 applyCyclePlan(db,1,'cycle',third.id,{expected_version:1},service);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',second.id,{expected_version:2},service),/planningConflict/);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied.version,2);
 // The accepted architecture survives execution retention, without retaining raw payloads.
 db.prepare('DELETE FROM ai_executions WHERE user_id=1').run();
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).proposals[0].execution,null);
 service.cleanup();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_proposals').get().n,2);
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied.version,2);
 db.prepare("UPDATE trainings SET feedback_rpe=5 WHERE user_id=1").run();
 updateCycle(db,'cycle',1,{primary_goal:'Changed goal'});
 assert.equal(readCyclePlanning(db,1,'cycle',service,config).applied.outdated,true);
 assert.equal(buildContext(db,1,{purpose:'workouts',config}).appliedPlan.outdated,true);
 await service.stop();db.close();
});

test('ownership, account activity, stale sources, conflicts, expired proposals and invalid plans refuse atomic application',async()=>{
 const db=fixture();const {config,service}=harness(db);const first=enqueue(service);await complete(service,first.id);
 for(const body of [{},{expected_version:-1},{expected_version:'0'},{expected_version:0,extra:true}])assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,body,service));
 assert.throws(()=>readCyclePlanning(db,2,'cycle',service,config),/resourceNotFound/);
 assert.throws(()=>applyCyclePlan(db,1,'private',first.id,{expected_version:0},service),/resourceNotFound/);
 assert.throws(()=>applyCyclePlan(db,1,'cycle','missing',{expected_version:0},service),/proposalNotFound/);
 db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),/accountUnavailable/);db.prepare('UPDATE users SET is_active=1 WHERE id=1').run();
 db.prepare("UPDATE cycle_plan_proposals SET plan_json='{}' WHERE id=?").run(first.id);assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),/invalidPlanningResponse/);
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=NULL WHERE id=?').run(first.id);assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),/planningOutdated/);
 db.prepare('UPDATE cycle_plan_proposals SET plan_json=? WHERE id=?').run(JSON.stringify(planFor(buildContext(db,1,{purpose:'cycle',resourceId:'cycle',config}))),first.id);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service,future(1)),/planningOutdated/);
 db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,feedback_has_pain,feedback_pain,feedback_rpe) VALUES(1,?,'Run','Recent','yes','Synthetic discomfort',5)").run(today);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),/planningOutdated/);
 const second=enqueue(service);await complete(service,second.id);updateCycle(db,'cycle',1,{status:'completed'});
 assert.throws(()=>applyCyclePlan(db,1,'cycle',second.id,{expected_version:0},service),/planningOutdated/);
 assert.throws(()=>enqueue(service),/cycleNotActive/);
 updateCycle(db,'cycle',1,{status:'active',target_date:future(-1)});assert.throws(()=>enqueue(service),/invalidPlanningDates/);
 updateCycle(db,'cycle',1,{target_date:future(28)});const third=enqueue(service);await complete(service,third.id);db.prepare('DELETE FROM ai_executions WHERE id=?').run(third.id);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',third.id,{expected_version:0},service),/proposalExpired/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);
 db.prepare('DELETE FROM training_cycles WHERE id=?').run('cycle');assert.throws(()=>applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},service),/resourceNotFound/);
 await service.stop();db.close();
});

test('invalid/refused/incomplete/provider-uncertain results and cancellation never persist a usable proposal',async()=>{
 for(const kind of ['invalid','refused','incomplete','uncertain','cancel','edit','switch','delete','inactive','account-delete']){
  const db=fixture();let release;const hold=new Promise(r=>release=r);
  const {service,config}=harness(db,async(payload)=>{await hold;const context=JSON.parse(payload.input[0].content[0].text).context;
   if(kind==='uncertain')throw new AiError('providerOutcomeUncertain',502);
   return {value:kind==='invalid'?{}:planFor(context),usage:{input:20,output:30,cached:0},error:kind==='refused'?'providerRefused':kind==='incomplete'?'providerIncomplete':null};});
  const row=enqueue(service);for(let i=0;i<50 && service.get(1,row.id).state!=='running';i++)await delay(5);
  if(kind==='cancel')service.cancel(1,row.id);
  if(kind==='switch'){updateCycle(db,'cycle',1,{status:'completed'});db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,target_date) VALUES('new-cycle',1,'New active cycle','active',?)").run(future(28));}
  if(kind==='edit')updateCycle(db,'cycle',1,{primary_goal:'Changed while generating'});
  if(kind==='inactive')db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  if(kind==='account-delete')db.prepare('DELETE FROM users WHERE id=1').run();
  if(kind==='delete')db.prepare("DELETE FROM training_cycles WHERE id='cycle'").run();
  release();if(!['inactive','account-delete'].includes(kind))await complete(service,row.id);await service.stop();
  if(!['inactive','account-delete','delete'].includes(kind))assert.equal(readCyclePlanning(db,1,'cycle',service,config).proposals[0].execution.state,service.get(1,row.id).state);
  const proposal=db.prepare('SELECT plan_json FROM cycle_plan_proposals WHERE id=?').get(row.id);assert.ok(!proposal || proposal.plan_json===null,kind);
  db.close();
 }
});


test('previous canonical cycles are bounded and source-backed; no interpretations are reused in weekly planning',()=>{
 const db=fixture();for(let i=0;i<5;i++)db.prepare("INSERT INTO training_cycles(id,user_id,objective,status) VALUES (?,1,'Synthetic previous race','completed')").run(`previous-${i}`);
 const context=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'});
 assert.equal(context.previousCycles.length,3);assert.equal(context.previousCycles[0].user_id,undefined);
 assert.ok(context.sources.some(r=>r.type==='cycle' && r.id.startsWith('previous')));db.close();
});

test('migration from a phase-0 database preserves cycles and records without inventing any planning',()=>{
 const db=fixture();db.exec("DROP TABLE cycle_plan_versions; DROP TABLE cycle_plan_proposals; ALTER TABLE training_cycles DROP COLUMN planning_revision; DELETE FROM schema_migrations WHERE name='2026-10-cycle-planning-v1';");
 const before=db.prepare('SELECT * FROM training_cycles ORDER BY id').all();initializeDatabase(db);initializeDatabase(db);
 for(const cycle of before){const row=db.prepare('SELECT * FROM training_cycles WHERE id=?').get(cycle.id);assert.equal(row.planning_revision,0);delete row.planning_revision;assert.deepEqual(row,cycle);}
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);db.close();
});

test('same-second cycle edits cannot restore a proposal freshness by reverting field values',async()=>{
 const db=fixture();const {service}=harness(db);const proposal=enqueue(service);await complete(service,proposal.id);
 updateCycle(db,'cycle',1,{primary_goal:'Temporary synthetic edit'});updateCycle(db,'cycle',1,{primary_goal:null});
 assert.equal(db.prepare("SELECT planning_revision FROM training_cycles WHERE id='cycle'").get().planning_revision,2);
 assert.throws(()=>applyCyclePlan(db,1,'cycle',proposal.id,{expected_version:0},service),/planningOutdated/);
 await service.stop();db.close();
});

test('cycle request uses supplied prior experience, saved availability and complete recent discomfort/RPE ahead of future prose',async()=>{
 const db=fixture();require('../src/ai/memory').saveProfile(db,1,{fields:{experience:'Synthetic running experience before Kinesis'},expected_version:0});
 db.prepare("INSERT INTO ai_coach_availability(user_id,day_key,can_train,available_periods,available_minutes,location) VALUES(1,'monday',1,'[\"before_08\"]',60,'Synthetic place')").run();
 db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe,feedback_has_pain,feedback_pain,fit_distance,fit_duration) VALUES(1,?,'Run','Recent synthetic session',1,5,'yes','Dated synthetic discomfort',5,'30:00')").run(today);
 for(let i=1;i<=7;i++)db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino,detalhes) VALUES(1,?,'Run','Future synthetic session',?)").run(future(i),'Optional prose '.repeat(30));
 const {service}=harness(db,async(payload)=>{
  const context=JSON.parse(payload.input[0].content[0].text).context;
  assert.equal(context.recent[0].report.feedback_rpe,5);assert.equal(context.recent[0].report.feedback_pain,'Dated synthetic discomfort');assert.equal(context.recent[0].report.observedOn,today);
  assert.equal(context.profile.fields.experience.value,'Synthetic running experience before Kinesis');assert.equal(context.availability[0].location,'Synthetic place');
  assert.equal(context.currentRestrictions,undefined);assert.equal(JSON.stringify(payload).includes('other@example.invalid'),false);
  return {value:planFor(context),usage:null,error:null};
 });
 const result=await complete(service,enqueue(service).id);assert.equal(result.state,'completed');await service.stop();db.close();
});

test('later task context supplies relevant applied phases and discloses omitted distant phase details',async()=>{
 const db=fixture();const {service,config}=harness(db,async(payload)=>{
  const plan=planFor(JSON.parse(payload.input[0].content[0].text).context);const later={...plan.phases[0],start:future(21)};plan.phases[0].end=future(20);plan.phases.push(later);return {value:plan,usage:null,error:null};
 });
 const proposal=enqueue(service);await complete(service,proposal.id);applyCyclePlan(db,1,'cycle',proposal.id,{expected_version:0},service);
 const context=buildContext(db,1,{purpose:'workouts',config});assert.equal(context.appliedPlan.architecture.length,2);assert.equal(context.appliedPlan.phases.length,1);
 assert.ok(context.omissions.some(o=>o.reason==='phase_details_outside_task_window' && o.count===1));
 await service.stop();db.close();
});

for (const purpose of ['workouts', 'analysis']) {
 test(`${purpose} budgets applied planning after complete recent reports and required sources`,async(t)=>{
  const db=fixture();t.after(()=>db.close());
  const {DAY_KEYS}=require('../src/availability');
  for(const day of DAY_KEYS) db.prepare(`INSERT INTO ai_coach_availability
   (user_id,day_key,can_train,available_periods,available_minutes,location)
   VALUES(1,?,1,'["before_08"]',60,'Synthetic locality')`).run(day);
  const recent=db.prepare(`INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe,feedback_has_pain,feedback_pain)
   VALUES(1,?,'Run','Recent synthetic report',1,5,'yes','Complete dated synthetic discomfort')`).run(today).lastInsertRowid;
  const requested=db.prepare("INSERT INTO trainings(user_id,dia,tipo,treino) VALUES(1,?,'Run','Requested synthetic session')").run(today).lastInsertRowid;
  const {service,config}=harness(db,async(payload)=>{
   const plan=planFor(JSON.parse(payload.input[0].content[0].text).context);
   for(const key of phaseFields) if(!['name','objective'].includes(key)) plan.phases[0][key]='Optional planning prose. '.repeat(60);
   for(const key of Object.keys(plan.adaptations)) plan.adaptations[key]='Optional adaptation. '.repeat(75);
   return {value:plan,usage:null,error:null};
  });t.after(()=>service.stop());
  const proposal=enqueue(service);assert.equal((await complete(service,proposal.id)).state,'completed');
  applyCyclePlan(db,1,'cycle',proposal.id,{expected_version:0},service);
  const args={purpose,resourceId:purpose==='analysis'?requested:null,config};
  const context=buildContext(db,1,args);
  const report=context.recent.find(r=>r.source.id===String(recent));
  assert.equal(report.report.feedback_pain,'Complete dated synthetic discomfort');
  assert.equal(report.report.feedback_rpe,5);assert.equal(report.report.observedOn,today);
  assert.equal(context.appliedPlan.version,1);assert.equal(context.appliedPlan.outdated,false);
  assert.equal(context.appliedPlan.architecture.length,1);assert.equal(context.appliedPlan.phases.length,0);
  assert.equal(context.appliedPlan.adaptations,null);
  assert.ok(context.omissions.some(o=>o.type==='phases' && o.id===proposal.id && o.reason==='context_budget'));
  assert.equal(context.sources.filter(s=>s.type==='cycle_plan' && s.id===proposal.id).length,1);
  if(purpose==='workouts') assert.equal(context.availability.length,7);
  else assert.equal(context.resource.source.id,String(requested));
  assert.ok(require('../src/ai/context').tokenBound(context)<=config.limits.AI_CONTEXT_TOKENS);
  assert.deepEqual(buildContext(db,1,args),context);
  const historical={...context,policyVersion:'training-context-v4'};const frozen=JSON.stringify(historical);
  assert.equal(require('../src/ai/context').contextIsCurrent(db,1,historical,config),false);
  assert.equal(JSON.stringify(historical),frozen);
  config.limits.AI_CONTEXT_TOKENS=1000;
  assert.throws(()=>buildContext(db,1,args),e=>e.code==='criticalContextTooLarge' && e.status===413);
 });
}

test('oversized applied architecture is selected deterministically without crowding mandatory reports',async(t)=>{
 const db=fixture();
 db.prepare(`INSERT INTO trainings(user_id,dia,tipo,treino,completed,feedback_rpe,feedback_has_pain,feedback_pain)
  VALUES(1,?,'Run','Synthetic session',1,5,'yes','Whole dated report')`).run(today);
 let generated;
 const {service,config}=harness(db,async(payload)=>{
  generated=planFor(JSON.parse(payload.input[0].content[0].text).context);
  const template=generated.phases[0];
  generated.phases=Array.from({length:12},(_,i)=>({...template,start:future(i),end:future(i===11?28:i),name:'N'.repeat(1500),objective:'O'.repeat(1500)}));
  return {value:generated,usage:null,error:null};
 });t.after(async()=>{await service.stop();db.close();});
 const proposal=enqueue(service);assert.equal((await complete(service,proposal.id)).state,'completed');
 applyCyclePlan(db,1,'cycle',proposal.id,{expected_version:0},service);
 const args={purpose:'workouts',config};const context=buildContext(db,1,args);
 assert.equal(context.recent[0].report.feedback_pain,'Whole dated report');
 assert.ok(context.appliedPlan.architecture.length>0 && context.appliedPlan.architecture.length<12);
 assert.deepEqual(context.appliedPlan.architecture,generated.phases.slice(0,context.appliedPlan.architecture.length).map(({name,start,end,objective})=>({name,start,end,objective})));
 assert.ok(context.omissions.some(o=>o.type==='architecture' && o.reason==='context_budget'));
 assert.ok(context.omissions.some(o=>o.reason==='selection_omissions'));
 assert.ok(require('../src/ai/context').tokenBound(context)<=config.limits.AI_CONTEXT_TOKENS);
 assert.deepEqual(buildContext(db,1,args),context);
 const cycleContext=buildContext(db,1,{purpose:'cycle',resourceId:'cycle',config});
 assert.equal(cycleContext.appliedPlan,undefined);assert.equal(cycleContext.recent[0].report.feedback_pain,'Whole dated report');
});
