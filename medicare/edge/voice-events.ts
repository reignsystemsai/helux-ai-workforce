import {createClient} from 'npm:@supabase/supabase-js@2.112.3';
const issuer='https://helux-ai-workforce.onrender.com';let cache:{at:number;key:CryptoKey}|null=null;
const reply=(d:unknown,s=200)=>Response.json(d,{status:s,headers:{'Cache-Control':'no-store'}});
const bytes=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
Deno.serve(async req=>{
 if(req.method==='GET')return reply({service:'Estimate Medicare voice event sink',configured:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 try{
  const raw=await req.text();if(raw.length>100000)return reply({error:'Too large'},413);const token=(req.headers.get('authorization')||'').replace(/^Bearer /,'').split('.');if(token.length!==3)return reply({error:'Unauthorized'},401);
  const header=JSON.parse(new TextDecoder().decode(bytes(token[0]))),claims=JSON.parse(new TextDecoder().decode(bytes(token[1]))),now=Math.floor(Date.now()/1000);
  if(header.alg!=='EdDSA'||header.kid!=='medicare-primary'||claims.iss!==issuer||claims.aud!=='estimatemedicare'||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<now||claims.iat>now+15||now-claims.iat>120)return reply({error:'Unauthorized'},401);
  if(!cache||Date.now()-cache.at>300000){const r=await fetch(issuer+'/api/v1/medicare/jwks',{signal:AbortSignal.timeout(10000)});if(!r.ok)return reply({error:'Voice issuer unavailable'},503);const jwk=(await r.json()).keys?.find((k:JsonWebKey&{kid?:string})=>k.kid==='medicare-primary');if(!jwk)return reply({error:'Voice issuer unavailable'},503);cache={at:Date.now(),key:await crypto.subtle.importKey('jwk',jwk,{name:'Ed25519'},false,['verify'])};}
  if(!await crypto.subtle.verify('Ed25519',cache.key,bytes(token[2]),new TextEncoder().encode(token[0]+'.'+token[1])))return reply({error:'Unauthorized'},401);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))).map(b=>b.toString(16).padStart(2,'0')).join('');if(hash!==claims.body_hash)return reply({error:'Unauthorized'},401);
  const body=JSON.parse(raw);if(body.kind==='probe'){const configDb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});const {data,error}=await configDb.from('medicare_voice_settings').select('transfer_phone,script_assignments').eq('id','primary').maybeSingle();if(error)return reply({error:'Voice configuration unavailable'},503);return reply({ok:true,transfer_phone:data?.transfer_phone||null,test_recording_phone:data?.script_assignments?.test_recording?.enabled===true?data?.script_assignments?.test_recording?.phone||null:null});}
  if(!/^[0-9a-f-]{36}$/i.test(body.event_id||'')||!/^CA[0-9a-f]{32}$/i.test(body.call_sid||'')||!['started','context','intake','summary','status','recording','recording_consent','recording_failed','transcript','transcription_consent'].includes(body.kind))return reply({error:'Invalid event'},400);
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  if(body.kind==='started'&&body.data?.direction==='inbound'){
   const {data:settings,error}=await db.from('medicare_voice_settings').select('script_library,script_assignments').eq('id','primary').single();
   if(error)return reply({error:'Intake script unavailable'},503);
   const number=settings.script_assignments?.intake||1,script=settings.script_library?.find((s:any)=>s.number===number);
   if(script?.content)body.data.voice_context={...(body.data.voice_context||{}),custom_script:script.content,script_number:number};
  }
  const result=await db.rpc('ingest_medicare_voice',{p_event_id:body.event_id,p_kind:body.kind,p_call_sid:body.call_sid,p_data:body.data||{}});return result.error?reply({error:'Unable to save call'},503):reply(result.data);
 }catch{return reply({error:'Unable to process voice event'},503);}
});
