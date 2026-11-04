'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const twilio=require('twilio');
const {registerMedicareVoice,instructions}=require('./index');

test('Medicare inbound activation and signed intake routes',async()=>{
 const routes=new Map(),events=[],updates=[];
 const app={get:(path,...handlers)=>routes.set('GET '+path,handlers.at(-1)),post:(path,...handlers)=>routes.set('POST '+path,handlers.at(-1))};
 let keyRow;
 const pool={query:async(sql,args)=>{
  if(sql.startsWith('INSERT INTO medicare_bridge_signing_keys'))keyRow={private_jwk:args[1],public_jwk:args[2]};
  return {rows:sql.startsWith('SELECT private_jwk')?[keyRow]:[]};
 }};
 const phone=()=>({update:async value=>updates.push(value)});
 phone.list=async()=>[{sid:'PNded2efa63292b8210420f5711248e0bb'}];
 const calls=()=>({recordings:{create:async()=>({})}});
 const oldFetch=global.fetch;
 global.fetch=async(_url,options)=>{
  const event=JSON.parse(options.body);events.push(event);
  return {ok:true,json:async()=>({ok:true})};
 };
 try{
  const bridge=registerMedicareVoice({app,pool,twilioClient:{incomingPhoneNumbers:phone,calls},authToken:'test-token',accountSid:'ACtest',publicBaseUrl:'https://voice.example',openaiKey:'test-key',voice:'marin',model:'test-model'});
  await bridge.activate();
  assert.equal(updates[0].voiceUrl,'https://voice.example/api/v1/medicare/voice');
  const res={statusCode:200,status(n){this.statusCode=n;return this;},sendStatus(n){this.statusCode=n;return this;},json(value){this.value=value;return this;},type(){return this;},send(value){this.value=value;return this;}};
  routes.get('GET /api/v1/medicare/health')({},res);
  assert.equal(res.value.ready,true);
  assert.equal(res.value.number_connected,true);
  assert.equal(res.value.closer_configured,false);
  const body={AccountSid:'ACtest',To:'+18773179445',From:'+12025550123',CallSid:'CA'+'1'.repeat(32)};
  function req(path,body){return {body,query:{},originalUrl:path,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature('test-token','https://voice.example'+path,body)}};}
  await routes.get('POST /api/v1/medicare/voice')(req('/api/v1/medicare/voice',body),res);
  assert.match(res.value,/May I record/);
  assert.match(res.value,/<Gather/);
  assert.doesNotMatch(res.value,/visit Estimate/);
  assert.equal(events.at(-1).kind,'started');
  const action=res.value.match(/action="([^"]+)"/)[1].replace(/&amp;/g,'&');
  const url=new URL(action),consentBody={...body,Digits:'2'};
  const request=req(url.pathname+url.search,consentBody);request.query={ctx:url.searchParams.get('ctx')};
  await routes.get('POST /api/v1/medicare/consent')(request,res);
  assert.match(res.value,/<Connect><Stream/);
  assert.match(res.value,/wss:\/\/voice.example\/api\/v1\/medicare\/media/);
  assert.equal(events.at(-1).data.consent,false);
  const invalid=req('/api/v1/medicare/voice',body);invalid.headers={};
  await routes.get('POST /api/v1/medicare/voice')(invalid,res);
  assert.equal(res.statusCode,403);
 }finally{global.fetch=oldFetch;}
});

test('intake asks for facts without promising an unconfigured transfer',()=>{
 const prompt=instructions({direction:'inbound',script_id:'intake',recording:false});
 for(const expected of ['name','ZIP','Parts A and B','save_intake','callback number','do not promise an immediate transfer'])assert.ok(prompt.includes(expected),expected);
 assert.match(prompt,/never decide eligibility or reject them/);
});
