'use strict';
const {createDatabase}=require('../../../src/db/database');
const {readAiConfig}=require('../../../src/ai/config');
const {createExecutionService}=require('../../../src/ai/executions');
const {createCyclePlanAdapter}=require('../../../src/ai/cycle-plan-adapter');
const {phaseFields,planningWindow}=require('../../../src/ai/cycle-plan-schema');
const {setTimeout:delay}=require('node:timers/promises');
const today=new Date().toISOString().slice(0,10);
const future=(n)=>new Date(Date.parse(today)+n*86400000).toISOString().slice(0,10);
function fixture(){
 const db=createDatabase({filename:':memory:'});
 db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES (1,'planner@example.invalid','synthetic','admin'),(2,'other@example.invalid','synthetic','user')").run();
 db.prepare("INSERT INTO training_cycles(id,user_id,objective,status,start_date,target_date) VALUES ('cycle',1,'Synthetic race','active',?,?),('private',2,'Other race','active',?,?)").run(today,future(28),today,future(28));
 return db;
}
function planFor(context){
 const window=planningWindow(context);const explanation='Synthetic planning recommendation based on the available records; review adaptation.';
 return {schemaVersion:'cycle-plan-v1',cycleId:context.resource.id,...window,
 assessment:'No unsupported athlete traits are established.',continuity:'Available history only.',feasibility:'Uncertain without recorded history.',confidence:'insufficient_data',
 phases:[{...window,...Object.fromEntries(phaseFields.map(k=>[k,explanation])),evidence:context.sources.map(r=>`${r.type}:${r.id}`)}],
 indicators:['Recorded RPE','Dated discomfort','Completed volume','Long run duration','Recovery feedback'],
 adaptations:Object.fromEntries(['increase','maintain','reduce','replaceQuality','reduceLongRun'].map(k=>[k,explanation])),uncertainties:['No complete history.'],assumptions:[],questions:[]};
}
function harness(db,client){
 const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic-test-key'});
 const adapter=createCyclePlanAdapter(db);
 const service=createExecutionService({db,config,operations:{cycle:adapter},client:client || (async payload=>({value:planFor(JSON.parse(payload.input[0].content[0].text).context),usage:{input:200,output:300,cached:0},error:null}))});
 return {config,adapter,service};
}
async function complete(s,id){for(let i=0;i<600;i++){const r=s.get(1,id);if(!['running','queued'].includes(r.state))return r;await delay(5);}throw Error('not complete');}

module.exports={fixture,planFor,harness,complete,today,future};
