'use strict';
const chrono=require('chrono-node'),fs=require('node:fs');
const {relativeDelay,callbackZone}=require('./callback-relative');
const {localInstant,zipZone}=require('./callback-flow');
const prefixes=fs.readFileSync(__dirname+'/phone-timezones.txt','utf8').split('\n').filter(l=>/^\d+\|/.test(l)).map(l=>l.split('|')).sort((a,b)=>b[0].length-a[0].length);
function phoneZone(phone){let n=String(phone||'').replace(/\D/g,'');if(n.length===10)n='1'+n;const row=prefixes.find(([prefix,zones])=>n.startsWith(prefix)&&!zones.includes('&'));return row?.[1]||null;}
function schedulingZone(p,words=''){return callbackZone(words)||phoneZone(p.phone||p.preparation_context?.intake?.phone)||zipZone(p)||p.preparation_context?.timezone||'America/New_York';}
function callbackRequest(words,p={},now=Date.now(),atCallback=false){
 const text=String(words||'').trim();if(!atCallback&&!/\b(?:call|ring).{0,25}back|callback|\bcall me\b/i.test(text)||/\b(?:don't|do not|never|cancel)\b/i.test(text)||/\bi(?:'ll| will) call you\b/i.test(text))return null;
 if(/\bi(?:'ll| will| might| may).{0,20}call(?: you)? back\b/i.test(text)&&!/call me back/i.test(text))return null;
 if(atCallback&&/^(?:in the )?(?:morning|evening|afternoon|night)[.! ]*$/i.test(text))return null;
 const zone=schedulingZone(p,text),request=/call.{0,25}back|callback/i.test(text)?text:'Call me back '+text,relative=relativeDelay(request,{now,timezone:zone});
 if(relative)return {callback_at:new Date(now+relative.seconds*1000).toISOString(),timezone:zone,request_quote:text,relative_seconds:relative.seconds,label:'in '+relative.label,relative_label:relative.label,request_selected:true};
 const offsetText=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'longOffset'}).formatToParts(now).find(v=>v.type==='timeZoneName')?.value||'GMT';const offsetParts=offsetText.match(/([+-])(\d+):(\d+)/);const offset=offsetParts?(offsetParts[1]==='-'?-1:1)*(Number(offsetParts[2])*60+Number(offsetParts[3])):0;
 const parsed=chrono.parse(text,{instant:new Date(now),timezone:offset},{forwardDate:true})[0];if(!parsed)return null;const c=parsed.start;
 let day=c.get('year')+'-'+String(c.get('month')).padStart(2,'0')+'-'+String(c.get('day')).padStart(2,'0');
 if(atCallback&&!c.isCertain('day'))day=p.callback_flow?.date||p.requested_callback_detail?.date||day;
 if(!c.isCertain('hour'))return {missing:'time',date:day,timezone:zone,question:'What time would you like me to call you on '+new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'}).format(Date.parse(day+'T12:00:00Z'))+'?'};
 if(!c.isCertain('meridiem')&&p.callback_flow?.period){c.assign('hour',c.get('hour')%12+(p.callback_flow.period==='pm'?12:0));c.assign('meridiem',p.callback_flow.period==='pm'?1:0);}
 if(!c.isCertain('meridiem')&&c.get('hour')>=1&&c.get('hour')<=12&&!/noon|midnight|morning|evening|afternoon|tonight/i.test(text))return {missing:'period',date:day,hour:c.get('hour'),minute:c.get('minute')||0,timezone:zone,question:'Would that be in the morning or the evening?'};
 const at=localInstant(day,c.get('hour'),c.get('minute')||0,zone);if(Date.parse(at)<=now)return {missing:'date',question:'What future date would you like for that callback?'};
 return {callback_at:at,timezone:zone,request_quote:text,label:new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(Date.parse(at)),request_selected:true};
}
module.exports={callbackRequest,schedulingZone,phoneZone};
