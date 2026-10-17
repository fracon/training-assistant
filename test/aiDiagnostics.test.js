'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createResponsesClient}=require('../src/ai/client');
const {fixture,planFor,complete}=require('./fixtures/ai/cycle-planning.cjs');
const {createExecutionService}=require('../src/ai/executions');const {readAiConfig}=require('../src/ai/config');const {createCyclePlanAdapter}=require('../src/ai/cycle-plan-adapter');
function client(raw,status=200,headers={}) {return createResponsesClient({apiKey:'synthetic-secret',timeoutMs:1000,fetchImpl:async()=>new Response(JSON.stringify(raw),{status,headers})});}
const exhausted={id:'resp_synthetic',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:7929,output_tokens:2048,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:2048}},output:[{type:'reasoning',summary:[]}]};
test('reproduced reasoning-only response exhaustion preserves known usage and identifies output limit without parsing partial content',async()=>{
 const result=await client(exhausted,200,{'x-request-id':'req_synthetic'})({},{clientRequestId:'kin_00000000-0000-0000-0000-000000000001_1'});
 assert.equal(result.error,'providerOutputLimit');assert.equal(result.value,null);assert.deepEqual(result.usage,{input:7929,output:2048,cached:0});
 assert.equal(result.diagnostic.timeoutMs,1000);assert.equal(result.diagnostic.incompleteReason,'max_output_tokens');assert.equal(result.diagnostic.reasoningTokens,2048);assert.equal(result.diagnostic.outputTextCount,0);assert.equal(result.diagnostic.requestId,'req_synthetic');
});

test('transport, HTTP, filtering, refusal, provider failure and malformed output retain only safe metadata',async()=>{
 const correlation={clientRequestId:'kin_00000000-0000-0000-0000-000000000001_1'};
 const success={...exhausted,status:'completed',incomplete_details:null,output:[null,{type:'message',content:[null,{type:'output_text',text:'{"ok":true}'}]}]};
 for(const [raw,code] of [[success,null],[{...exhausted,incomplete_details:{reason:'content_filter'}},'providerContentFiltered'],[{...exhausted,incomplete_details:{reason:'private athlete value'}},'providerIncomplete'],[{...success,output:[{type:'message',content:[{type:'output_text',text:42}]}]},'providerInvalidResponse'],[{...success,status:'failed'},'providerFailed'],[{...success,status:'unexpected private value'},'providerInvalidResponse'],[{...success,output:[{type:'message',content:[{type:'refusal',refusal:'private value'}]}]},'providerRefused'],[{...success,output:[{type:'message',content:[{type:'output_text',text:'not json private value'}]}]},'providerInvalidResponse']]){
  const r=await client(raw,200,{'x-request-id':'req_test'} )({},correlation);assert.equal(r.error,code);assert.ok(!JSON.stringify(r.diagnostic).includes('private'));assert.equal(r.diagnostic.httpStatus,200);assert.equal(r.diagnostic.clientRequestId,correlation.clientRequestId);
 }
 for(const status of [400,401,403,429,500,408,409])await assert.rejects(client({error:{message:'private credential'}},status,{'x-request-id':'req_http'} )({},correlation),e=>{assert.equal(e.diagnostic.httpStatus,status);assert.equal(e.diagnostic.stage,'provider_http');assert.ok(!JSON.stringify(e.diagnostic).includes('private'));return true;});
 for(const raw of [null,[],1])await assert.rejects(client(raw)({}),e=>e.diagnostic.stage==='parsing');
 const transport=createResponsesClient({apiKey:'synthetic',timeoutMs:1000,fetchImpl:async()=>{throw Error('private transport message');}});await assert.rejects(transport({}),e=>e.diagnostic.stage==='transport' && !e.message.includes('private'));
 let header;const check=createResponsesClient({apiKey:'synthetic',timeoutMs:1000,fetchImpl:async(_,options)=>{header=options.headers['X-Client-Request-Id'];return new Response(JSON.stringify(success));}});await check({},correlation);assert.equal(header,correlation.clientRequestId);
});

test('closed diagnostic vocabulary rejects values, arbitrary paths, identifiers and unbounded text',()=>{
 const {sanitizeDiagnostic,saveDiagnostic}=require('../src/ai/diagnostics');
 assert.deepEqual(sanitizeDiagnostic(),{});
 for(const value of [-1,1.5,'private',null,{},1e100])assert.deepEqual(sanitizeDiagnostic({durationMs:value,httpStatus:value,requestId:value,validation:{code:'shape_type',path:value}}),{});
 for(const httpStatus of [99,600])assert.deepEqual(sanitizeDiagnostic({httpStatus}),{});
 for(const path of ['$.privateValue','x','x'.repeat(161)])assert.deepEqual(sanitizeDiagnostic({validation:{code:'shape_type',path}}),{});
 assert.deepEqual(sanitizeDiagnostic({validation:{code:'private',path:'$'}}),{});
 assert.deepEqual(sanitizeDiagnostic({validation:{code:'shape_type',path:'$.phases[0].rationale'},stage:'schema',code:'invalidDomainResponse',providerStatus:'completed',incompleteReason:'max_output_tokens',requestId:'bad',responseId:'resp_safe',headers:'private'}),{stage:'schema',code:'invalidDomainResponse',providerStatus:'completed',incompleteReason:'max_output_tokens',responseId:'resp_safe',validation:{code:'shape_type',path:'$.phases[0].rationale'}});
 const db=fixture();saveDiagnostic(db,'missing',1,{});db.close();
});

test('diagnostics migration preserves existing snapshots and is idempotent on marked and unmarked columns',async()=>{
 const {initializeDatabase}=require('../src/db/database');const {migrateAiDiagnostics}=require('../src/ai/schema');
 const db=fixture();const {service}=require('./fixtures/ai/cycle-planning.cjs').harness(db);
 const execution=service.enqueue(1,{purpose:'cycle',resource_id:'cycle',idempotency_key:'existing-snapshot'});await service.stop();
 const snapshot=db.prepare('SELECT * FROM ai_executions WHERE id=?').get(execution.id);
 db.exec("ALTER TABLE ai_executions DROP COLUMN diagnostics_json; DELETE FROM schema_migrations WHERE name='2026-10-ai-execution-diagnostics-v1'");
 initializeDatabase(db);assert.ok(db.pragma('table_info(ai_executions)').some(c=>c.name==='diagnostics_json'));
 assert.deepEqual(db.prepare('SELECT * FROM ai_executions WHERE id=?').get(execution.id),snapshot);
 const before=db.prepare('SELECT * FROM training_cycles').all();initializeDatabase(db);assert.deepEqual(db.prepare('SELECT * FROM training_cycles').all(),before);
 db.prepare("DELETE FROM schema_migrations WHERE name='2026-10-ai-execution-diagnostics-v1'").run();migrateAiDiagnostics(db);assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name='2026-10-ai-execution-diagnostics-v1'").get().n,1);service.stop();db.close();
});

function setupService(db,call,operations) {
 const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-key'});
 const adapter=createCyclePlanAdapter(db);
 const service=createExecutionService({db,config,operations:operations || {cycle:adapter},client:call});
 return {service,adapter,config};
}
const request={purpose:'cycle',resource_id:'cycle',idempotency_key:'diagnostic-generation'};

test('one persisted execution and known billed use survive output limit, idempotent replay and no implicit retry',async(t)=>{
 const db=fixture();let calls=0;const actual=client(exhausted,200,{'x-request-id':'req_budget'});
 const {service}=setupService(db,async(payload,metadata)=>{calls++;assert.equal(db.inTransaction,false);return actual(payload,metadata);});t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request);const r=await complete(service,row.id);assert.equal(r.state,'failed');assert.equal(r.error,'providerOutputLimit');assert.equal(service.enqueue(1,request).id,row.id);assert.equal(calls,1);
 const debug=service.get(1,row.id,true);assert.equal(debug.costBasis,'reported_usage_estimate');assert.equal(debug.attempts,1);assert.equal(debug.usage.output,2048);assert.equal(debug.estimatedCostUsd,0.070365);assert.equal(debug.diagnostics.length,1);assert.equal(debug.diagnostics[0].stage,'provider_response');assert.equal(debug.diagnostics[0].reasoningTokens,2048);assert.equal(r.diagnostics,undefined);assert.equal(db.prepare('SELECT plan_json FROM cycle_plan_proposals').get().plan_json,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM cycle_plan_versions').get().n,0);
 assert.throws(()=>service.get(2,row.id,true),/adminRequired/);
});

test('per-attempt correlation distinguishes authorized 429 retry from invalid, incomplete or uncertain outcomes',async(t)=>{
 for(const kind of ['retry','invalid','uncertain','filter']){
  const db=fixture();let calls=0;const {service}=setupService(db,async(payload,metadata)=>{calls++;if(kind==='retry' && calls===1)return client({},429,{'x-request-id':'req_rate'})(payload,metadata);if(kind==='uncertain')return createResponsesClient({apiKey:'synthetic',timeoutMs:1000,fetchImpl:async()=>{throw Error();}})(payload,metadata);if(kind==='filter')return client({...exhausted,incomplete_details:{reason:'content_filter'}})(payload,metadata);const context=JSON.parse(payload.input[0].content[0].text).context;return {value:kind==='invalid'?{}:planFor(context),usage:{input:10,output:20,cached:0},error:null};});
  const row=service.enqueue(1,request);await complete(service,row.id);const r=service.get(1,row.id,true);assert.equal(calls,kind==='retry'?2:1);assert.equal(r.diagnostics.length,calls);assert.equal(r.attempts,calls);
  if(kind==='retry'){assert.equal(r.state,'completed');assert.equal(r.diagnostics[0].httpStatus,429);assert.equal(r.diagnostics[0].code,'providerRateLimited');assert.notEqual(r.diagnostics[0].clientRequestId,r.diagnostics[1].clientRequestId);}
  if(kind==='invalid'){assert.equal(r.error,'invalidDomainResponse');assert.deepEqual(r.diagnostics[0].validation,{code:'shape_fields',path:'$'});assert.equal(r.diagnostics[0].stage,'schema');assert.deepEqual(r.usage,{input:10,output:20,cached:0});}
  if(kind==='uncertain'){assert.equal(r.state,'uncertain');assert.equal(r.estimatedCostUsd,r.reservedCostUsd);assert.equal(r.costBasis,'reserved_unknown_usage');assert.equal(r.usage,null);}
  await service.stop();db.close();
 }
});

test('proposal persistence failure rolls back output but retains actual usage and sanitized stage',async(t)=>{
 const db=fixture();const adapter=createCyclePlanAdapter(db);adapter.onCompleted=()=>{throw Error('private disk failure');};
 const {service}=setupService(db,async payload=>({value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:10,output:20,cached:0},error:null}),{cycle:adapter});t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request);await complete(service,row.id);const r=service.get(1,row.id,true);assert.equal(r.state,'failed');assert.equal(r.error,'resultPersistenceFailed');assert.equal(r.usage.output,20);assert.equal(r.diagnostics[0].stage,'persistence');assert.ok(!JSON.stringify(r.diagnostics).includes('private'));assert.equal(db.prepare('SELECT plan_json FROM cycle_plan_proposals').get().plan_json,null);
});

test('domain diagnostics identify only schema paths, dates, continuity and evidence without copying values',()=>{
 const {buildContext}=require('../src/ai/context');const {diagnosePlan,validatePlan,shapeIssue}=require('../src/ai/cycle-plan-schema');
 const db=fixture();const ctx=buildContext(db,1,{purpose:'cycle',resourceId:'cycle'});const good=planFor(ctx);
 for(const [mutate,expected] of [
  [p=>p.cycleId='private-id',{code:'cycle_identity',path:'$.cycleId'}],
  [p=>p.start='2090-01-01',{code:'window_start',path:'$.start'}],
  [p=>p.end='2090-01-01',{code:'window_end',path:'$.end'}],
  [p=>p.phases[0].start='bad',{code:'phase_date',path:'$.phases[0].start'}],
  [p=>p.phases[0].end='bad',{code:'phase_date',path:'$.phases[0].end'}],
  [p=>p.phases[0].start=p.end,{code:'phase_continuity',path:'$.phases[0].start'}],
  [p=>p.phases[0].end='2090-01-01',{code:'phase_interval',path:'$.phases[0].end'}],
  [p=>p.phases[0].evidence=['private-value'],{code:'phase_evidence',path:'$.phases[0].evidence'}],
  [p=>p.phases[0].end=p.start,{code:'phase_coverage',path:'$.phases'}],
  [p=>p.phases[0].objective=42,{code:'shape_type',path:'$.phases[0].objective'}],
  [p=>p.confidence='private-value',{code:'shape_enum',path:'$.confidence'}],
 ]){const p=structuredClone(good);mutate(p);const issue=diagnosePlan(p,ctx);assert.deepEqual(issue,expected);assert.equal(validatePlan(p,ctx),false);assert.ok(!JSON.stringify(issue).includes('private'));}
 assert.equal(diagnosePlan(good,ctx),null);assert.equal(validatePlan(good,{...ctx,sources:null}),false);assert.equal(diagnosePlan(good,{...ctx,resource:null}).code,'context_window');
 assert.deepEqual(shapeIssue([], {type:'object',required:[],properties:{}}),{code:'shape_type',path:'$'});
 assert.equal(shapeIssue(null,{type:'string',minLength:1,maxLength:10}).code,'shape_type');db.close();
});

test('diagnostic exceptions stay sanitized; metadata is bounded and reservation snapshots remain unchanged',async(t)=>{
 const db=fixture();const adapter=createCyclePlanAdapter(db);adapter.validate=()=>{throw Error('private validation message');};
 const {service}=setupService(db,async()=>({value:{},usage:null,error:null}),{cycle:adapter});t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request);await complete(service,row.id);const r=service.get(1,row.id,true);assert.deepEqual(r.diagnostics[0].validation,{code:'validator_exception',path:'$'});assert.equal(r.diagnostics[0].stage,'domain');
 const {saveDiagnostic}=require('../src/ai/diagnostics');for(let attempt=1;attempt<=5;attempt++)saveDiagnostic(db,row.id,attempt,{stage:'transport'});const after=service.get(1,row.id,true);assert.deepEqual(after.diagnostics.map(d=>d.attempt),[3,4,5]);assert.equal(after.externalPrompt,r.externalPrompt);assert.equal(after.payload.model,r.payload.model);assert.equal(after.configuration.timeoutMs,60000);
 await service.stop();
 const base={version:'synthetic',format:{},instructions:'synthetic',adaptPrompt:p=>p,validate:()=>false};
 const other=setupService(db,async()=>({value:{},usage:null,error:null}),{cycle:base}).service;t.after(()=>other.stop());const next=other.enqueue(1,{...request,idempotency_key:'generic-validator'});await complete(other,next.id);assert.equal(other.get(1,next.id).error,'invalidDomainResponse');assert.equal(other.get(1,next.id,true).diagnostics[0].validation.code,'domain_invalid');
});

test('actual abort deadline is distinguishable from network failure and never turns uncertainty into a retry',async(t)=>{
 const db=fixture();let calls=0;
 const timeout=createResponsesClient({apiKey:'synthetic-key',timeoutMs:1,fetchImpl:async()=>{calls++;await require('node:timers/promises').setTimeout(10);throw Error('private network exception');}});
 const {service}=setupService(db,timeout);t.after(async()=>{await service.stop();db.close();});const row=service.enqueue(1,request);await complete(service,row.id);
 const r=service.get(1,row.id,true);assert.equal(calls,1);assert.equal(r.error,'providerTimeout');assert.equal(r.state,'uncertain');assert.equal(r.diagnostics[0].transportReason,'timeout');assert.equal(r.usage,null);assert.equal(r.estimatedCostUsd,r.reservedCostUsd);assert.equal(r.attempts,1);
});

test('timeout while receiving an HTTP 200 body preserves request ID and unknown billed outcome',async()=>{
 const c=createResponsesClient({apiKey:'synthetic',timeoutMs:1,fetchImpl:async()=>({status:200,ok:true,headers:new Headers({'x-request-id':'req_body_timeout'}),text:async()=>{await require('node:timers/promises').setTimeout(10);throw Error('private body failure');}})});
 await assert.rejects(c({}),e=>e.code==='providerTimeout' && e.diagnostic.httpStatus===200 && e.diagnostic.requestId==='req_body_timeout' && e.diagnostic.transportReason==='timeout' && e.diagnostic.stage==='parsing');
});

test('admin cost basis distinguishes pending reservation, known unbilled HTTP rejection and usage estimates',async(t)=>{
 const db=fixture();const {service}=setupService(db,client({},400));t.after(async()=>{await service.stop();db.close();});
 const row=service.enqueue(1,request);assert.equal(service.get(1,row.id,true).costBasis,'reservation_pending');await complete(service,row.id);const r=service.get(1,row.id,true);assert.equal(r.costBasis,'known_unbilled');assert.equal(r.estimatedCostUsd,0);assert.equal(r.usage,null);assert.equal(service.get(1,row.id).costBasis,undefined);
});
