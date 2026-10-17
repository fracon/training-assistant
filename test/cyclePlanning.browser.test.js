'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,writeFileSync,readFileSync}=require('node:fs');const {tmpdir}=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');const {once}=require('node:events');const {createServer}=require('node:http');const {setTimeout:delay}=require('node:timers/promises');
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
  const key=async(key,code,value,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:value,modifiers});};
  const open=async()=>{await evaluate("document.querySelector('[data-action=planning]').click()");await wait("!document.getElementById('cyclePlanningGenerate').disabled");};
  // Optional local visual run uses the real Lucide UMD asset, outside Git.
  // Standard automated runs remain independent of CDN/network availability.
  if(process.env.KINESIS_TEST_LUCIDE_FILE) await command('Page.addScriptToEvaluateOnNewDocument',{source:readFileSync(process.env.KINESIS_TEST_LUCIDE_FILE,'utf8')});
  let promptRequests=0;
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent' && /\/api\/cycles\/[^/]+\/prompt/.test(m.params.request.url))promptRequests++;});
  const capture=async(name)=>{await delay(300);const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`/tmp/kinesis-cycle-${name}.png`,Buffer.from(shot.data,'base64'));};
  const loadingOpen=async(name)=>{
   let resolvePaused;const paused=new Promise(r=>resolvePaused=r);
   const listener=event=>{const m=JSON.parse(event.data);if(m.method==='Fetch.requestPaused')resolvePaused(m.params.requestId);};
   socket.addEventListener('message',listener);
   await command('Fetch.enable',{patterns:[{urlPattern:origin+'/api/cycles/*/planning',requestStage:'Response'}]});
   await evaluate("document.querySelector('[data-action=planning]').click()");const requestId=await paused;
   assert.equal(await evaluate("document.getElementById('cyclePlanningGenerate').disabled"),true);
   await capture('loading-'+name);
   await command('Fetch.continueResponse',{requestId});await command('Fetch.disable');socket.removeEventListener('message',listener);
   await wait("!document.getElementById('cyclePlanningGenerate').disabled");
  };
  let referenceClose=null;
  const controlStyle=async(selector)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e),r=e.getBoundingClientRect();return {width:Math.round(r.width*100)/100,height:Math.round(r.height*100)/100,borderRadius:s.borderRadius,padding:s.padding,fontSize:s.fontSize,background:s.backgroundColor,color:s.color};})()`);
  await command('Page.enable');await command('Network.enable');await command('Network.setBlockedURLs',{urls:['*unpkg.com*','*fonts.googleapis.com*','*fonts.gstatic.com*']});
  for(const account of [0,1]){
   await command('Network.setCookie',{name:SESSION_COOKIE_NAME,value:tokens[account],url:origin,httpOnly:true});
   await command('Page.navigate',{url:origin+'/cycles.html'});await wait("!!document.querySelector('[data-action=planning]')");
   for(const language of ['en-US','pt-BR'])for(const width of [1280,768,390]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(350);
    await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
    await wait(`document.documentElement.lang==='${language}' && document.querySelector('[data-action=planning]').getAttribute('aria-label')==='${language==='pt-BR'?'Planejar ciclo':'Plan cycle'}'`);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    assert.equal(await evaluate("!!document.querySelector('[data-action=prompt]')"),account===0);
    assert.equal(await evaluate("!!document.getElementById('promptModal')"),account===0);
    const label=language==='pt-BR'?'Planejar ciclo':'Plan cycle';
    assert.equal(await evaluate("document.querySelector('[data-action=planning]').getAttribute('aria-label')"),label);
    assert.equal(await evaluate("document.querySelector('[data-action=planning]').hasAttribute('title')"),false);
    assert.deepEqual(await controlStyle('[data-action=planning]'),await controlStyle('[data-action=edit]'));
    const point=await evaluate("(()=>{const r=document.querySelector('[data-action=planning]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await delay(200);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-action=planning] .custom-tooltip')).opacity"),'1');
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
    await evaluate("document.querySelector('[data-action=cancel]').focus()");await key('Tab','Tab',9);if(account===0)await key('Tab','Tab',9);await delay(200);
    assert.equal(await evaluate('document.activeElement.dataset.action'),'planning');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-action=planning] .custom-tooltip')).opacity"),'1');
    const callsBeforeOpen=calls;
    await loadingOpen(`${account}-${language}-${width}`);assert.equal(calls,callsBeforeOpen);assert.equal(await evaluate('document.activeElement.id'),'cyclePlanningClose');
    assert.equal(await evaluate("document.getElementById('cyclePlanningClose').getAttribute('aria-label')"),language==='pt-BR'?'Fechar':'Close');
    assert.equal(await evaluate("document.getElementById('cyclePlanningHeading').textContent"),label);
    assert.equal(await evaluate("!!document.getElementById('appView').closest('[inert]')"),true);
    const planningClose=await controlStyle('#cyclePlanningClose');referenceClose=planningClose;
    await evaluate("document.getElementById('cycleModal').classList.remove('hidden')");
    assert.deepEqual(planningClose,await controlStyle('#cycleModalCloseBtn'));
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.cycle-planning-card')).padding"),await evaluate("getComputedStyle(document.querySelector('#cycleModal .modal-card')).padding"));
    await evaluate("document.getElementById('cycleModal').classList.add('hidden')");
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.cycle-planning-card')).animationName"),'none');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('cyclePlanningClose')).transitionDuration"),'0s');
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const layout=await evaluate("(()=>{const card=document.querySelector('.cycle-planning-card'),body=card.querySelector('.cycle-planning-body'),footer=card.querySelector('footer'),close=document.getElementById('cyclePlanningClose'),title=document.getElementById('cyclePlanningHeading'),b=body.getBoundingClientRect(),f=footer.getBoundingClientRect(),c=close.getBoundingClientRect(),h=title.getBoundingClientRect();return {padding:getComputedStyle(card).padding,aligned:Math.abs(b.left-f.left)<1 && Math.abs(b.right-f.right)<1,overlap:h.right>c.left,footerVisible:f.bottom<=card.getBoundingClientRect().bottom,close:[Math.round(c.width),Math.round(c.height)]};})()");
    assert.equal(layout.aligned,true);assert.equal(layout.overlap,false);assert.equal(layout.footerVisible,true);assert.deepEqual(layout.close,[30,30]);
    if(process.env.KINESIS_TEST_LUCIDE_FILE) {
     assert.equal(await evaluate("!!lucide.icons.CalendarRange"),true);
     assert.equal(await evaluate("document.querySelector('[data-action=planning] svg').getAttribute('aria-hidden')"),'true');
     assert.deepEqual(await evaluate("(()=>{const r=document.querySelector('#cyclePlanningClose svg').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];})()"),[18,18]);
    }
    await capture(`initial-${account}-${language}-${width}`);
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
    assert.equal(await evaluate("(()=>{const c=document.querySelector('#cyclePlanningModal .cycle-planning-body');return c.scrollHeight>c.clientHeight && getComputedStyle(c).overflowY==='auto';})()"),true);
    await evaluate("document.getElementById('cyclePlanningClose').focus()");await key('Tab','Tab',9,8);
    assert.equal(await evaluate('document.activeElement.id'),'cyclePlanningApply');await key('Tab','Tab',9);
    const proposal=await command('Page.captureScreenshot' ,{format:'png'});writeFileSync(`/tmp/kinesis-cycle-proposal-${account}-${language}-${width}.png`,Buffer.from(proposal.data,'base64'));
    await evaluate("document.getElementById('cyclePlanningApply').click()");await wait("document.getElementById('cyclePlanningApply').hidden && !document.getElementById('cyclePlanningGenerate').disabled");
    assert.ok((await evaluate("document.getElementById('cyclePlanningContent').textContent")).includes(language==='pt-BR'?'Planejamento aplicado':'Applied planning'));
    await evaluate("document.querySelector('.cycle-planning-body').scrollTop=0");await capture(`applied-plan-${account}-${language}-${width}`);
    if(account===0){await evaluate("document.getElementById('cyclePlanningDebug').click()");await wait("!document.getElementById('cyclePlanningDebugDetails').hidden");assert.ok((await evaluate("document.getElementById('cyclePlanningDebugOutput').textContent")).includes('"store": false'));}
    await evaluate("document.getElementById('cyclePlanningClose').focus()");await key('Tab','Tab',9);assert.equal(await evaluate("document.getElementById('cyclePlanningModal').contains(document.activeElement)"),true);
    await evaluate("document.dispatchEvent(new Event('app:languagechange'))");
    await capture(`applied-${account}-${language}-${width}`);
    await key('Escape','Escape',27);await wait("document.getElementById('cyclePlanningModal').hidden");assert.equal(await evaluate('document.activeElement.dataset.action'),'planning');
   }
   if(account===0) {
    const paidBefore=calls;await evaluate("document.querySelector('[data-action=prompt]').click()");
    await wait("!document.getElementById('promptModal').classList.contains('hidden')");
    await command('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
    await evaluate("document.getElementById('promptCopyBtn').click()");await delay(100);
    assert.equal(await evaluate('navigator.clipboard.readText()'),await evaluate("document.getElementById('promptOutput').textContent"));
    assert.equal(calls,paidBefore);await evaluate("document.getElementById('promptCloseBtn').click()");
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
  for(const language of ['pt-BR','en-US'])for(const width of [1280,768,390]) {
   await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
   await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
    await wait(`document.documentElement.lang==='${language}' && document.querySelector('[data-action=planning]').getAttribute('aria-label')==='${language==='pt-BR'?'Planejar ciclo':'Plan cycle'}'`);
   await capture(`error-${language}-${width}`);
   assert.equal(await evaluate('document.activeElement.id'),'cyclePlanningError');
  }
  await key('Escape','Escape',27);
  await evaluate("document.querySelector('.lang-switch [data-lang=\"pt-BR\"]').click()");
  await wait("document.documentElement.lang==='pt-BR'");
  config.enabled=false;await evaluate("document.querySelector('[data-action=planning]').click()");await wait("document.getElementById('cyclePlanningStatus').textContent.includes('IA indisponível')");assert.equal(await evaluate("document.getElementById('cyclePlanningGenerate').disabled"),true);
  await capture('unavailable');await key('Escape','Escape',27);
  const paidBeforeManual=calls,promptsBeforeManual=promptRequests;
  db.prepare("UPDATE training_cycles SET status='completed' WHERE id='private'").run();
  await command('Page.navigate',{url:origin+'/cycles.html'});await wait("!!document.querySelector('[data-action=planning]') && !document.getElementById('addCycleBtn').disabled");
  assert.equal(await evaluate("!!document.querySelector('[data-action=planning]')"),true);
  const inactiveBefore=JSON.stringify(db.prepare("SELECT * FROM training_cycles WHERE id='private'").get());
  await evaluate("document.querySelector('[data-action=planning]').click()");
  await wait("document.getElementById('cyclePlanningContent').textContent.includes('Planejamento aplicado')");
  assert.equal(calls,paidBeforeManual);assert.equal(JSON.stringify(db.prepare("SELECT * FROM training_cycles WHERE id='private'").get()),inactiveBefore);
  await evaluate("document.getElementById('cyclePlanningModal').click()");await wait("document.getElementById('cyclePlanningModal').hidden");
  assert.equal(await evaluate('document.activeElement.dataset.action'),'planning');
  await evaluate("document.getElementById('addCycleBtn').click()");await capture('cycle-reference-390');
  await evaluate("document.getElementById('cycleObjective').value='New synthetic cycle';document.getElementById('cycleForm').requestSubmit()");
  await wait("document.getElementById('cycleModal').classList.contains('hidden') && document.querySelectorAll('.cycle-card').length===2");
  assert.equal(promptRequests,promptsBeforeManual);assert.equal(calls,paidBeforeManual);
  assert.equal(await evaluate("!!document.querySelector('[data-action=prompt]') || !!document.getElementById('promptModal')"),false);
  await evaluate("document.querySelector('[data-action=edit]').click();document.getElementById('cyclePrimaryGoal').value='Edited synthetic goal';document.getElementById('cycleForm').requestSubmit()");
  await wait("document.getElementById('cycleModal').classList.contains('hidden') && document.getElementById('cycleList').textContent.includes('Edited synthetic goal')");
  await evaluate("document.querySelector('.lang-switch [data-lang=\"en-US\"]').click()");
  await wait("document.documentElement.lang==='en-US' && document.querySelector('[data-action=planning]').getAttribute('aria-label')==='Plan cycle'");
  assert.equal(await evaluate("!!document.querySelector('[data-action=prompt]')"),false);
  await evaluate("(()=>{const b=document.createElement('button');b.dataset.action='prompt';b.dataset.id='private';document.getElementById('cycleList').append(b);b.click();b.remove();})()");await delay(100);
  assert.equal(promptRequests,promptsBeforeManual);assert.equal(calls,paidBeforeManual);
  await command('Page.navigate',{url:origin+'/shoes.html'});await wait("!!document.getElementById('shoeEmpty') && !document.getElementById('shoeEmpty').classList.contains('hidden')");
  await evaluate("document.getElementById('addShoeBtn').click()");await wait("!document.getElementById('shoeModal').classList.contains('hidden')");
  const shoeClose=await controlStyle('#modalCloseBtn');assert.deepEqual(shoeClose,referenceClose);

  await capture('shoe-reference-390');
 }finally{release?.();socket?.close();chrome.kill('SIGTERM');await once(chrome,'exit').catch(()=>{});await app.close();db.close();rmSync(profile,{recursive:true,force:true});}
});
