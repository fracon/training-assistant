'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { buildServer } = require('../src/server');
const { createSession, SESSION_COOKIE_NAME } = require('../src/auth/sessions');
const { migrateRecords, readRecords, saveRecord, deleteRecord, captureAnamnesisRecords, syncAnamnesisRecords, recordsContext } = require('../src/personal-records');
const { saveAnamnesis, readAnamnesis, deleteAnamnesis, anamnesisContext } = require('../src/anamnesis');
const { buildContext, contextIsCurrent, appliedPlanIsCurrent } = require('../src/ai/context');
const { readAiConfig } = require('../src/ai/config');
const { buildPayload } = require('../src/ai/client');
function setup(t) {
  const db = createDatabase({ filename: ':memory:' });
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,email,password_hash,first_name) VALUES (1,'a@example.test','unused','A'),(2,'b@example.test','unused','B')").run();
  return db;
}
const race = (distance='5k', time=1500, year=2024) => ({ distance, ...(distance === 'other' ? {distance_km:15} : {}), time_seconds: time, year });
const answer = (value) => ({ status: 'answered', value });
function anam(db, value, user=1) {
  return saveAnamnesis(db, user, { expected_revision: readAnamnesis(db,user).anamnesis.revision, answers: { race_results: answer(value) } }).anamnesis;
}
const best = (db, user=1, index=0) => readRecords(db,user).records[index].best;
function session(db, distance, time, date='2026-01-01', user=1, source='manual') {
  return Number(db.prepare(`INSERT INTO trainings(user_id,dia,tipo,result_data_source,fit_distance,fit_duration)
    VALUES (?,?,'Corrida',?,?,?)`).run(user,date,source,distance,time).lastInsertRowid);
}

test('manual records validate strict bodies, dates, seconds and names and remain owner scoped', (t) => {
  const db=setup(t);
  for (const body of [null,[],{},'bad',{time_seconds:1,role:'admin'}])
    assert.throws(()=>saveRecord(db,1,'5k',body), /invalidRecord|invalidTime/);
  for (const time of [0,1,59,-1,1.5,'100',604801,Infinity]) assert.throws(()=>saveRecord(db,1,'5k',{time_seconds:time}), /invalidTime/);
  for (const date of [5,'bad','9999-01-01','2026-02-30','1950-00-01','1949-12-31','2026-99-01'])
    assert.throws(()=>saveRecord(db,1,'5k',{time_seconds:1500,achieved_on:date}), /invalidDate/);
  for (const name of [5,'x'.repeat(121)]) assert.throws(()=>saveRecord(db,1,'5k',{time_seconds:1500,race_name:name}), /invalidRaceName/);
  assert.throws(()=>saveRecord(db,1,'other',{}), /invalidDistance/);
  assert.throws(()=>deleteRecord(db,1,'other'), /invalidDistance/);
  saveRecord(db,1,'5k',{time_seconds:1500});
  assert.equal(best(db).achieved_on,null);
  assert.equal(best(db).race_name,null);
  saveRecord(db,1,'5k',{time_seconds:1400,achieved_on:'2024-02-29',race_name:'  Synthetic  '});
  assert.equal(best(db).time_seconds,1400);
  assert.equal(best(db).race_name,'Synthetic');
  assert.equal(best(db).year,2024);
  saveRecord(db,1,'10k',{time_seconds:3000,race_name:'   '});
  assert.equal(readRecords(db,1).records[1].manual.race_name,null);
  assert.equal(best(db,2),null);
  deleteRecord(db,2,'5k');
  assert.equal(best(db).time_seconds,1400);
  deleteRecord(db,1,'5k');
  assert.equal(best(db),null);
  deleteRecord(db,1,'5k');
  db.prepare('DELETE FROM users WHERE id=1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_records').get().n,0);
});

test('existing results match only proven whole distances with bounded tolerance; no extrapolation or future candidates', (t) => {
  const db=setup(t);
  for (const [km,time] of [[4.99,'18:00'],[5.101,'17:00'],[10,'0:00'],[5,'bad'],[5,''],[5,null],[5,'0:99'],[5,'1'],[5,'-1:00'],[5,'1:00:99'],[5,'1000:00:00'],[5,'9'.repeat(400)+':00']]) session(db,km,time);
  session(db,5,'10:00','2099-01-01');
  session(db,5,'11:00','2025-01-01',2);
  session(db,5,'12:00','2025-01-01',1,'none');
  assert.equal(best(db),null);
  const id=session(db,5.05,'0:25:10');
  assert.equal(best(db).time_seconds,1510);
  assert.equal(best(db).training_id,id);
  assert.equal(best(db).origin,'session');
  session(db,10.1,'0:50:00');
  assert.equal(readRecords(db,1).records[1].best.time_seconds,3000);
  session(db,21.098,'1:50:00'); session(db,42.195,'4:00:00');
  assert.ok(readRecords(db,1).records.every(row=>row.best));
  saveRecord(db,1,'5k',{time_seconds:1600});
  assert.equal(best(db).origin,'session');
  assert.equal(readRecords(db,1).records[0].manual.time_seconds,1600);
  saveRecord(db,1,'5k',{time_seconds:1400});
  assert.equal(best(db).origin,'manual');
});

test('manual declarations replace anamnesis values without reviving corrected values on removal', (t) => {
  const db=setup(t);
  syncAnamnesisRecords(db,1);
  anam(db,[race(),race('other',2000)]);
  assert.equal(best(db).origin,'anamnesis');
  assert.equal(best(db).achieved_on,null);
  assert.equal(best(db).year,2024);
  const before=readAnamnesis(db,1).anamnesis;
  saveRecord(db,1,'5k',{time_seconds:1400});
  let current=readAnamnesis(db,1).anamnesis;
  assert.equal(current.answers.race_results.value[0].time_seconds,1400);
  assert.equal(current.answers.race_results.value[0].year,2024);
  assert.ok(current.revision>before.revision);
  assert.throws(()=>saveAnamnesis(db,1,{expected_revision:before.revision,answers:{race_results:answer([])}}),/changed in another session/);
  assert.equal(current.status,'draft');
  anam(db,current.answers.race_results.value.map(r=>r.distance === 'other' ? r : (({distance_km,...rest})=>rest)(r)));
  deleteRecord(db,1,'5k');
  assert.equal(best(db),null);
  const races=readAnamnesis(db,1).anamnesis.answers.race_results.value;
  assert.equal(races.some(r=>r.distance==='5k'),false);
  assert.ok(races.some(r=>r.distance==='other'));
  saveRecord(db,1,'10k',{time_seconds:3000,achieved_on:'2025-01-01'});
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value.find(r=>r.distance==='10k').year,2025);
  const rev=readAnamnesis(db,1).anamnesis.revision;
  syncAnamnesisRecords(db,1); assert.equal(readAnamnesis(db,1).anamnesis.revision,rev);
  deleteRecord(db,1,'10k');
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value.some(r=>r.distance==='10k'),false);
  // An explicit edit is a new self-report; an unchanged automatic field is not.
  saveRecord(db,1,'5k',{time_seconds:1400});
  anam(db,[race('5k',1300),race('10k',3200)]);
  assert.equal(best(db).origin,'manual');
  deleteRecord(db,1,'5k'); assert.equal(best(db),null);
  deleteAnamnesis(db,1); assert.equal(best(db),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM anamnesis_record_sources').get().n,0);
  saveRecord(db,1,'5k',{time_seconds:1200});
  saveAnamnesis(db,1,{expected_revision:0,answers:{birth_year:{status:'declined'}}});
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results,undefined);
  saveAnamnesis(db,1,{expected_revision:1,answers:{race_results:null}});
  captureAnamnesisRecords(db,1,{status:'declined'});
  syncAnamnesisRecords(db,1);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results,undefined);
});

test('migration seeds existing anamnesis, compares historical sessions, preserves data and is idempotent', (t) => {
  const db=setup(t);
  anam(db,[race()]); session(db,5,'20:00');
  db.exec('DROP TABLE personal_records; DROP TABLE anamnesis_record_sources;');
  db.prepare("DELETE FROM schema_migrations WHERE name='2026-11-personal-records-v1'").run();
  migrateRecords(db);
  assert.equal(best(db).time_seconds,1200);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1200);
  const revision=readAnamnesis(db,1).anamnesis.revision;
  migrateRecords(db); assert.equal(readAnamnesis(db,1).anamnesis.revision,revision);
  db.prepare('DELETE FROM trainings').run(); syncAnamnesisRecords(db,1);
  assert.equal(best(db).time_seconds,1500);
});

test('cycle contexts record personal records and their freshness without invalidating legacy plans or calling AI', (t) => {
  const db=setup(t);
  const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic'});
  db.prepare("INSERT INTO training_cycles(id,user_id,status,objective,target_date) VALUES ('c',1,'active','Synthetic','2026-12-31')").run();
  const ctx=(extra={})=>buildContext(db,1,{purpose:'cycle',resourceId:'c',config,...extra});
  const legacy=ctx({includeRecords:false});
  const empty=ctx();
  assert.equal(contextIsCurrent(db,1,empty,config),true);
  saveRecord(db,1,'5k',{time_seconds:1500});
  assert.equal(contextIsCurrent(db,1,empty,config),false);
  assert.equal(contextIsCurrent(db,1,legacy,config),true);
  assert.equal(appliedPlanIsCurrent(db,1,'c',JSON.stringify(legacy.sources)),true);
  assert.equal(appliedPlanIsCurrent(db,1,'c',JSON.stringify(empty.sources)),false);
  const current=ctx();
  assert.equal(current.personalRecords[0].achievedOn,'not_informed');
  assert.equal(appliedPlanIsCurrent(db,1,'c',JSON.stringify(current.sources)),true);
  assert.deepEqual(recordsContext(db,2).records,[]);
  const payload=buildPayload({model:'synthetic',context:current,prompt:'synthetic',adapter:{instructions:'synthetic',adaptPrompt:p=>p,format:{}},maxOutputTokens:100});
  assert.match(payload.instructions,/historical performance/);
  deleteRecord(db,1,'5k');
  assert.equal(contextIsCurrent(db,1,current,config),false);
});

test('records API gates pages, authenticates, scopes data and synchronizes manual results, dates and deletion atomically', async (t) => {
  const db=setup(t);
  const app=await buildServer({db,sessionCookieSecure:false});
  t.after(()=>app.close());
  const cookie=(user)=>`${SESSION_COOKIE_NAME}=${createSession(db,user).token}`;
  const headers={cookie:cookie(1)};
  assert.equal((await app.inject({url:'/api/records'})).statusCode,401);
  assert.equal((await app.inject({url:'/records.html'})).statusCode,302);
  assert.equal((await app.inject({url:'/records.html',headers})).headers.location,'/anamnesis.html');
  anam(db,[race()]);
  db.prepare("UPDATE athlete_anamnesis SET status='completed',completed_at='2026-01-01T00:00:00Z' WHERE user_id=1").run();
  assert.equal((await app.inject({url:'/records.html',headers})).statusCode,200);
  const call=(method,url,payload,h=headers)=>app.inject({method,url,headers:h,payload});
  const read=await call('GET','/api/records');
  assert.equal(read.headers['cache-control'],'no-store');
  assert.equal(read.json().records[0].best.origin,'anamnesis');
  assert.equal((await call('PUT','/api/records/5k',{time_seconds:1400})).statusCode,200);
  assert.equal((await call('PUT','/api/records/5k',{time_seconds:0})).statusCode,400);
  assert.equal((await call('GET','/api/records',undefined,{cookie:cookie(2)})).json().records[0].best,null);
  const id=session(db,5,'25:00');
  assert.equal((await call('PUT',`/api/trainings/${id}/manual-results`,{distance_km:5,duration_seconds:1200,feedback_rpe:3})).statusCode,200);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1200);
  assert.equal((await call('PATCH',`/api/trainings/${id}/reschedule`,{date:'2025-03-01'})).statusCode,200);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].year,2025);
  assert.equal((await call('DELETE',`/api/trainings/${id}`)).statusCode,200);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1400);
  assert.equal((await call('DELETE','/api/records/5k')).statusCode,200);
  assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value.some(r=>r.distance==='5k'),false);
  assert.ok(anamnesisContext(db,1).projection.experience.raceResults);
});

test('malformed and non-running FIT summaries are excluded and unchanged derived answers never become self reports', (t)=>{
 const db=setup(t);
 for(const summary of ['invalid','{}','{"activity":{}}','{"activity":{"sport":"cycling"}}','{"activity":{"sport":"running"}}']) {
  const id=session(db,5,'25:00');
  db.prepare('UPDATE trainings SET fit_summary_json=? WHERE id=?').run(summary,id);
 }
 assert.equal(best(db).time_seconds,1500);
 anam(db,[]);
 captureAnamnesisRecords(db,1,undefined);
 captureAnamnesisRecords(db,1,answer([]),answer([]));
 captureAnamnesisRecords(db,1,{status:'declined'});
 captureAnamnesisRecords(db,1,answer([]),answer([]));
 syncAnamnesisRecords(db,1);
});

test('a result correction reverts the copied record, and a failed synchronization rolls the entire manual write back', (t)=>{
 const db=setup(t);
 anam(db,[race()]);
 const id=session(db,5,'20:00'); syncAnamnesisRecords(db,1);
 assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1200);
 db.prepare("UPDATE trainings SET fit_duration='30:00' WHERE id=?").run(id); syncAnamnesisRecords(db,1);
 assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1500);
 db.exec("CREATE TEMP TRIGGER reject_record_sync BEFORE UPDATE ON athlete_anamnesis BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.throws(()=>saveRecord(db,1,'5k',{time_seconds:1300}),/synthetic failure/);
 assert.equal(readRecords(db,1).records[0].manual,null);
 assert.equal(best(db).time_seconds,1500);
});

test('FIT upload updates the anamnesis in the result transaction and refusal leaves both unchanged', async(t)=>{
 const db=setup(t);
 anam(db,[race()]);
 const id=session(db,5,'30:00');
 const app=await buildServer({db,sessionCookieSecure:false,parseFitFile:async()=>({activity:{sport:'running'},totals:{durationSeconds:1200,distanceKm:5},laps:[]})});
 t.after(()=>app.close());
 const boundary='records-test-boundary';
 const upload=(rpe)=>app.inject({method:'POST',url:`/api/trainings/${id}/fit`,headers:{cookie:`${SESSION_COOKIE_NAME}=${createSession(db,1).token}`,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.fit"\r\nContent-Type: application/octet-stream\r\n\r\nsynthetic\r\n--${boundary}\r\nContent-Disposition: form-data; name="confirm_replace_manual"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="feedback_rpe"\r\n\r\n${rpe}\r\n--${boundary}--\r\n`)});
 assert.equal((await upload('')).statusCode,400);
 assert.equal(best(db).time_seconds,1500);
 assert.equal((await upload('3')).statusCode,200);
 assert.equal(best(db).time_seconds,1200);
 assert.equal(readAnamnesis(db,1).anamnesis.answers.race_results.value[0].time_seconds,1200);
});


test('AI record projection never exposes a draft anamnesis and falls back to independent sources', (t)=>{
 const db=setup(t);
 anam(db,[race('5k',1200)]);
 assert.deepEqual(recordsContext(db,1).records,[]);
 saveRecord(db,1,'5k',{time_seconds:1400});
 assert.equal(best(db).time_seconds,1400);
 assert.equal(recordsContext(db,1).records[0].timeSeconds,1400);
 db.prepare("UPDATE athlete_anamnesis SET status='completed',completed_at='2026-01-01T00:00:00Z' WHERE user_id=1").run();
 assert.equal(recordsContext(db,1).records[0].timeSeconds,1400);
});


test('the questionnaire accepts a record without a year and bounds other-distance answers independently', (t)=>{
 const db=setup(t);
 anam(db,[{distance:'5k',time_seconds:60}]);
 assert.equal(best(db).year,null);
 assert.throws(()=>anam(db,Array(6).fill(race('other',2000))),/An answer is invalid/);
});


test('record synchronization preserves an existing year when date is absent and replaces it only with a supplied year', (t)=>{
 const db=setup(t);
 anam(db,[race('5k',1500,2024)]);
 const saved=()=>readAnamnesis(db,1).anamnesis;
 saveRecord(db,1,'5k',{time_seconds:1400});
 assert.equal(saved().answers.race_results.value[0].year,2024);
 assert.equal(saved().answers.race_results.value[0].time_seconds,1400);
 saveRecord(db,1,'5k',{time_seconds:1300,achieved_on:'2025-06-01'});
 assert.equal(saved().answers.race_results.value[0].year,2025);
 saveRecord(db,1,'5k',{time_seconds:1200,achieved_on:null});
 assert.equal(saved().answers.race_results.value[0].year,2025);
 assert.equal(saved().answers.race_results.value[0].time_seconds,1200);
 const revision=saved().revision;
 saveRecord(db,1,'5k',{time_seconds:1200});
 assert.equal(saved().revision,revision);
 // No year is invented for a distance with no previous answer.
 saveRecord(db,1,'10k',{time_seconds:3000});
 assert.equal(saved().answers.race_results.value.find(r=>r.distance==='10k').year,null);
 assert.equal(best(db).achieved_on,null);
 assert.equal(best(db).year,null, 'preserving the questionnaire does not fabricate a record date');
});


test('session improvements change context evidence but never the declared basis of an applied plan', (t)=>{
 const db=setup(t);
 const { anamnesisContext }=require('../src/anamnesis');
 const { projectContextForModel }=require('../src/ai/context');
 const { memoryOverview }=require('../src/ai/overview');
 const config=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'synthetic'});
 anam(db,[race(),race('other',3600)]);
 db.prepare("UPDATE athlete_anamnesis SET status='completed',completed_at='2026-01-01T00:00:00Z' WHERE user_id=1").run();
 db.prepare("INSERT INTO training_cycles(id,user_id,status,objective,target_date) VALUES ('c',1,'active','Synthetic','2026-12-31')").run();
 const ctx=()=>buildContext(db,1,{purpose:'cycle',resourceId:'c',config});
 const before=ctx(); const basis=anamnesisContext(db,1).basisVersion;
 const stamp=readAnamnesis(db,1).anamnesis.updated_at;
 const id=session(db,5,'20:00'); syncAnamnesisRecords(db,1);
 assert.equal(contextIsCurrent(db,1,before,config),false);
 assert.equal(appliedPlanIsCurrent(db,1,'c',JSON.stringify(before.sources)),true);
 assert.equal(anamnesisContext(db,1).basisVersion,basis);
 assert.equal(readAnamnesis(db,1).anamnesis.updated_at,stamp);
 const current=ctx();
 assert.equal(current.personalRecords[0].timeSeconds,1200);
 assert.deepEqual(projectContextForModel(current).anamnesis.experience.raceResults.map(r=>r.distance),['other']);
 assert.equal(projectContextForModel(current).anamnesis.experience.raceResults[0].distanceKm,15);
 assert.equal(current.anamnesis.experience.raceResults[0].timeSeconds,1200, 'projection never changes protected snapshots');
 assert.deepEqual(memoryOverview(db,1,config).personalRecords,current.personalRecords);
 assert.equal(memoryOverview(db,1,config,null,{purpose:'workouts'}).personalRecords,null);
 saveRecord(db,1,'5k',{time_seconds:1400});
 assert.equal(appliedPlanIsCurrent(db,1,'c',JSON.stringify(current.sources)),false,'a declared mark changes the basis even if a session remains faster');
 db.prepare('DELETE FROM trainings WHERE id=?').run(id); syncAnamnesisRecords(db,1);
 assert.equal(best(db).time_seconds,1400);
});

test('GPS allowance accepts 10.15 km using the actual full time and rejects distances beyond two percent', (t)=>{
 const db=setup(t);
 session(db,10.201,'40:00'); assert.equal(readRecords(db,1).records[1].best,null);
 session(db,10.15,'45:00'); assert.equal(readRecords(db,1).records[1].best.time_seconds,2700);
});

test('a questionnaire with no original race answer has no fabricated race basis', (t)=>{
 const db=setup(t); anam(db,[]);
 db.prepare("UPDATE athlete_anamnesis SET status='completed',completed_at='2026-01-01T00:00:00Z' WHERE user_id=1").run();
 captureAnamnesisRecords(db,1,undefined);
 assert.ok(anamnesisContext(db,1).basisVersion);
});

test('editing feedback does not scan result history or touch questionnaire timestamps/revision', async(t)=>{
 const db=setup(t); anam(db,[race()]); const id=session(db,5,'20:00'); syncAnamnesisRecords(db,1);
 const before=readAnamnesis(db,1).anamnesis;
 const app=await buildServer({db,sessionCookieSecure:false}); t.after(()=>app.close());
 const cookie=`${SESSION_COOKIE_NAME}=${createSession(db,1).token}`;
 const prepare=db.prepare.bind(db);
 db.prepare=(sql)=>{ assert.equal(sql.includes("result_data_source IN ('manual','fit_upload','garmin_connect')"),false,'feedback must not select all results'); return prepare(sql); };
 const response=await app.inject({method:'PATCH',url:`/api/trainings/${id}`,headers:{cookie},payload:{feedback_notas:'Synthetic note'}});
 db.prepare=prepare;
 assert.equal(response.statusCode,200);
 const after=readAnamnesis(db,1).anamnesis;
 assert.equal(after.revision,before.revision); assert.equal(after.updated_at,before.updated_at);
});


test('slower manual correction replaces the declaration; sessions compete and removal never revives the old answer', (t)=>{
 const db=setup(t); anam(db,[race('5k',1500,2024),race('other',4000)]);
 anam(db,[race('5k',1200,2023)],2);
 const otherBefore=readAnamnesis(db,2).anamnesis;
 const before=readAnamnesis(db,1).anamnesis;
 saveRecord(db,1,'5k',{time_seconds:1620});
 const read=()=>readAnamnesis(db,1).anamnesis;
 const mark=()=>read().answers.race_results.value.find(r=>r.distance==='5k');
 assert.equal(best(db).time_seconds,1620); assert.equal(best(db).origin,'manual');
 assert.equal(mark().time_seconds,1620); assert.equal(mark().year,2024);
 assert.equal(read().status,'draft'); assert.ok(read().revision>before.revision);
 assert.equal(read().updated_at,before.updated_at);
 assert.equal(read().answers.race_results.value.find(r=>r.distance==='other').time_seconds,4000);
 const original=()=>JSON.parse(db.prepare('SELECT answer_json FROM anamnesis_record_sources WHERE user_id=1').get().answer_json);
 assert.equal(original().value.find(r=>r.distance==='5k').time_seconds,1620);
 assert.throws(()=>saveAnamnesis(db,1,{expected_revision:before.revision,answers:{race_results:answer([])}}),/changed in another session/);
 const id=session(db,5,'26:00'); syncAnamnesisRecords(db,1);
 assert.equal(best(db).origin,'session'); assert.equal(mark().time_seconds,1560);
 deleteRecord(db,1,'5k'); assert.equal(mark().time_seconds,1560);
 assert.equal(original().value.some(r=>r.distance==='5k'),false);
 db.prepare('DELETE FROM trainings WHERE id=?').run(id); syncAnamnesisRecords(db,1);
 assert.equal(best(db),null); assert.equal(mark(),undefined);
 assert.deepEqual(readAnamnesis(db,2).anamnesis,otherBefore);
 // Idempotent removal without a manual must not erase an independent anamnesis answer.
 anam(db,[race('10k',3000)]); deleteRecord(db,1,'10k');
 assert.equal(readRecords(db,1).records[1].best.time_seconds,3000);
});
