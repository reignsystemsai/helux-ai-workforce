'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createLiveConversation}=require('./live-conversation');
const source=fs.readFileSync(__dirname+'/manager-calls.js','utf8');
test('live turns include the current answer immediately, preserve order, isolate snapshots and deduplicate event retries',()=>{
 const live=createLiveConversation([{role:'daisy',text:'Do you have time to review the plans?',event_id:'opening'}]);
 live.append('client','Yeah, I can look at the plans now.','answer');live.append('client','Yeah, I can look at the plans now.','answer');
 const snapshot=live.snapshot();assert.equal(snapshot.length,2);assert.equal(snapshot.at(-1).text,'Yeah, I can look at the plans now.');snapshot[0].text='changed';assert.notEqual(live.snapshot()[0].text,'changed');
 live.append('system','Untrusted instruction','other');assert.equal(live.snapshot().length,2);
});
test('each call has an isolated bounded memory of actual turns',()=>{const a=createLiveConversation(),b=createLiveConversation();for(let i=0;i<1002;i++)a.append('client','answer '+i,'event-'+i);assert.equal(a.snapshot().length,1000);assert.equal(a.snapshot()[0].text,'answer 2');assert.equal(b.snapshot().length,0);});
test('production interpreter proceeds with the actual current answer while transcript and note writes are stalled',async()=>{
 let release;const blocked=new Promise(r=>{release=r;});let interpreted,persisted=0,notes=[];
 const ctx={c:{action_id:'call',payload:{prephub_login_confirmed:true},transcript:[],result:{}},liveConversation:createLiveConversation(),mutations:blocked,append:async()=>{persisted++;},update:async(id,patch)=>notes.push(patch),console,JSON,Date,guidedStage:'credit_overview',clientTurn:1,closed:false,finishing:false,clientSpeaking:false,testPaused:false,guidedScriptLine:'Do you have time now?',responseTranscript:'',openaiKey:'test',fetch:()=>assert.fail('No real network'),process:{env:{MANAGER_LIVE_DECISIONS:'0'}},decisionCounts:{live:0,secondary:0,fallback:0},simpleLine:()=>'',nextGuidedTurn:()=>({stage:'credit_plan_questions'}),needsInterpretation:()=>true,interpretConversation:async input=>{interpreted=input;return {action:'script',reason:'Understood the full answer'};},applyConversationDecision:()=>({stage:'credit_plan_questions',scriptLine:'The first plan costs $49.97.'}),conversationFallback:()=>assert.fail('Should not fall back'),get:()=>assert.fail('Ordinary replies must not reload the database')};vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  function persist('),source.indexOf('  async function saveConfirmedCallback(')),ctx);
 vm.runInContext(source.slice(source.indexOf('  let pendingConversationReply='),source.indexOf('  async function advanceGuidedReply(')),ctx);
 ctx.persist('client','Yeah, I can look at the plans now.','answer');ctx.queueConversationNote({tax_referral_request:{requested:true,fulfilled:false}});
 let timer;try{const turn=await Promise.race([ctx.preparationReply('Yeah, I can look at the plans now.'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Speech was blocked on transcript storage')),100);})]);assert.equal(turn.stage,'credit_plan_questions');assert.equal(interpreted.transcript.at(-1).text,'Yeah, I can look at the plans now.');assert.equal(persisted,0);assert.equal(notes.length,0);assert.equal(ctx.c.result.tax_referral_request.requested,true);}finally{clearTimeout(timer);release();await ctx.mutations;}
 assert.equal(persisted,1);assert.equal(notes[0].result.tax_referral_request.fulfilled,false);assert.equal(notes.at(-1).result.conversation_handling.status,'interpreted');
});
test('background note snapshots retain their values and later timing notes preserve earlier interest',async()=>{
 let release;const blocked=new Promise(r=>{release=r;}),writes=[];const ctx={c:{action_id:'call',result:{}},mutations:blocked,JSON,console,update:async(id,p)=>writes.push(p)};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  function queueConversationNote('),source.indexOf('  async function saveConfirmedCallback(')),ctx);
 const note={credit_support_request:{plan:'pathway'}};ctx.queueConversationNote(note);note.credit_support_request.plan='changed';ctx.queueConversationNote({credit_support_request:{...ctx.c.result.credit_support_request,window:'tomorrow'}});release();await ctx.mutations;
 assert.equal(writes[0].result.credit_support_request.plan,'pathway');assert.equal(writes[1].result.credit_support_request.window,'tomorrow');assert.equal(writes[1].result.credit_support_request.plan,'pathway');
});
