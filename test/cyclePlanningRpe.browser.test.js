'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,harness,complete}=require('./fixtures/ai/cycle-planning.cjs');
const {incompatiblePlan}=require('./fixtures/ai/rpe-planning.cjs');
const {applyCyclePlan}=require('../src/ai/cycle-plans');
const {buildServer}=require('../src/server'),{readAiConfig}=require('../src/ai/config');
const {createResponsesClient}=require('../src/ai/client');
const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');
const {launchChrome}=require('./helpers/chrome.cjs');
const delay=require('node:timers/promises').setTimeout;

test('Chrome PT/EN: RPE refusal preserves applied planning; old incompatible versions stay visible with exclusion warning',async(t)=>{
 const db=fixture(),seed=harness(db);
 const first=seed.service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'rpe-browser-seed'});
 const original=await complete(seed.service,first.id);applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},seed.service);await seed.service.stop();
 const applied=db.prepare('SELECT * FROM cycle_plan_versions').get();let calls=0;
 const simulated=createResponsesClient({apiKey:'synthetic-only-key',timeoutMs:1000,fetchImpl:async(_,options)=>{
  calls++;const context=JSON.parse(JSON.parse(options.body).input[0].content[0].text).context;
  return new Response(JSON.stringify({id:`resp_rpe_${calls}`,status:'completed',usage:{input_tokens:100,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(incompatiblePlan(context))}]}]}));
 }});
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-only-key'}),aiClient:simulated});
 const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const b=await launchChrome(t);const token=createSession(db,1).token;
 await b.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:token,url:origin,httpOnly:true});
 for(const role of ['user','admin'])for(const language of ['pt-BR','en-US'])for(const width of [1280,390]){
  db.prepare('UPDATE users SET role=? WHERE id=1').run(role);
  await b.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await b.command('Page.navigate',{url:origin+'/cycles.html'});await b.wait("!!document.querySelector('[data-action=planning]')");
  await b.evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);await b.wait(`document.documentElement.lang==='${language}'`);
  for(let i=0;i<200 && db.prepare('SELECT preferred_lang FROM users WHERE id=1').get().preferred_lang!==language;i++)await delay(5);
  const messages=require(`../src/public/locales/${language==='pt-BR'?'pt':'en'}.json`).cyclePlanning;
  const before=calls;await b.evaluate("document.querySelector('[data-action=planning]').click()");await b.wait("!document.getElementById('cyclePlanningGenerate').disabled");assert.equal(calls,before);
  await b.evaluate("document.getElementById('cyclePlanningGenerate').click();document.getElementById('cyclePlanningGenerate').click()");
  await b.wait(`!document.getElementById('cyclePlanningGenerate').disabled && !document.getElementById('cyclePlanningError').hidden && document.getElementById('cyclePlanningError').textContent===${JSON.stringify(messages.errors.planningRpeIncompatible)}`);
  assert.equal(calls,before+1);assert.equal(await b.evaluate("document.getElementById('cyclePlanningApply').hidden"),true);
  assert.equal(await b.evaluate("document.getElementById('cyclePlanningError').getAttribute('role')"),'alert');
  assert.equal(await b.evaluate("document.querySelector('.cycle-plan-section .cycle-status').textContent.includes('1')"),true);
  assert.deepEqual(db.prepare('SELECT * FROM cycle_plan_versions').get(),applied);
  assert.equal(await b.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await b.capture(`rpe-refused-${role}-${language}-${width}`);
  await b.key('Escape','Escape',27);assert.equal(await b.evaluate('document.activeElement.dataset.action'),'planning');
 }
 // Reproduce only a synthetic legacy applied record; no real evaluation output is a fixture.
 const legacy=structuredClone(original.response);legacy.phases[0].intensity='RPE 2–4/10';const json=JSON.stringify(legacy);
 db.prepare('UPDATE cycle_plan_versions SET plan_json=? WHERE id=?').run(json,first.id);
 for(const language of ['pt-BR','en-US']){
  await b.evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);await b.wait(`document.documentElement.lang==='${language}'`);
  await b.evaluate("document.querySelector('[data-action=planning]').click()");
  const warning=require(`../src/public/locales/${language==='pt-BR'?'pt':'en'}.json`).cyclePlanning.appliedRpeIncompatible;
  await b.wait(`document.getElementById('cyclePlanningContent').textContent.includes(${JSON.stringify(warning)})`);
  assert.equal(await b.evaluate("document.getElementById('cyclePlanningContent').textContent.includes('RPE 2–4/10')"),true);
  assert.equal(db.prepare('SELECT plan_json FROM cycle_plan_versions').get().plan_json,json);
  await b.capture(`rpe-legacy-warning-${language}-390`);await b.key('Escape','Escape',27);
 }
 assert.equal(calls,8);assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,1);
});
