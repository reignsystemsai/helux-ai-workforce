// Dedicated, script-locked PrepHub calls. Existing DPA scripts/routes are untouched.
const {randomUUID,createHmac}=require('crypto');
const CALLBACK='https://fklchtsxahepzfzgcqdp.supabase.co/functions/v1/prephub-followup-worker';
const clean=(v,n=2000)=>String(v??'').trim().slice(0,n);
const fill=(v,first)=>clean(v).replaceAll('{first_name}',clean(first,100)||'Homebuyer');
const classify=text=>{const s=clean(text,500).toLowerCase();if(/\b(stop|unsubscribe|do not call|don't call|remove me|wrong number)\b/.test(s)||s==='9')return 'stop';if(/\b(callback|call back|later|busy|another time)\b/.test(s)||s==='2')return 'callback';if(/\b(no|not interested|no thanks)\b/.test(s))return 'decline';if(/\b(yes|sure|okay|ok|help|interested|please|go ahead)\b/.test(s)||s==='1')return 'interested';return 'unknown';};
function registerPrepHubOutreach({app,pool,authenticateHelux,twilioClient,publicBaseUrl,authToken,fromNumber,heluxKey}){
 const twilio=require('twilio');
 let initialized;
 const ready=()=>initialized||(initialized=pool.query(`create table if not exists prephub_outreach_calls(job_id uuid primary key,call_sid text,token text not null,payload jsonb not null,status text not null default 'claiming',result jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now())`).catch(e=>{initialized=null;throw e;}));
 const save=async(id,status,result)=>pool.query('update prephub_outreach_calls set status=$2,result=result||$3::jsonb,updated_at=now() where job_id=$1',[id,status,JSON.stringify(result||{})]);
 const get=async id=>(await pool.query('select * from prephub_outreach_calls where job_id=$1',[id])).rows[0];
 async function report(call){
  if(!call.call_sid)return;
  const body=JSON.stringify({action:'call_result',job_id:call.job_id,call_sid:call.call_sid,status:call.status,result:{...call.result,script_id:call.payload.script_id,script_version:call.payload.script_version}}),time=String(Date.now());
  const r=await fetch(CALLBACK,{method:'POST',headers:{'Content-Type':'application/json','x-helux-timestamp':time,'x-helux-signature':createHmac('sha256',heluxKey).update(`${time}.${body}`).digest('hex')},body,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('CRM call result not accepted: '+r.status);
 }
 function valid(req,call){
  return call&&req.query.token===call.token&&(!req.body.CallSid||!call.call_sid||req.body.CallSid===call.call_sid)&&twilio.validateRequest(authToken,req.get('x-twilio-signature')||'',publicBaseUrl+req.originalUrl,req.body);
 }
 const say=(response,text)=>response.say({voice:'Polly.Joanna',language:'en-US'},text);
 const actionUrl=(call,stage,tries=0)=>`${publicBaseUrl}/api/v1/prephub/respond?job_id=${call.job_id}&token=${call.token}&stage=${stage}&tries=${tries}`;
 const gather=(response,call,stage,text,tries=0)=>{const g=response.gather({input:'speech dtmf',numDigits:1,speechTimeout:'auto',timeout:6,action:actionUrl(call,stage,tries),method:'POST',actionOnEmptyResult:true,language:'en-US'});say(g,text);};
 app.get('/api/v1/prephub/health',authenticateHelux,async(req,res)=>{try{await ready();res.json({ok:true,version:1,script_locked:true,channel:'phone',configured:!!(fromNumber&&authToken&&heluxKey)});}catch(e){res.status(503).json({error:'PrepHub call storage unavailable'});}});
 app.post('/api/v1/prephub/calls',authenticateHelux,async(req,res)=>{
  try{
   const p=req.body||{};
   if(!/^[0-9a-f-]{36}$/i.test(p.job_id||'')||!p.permission_verified||p.result_url!==CALLBACK||!p.script_id||!Number.isInteger(p.script_version))return res.status(422).json({error:'Verified permission, job and approved script version required'});
   const fields=['opening','overview','question','interested','callback','decline','stop','unknown','voicemail'];if(fields.some(k=>!clean(p.script?.[k])))return res.status(422).json({error:'Incomplete call script'});
   if(fields.some(k=>String(p.script[k]).length>2000))return res.status(422).json({error:'Script field too long'});
   let phone=String(p.phone||'').replace(/\D/g,'');if(phone.length===10)phone='1'+phone;if(!/^1\d{10}$/.test(phone))return res.status(422).json({error:'A valid US phone number is required'});
   await ready();const inserted=await pool.query('insert into prephub_outreach_calls(job_id,token,payload) values($1,$2,$3::jsonb) on conflict(job_id) do nothing returning job_id',[p.job_id,randomUUID(),JSON.stringify(p)]);
   if(!inserted.rows.length){const old=await get(p.job_id);return res.status(old.call_sid?200:409).json({ok:!!old.call_sid,duplicate:true,call_sid:old.call_sid,status:old.status,error:old.call_sid?undefined:'Dispatch unconfirmed; verify provider before retrying'});}
   const c=await get(p.job_id),url=`${publicBaseUrl}/api/v1/prephub/voice?job_id=${c.job_id}&token=${c.token}`,statusCallback=`${publicBaseUrl}/api/v1/prephub/status?job_id=${c.job_id}&token=${c.token}`;
   try{
    const call=await twilioClient.calls.create({to:'+'+phone,from:fromNumber,url,method:'POST',statusCallback,statusCallbackMethod:'POST',statusCallbackEvent:['initiated','ringing','answered','completed'],machineDetection:'Enable',timeout:25,timeLimit:180});
    await pool.query("update prephub_outreach_calls set call_sid=$2,status=case when status='claiming' then $3 else status end,updated_at=now() where job_id=$1",[c.job_id,call.sid,call.status]);
    await report(await get(c.job_id)).catch(e=>console.error('PrepHub result sync pending',e.message));
    return res.json({ok:true,call_sid:call.sid,status:call.status});
   }catch(e){await save(c.job_id,'unconfirmed',{summary:'Dispatch did not confirm a call; check provider before retrying'});throw e;}
  }catch(e){console.error('PrepHub call dispatch',e.message);res.status(502).json({error:'Call dispatch unconfirmed; verify provider before retrying'});}
 });
 app.post('/api/v1/prephub/voice',async(req,res)=>{
  try{await ready();const c=await get(req.query.job_id);if(!valid(req,c))return res.sendStatus(403);
   if(!c.call_sid&&req.body.CallSid)await pool.query('update prephub_outreach_calls set call_sid=$2 where job_id=$1',[c.job_id,req.body.CallSid]);
   const r=new twilio.twiml.VoiceResponse(),script=c.payload.script;
   if(String(req.body.AnsweredBy||'').startsWith('machine')){say(r,fill(script.voicemail,c.payload.first_name));r.hangup();await save(c.job_id,'in-progress',{intent:'voicemail',summary:'Approved voicemail message played'});}
   else{gather(r,c,'permission',fill(script.opening,c.payload.first_name));await save(c.job_id,'in-progress',{summary:'Welcome call answered; awaiting permission to continue'});}
   res.type('text/xml').send(r.toString());
  }catch(e){console.error('PrepHub voice',e.message);res.sendStatus(500);}
 });
 app.post('/api/v1/prephub/respond',async(req,res)=>{
  try{await ready();const c=await get(req.query.job_id);if(!valid(req,c))return res.sendStatus(403);
   const r=new twilio.twiml.VoiceResponse(),script=c.payload.script,answer=clean(req.body.SpeechResult||req.body.Digits,500),intent=classify(answer),tries=Number(req.query.tries)||0;
   if(req.query.stage==='permission'&&intent==='interested'){say(r,fill(script.overview,c.payload.first_name));gather(r,c,'help',fill(script.question,c.payload.first_name));await save(c.job_id,'in-progress',{summary:'Client agreed to hear the PrepHub walkthrough'});}
   else if(intent==='unknown'&&tries<1){gather(r,c,String(req.query.stage)==='permission'?'permission':'help',fill(script.unknown,c.payload.first_name),tries+1);}
   else{const outcome=intent==='unknown'?'needs_review':intent;say(r,fill(script[intent==='unknown'?'decline':intent],c.payload.first_name));r.hangup();await save(c.job_id,'in-progress',{intent:outcome,summary:`PrepHub call: ${outcome}. Client response: ${answer||'No response'}`});await report(await get(c.job_id)).catch(e=>console.error('PrepHub result sync pending',e.message));}
   res.type('text/xml').send(r.toString());
  }catch(e){console.error('PrepHub response',e.message);res.sendStatus(500);}
 });
 app.post('/api/v1/prephub/status',async(req,res)=>{
  try{await ready();const c=await get(req.query.job_id);if(!valid(req,c))return res.sendStatus(403);
   const terminal=['completed','no-answer','busy','failed','canceled'];if(terminal.includes(c.status)&&!terminal.includes(req.body.CallStatus))return res.sendStatus(204);
   if(!c.call_sid&&req.body.CallSid)await pool.query('update prephub_outreach_calls set call_sid=$2 where job_id=$1',[c.job_id,req.body.CallSid]);
   await save(c.job_id,clean(req.body.CallStatus,50),{duration_seconds:Number(req.body.CallDuration)||0});await report(await get(c.job_id));res.sendStatus(204);
  }catch(e){console.error('PrepHub status sync',e.message);res.sendStatus(500);}
 });
}
module.exports={registerPrepHubOutreach,classify};
