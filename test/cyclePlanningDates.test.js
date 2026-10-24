'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {planningWindow}=require('../src/ai/cycle-plan-schema');
const {createCyclePlanAdapter}=require('../src/ai/cycle-plan-adapter');
const {createExecutionService}=require('../src/ai/executions');
const {readAiConfig}=require('../src/ai/config');
const {applyCyclePlan}=require('../src/ai/cycle-plans');
const {fixture,planFor,complete}=require('./fixtures/ai/cycle-planning.cjs');
const AS_OF='2030-06-15';
const context=(fields={})=>({asOf:AS_OF,resource:{id:'cycle',objective:'Run 10 km without a race',status:'active',start_date:null,target_date:'2030-08-15',...fields}});
const invalid=[
 [{target_date:null},'planningTargetDateRequired'],[{target_date:''},'planningTargetDateRequired'],[{target_date:undefined},'planningTargetDateRequired'],
 [{target_date:'2030-02-30'},'planningTargetDateInvalid'],[{target_date:'15/08/2030'},'planningTargetDateInvalid'],[{target_date:'08/15/2030'},'planningTargetDateInvalid'],[{target_date:'2030-08-15T00:00:00Z'},'planningTargetDateInvalid'],
 [{start_date:'2030-02-30'},'planningStartDateInvalid'],[{start_date:'bad'},'planningStartDateInvalid'],[{start_date:false},'planningStartDateInvalid'],
 [{start_date:'2030-08-16'},'planningTargetBeforeStart'],[{start_date:'2030-06-01',target_date:'2030-06-14'},'planningTargetBeforeReference'],
 [{status:'completed'},'cycleNotActive'],[{status:'cancelled'},'cycleNotActive'],
];
test('fixed calendar window accepts race and personal goals with inclusive target, past/future/absent start',()=>{
 for(const objective of ['Run a race','Run 10 km without competition','Build a consistent running habit']){
  for(const [start_date,start] of [[null,AS_OF],['',AS_OF],[undefined,AS_OF],['2030-01-01',AS_OF],['2030-07-01','2030-07-01']])assert.deepEqual(planningWindow(context({objective,start_date})),{start,end:'2030-08-15'});
 }
 assert.deepEqual(planningWindow(context({target_date:AS_OF})),{start:AS_OF,end:AS_OF});
 const oneDay={...context({target_date:AS_OF}),sources:[{type:'cycle',id:'cycle'}]};
 assert.equal(require('../src/ai/cycle-plan-schema').validatePlan(planFor(oneDay),oneDay),true);
 assert.deepEqual(planningWindow(context({start_date:'2030-08-15'})),{start:'2030-08-15',end:'2030-08-15'});
});
test('date refusal identifies the exact field or interval, without requiring a race',()=>{
 const adapter=createCyclePlanAdapter(null);
 for(const [patch,code] of invalid){assert.throws(()=>planningWindow(context(patch)),e=>e.code===code,JSON.stringify(patch));assert.throws(()=>adapter.prepare(context(patch)),e=>e.code===code && e.status===400);}
});
test('invalid windows refuse before reservations or calls; personal goal generates and applies with simulated provider',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date(AS_OF+'T12:00:00Z')});
 const db=fixture();let calls=0;
 const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'});
 const adapter=createCyclePlanAdapter(db);
 const service=createExecutionService({db,config,operations:{cycle:adapter},client:async(payload)=>{
  calls++;const {context,trainingPrompt}=JSON.parse(payload.input[0].content[0].text);
  assert.equal(payload.store,false);assert.equal(context.resource.objective,'Run 10 km without competition');
  assert.equal(context.resource.target_date,'2030-08-15');assert.match(payload.instructions,/race is optional/i);
  assert.match(trainingPrompt,/only when a race is explicitly part of the registered goal/i);
  return {value:planFor(context),usage:{input:100,output:200,cached:0},error:null};
 }});t.after(async()=>{await service.stop();db.close();});
 let key=0;const enqueue=()=>service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:`date-case-${++key}`});
 const reset=()=>db.prepare("UPDATE training_cycles SET objective='Run 10 km without competition',status='active',start_date=NULL,target_date='2030-08-15' WHERE id='cycle'").run();
 for(const [patch,code] of invalid){if(Object.values(patch).some(v=>v===undefined || v===false))continue;reset();for(const [field,value] of Object.entries(patch))db.prepare(`UPDATE training_cycles SET ${field}=? WHERE id='cycle'`).run(value);assert.throws(enqueue,e=>e.code===code);}
 assert.equal(calls,0);
 for(const table of ['ai_executions','cycle_plan_proposals','ai_usage','ai_global_usage'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 reset();const row=enqueue();assert.equal((await complete(service,row.id)).state,'completed');assert.equal(calls,1);
 assert.deepEqual(applyCyclePlan(db,1,'cycle',row.id,{expected_version:0},service),{appliedVersion:1,alreadyApplied:false});
 assert.deepEqual(applyCyclePlan(db,1,'cycle',row.id,{expected_version:0},service),{appliedVersion:1,alreadyApplied:true});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,1);
});

test('HTTP preserves exact refusal codes before reserving usage',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date(AS_OF+'T12:00:00Z')});
 const {buildServer}=require('../src/server');const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');
 const db=fixture();let calls=0;const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'}),aiClient:async(payload)=>{calls++;return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:null,error:null};}});
 t.after(async()=>{await app.close();db.close();});const cookie=`${SESSION_COOKIE_NAME}=${createSession(db,1).token}`;
 let sequence=0;
 for(const [patch,code] of invalid){if(Object.values(patch).some(v=>v===undefined || v===false))continue;db.prepare("UPDATE training_cycles SET status='active',start_date=NULL,target_date='2030-08-15' WHERE id='cycle'").run();for(const [field,value] of Object.entries(patch))db.prepare(`UPDATE training_cycles SET ${field}=? WHERE id='cycle'`).run(value);const r=await app.inject({method:'POST',url:'/api/ai/executions',headers:{cookie},payload:{purpose:'cycle',resource_id:'cycle',idempotency_key:`date-http-${++sequence}`}});assert.equal(r.statusCode,400);assert.deepEqual(r.json(),{error:code,errors:[code]});}
 assert.equal(calls,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);
});

test('Chrome PT/EN personal-goal dates round-trip form/API/database and errors identify target without race requirement',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date(AS_OF+'T12:00:00Z')});
 const {buildServer}=require('../src/server');const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');const {launchChrome}=require('./helpers/chrome.cjs');
 const db=fixture();db.prepare('DELETE FROM training_cycles WHERE user_id=1').run();let calls=0;
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'}),aiClient:async(payload)=>{calls++;return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:10,output:20,cached:0},error:null};}});
 const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const b=await launchChrome(t);const cookie=createSession(db,1).token;await b.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:cookie,url:origin,httpOnly:true});
 for(const language of ['pt-BR','en-US'])for(const width of [1280,390]){
  await b.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await b.command('Page.navigate',{url:origin+'/cycles.html'});await b.wait("!!document.querySelector('.lang-switch') && !document.getElementById('cycleEmpty').classList.contains('hidden')");
  await b.evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);await b.wait(`document.documentElement.lang==='${language}'`);
  await b.evaluate("document.getElementById('addCycleBtn').click()");await b.wait("!document.getElementById('cycleModal').classList.contains('hidden')");
  const goal=language==='pt-BR'?'Conseguir correr 10 km sem prova':'Run 10 km without competition';
  await b.evaluate(`document.getElementById('cycleObjective').value=${JSON.stringify(goal)};document.getElementById('cycleForm').requestSubmit()`);
  await b.wait("!document.getElementById('cyclePlanningModal').hidden && !document.getElementById('cyclePlanningGenerate').disabled");
  const cycle=db.prepare('SELECT * FROM training_cycles WHERE user_id=1').get();assert.equal(cycle.target_date,null);const before=calls;
  await b.evaluate("document.getElementById('cyclePlanningGenerate').click()");await b.wait("!document.getElementById('cyclePlanningError').hidden");
  assert.equal(calls,before);assert.equal(await b.evaluate('document.activeElement.id'),'cyclePlanningError');
  const messages=require(`../src/public/locales/${language==='pt-BR'?'pt':'en'}.json`);
  assert.equal(await b.evaluate("document.getElementById('cyclePlanningError').textContent"),messages.cyclePlanning.errors.planningTargetDateRequired);
  await b.capture(`dates-missing-${language}-${width}`);
  await b.key('Escape','Escape',27);await b.evaluate("document.querySelector('[data-action=edit]').click()");
  await b.wait("!document.getElementById('cycleModal').classList.contains('hidden')");
  assert.equal(await b.evaluate("document.getElementById('cycleObjective').value"),goal);
  await b.evaluate("document.getElementById('cycleTargetDate').datePicker.setValue('2030-08-15');document.getElementById('cycleStartDate').datePicker.setValue('2030-06-01')");
  assert.equal(await b.evaluate("document.getElementById('cycleTargetDate').value"),language==='pt-BR'?'15/08/2030':'08/15/2030');
  assert.equal(await b.evaluate("document.getElementById('cycleStartDate').value"),language==='pt-BR'?'01/06/2030':'06/01/2030');
  await b.capture(`dates-valid-${language}-${width}`);
  await b.evaluate("document.getElementById('cycleForm').requestSubmit()");await b.wait("!document.getElementById('cyclePlanningModal').hidden && !document.getElementById('cyclePlanningGenerate').disabled");
  const saved=db.prepare('SELECT * FROM training_cycles WHERE id=?').get(cycle.id);assert.equal(saved.target_date,'2030-08-15');assert.equal(saved.start_date,'2030-06-01');assert.equal(saved.objective,goal);assert.equal(calls,before);
  await b.evaluate("document.getElementById('cyclePlanningGenerate').click()");await b.wait("!document.getElementById('cyclePlanningApply').hidden && !document.getElementById('cyclePlanningApply').disabled");assert.equal(calls,before+1);
  const plan=JSON.parse(db.prepare('SELECT plan_json FROM cycle_plan_proposals WHERE cycle_id=?').get(cycle.id).plan_json);assert.equal(plan.start,AS_OF);assert.equal(plan.end,'2030-08-15');
  assert.equal(await b.evaluate('document.documentElement.scrollWidth>innerWidth'),false);await b.capture(`dates-proposal-${language}-${width}`);
  await b.evaluate("document.getElementById('cyclePlanningApply').click()");await b.wait("document.getElementById('cyclePlanningApply').hidden");
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions WHERE cycle_id=?').get(cycle.id).n,1);
  await b.key('Escape','Escape',27);db.prepare('DELETE FROM training_cycles WHERE id=?').run(cycle.id);
 }
});
