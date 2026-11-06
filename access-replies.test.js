'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nextGuidedTurn}=require('./manager-calls');
const p=()=>({first_name:'Test',lead_id:'synthetic',script:{script_text:''}});
test('natural readiness replies advance the pending email task and then the login task',()=>{for(const words of ["I'm ready.","Um, I'm in.","I'm done.",'All set.','Ready.','Good to go.','Ready to go.',"I'm ready now.",'Ready when you are.',"I'm all set.",'Done.',"I'm finished.","It’s open."]){assert.equal(nextGuidedTurn('email_search',words,p()).stage,'email_login',words);assert.equal(nextGuidedTurn('email_login',words,p()).stage,'section_status',words);}});
test('waiting, future action, negation and thanks are not mistaken for completion',()=>{for(const words of ["I'm not ready.","I'm going to sign in.",'Let me find it.'])assert.notEqual(nextGuidedTurn('email_search',words,p()).stage,'email_login',words);for(const words of ['Thank you.','Thanks.']){const t=nextGuidedTurn('email_search',words,p());assert.equal(t.hold,true);assert.equal(t.clarification,undefined);}});
