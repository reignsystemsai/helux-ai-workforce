const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),vm=require('node:vm'),fs=require('node:fs'),twilio=require('twilio');
const tick=()=>new Promise(r=>setImmediate(r));
async function run(){
 let media,ai,update;const routes=new Map(),events=[];
 class WSS extends EventEmitter{constructor(){super();media=this;}handleUpgrade(){}}
 class WS extends EventEmitter{static OPEN=1;constructor(){super();this.readyState=1;this.sent=[];ai=this;queueMicrotask(()=>this.emit('open'));}send(v){this.sent.push(JSON.parse(v));}close(){this.readyState=3;}}
 WS.WebSocketServer=WSS;
 const context={require:n=>n==='ws'?WS:require(n==='./intake-flow'?'./intake-flow':n),module:{exports:{}},Buffer,URL,setTimeout,console,AbortSignal,fetch:async(u,o)=>{events.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),context);
 const client={calls:()=>({update:async b=>{update=b;}})};client.incomingPhoneNumbers=()=>({update:async()=>{}});
 context.module.exports.registerAiBuilder({app:{get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},twilioClient:client,authToken:'test-secret',accountSid:'AC'+'a'.repeat(32),publicBaseUrl:'https://voice.example',openaiKey:'test',heluxKey:'test',voice:'coral',model:'test'});
 const body={AccountSid:'AC'+'a'.repeat(32),CallSid:'CA'+'b'.repeat(32),To:'+18883305262',From:'+12025550123'},url='/api/v1/ai-builder/voice';let xml;
 await routes.get(url)({body,originalUrl:url,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature('test-secret','https://voice.example'+url,body)}},{type(){return this},send(v){xml=v},sendStatus(s){throw Error(String(s))}});
 const token=xml.match(/name="ctx" value="([^"]+)"/)[1];const socket=new EventEmitter();socket.readyState=1;socket.sent=[];socket.send=v=>socket.sent.push(JSON.parse(v));socket.close=()=>{};media.emit('connection',socket);
 socket.emit('message',JSON.stringify({event:'start',start:{callSid:body.CallSid,streamSid:'MZtest',customParameters:{ctx:token}}}));await tick();
 const session=ai.sent.find(e=>e.type==='session.update').session;assert.equal(session.audio.input.noise_reduction.type,'near_field');assert.equal(session.audio.input.turn_detection.create_response,false);assert.equal(session.audio.input.transcription.prompt,undefined);assert.equal(session.tools[0].parameters.properties.ad_budget,undefined);
 const emit=m=>ai.emit('message',JSON.stringify(m));let count=0;
 function responseDone(){const id='r'+(++count);emit({type:'response.created',response:{id}});emit({type:'response.done',response:{id,status:'completed'}});}
 emit({type:'session.updated'});await tick();responseDone();
 const requests=()=>ai.sent.filter(e=>e.type==='response.create');
 const before=requests().length;
 for(const text of ['',' ','Um,'])emit({type:'conversation.item.input_audio_transcription.completed',transcript:text,item_id:'noise'});
 assert.equal(requests().length,before,'silence and hesitations must not cause replies');
 const turns=[
  {first_name:'Test',last_name:'Caller'},
  {email:'test@example.invalid'},
  {email_confirmed:true},
  {role:'Marketer'},
  {classes:['Meta ads','Custom webinars']},
  {goal:'Offer services to clients'},
  {budget:'no budget'},
  {budget_meaning:'unknown'},
  {timing:'As soon as possible'},
  {use_incoming_number:true}
 ];
 for(const [n,a] of turns.entries()){
  emit({type:'input_audio_buffer.speech_started',item_id:'u'+n,audio_start_ms:n*2000});emit({type:'input_audio_buffer.speech_stopped',item_id:'u'+n,audio_end_ms:n*2000+1000});emit({type:'conversation.item.input_audio_transcription.completed',transcript:n===9?'The number I called you on.':'Test answer',item_id:'u'+n});
  assert.equal(requests().at(-1).response.tool_choice.name,'save_intake');const id='extract'+n;emit({type:'response.created',response:{id}});
  const beforeSave=requests().length;emit({type:'response.function_call_arguments.done',name:'save_intake',call_id:'save'+n,arguments:JSON.stringify({answer_clear:true,...a})});await tick();await tick();assert.equal(requests().length,beforeSave,'never overlap extraction and speech');
  emit({type:'response.done',response:{id,status:'completed'}});await tick();await tick();
  assert.equal(requests().at(-1).response.tool_choice,'none');responseDone();await tick();
 }
 assert.ok(socket.sent.some(e=>e.event==='mark'));
 socket.emit('message',JSON.stringify({event:'mark',mark:{name:'ai-builder-finish'}}));await tick();await tick();
 assert.match(update.twiml,/<Hangup/);assert.doesNotMatch(update.twiml,/<Dial/);
 const last=events.filter(e=>e.kind==='intake').at(-1);assert.equal(last.data.intake.phone,'+12025550123');assert.equal(last.data.intake.phone_confirmed,true);assert.equal(last.data.intake.budget,'Still deciding');assert.equal(last.data.intake.ad_budget,undefined);assert.ok(last.data.intake.summary.includes('Learning/building budget: Still deciding'));
 const lines=requests().filter(e=>e.response.tool_choice==='none').map(e=>e.response.instructions.split('Exact line: ')[1]);
 assert.ok(lines.some(l=>l.includes('AI Workflows')&&l.includes('Custom Webinars')));assert.ok(lines.some(l=>l.includes('twenty-five hundred')&&l.includes('ten thousand')));assert.ok(lines.some(l=>l.includes('When you say no budget')));assert.ok(lines.some(l=>l.includes('number you are calling from')));
 assert.ok(!lines.some(l=>/advertising budget|summary|do not call/i.test(l)),'spoken questions must omit ad budget, summary and opt-out suggestions');
 assert.ok(last.data.transcript.some(e=>e.role==='caller'&&e.at&&e.item_id));
}
test('complete application-driven intake saves notes without ad-budget question, spoken summary, or phone dictation',run);
