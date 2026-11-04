'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const vm=require('node:vm');
const fs=require('node:fs');
const twilio=require('twilio');
const tick=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};

for(const missingParts of [false,true])test(missingParts?'confirmed missing A/B plays the required closing and hangs up without dialing':'real media handler enforces priority-first saves and automatically dials after announcement playback',async()=>{
 const routes=new Map(),updates=[],aiSessions=[],events=[],phoneMessages=[],recordingRequests=[];let holdIntake=true,releaseWrite;
 const phone=new EventEmitter();phone.readyState=1;phone.send=raw=>phoneMessages.push(JSON.parse(raw));phone.close=()=>{};
 class FakeAI extends EventEmitter{constructor(){super();this.readyState=1;this.sent=[];aiSessions.push(this);}send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;}}
 FakeAI.OPEN=1;
 FakeAI.WebSocketServer=class extends EventEmitter{handleUpgrade(req,socket,head,callback){callback(phone);}};
 const moduleObject={exports:{}};
 const sandbox={module:moduleObject,exports:moduleObject.exports,require:name=>name==='ws'?FakeAI:require(name),Buffer,URL,AbortSignal,console,setTimeout,clearTimeout,fetch:async(url,options)=>{
  const event=JSON.parse(options.body);events.push(event);if(event.kind==='intake'&&holdIntake)return await new Promise(resolve=>{releaseWrite=()=>resolve({ok:true,json:async()=>({ok:true})});});
  return {ok:true,json:async()=>event.kind==='probe'?{ok:true,transfer_phone:'+12025550199',test_recording_phone:'+12025550123'}:event.kind==='context'?{ok:true,context:{direction:'inbound',script_id:'intake',phone:'+12025550123',custom_script:'Collect name then ZIP. Offer an optional specialist transfer.'}}:{ok:true}};
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('./index'),'utf8'),sandbox);
 let keyRow;
 const numbers=()=>({update:async()=>{}});numbers.list=async()=>[{sid:'PNded2efa63292b8210420f5711248e0bb'}];
 const bridge=moduleObject.exports.registerMedicareVoice({app:{get:(p,...h)=>routes.set('GET '+p,h.at(-1)),post:(p,...h)=>routes.set('POST '+p,h.at(-1))},pool:{query:async(sql,args)=>{if(sql.startsWith('INSERT INTO medicare_bridge_signing_keys'))keyRow={private_jwk:args[1],public_jwk:args[2]};return {rows:sql.startsWith('SELECT private_jwk')?[keyRow]:[]};}},twilioClient:{incomingPhoneNumbers:numbers,calls:()=>({update:async value=>updates.push(value),recordings:{create:async options=>{recordingRequests.push(options);return {sid:'RE'+'1'.repeat(32)};}}})},authToken:'test-token',accountSid:'ACtest',publicBaseUrl:'https://voice.example',openaiKey:'test',voice:'marin',model:'test'});
 await bridge.activate();
 const body={AccountSid:'ACtest',To:'+18773179445',From:'+12025550123',CallSid:'CA'+'2'.repeat(32)};
 const req={body,query:{},originalUrl:'/api/v1/medicare/voice',headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature('test-token','https://voice.example/api/v1/medicare/voice',body)}};
 const res={type(){return this;},send(value){this.value=value;},sendStatus(value){throw Error('HTTP '+value);}};
 await routes.get('POST /api/v1/medicare/voice')(req,res);
 const token=res.value.match(/name="ctx" value="([^"]+)"/)[1];
 bridge.handleUpgrade({url:'/api/v1/medicare/media'},{},null);
 phone.emit('message',JSON.stringify({event:'start',start:{callSid:body.CallSid,streamSid:'MZtest',customParameters:{ctx:token}}}));await tick();
 const ai=aiSessions[0];ai.emit('open');assert.ok(ai.sent[0].session.instructions.length<3000,'keep the per-turn prompt compact');assert.equal(ai.sent[0].session.audio.input.turn_detection.silence_duration_ms,450);ai.emit('message',JSON.stringify({type:'session.updated'}));await tick();
 const lastResponse=()=>ai.sent.filter(e=>e.type==='response.create').at(-1).response.instructions;
 assert.match(lastResponse(),/STEP: name/);assert.doesNotMatch(lastResponse(),/transcribed|recorded|recording notice/);assert.equal(recordingRequests.length,1);assert.equal(recordingRequests[0].recordingChannels,'dual');assert.ok(events.some(e=>e.kind==='recording_consent'&&e.data.consent===true));
 ai.emit('message',JSON.stringify({type:'response.created',response:{id:'opening'}}));ai.emit('message',JSON.stringify({type:'response.output_audio_transcript.done',response_id:'opening',item_id:'opening-item',transcript:'Thank you for calling Estimate Medicare. I’m Daisy. And whom do I have the pleasure of speaking to?'}));ai.emit('message',JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'caller-name'}));ai.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'caller-name',transcript:'Test Caller.'}));await tick();
 assert.ok(events.some(e=>e.kind==='summary'&&e.data.transcript?.some(t=>t.role==='daisy')));assert.ok(events.some(e=>e.kind==='summary'&&e.data.transcript?.some(t=>t.role==='caller'&&t.text==='Test Caller.')));

 const answers=[[{full_name:'Test Caller'},'priority'],[{review_priority:'doctors'},'zip'],[{zip_code:'32819'},'parts_a_b'],[{has_parts_a_b:!missingParts},missingParts?'missing_parts':'coverage'],...(missingParts?[]:[[{current_coverage:'original_medicare'},'phone']])];
 for(const [answer,next] of answers){ai.emit('message',JSON.stringify({type:'response.function_call_arguments.done',name:'save_intake',call_id:next,arguments:JSON.stringify(answer)}));await tick();if(missingParts&&next==='missing_parts')assert.match(lastResponse(),/Having A and B is necessary/);else assert.match(lastResponse(),new RegExp('STEP: '+next));if(next==='phone')assert.match(lastResponse(),/plus one, two zero two, five five five, zero one two three/);assert.equal(updates.length,0);if(next==='priority'){assert.equal(typeof releaseWrite,'function','CRM write is still waiting while the next question is already queued');holdIntake=false;releaseWrite();await tick();}}
 if(missingParts){
  assert.match(lastResponse(),/visit Medicare.gov/);assert.match(lastResponse(),/Have a wonderful day. Goodbye/);
  ai.emit('message',JSON.stringify({type:'response.created',response:{id:'missing-parts-closing'}}));
  ai.emit('message',JSON.stringify({type:'response.done',response:{id:'missing-parts-closing'}}));await tick();
  phone.emit('message',JSON.stringify({event:'mark',mark:{name:'medicare-finish'}}));await tick();
  assert.equal(updates.length,1);assert.equal(updates[0].status,'completed');assert.equal(updates[0].twiml,undefined);
  assert.ok(events.some(e=>e.kind==='summary'&&e.data.intake?.service_outcome==='missing_parts_a_b'));return;
 }
 ai.emit('message',JSON.stringify({type:'response.function_call_arguments.done',name:'save_intake',call_id:'confirm',arguments:JSON.stringify({phone:'+12025550123',phone_confirmed:true})}));await tick();
 assert.match(lastResponse(),/Thank you for your time, Test Caller\. Please hold while I connect you to a live representative who can further assist you with your Medicare plans\./);
 assert.match(lastResponse(),/Do not ask whether the caller wants a transfer/);
 assert.equal(updates.length,0,'wait until the announcement is heard');
 ai.emit('message',JSON.stringify({type:'response.created',response:{id:'handoff'}}));
 ai.emit('message',JSON.stringify({type:'response.done',response:{id:'handoff'}}));await tick();
 assert.equal(phoneMessages.at(-1).mark.name,'medicare-finish');
 phone.emit('message',JSON.stringify({event:'mark',mark:{name:'medicare-finish'}}));await tick();
 assert.equal(updates.length,1);
 assert.match(updates[0].twiml,/>\+12025550199<\/Dial>/);
 assert.ok(events.some(e=>e.data.intake?.handoff_status==='dialing'));phone.emit('message',JSON.stringify({event:'stop'}));ai.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'final-confirmation',transcript:'Yes, that is correct.'}));ai.emit('message',JSON.stringify({type:'response.output_audio_transcript.done',response_id:'handoff',item_id:'handoff-item',transcript:'Thank you for your time, Test Caller. Please hold while I connect you to a live representative who can further assist you with your Medicare plans.'}));await tick();assert.ok(events.some(e=>e.kind==='summary'&&e.data.transcript?.some(t=>t.text==='Yes, that is correct.')));assert.ok(events.some(e=>e.kind==='summary'&&e.data.transcript?.some(t=>t.text.includes('Thank you for your time, Test Caller'))));
 assert.ok(!ai.sent.some(e=>e.type==='response.create'&&/Would you like/.test(e.response?.instructions||'')));
});


