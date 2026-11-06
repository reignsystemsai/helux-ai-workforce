const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),vm=require('node:vm'),fs=require('node:fs'),twilio=require('twilio');
const tick=()=>new Promise(r=>setImmediate(r));
async function run(budget){
 let media,ai,update;const routes=new Map(),events=[];
 class WSS extends EventEmitter{constructor(){super();media=this;}handleUpgrade(){}}
 class WS extends EventEmitter{static OPEN=1;constructor(){super();this.readyState=1;this.sent=[];ai=this;queueMicrotask(()=>this.emit('open'));}send(v){this.sent.push(JSON.parse(v));}close(){this.readyState=3;}}
 WS.WebSocketServer=WSS;
 const context={require:n=>n==='ws'?WS:require(n),module:{exports:{}},Buffer,URL,setTimeout,console,AbortSignal,fetch:async(u,o)=>{events.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),context);
 const client={calls:()=>({update:async b=>{update=b;}})};client.incomingPhoneNumbers=()=>({update:async()=>{}});
 context.module.exports.registerAiBuilder({app:{get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},twilioClient:client,authToken:'test-secret',accountSid:'AC'+'a'.repeat(32),publicBaseUrl:'https://voice.example',openaiKey:'test',heluxKey:'test',voice:'coral',model:'test'});
 const body={AccountSid:'AC'+'a'.repeat(32),CallSid:'CA'+'b'.repeat(32),To:'+18883305262',From:'+12025550123'},url='/api/v1/ai-builder/voice';let xml;
 await routes.get(url)({body,originalUrl:url,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature('test-secret','https://voice.example'+url,body)}},{type(){return this},send(v){xml=v},sendStatus(s){throw Error(String(s))}});
 const token=xml.match(/name="ctx" value="([^"]+)"/)[1];const socket=new EventEmitter();socket.readyState=1;socket.sent=[];socket.send=v=>socket.sent.push(JSON.parse(v));socket.close=()=>{};media.emit('connection',socket);
 socket.emit('message',JSON.stringify({event:'start',start:{callSid:body.CallSid,streamSid:'MZtest',customParameters:{ctx:token}}}));await tick();
 const session=ai.sent.find(e=>e.type==='session.update').session;assert.equal(session.audio.input.noise_reduction.type,'near_field');assert.equal(session.audio.input.turn_detection.threshold,0.8);assert.equal(session.audio.input.turn_detection.create_response,false);assert.equal(session.audio.input.turn_detection.silence_duration_ms,850);
 ai.emit('message',JSON.stringify({type:'session.updated'}));await tick();assert.ok(ai.sent.some(e=>e.type==='response.create'));ai.emit('message',JSON.stringify({type:'response.done',response:{id:'greeting'}}));
 ai.emit('message',JSON.stringify({type:'response.created',response:{id:'premature'}}));ai.emit('message',JSON.stringify({type:'response.function_call_arguments.done',name:'finish_call',call_id:'premature',arguments:'{}'}));await tick();await tick();const rejected=ai.sent.find(e=>e.item?.call_id==='premature');assert.equal(JSON.parse(rejected.item.output).ok,false,'incomplete intake must not finish');ai.emit('message',JSON.stringify({type:'response.done',response:{id:'premature'}}));await tick();ai.emit('message',JSON.stringify({type:'response.done',response:{id:'clarification'}}));
 ai.emit('message',JSON.stringify({type:'input_audio_buffer.speech_started',audio_start_ms:100,item_id:'utterance1'}));const beforeNoise=ai.sent.filter(e=>e.type==='response.create').length;ai.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:' ',item_id:'utterance1'}));assert.equal(ai.sent.filter(e=>e.type==='response.create').length,beforeNoise,'empty noise must not trigger a reply');ai.emit('message',JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Test Caller',item_id:'utterance2'}));
 const answer={first_name:'Test',last_name:'Caller',email:'test@example.invalid',role:'Business owner',classes:['Custom webinars'],goal:'Learn a new skill',budget:'$2,500+',timing:'Just exploring',ad_budget:budget,ad_budget_status:budget===null?'unknown':'confirmed',email_confirmed:true,summary_confirmed:true,phone_confirmed:true};
 ai.emit('message',JSON.stringify({type:'response.created',response:{id:'saving'}}));
 const beforeSave=ai.sent.filter(e=>e.type==='response.create').length;
 ai.emit('message',JSON.stringify({type:'response.function_call_arguments.done',name:'save_intake',call_id:'save',arguments:JSON.stringify(answer)}));await tick();await tick();
 assert.equal(ai.sent.filter(e=>e.type==='response.create').length,beforeSave,'saving must not create an overlapping response');ai.emit('message',JSON.stringify({type:'response.done',response:{id:'saving'}}));await tick();assert.equal(ai.sent.filter(e=>e.type==='response.create').length,beforeSave+1);
 ai.emit('message',JSON.stringify({type:'response.created',response:{id:'finishing'}}));
 ai.emit('message',JSON.stringify({type:'response.function_call_arguments.done',name:'finish_call',call_id:'finish',arguments:JSON.stringify({summary:'Intake complete'})}));await tick();await tick();
 ai.emit('message',JSON.stringify({type:'response.done',response:{id:'finishing'}}));await tick();ai.emit('message',JSON.stringify({type:'response.created',response:{id:'closing'}}));ai.emit('message',JSON.stringify({type:'response.done',response:{id:'closing'}}));await tick();
 assert.ok(socket.sent.some(e=>e.event==='mark'));
 socket.emit('message',JSON.stringify({event:'mark',mark:{name:'ai-builder-finish'}}));await tick();await tick();
 assert.ok(events.some(e=>e.kind==='intake'&&e.data.intake.ad_budget===budget));const entries=events.filter(e=>e.kind==='intake').at(-1).data.transcript;assert.ok(entries.some(e=>e.type==='speech_started'&&e.audio_start_ms===100&&e.at));assert.ok(entries.some(e=>e.role==='caller'&&e.item_id==='utterance2'&&e.at));assert.ok(!entries.some(e=>e.role==='caller'&&!e.text.trim()));return update.twiml;
}
test('full inbound flow saves qualified webinar lead before dialing only the fixed owner',async()=>{const xml=await run(1000);assert.match(xml,/<Dial/);assert.match(xml,/\+16892828783/);assert.doesNotMatch(xml,/911<\/Number>/);});
test('full inbound flow never dials for a large learning budget with a low ad budget',async()=>{const xml=await run(999);assert.match(xml,/<Hangup/);assert.doesNotMatch(xml,/<Dial/);});

test('unknown advertising budget remains null and never transfers',async()=>{const xml=await run(null);assert.match(xml,/<Hangup/);assert.doesNotMatch(xml,/<Dial/);});
