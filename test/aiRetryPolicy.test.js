'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {RETRY_WINDOW_MS,parseRetryAfter,retryDelayMs}=require('../src/ai/retry-policy');

test('Retry-After accepts seconds and HTTP dates and rejects values outside the recovery window',()=>{
 const now=Date.parse('2026-10-24T12:00:00Z');
 assert.equal(parseRetryAfter('12',now),12000);
 assert.equal(parseRetryAfter('Sat, 24 Oct 2026 12:00:05 GMT',now),5000);
 assert.equal(parseRetryAfter('Saturday, 24-Oct-26 12:00:05 GMT',now),5000);
 assert.equal(parseRetryAfter('Sat Oct 24 12:00:05 2026',now),5000);
 assert.equal(parseRetryAfter('Sat, 24 Oct 2026 11:59:55 GMT',now),0);
 assert.equal(parseRetryAfter('61',now),RETRY_WINDOW_MS+1);
 assert.equal(parseRetryAfter('9007199254740992',now),RETRY_WINDOW_MS+1);
 for(const value of [null,undefined,'','tomorrow','1.5','Fri, 24 Oct 2026 12:00:05 GMT','Sat, 31 Feb 2026 12:00:05 GMT','Sat, 24 Oct 2026 99:00:05 GMT'])assert.equal(parseRetryAfter(value,now),null);
});

test('retry delay honors valid server windows and applies bounded deterministic jitter otherwise',()=>{
 assert.deepEqual(retryDelayMs({retryAfterMs:0,attempt:1}),{delayMs:1000,disposition:'scheduled'});
 assert.deepEqual(retryDelayMs({retryAfterMs:9000,attempt:1}),{delayMs:9000,disposition:'scheduled'});
 assert.deepEqual(retryDelayMs({retryAfterMs:RETRY_WINDOW_MS+1,attempt:1}),{delayMs:null,disposition:'outside_window'});
 assert.deepEqual(retryDelayMs({retryAfterMs:null,attempt:1,random:()=>0}),{delayMs:1000,disposition:'scheduled'});
 assert.deepEqual(retryDelayMs({retryAfterMs:undefined,attempt:3,random:()=>0.5}),{delayMs:4000,disposition:'scheduled'});
 assert.deepEqual(retryDelayMs({retryAfterMs:undefined,attempt:20,random:()=>0.999}),{delayMs:30000,disposition:'scheduled'});
});
