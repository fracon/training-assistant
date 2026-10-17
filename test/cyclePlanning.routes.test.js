'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildServer}=require('../src/server');const {createSession,SESSION_COOKIE_NAME}=require('../src/auth/sessions');
const {readAiConfig}=require('../src/ai/config');const {planFor,fixture}=require('./fixtures/ai/cycle-planning.cjs');
const {setTimeout:delay}=require('node:timers/promises');
test('production cycle adapter HTTP generation/poll/apply is scoped, atomic and unavailable gracefully',async(t)=>{
 const db=fixture();let calls=0;const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'});
 const app=await buildServer({db,sessionCookieSecure:false,aiConfig:config,aiClient:async(payload)=>{calls++;assert.equal(payload.store,false);assert.equal(payload.text.format.type,'json_schema');assert.equal(payload.tools.length,0);return {value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:40,output:100,cached:0},error:null};}});
 t.after(async()=>{await app.close();db.close();});
 const tokens=[null,createSession(db,1).token,createSession(db,2).token];
 const send=(method,url,payload,user=1)=>app.inject({method,url,payload,headers:user?{cookie:`${SESSION_COOKIE_NAME}=${tokens[user]}`}:{}});
 assert.equal((await send('GET','/api/cycles/cycle/planning',null,0)).statusCode,401);
 assert.equal((await send('GET','/api/cycles/private/planning')).statusCode,404);
 assert.equal((await send('GET','/api/cycles/cycle/planning',null,2)).statusCode,404);
 assert.equal((await send('POST','/api/ai/executions',{purpose:'analysis',resource_id:'cycle',idempotency_key:'wrong-purpose'})).statusCode,409);
 const response=await send('POST','/api/ai/executions',{purpose:'cycle',resource_id:'cycle',idempotency_key:'http-planning'});assert.equal(response.statusCode,202);const id=response.json().id;
 let overview;for(let i=0;i<100;i++){overview=(await send('GET','/api/cycles/cycle/planning')).json();if(overview.proposals[0]?.execution.state==='completed')break;await delay(10);}
 assert.equal(overview.applied,null);assert.equal(overview.proposals[0].execution.response.cycleId,'cycle');
 assert.equal(overview.proposals[0].execution.payload,undefined);
 assert.equal((await send('GET',`/api/ai/admin/executions/${id}`,null,2)).statusCode,403);
 const results=await Promise.all([send('POST',`/api/cycles/cycle/planning/${id}/apply`,{expected_version:0}),send('POST',`/api/cycles/cycle/planning/${id}/apply`,{expected_version:0})]);
 assert.deepEqual(results.map(r=>r.statusCode),[200,200]);assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,1);
 assert.equal((await send('GET','/api/cycles/cycle/planning')).json().applied.version,1);
 assert.equal((await send('GET','/api/ai/admin/executions/'+id)).json().payload.store,false);
 assert.equal(calls,1);
 db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();assert.equal((await send('GET','/api/cycles/cycle/planning')).statusCode,401);
});
test('no key leaves manual registration usable and reports generation unavailability',async(t)=>{
 const db=fixture();const app=await buildServer({db,sessionCookieSecure:false,aiConfig:readAiConfig({})});t.after(async()=>{await app.close();db.close();});
 const cookie=`${SESSION_COOKIE_NAME}=${createSession(db,1).token}`;
 const get=await app.inject({method:'GET',url:'/api/cycles/cycle/planning',headers:{cookie}});assert.equal(get.json().available,false);
 assert.equal((await app.inject({method:'POST',url:'/api/ai/executions',headers:{cookie},payload:{purpose:'cycle',resource_id:'cycle',idempotency_key:'disabled-plan'}})).statusCode,503);
 assert.equal((await app.inject({method:'PUT',url:'/api/cycles/cycle',headers:{cookie},payload:{primary_goal:'Still editable'}})).statusCode,200);
});
