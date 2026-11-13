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

test('Chrome PT/EN desktop/mobile: authorized execution detail tabs render synthetic raw output safely',async(t)=>{
 const db=fixture();const seed=harness(db);const queued=seed.service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'synthetic-trace-browser'});await complete(seed.service,queued.id);await seed.service.stop();
 const output='{"sessions":[{"evidence":["synthetic:rejected"]}]}';
 db.prepare("UPDATE ai_executions SET state='failed',response_json=NULL,error_code='invalidDomainResponse',raw_output_capture_version=1,diagnostics_json=? WHERE id=?").run(JSON.stringify([{attempt:1,stage:'domain',code:'invalidDomainResponse',providerStatus:'completed',httpStatus:200,validation:{code:'evidence',path:'$.sessions[0].evidence',reason:'evidence_unknown_reference'}},{attempt:2,stage:'parsing',code:'providerInvalidResponse',providerStatus:'completed',httpStatus:200}]),queued.id);
 db.prepare('INSERT INTO ai_execution_raw_outputs(execution_id,attempt,output_text,output_bytes,truncated,expired,expires_at) VALUES(?,?,?,?,0,0,?)').run(queued.id,1,output,Buffer.byteLength(output),new Date(Date.now()+86400000).toISOString());
 db.prepare('INSERT INTO ai_execution_raw_outputs(execution_id,attempt,output_text,output_bytes,truncated,expired,expires_at) VALUES(?,?,?,?,0,0,?)').run(queued.id,2,'{malformed json',15,new Date(Date.now()+86400000).toISOString());
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-test-key'})});const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const browser=await launchChrome(t);const token=createSession(db,1).token;
 for(const item of [{lang:'pt-BR',width:1280},{lang:'pt-BR',width:390},{lang:'en-US',width:1280},{lang:'en-US',width:390}]){
  await browser.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:token,url:origin,httpOnly:true});await browser.command('Emulation.setDeviceMetricsOverride',{width:item.width,height:900,deviceScaleFactor:1,mobile:item.width===390});await browser.command('Page.navigate',{url:origin+'/admin-ai-history.html'});await browser.wait("!!document.querySelector('#aiHistoryList button[data-id]')");
  await browser.evaluate(`document.querySelector('.lang-switch [data-lang="${item.lang}"]').click()`);await browser.wait(`document.documentElement.lang==='${item.lang}'`);await browser.evaluate("document.querySelector('#aiHistoryList button[data-id]').click()");await browser.wait("!document.getElementById('aiExecutionContent').hidden");await browser.evaluate("document.getElementById('traceAttempt').value='1';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");await browser.wait("document.getElementById('traceOutput').textContent.includes('synthetic:rejected')");
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false);assert.equal(await browser.evaluate("document.getElementById('traceDiagnosis').textContent.includes('$.sessions[0].evidence')"),true);
  await browser.evaluate("document.getElementById('traceResponseTab').click();document.getElementById('aiExecutionContent').scrollIntoView({block:'center'})");await browser.capture(`ai-trace-${item.lang}-${item.width}-response`);assert.equal(await browser.evaluate("document.getElementById('traceAttempt').options.length"),2);await browser.evaluate("document.getElementById('traceAttempt').value='2';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent"),'{malformed json');await browser.evaluate("document.getElementById('traceAttempt').value='1';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");
  await browser.evaluate("document.getElementById('traceResponseTab').focus();document.getElementById('traceResponseTab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");assert.equal(await browser.evaluate("document.getElementById('traceRequestTab').getAttribute('aria-selected')"),'true');assert.equal(await browser.evaluate("document.getElementById('aiExecutionPrompt').textContent.length>0"),true);assert.equal(await browser.evaluate("document.getElementById('aiExecutionPayload').textContent.length>0"),true);await browser.evaluate("document.getElementById('aiExecutionContent').scrollIntoView({block:'center'})");await browser.capture(`ai-trace-${item.lang}-${item.width}-request`);
  assert.equal(await browser.evaluate('document.activeElement.id'),'traceRequestTab');
 }
});

test('Chrome: a selected failed attempt in a completed execution keeps its own diagnosis and never borrows the later response',async(t)=>{
 const db=fixture();const seed=harness(db);const queued=seed.service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'synthetic-retry-associated-trace'});await complete(seed.service,queued.id);await seed.service.stop();
 db.prepare("UPDATE ai_executions SET state='completed',response_json=?,error_code=NULL,raw_output_capture_version=1,diagnostics_json=? WHERE id=?").run(JSON.stringify({accepted:'synthetic validated response'}),JSON.stringify([{attempt:1,stage:'domain',code:'invalidDomainResponse',validation:{code:'evidence',path:'$.sessions[0].evidence',reason:'evidence_empty'}},{attempt:2,stage:'completed',code:'completed'}]),queued.id);
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-test-key'})});const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const browser=await launchChrome(t);await browser.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:createSession(db,1).token,url:origin,httpOnly:true});await browser.command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});await browser.command('Page.navigate',{url:origin+'/admin-ai-history.html'});await browser.wait("!!document.querySelector('#aiHistoryList button[data-id]')");await browser.evaluate("document.querySelector('#aiHistoryList button[data-id]').click()");await browser.wait("!document.getElementById('aiExecutionContent').hidden");await browser.evaluate("document.getElementById('traceResponseTab').click();document.getElementById('traceAttempt').value='1';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");
 const observed=await browser.evaluate("JSON.stringify({diagnosis:document.getElementById('traceDiagnosis').textContent,output:document.getElementById('traceOutput').textContent,copyDisabled:document.getElementById('traceCopy').disabled,title:document.getElementById('traceOutputTitle')?.textContent||null,copyInHeader:!!document.querySelector('.trace-output-header #traceCopy'),scroll:document.documentElement.scrollWidth>innerWidth})");
 assert.deepEqual(JSON.parse(observed),{diagnosis:'Failed · domain · evidence · the evidence list is empty · $.sessions[0].evidence',output:'This attempt received no output text.',copyDisabled:true,title:'Model output',copyInHeader:true,scroll:false});
 assert.match(await browser.evaluate("document.getElementById('aiExecutionMeta').textContent"),/Completed/);
 await browser.evaluate("document.getElementById('traceAttempt').value='2';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");assert.equal(await browser.evaluate("document.getElementById('traceDiagnosis').textContent"),'Completed');assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent"),'{\n  "accepted": "synthetic validated response"\n}');assert.equal(await browser.evaluate("document.getElementById('traceCopy').disabled"),false);
 db.prepare("UPDATE ai_executions SET raw_output_capture_version=0,diagnostics_json='[]' WHERE id=?").run(queued.id);await browser.evaluate("document.getElementById('aiExecutionClose').click();document.querySelector('#aiHistoryList button[data-id]').click()");await browser.evaluate("document.getElementById('traceResponseTab').click()");await browser.wait("document.getElementById('traceOutput').textContent==='Legacy trace without captured output.'");assert.equal(await browser.evaluate("document.getElementById('traceCopy').disabled"),true);assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent.includes('synthetic validated response')"),false);
});

test('Chrome: an open attempt expires visibly and the copy action rechecks expiry before writing',async(t)=>{
 const db=fixture();const seed=harness(db);const queued=seed.service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'synthetic-live-expiry-trace'});await complete(seed.service,queued.id);await seed.service.stop();
 const raw='{"rejected":"synthetic output"}';const expiry=new Date(Date.now()+60000).toISOString();
 db.prepare("UPDATE ai_executions SET state='completed',response_json=?,error_code=NULL,raw_output_capture_version=1,diagnostics_json=? WHERE id=?").run(JSON.stringify({accepted:'synthetic validated response'}),JSON.stringify([{attempt:1,stage:'domain',code:'invalidDomainResponse',validation:{code:'evidence',path:'$.sessions[0].evidence'}},{attempt:2,stage:'completed',code:'completed'}]),queued.id);
 db.prepare('INSERT INTO ai_execution_raw_outputs(execution_id,attempt,output_text,output_bytes,truncated,expired,expires_at) VALUES(?,?,?,?,0,0,?)').run(queued.id,1,raw,Buffer.byteLength(raw),expiry);
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-test-key'})});const origin=await app.listen({port:0,host:'127.0.0.1'});t.after(async()=>{await app.close();db.close();});
 const browser=await launchChrome(t);await browser.command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:createSession(db,1).token,url:origin,httpOnly:true});await browser.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await browser.command('Page.navigate',{url:origin+'/admin-ai-history.html'});await browser.wait("!!document.querySelector('#aiHistoryList button[data-id]')");await browser.evaluate("document.querySelector('#aiHistoryList button[data-id]').click()");await browser.wait("!document.getElementById('aiExecutionContent').hidden");
 await browser.evaluate("document.getElementById('traceResponseTab').click();document.getElementById('traceAttempt').value='1';document.getElementById('traceAttempt').dispatchEvent(new Event('change'));window.__traceCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>window.__traceCopies.push(text)}})");
 assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent"),raw);assert.equal(await browser.evaluate("document.getElementById('traceCopy').disabled"),false);await browser.evaluate("document.getElementById('traceCopy').click()");await browser.wait("window.__traceCopies.length===1");assert.equal(await browser.evaluate('window.__traceCopies[0]'),raw);
 await browser.evaluate("window.__traceDateNow=Date.now.bind(Date);Date.now=()=>window.__traceDateNow()+65000;document.getElementById('traceCopy').click()");assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent"),'Captured output has expired.');assert.equal(await browser.evaluate("document.getElementById('traceCopy').disabled"),true);assert.equal(await browser.evaluate('window.__traceCopies.length'),1);
 await browser.evaluate("document.getElementById('traceAttempt').value='2';document.getElementById('traceAttempt').dispatchEvent(new Event('change'))");assert.equal(await browser.evaluate("document.getElementById('traceOutput').textContent"),'{\n  "accepted": "synthetic validated response"\n}');assert.equal(await browser.evaluate("document.getElementById('traceCopy').disabled"),false);
});
