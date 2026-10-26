'use strict';
// Deliberately closed vocabulary. No provider message, response text or athlete value.
const STAGES=['transport','provider_http','provider_response','parsing','schema','domain','persistence','sources','lifecycle','completed'];
const CODES=['providerOutcomeUncertain','providerTimeout','providerRejected','providerRateLimited','providerIncomplete','providerOutputLimit','providerContentFiltered','providerRefused','providerInvalidResponse','providerFailed','invalidDomainResponse','planningRpeIncompatible','resultPersistenceFailed','sourceChanged','completed','restartOutcomeUncertain','reservationExpired','aiUnavailable','accountUnavailable','adapterUnavailable'];
const VALIDATION=['shape_type','shape_fields','shape_length','shape_enum','cycle_identity','window_start','window_end','phase_date','phase_continuity','phase_interval','phase_evidence','phase_coverage','context_window','validator_exception','domain_invalid','rpe_scale','shape','week','session_date','availability','prescription_required','prescription_invalid','prescription_guidance','text_length','unit','rpe','prescription_pace_target','prescription_units','prescription_value','prescription_recovery','incompatible_rpe','session_kind','duration','shoe','location','required','evidence','daily_budget','weather_evidence','analysis_text','analysis_technical_reference','analysis_evidence','analysis_version','analysis_language','analysis_shape','analysis_classification','analysis_interpretation','analysis_rpe_scale'];
const PATH=/^\$(?:\.(?:schemaVersion|language|summary|comparison|contextualReading|attention|recommendations|classification|limitations|reusableInterpretations|text|kind|value|cycleId|start|end|assessment|continuity|feasibility|confidence|phases|indicators|adaptations|uncertainties|assumptions|questions|name|objective|volume|longRuns|quality|intensity|easyRuns|strength|risks|advanceCriteria|rationale|evidence|increase|maintain|reduce|replaceQuality|reduceLongRun|weekStart|sessions|date|weekday|period|sessionKind|prescription|shoeId|location|justification|weather|notes|targetHr|rpe)|\[\d{1,3}\])*$/;
function sanitizeDiagnostic(value={}) {
 const out={};
 for(const [key,allowed] of Object.entries({stage:STAGES,code:CODES,providerStatus:['completed','incomplete','failed','cancelled','queued','in_progress'],incompleteReason:['max_output_tokens','content_filter'],transportReason:['timeout','network'],retryDisposition:['scheduled','attempt_limit','outside_window']})) if(allowed.includes(value[key]))out[key]=value[key];
 for(const key of ['attempt','durationMs','timeoutMs','reasoningTokens','outputTextCount','outputTextBytes'])if(Number.isSafeInteger(value[key]) && value[key]>=0)out[key]=value[key];
 if(Number.isSafeInteger(value.retryDelayMs) && value.retryDelayMs>=0 && value.retryDelayMs<=60000)out.retryDelayMs=value.retryDelayMs;
 if(Number.isInteger(value.httpStatus) && value.httpStatus>=100 && value.httpStatus<=599)out.httpStatus=value.httpStatus;
 for(const [key,pattern] of [['requestId',/^req_[A-Za-z0-9_-]{1,192}$/],['responseId',/^resp_[A-Za-z0-9_-]{1,192}$/],['clientRequestId',/^kin_[a-f\d-]{36}_[1-3]$/]])if(typeof value[key]==='string' && pattern.test(value[key]))out[key]=value[key];
 if(VALIDATION.includes(value.validation?.code) && typeof value.validation.path==='string' && value.validation.path.length<=160 && PATH.test(value.validation.path))out.validation={code:value.validation.code,path:value.validation.path};
 return out;
}
function saveDiagnostic(db,id,attempt,diagnostic) {
 const row=db.prepare('SELECT diagnostics_json FROM ai_executions WHERE id=?').get(id);
 if(!row)return;
 const entries=JSON.parse(row.diagnostics_json);
 const entry=sanitizeDiagnostic({...diagnostic,attempt});
 const index=entries.findIndex(item=>item.attempt===attempt);
 if(index<0)entries.push(entry);else entries[index]={...entries[index],...entry};
 db.prepare('UPDATE ai_executions SET diagnostics_json=? WHERE id=?').run(JSON.stringify(entries.slice(-3)),id);
}
module.exports={sanitizeDiagnostic,saveDiagnostic};
