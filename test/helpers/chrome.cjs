'use strict';
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,writeFileSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('node:http');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');

async function launchChrome(t) {
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const profile=mkdtempSync(join(tmpdir(),'kinesis-flow-chrome-'));
 const child=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-allow-origins=*',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
 let socket;
 t.after(async()=>{socket?.close();const exited=child.exitCode===null && child.signalCode===null?once(child,'exit'):Promise.resolve();child.kill('SIGTERM');await exited;rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 for(let i=0;i<200;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}await delay(50);}
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
 let sequence=0;const pending=new Map();
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
 const wait=async(expr)=>{for(let i=0;i<300;i++){try{if(await evaluate(expr))return;}catch{}await delay(50);}const state=await evaluate("JSON.stringify({formHidden:document.getElementById('cycleModal')?.classList.contains('hidden'),formError:document.getElementById('cycleFormError')?.textContent,modalHidden:document.getElementById('cyclePlanningModal')?.hidden,cycle:document.getElementById('cyclePlanningModal')?.dataset.cycleId,status:document.getElementById('cyclePlanningStatus')?.textContent,error:document.getElementById('cyclePlanningError')?.textContent,generateDisabled:document.getElementById('cyclePlanningGenerate')?.disabled})");throw Error('Timed out: '+expr+' '+state);};
 const key=async(key,code,value,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:value,modifiers});};
 const capture=async(name)=>{await delay(300);const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(tmpdir(),`kinesis-flow-${name}.png`),Buffer.from(r.data,'base64'));};
 async function intercept(pattern) {
  let resolve;const next=new Promise(r=>resolve=r);
  const listener=e=>{const m=JSON.parse(e.data);if(m.method==='Fetch.requestPaused')resolve(m.params);};
  socket.addEventListener('message',listener);
  await command('Fetch.enable',{patterns:[{urlPattern:pattern,requestStage:'Response'}]});
  return {next,async release(params){await command('Fetch.continueResponse',{requestId:params.requestId});await this.close();},async close(){await command('Fetch.disable');socket.removeEventListener('message',listener);}};
 }
 await command('Page.enable');await command('Network.enable');
 await command('Network.setBlockedURLs',{urls:['*unpkg.com*','*fonts.googleapis.com*','*fonts.gstatic.com*']});
 if(process.env.KINESIS_TEST_LUCIDE_FILE)await command('Page.addScriptToEvaluateOnNewDocument',{source:readFileSync(process.env.KINESIS_TEST_LUCIDE_FILE,'utf8')});
 return {command,evaluate,wait,key,capture,intercept,socket};
}
module.exports={launchChrome};
