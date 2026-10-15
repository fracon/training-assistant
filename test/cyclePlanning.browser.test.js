'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,writeFileSync}=require('node:fs');const {tmpdir}=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');const {once}=require('node:events');const {createServer}=require('node:http');const {setTimeout:delay}=require('node:timers/promises');
const {buildServer}=require('../src/server');const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');const {readAiConfig}=require('../src/ai/config');const {fixture,planFor}=require('./fixtures/ai/cycle-planning.cjs');
test('Chrome cycle planning PT/EN desktop/mobile: recovered generation, proposal, apply, focus, errors and own admin debug',async()=>{
 const db=fixture();let release=null,calls=0;
 const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'});
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:config,aiClient:async(payload)=>{
  calls++;await new Promise(r=>release=r);return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:50,output:100,cached:0},error:null};
 }});
 const origin=await app.listen({port:0,host:'127.0.0.1'});const tokens=[1,2].map(id=>createSession(db,id).token);
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 const profile=mkdtempSync(path.join(tmpdir(),'kinesis-cycle-planning-'));
 const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-allow-origins=*',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});let socket;
 try{
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}await delay(50);}
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
  let sequence=0;const pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
  const wait=async(expr)=>{for(let i=0;i<200;i++){try{if(await evaluate(expr))return;}catch{}await delay(50);}throw Error('Timed out: '+expr);};
  const key=async(key,code,value)=>{for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:value});};
  const open=async()=>{await evaluate("document.querySelector('[data-action=planning]').click()");await wait("!document.getElementById('cyclePlanningGenerate').disabled");};
  await command('Page.enable');await command('Network.enable');await command('Network.setBlockedURLs',{urls:['*unpkg.com*','*fonts.googleapis.com*','*fonts.gstatic.com*']});
  for(const account of [0,1]){
   await command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:tokens[account],url:origin,httpOnly:true});
   await command('Page.navigate',{url:origin+'/cycles.html'});await wait("!!document.querySelector('[data-action=planning]')");
   for(const language of ['en-US','pt-BR'])for(const width of [1280,390]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(350);
    await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await open();assert.equal(await evaluate('document.activeElement.id'),'cyclePlanningClose');
    assert.equal(await evaluate("document.getElementById('cyclePlanningClose').getAttribute('aria-label')"),language==='pt-BR'?'Fechar':'Close');
    const before=calls;await evaluate("document.getElementById('cyclePlanningGenerate').click();document.getElementById('cyclePlanningGenerate').click()");
    for(let i=0;i<100 && calls===before;i++)await delay(10);assert.equal(calls,before+1);
    await wait("document.getElementById('cyclePlanningGenerate').disabled && !document.getElementById('cyclePlanningCancel').hidden");
    const running=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`/tmp/kinesis-cycle-running-${account}-${language}-${width}.png`,Buffer.from(running.data,'base64'));
    // Reload while the backend call is held. The durable execution is recovered.
    await command('Page.navigate',{url:origin+'/cycles.html'});await wait("!!document.querySelector('[data-action=planning]')");
    await evaluate("document.querySelector('[data-action=planning]').click()");await wait("!document.getElementById('cyclePlanningCancel').hidden");
    assert.equal(calls,before+1);release();release=null;
    await wait("!document.getElementById('cyclePlanningApply').hidden && !document.getElementById('cyclePlanningApply').disabled");
    assert.ok((await evaluate("document.getElementById('cyclePlanningContent').textContent")).includes('Synthetic planning recommendation'));
    assert.equal(await evaluate("document.getElementById('cyclePlanningDebug').hidden"),account!==0);
    assert.equal(await evaluate("document.querySelector('#cyclePlanningModal .modal-card').scrollWidth>document.querySelector('#cyclePlanningModal .modal-card').clientWidth"),false);
    assert.equal(await evaluate("(()=>{const c=document.querySelector('#cyclePlanningModal .modal-card');return c.scrollHeight>c.clientHeight && getComputedStyle(c).overflowY==='auto';})()"),true);
    const proposal=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`/tmp/kinesis-cycle-proposal-${account}-${language}-${width}.png`,Buffer.from(proposal.data,'base64'));
    await evaluate("document.getElementById('cyclePlanningApply').click()");await wait("document.getElementById('cyclePlanningApply').hidden && !document.getElementById('cyclePlanningGenerate').disabled");
    assert.ok((await evaluate("document.getElementById('cyclePlanningContent').textContent")).includes(language==='pt-BR'?'Planejamento aplicado':'Applied planning'));
    if(account===0){await evaluate("document.getElementById('cyclePlanningDebug').click()");await wait("!document.getElementById('cyclePlanningDebugDetails').hidden");assert.ok((await evaluate("document.getElementById('cyclePlanningDebugOutput').textContent")).includes('"store": false'));}
    await evaluate("document.getElementById('cyclePlanningClose').focus()");await key('Tab','Tab',9);assert.equal(await evaluate("document.getElementById('cyclePlanningModal').contains(document.activeElement)"),true);
    await evaluate("document.dispatchEvent(new Event('app:languagechange'))");
    await key('Escape','Escape',27);await wait("document.getElementById('cyclePlanningModal').hidden");assert.equal(await evaluate('document.activeElement.dataset.action'),'planning');
   }
  }
  // Hold an older poll response, cancel, then release it after a newer response.
  await open();await evaluate("document.getElementById('cyclePlanningGenerate').click()");
  await wait("!document.getElementById('cyclePlanningCancel').hidden && !document.getElementById('cyclePlanningCancel').disabled");
  let held=null;let resolveHeld;const firstPoll=new Promise(r=>resolveHeld=r);
  const holdPoll=(event)=>{const m=JSON.parse(event.data);if(m.method!=='Fetch.requestPaused')return;if(!held){held=m.params.requestId;resolveHeld();}else command('Fetch.continueResponse',{requestId:m.params.requestId}).catch(()=>{});};
  socket.addEventListener('message',holdPoll);
  await command('Fetch.enable',{patterns:[{urlPattern:origin+'/api/cycles/private/planning',requestStage:'Response'}]});
  await firstPoll;await evaluate("document.getElementById('cyclePlanningCancel').click()");
  await wait("document.getElementById('cyclePlanningStatus').textContent.includes('cancelada')");
  await command('Fetch.continueResponse',{requestId:held});await delay(100);
  assert.ok((await evaluate("document.getElementById('cyclePlanningStatus').textContent")).includes('cancelada'));
  await command('Fetch.disable');socket.removeEventListener('message',holdPoll);
  release();release=null;await delay(50);await key('Escape','Escape',27);
  // Invalid dates produce an actionable localized error without starting a call.
  db.prepare("UPDATE training_cycles SET target_date='bad' WHERE id='private'").run();await open();const before=calls;await evaluate("document.getElementById('cyclePlanningGenerate').click()");await wait("!document.getElementById('cyclePlanningError').hidden");assert.equal(calls,before);assert.equal(await evaluate('document.activeElement.id'),'cyclePlanningError');
  assert.ok((await evaluate("document.getElementById('cyclePlanningError').textContent")).includes('datas válidas'));
  await key('Escape','Escape',27);
  config.enabled=false;await evaluate("document.querySelector('[data-action=planning]').click()");await wait("document.getElementById('cyclePlanningStatus').textContent.includes('IA indisponível')");assert.equal(await evaluate("document.getElementById('cyclePlanningGenerate').disabled"),true);
 }finally{release?.();socket?.close();chrome.kill('SIGTERM');await once(chrome,'exit').catch(()=>{});await app.close();db.close();rmSync(profile,{recursive:true,force:true});}
});
