'use strict';
const zipZones=require('zipcode-to-timezone');
const {clockChoice}=require('./callback-clock');
const {callbackZone}=require('./callback-relative');
const {callbackAffirmative}=require('./callback-time');
const LABELS={'America/New_York':'Eastern time','America/Chicago':'Central time','America/Denver':'Mountain time','America/Los_Angeles':'Pacific time','America/Phoenix':'Arizona time','Pacific/Honolulu':'Hawaii time','America/Anchorage':'Alaska time','America/Bogota':'Colombia time'};
function zipZone(p){const zip=String(p.preparation_context?.intake?.zip||'').match(/^\d{5}(?:-\d{4})?$/)?.[0]?.slice(0,5);if(!zip)return null;const raw=zipZones.lookup(zip);if(!raw||LABELS[raw])return raw;try{const label=new Intl.DateTimeFormat('en-US',{timeZone:raw,timeZoneName:'longGeneric'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName')?.value;return callbackZone(label)||null;}catch{return null;}}
function localInstant(date,hour,minute,zone){const [y,m,d]=date.split('-').map(Number),target=Date.UTC(y,m-1,d,hour,minute);let at=target;for(let i=0;i<3;i++){const v=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));const delta=target-Date.UTC(+v.year,+v.month-1,+v.day,+v.hour,+v.minute);if(!delta)return new Date(at).toISOString();at+=delta;}throw Error('That local time is unavailable; choose another time');}
function dateChoice(words,options){const s=words.toLowerCase();if(/\b(first|former)\b/.test(s))return options[0];if(/\b(second|latter)\b/.test(s))return options[1];const matched=options.filter(o=>{const [y,m,d]=o.date.split('-').map(Number),month=new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(Date.UTC(y,m-1,d)).toLowerCase();return s.includes(o.date)||new RegExp('\\b'+month.slice(0,3)+'(?:'+month.slice(3)+')?\\s+'+d+'(?:st|nd|rd|th)?\\b').test(s)||new RegExp('^(?:the )?'+d+'(?:st|nd|rd|th)?(?:[.! ]|$)').test(s);});return matched.length===1?matched[0]:null;}
function callbackFlow(stage,words,p){
 if(stage!=='callback_time'||p.callback_suggestions?.kind!=='dates')return null;
 const options=p.callback_suggestions.options;if(!options?.length)return null;
 const text=String(words||'').trim();if(/^(?:why|what|how|who|where|can you|could you|do you|does|is there)\b/i.test(text))return null;if(/\b(?:stop|cancel|don.t call|do not call|i.ll call you|i will call you)\b/i.test(text)||/\b(?:don.t|do not|no need|never mind|forget).{0,35}(?:call|callback)\b/i.test(text)||/\b(?:can.t|cannot|not at)\b/i.test(text))return null;
 let f=p.callback_flow;if(!f)f=p.callback_flow={phase:'date',options};
 const revisedClock=clockChoice(text),revisedZone=callbackZone(text),revisedDate=f.phase!=='date'?dateChoice(text,f.options):null;
 if(revisedDate){f.date=revisedDate.date;f.date_label=revisedDate.label;}
 if(f.phase==='complete'){if(!revisedClock&&!revisedZone&&!revisedDate)return null;if(revisedClock){f.clock=revisedClock;f.clock_quote=text;if(revisedClock.period)f.period=revisedClock.period;}if(revisedZone){f.zone=revisedZone;f.zone_confirmed=true;}}
 if(f.phase==='zone'&&revisedClock)f.phase='time';
 const say=line=>({stage:'callback_time',scriptLine:line,callbackFlow:true,instructions:'Read only this callback question and wait. These are choices, not a scheduled appointment. Never infer AM/PM or timezone confirmation.'});
 if(f.phase==='date'){
  const selected=dateChoice(text,f.options);if(!selected)return null;
  f.date=selected.date;f.date_label=selected.label;f.phase='period';f.date_quote=text;
  if(p.callback_requested_quote&&/morning|evening|afternoon|night|\d.*(?:am|pm)/i.test(p.callback_requested_quote))return callbackFlow(stage,p.callback_requested_quote,p);
  return say('Would you prefer a call in the morning or the evening?');
 }
 if(f.phase==='period'||f.phase==='time'){
  const zone=callbackZone(text);if(zone){f.zone=zone;f.zone_confirmed=true;}
  const morning=/\bmorning\b|^a\.?\s*m\.?[.! ]*$/i.test(text),evening=/\b(?:evening|afternoon|night)\b|^p\.?\s*m\.?[.! ]*$/i.test(text);
  const clock=clockChoice(text);
  if(morning&&!evening)f.period='am';else if(evening&&!morning)f.period='pm';
  if(clock&&/\b(?:after|before|between)\b/i.test(text)){f.period=clock.period||f.period;f.phase='time';return say('What specific time would work within that window?');}
  if(clock){f.clock=clock;f.clock_quote=text;if(clock.period)f.period=clock.period;}
  if(!f.period)return say('Would morning or evening work better for you?');
  if(!f.clock){f.phase='time';return say(f.period==='am'?'What time in the morning works best—perhaps 8 AM or 9 AM?':'What time in the evening works best—perhaps 6 PM or 7 PM?');}
  f.phase='zone';
  if(!f.zone_confirmed){const suggested=zipZone(p);if(suggested&&LABELS[suggested]){f.suggested_zone=suggested;return say('Based on your ZIP code, I have '+LABELS[suggested]+'. Is that correct?');}return say('Would that be Eastern, Central, Mountain, or Pacific time—or another time zone?');}
 }else if(f.phase==='zone'){
  const explicit=callbackZone(text);
  if(explicit){f.zone=explicit;f.zone_confirmed=true;}
  else if(f.suggested_zone&&callbackAffirmative(text)){f.zone=f.suggested_zone;f.zone_confirmed=true;}
  else {delete f.suggested_zone;return say('What time zone should I use for your callback?');}
 }
 if(f.zone_confirmed&&f.clock&&f.period){const hour=f.clock.hour%12+(f.period==='pm'?12:0);try{const callback_at=localInstant(f.date,hour,f.clock.minute,f.zone);f.phase='complete';return {stage:'callback_time',callbackFlow:true,callbackProposal:{callback_at,timezone:f.zone,client_quote:f.clock_quote},instructions:'Prepare the one exact appointment readback through the existing callback tool, then wait for consent before saving.'};}catch{f.phase='time';delete f.clock;return say('That local time is unavailable. What other time would work?');}}
 return null;
}
module.exports={callbackFlow,zipZone,localInstant,clockChoice};
