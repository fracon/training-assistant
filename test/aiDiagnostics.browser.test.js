'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {fixture,planFor,harness,complete}=require('./fixtures/ai/cycle-planning.cjs');
const {applyCyclePlan}=require('../src/ai/cycle-plans');const {buildServer}=require('../src/server');
const {readAiConfig}=require('../src/ai/config');const {createResponsesClient}=require('../src/ai/client');
const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');const {launchChrome}=require('./helpers/chrome.cjs');
const {AiError}=require('../src/ai/memory');
test('Chrome PT/EN: output-limit alert, one explicit call, protected diagnostics and free recovery after failed read',async(t)=>{
 const db=fixture();const seed=harness(db);const first=seed.service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'synthetic-applied'});await complete(seed.service,first.id);applyCyclePlan(db,1,'cycle',first.id,{expected_version:0},seed.service);await seed.service.stop();
 let calls=0,timeout=false;
 const provider=createResponsesClient({apiKey:'synthetic-only-key',timeoutMs:1000,fetchImpl:async(_,options)=>{
  calls++;if(timeout){await require('node:timers/promises').setTimeout(1100);throw Error('synthetic timeout');}assert.match(options.headers['X-Client-Request-Id'],/^kin_/);
  return new Response(JSON.stringify({id:`resp_browser_${calls}`,status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:100,output_tokens:2048,output_tokens_details:{reasoning_tokens:2048}},output:[{type:'reasoning',summary:[]}]}),{headers:{'x-request-id':`req_browser_${calls}`}});
 }});
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-only-key'}),aiClient:provider});const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const b=await launchChrome(t);const tokens=[1,2].map(id=>createSession(db,id).token);
 for(const account of [0,1])for(const language of ['pt-BR','en-US'])for(const width of [1280,390]){
  const id=account===0?'cycle':'private',messages=require(`../src/public/locales/${language==='pt-BR'?'pt':'en'}.json`);
  await b.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:tokens[account],url:origin,httpOnly:true});await b.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await b.command('Page.navigate',{url:origin+'/cycles.html'});await b.wait("!!document.querySelector('[data-action=planning]')");
  await b.evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);await b.wait(`document.documentElement.lang==='${language}'`);
  for(let i=0;i<200 && db.prepare('SELECT preferred_lang FROM users WHERE id=?').get(account+1).preferred_lang!==language;i++)await require('node:timers/promises').setTimeout(5);
  assert.equal(db.prepare('SELECT preferred_lang FROM users WHERE id=?').get(account+1).preferred_lang,language);
  await b.evaluate("document.querySelector('[data-action=planning]').click()");await b.wait("!document.getElementById('cyclePlanningGenerate').disabled");
  const before=calls;await b.evaluate("document.getElementById('cyclePlanningGenerate').click();document.getElementById('cyclePlanningGenerate').click()");
  await b.wait(`!document.getElementById('cyclePlanningGenerate').disabled && !document.getElementById('cyclePlanningError').hidden && document.getElementById('cyclePlanningError').textContent===${JSON.stringify(messages.cyclePlanning.errors.providerOutputLimit)}`);
  assert.equal(calls,before+1);assert.equal(await b.evaluate("document.getElementById('cyclePlanningError').getAttribute('role')"),'alert');assert.equal(await b.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await b.capture(`diagnostic-limit-${account}-${language}-${width}`);
  const row=db.prepare('SELECT * FROM ai_executions WHERE resource_id=? ORDER BY created_at DESC LIMIT 1').get(id);assert.equal(row.attempts,1);assert.equal(JSON.parse(row.usage_json).output,2048);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions WHERE cycle_id=?').get('cycle').n,1);
  if(account===0){await b.evaluate("document.getElementById('cyclePlanningDebug').click()");await b.wait("!document.getElementById('cyclePlanningDebugDetails').hidden");const exact=JSON.parse(await b.evaluate("document.getElementById('cyclePlanningDebugOutput').textContent"));assert.equal(exact.diagnostics[0].incompleteReason,'max_output_tokens');assert.equal(exact.diagnostics[0].requestId,`req_browser_${calls}`);assert.ok(!JSON.stringify(exact).includes('synthetic-only-key'));}
  else {assert.equal(await b.evaluate("document.getElementById('cyclePlanningAdmin').hidden"),true);assert.equal(await b.evaluate(`fetch('/api/ai/admin/executions/${row.id}').then(r=>r.status)`),403);const safe=await b.evaluate(`fetch('/api/cycles/${id}/planning').then(r=>r.json())`);assert.equal(safe.proposals[0].execution.diagnostics,undefined);}
  await b.key('Escape','Escape',27);
 }
 // A read failure is recoverable without repeating a paid operation or changing its durable state.
 const before=calls;const held=await b.intercept(origin+'/api/cycles/private/planning');await b.evaluate("document.querySelector('[data-action=planning]').click()");const paused=await held.next;
 await b.command('Fetch.fulfillRequest',{requestId:paused.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"synthetic-read-failure"}').toString('base64')});await held.close();await b.wait("!document.getElementById('cyclePlanningRetry').hidden");
 assert.equal(db.prepare("SELECT state FROM ai_executions WHERE resource_id='private' ORDER BY created_at DESC LIMIT 1").get().state,'failed');await b.evaluate("document.getElementById('cyclePlanningRetry').click()");await b.wait(`document.getElementById('cyclePlanningError').textContent===${JSON.stringify(require('../src/public/locales/en.json').cyclePlanning.errors.providerOutputLimit)}`);assert.equal(calls,before);
 timeout=true;await b.evaluate("document.getElementById('cyclePlanningGenerate').click()");
 await b.wait(`document.getElementById('cyclePlanningError').textContent===${JSON.stringify(require('../src/public/locales/en.json').cyclePlanning.errors.providerTimeout)}`);assert.equal(calls,before+1);
 const uncertain=db.prepare("SELECT state,usage_json,charged_cost,reserved_cost FROM ai_executions WHERE resource_id='private' ORDER BY created_at DESC LIMIT 1").get();assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.usage_json,null);assert.equal(uncertain.charged_cost,uncertain.reserved_cost);
 for(const lang of ['pt-BR','en-US']){await b.evaluate(`document.querySelector('.lang-switch [data-lang="${lang}"]').click()`);const text=require(`../src/public/locales/${lang==='pt-BR'?'pt':'en'}.json`).cyclePlanning.errors.providerTimeout;await b.wait(`document.getElementById('cyclePlanningError').textContent===${JSON.stringify(text)}`);await b.capture(`diagnostic-timeout-${lang}-390`);}
});

test('Chrome PT/EN: a delayed 429 explains the wait, closes safely, and resumes the same execution without duplicate calls',async(t)=>{
 const db=fixture();let calls=0;const byCycle=new Map();
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'}),aiClient:async(payload)=>{
  calls++;const context=JSON.parse(payload.input[0].content[0].text).context;const id=context.resource.id;const attempt=(byCycle.get(id)||0)+1;byCycle.set(id,attempt);
  if(attempt===1){const error=new AiError('providerRateLimited',429);error.retryAfterMs=4000;error.diagnostic={stage:'provider_http',httpStatus:429};throw error;}
  return {value:planFor(context),usage:{input:20,output:30,cached:0},error:null};
 }});
 const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const browser=await launchChrome(t);
 for(const entry of [{user:1,id:'cycle',lang:'pt-BR',width:390},{user:2,id:'private',lang:'en-US',width:1280}]){
  await browser.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:createSession(db,entry.user).token,url:origin,httpOnly:true});
  await browser.command('Emulation.setDeviceMetricsOverride',{width:entry.width,height:900,deviceScaleFactor:1,mobile:entry.width===390});
  await browser.command('Page.navigate',{url:origin+'/cycles.html'});await browser.wait(`!!document.querySelector('[data-action=planning][data-id=${entry.id}]')`);
  await browser.evaluate(`document.querySelector('.lang-switch [data-lang="${entry.lang}"]').click()`);await browser.wait(`document.documentElement.lang==='${entry.lang}'`);
  await browser.evaluate(`document.querySelector('[data-action=planning][data-id=${entry.id}]').click()`);await browser.wait("!document.getElementById('cyclePlanningGenerate').disabled");
  await browser.evaluate("document.getElementById('cyclePlanningGenerate').click()");
  const waiting=entry.lang==='pt-BR'?'O serviço está ocupado':'The service is busy';
  await browser.wait(`document.getElementById('cyclePlanningStatus').textContent.includes(${JSON.stringify(waiting)})`);
  const execution=db.prepare('SELECT * FROM ai_executions WHERE resource_id=?').get(entry.id);assert.ok(execution);assert.equal(execution.state,'queued');assert.equal(execution.attempts,1);assert.equal(calls,entry.user===1?1:3);
  assert.equal(await browser.evaluate("document.getElementById('cyclePlanningCancel').hidden"),false);
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await browser.capture(`cycle-planning-retry-${entry.lang}-${entry.width}`);
  if(entry.lang==='pt-BR'){
   await browser.evaluate("document.getElementById('cyclePlanningCancel').focus()");
   const heldRead=await browser.intercept(origin+`/api/cycles/${entry.id}/planning`);const paused=await heldRead.next;
   await browser.command('Fetch.fulfillRequest',{requestId:paused.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"synthetic-read-failure"}').toString('base64')});await heldRead.close();
   await browser.wait("!document.getElementById('cyclePlanningRetry').hidden && document.getElementById('cyclePlanningStatus').textContent.includes('A consulta do andamento falhou')");
   assert.equal(await browser.evaluate('document.activeElement.id'),'cyclePlanningCancel');
   await browser.evaluate("document.getElementById('cyclePlanningRetry').click()");
   await browser.wait("document.getElementById('cyclePlanningRetry').hidden || document.getElementById('cyclePlanningStatus').textContent.includes('O serviço está ocupado')");
   assert.equal(calls,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_executions WHERE resource_id='cycle'").get().n,1);
  }
  await browser.evaluate("document.getElementById('cyclePlanningLater').click()");assert.equal(calls,entry.user===1?1:3);
  await browser.evaluate(`document.querySelector('[data-action=planning][data-id=${entry.id}]').click()`);
  await browser.wait(`document.getElementById('cyclePlanningStatus').textContent.includes(${JSON.stringify(waiting)}) || !document.getElementById('cyclePlanningApply').hidden`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_executions WHERE resource_id=?').get(entry.id).n,1);
  for(let i=0;i<200 && ['queued','running'].includes(db.prepare('SELECT state FROM ai_executions WHERE id=?').get(execution.id).state);i++)await require('node:timers/promises').setTimeout(25);
  const final=db.prepare('SELECT state,attempts,error_code,diagnostics_json FROM ai_executions WHERE id=?').get(execution.id);
  assert.equal(final.state,'completed',JSON.stringify({error:final.error_code,diagnostics:JSON.parse(final.diagnostics_json)}));
  assert.equal(final.attempts,2);assert.equal(calls,entry.user===1?2:4);
  await browser.wait("!document.getElementById('cyclePlanningApply').hidden");
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
 }
});
