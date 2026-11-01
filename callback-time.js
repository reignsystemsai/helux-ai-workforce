const {callbackZone}=require('./callback-relative');
'use strict';
function normalizeAffirmation(value){return String(value||'').trim().replace(/^(?:(?:oh|um|uh(?![ -]*(?:huh|uh)\b)|ah|well)[,!. ]+)+/i,'').replace(/^(?:uh[ -]*huh|mhm|mm[ -]*hmm)\b/i,'Yes');}
function callbackAffirmative(value){const s=normalizeAffirmation(value).replace(/^(?:oh|um|uh)[, ]+/i,'');return /^(?:yes|yeah|yep|yup|sure|okay|ok|correct|absolutely|that (?:works|is fine|sounds good)|sounds good|perfect|please do|go ahead)\b/i.test(s)&&!/\b(?:not|don.t|do not|no|wait|but|instead|actually)\b/i.test(s);}
function callbackProposal(args,transcript,now=Date.now()){
 const at=Date.parse(args.callback_at),zone=String(args.timezone||''),quote=String(args.client_quote||'').trim();
 if(!/(Z|[+-]\d\d:\d\d)$/.test(String(args.callback_at))||!Number.isFinite(at)||at<now+60000||at>now+366*86400000)throw Error('Choose an exact future callback date and time, at least one minute from now');
 if(!quote||!(transcript||[]).some(t=>t.role==='client'&&String(t.text||'').includes(quote)))throw Error('Use the client’s actual requested time quotation');
 const spokenZone={'America/New_York':'Eastern time','America/Chicago':'Central time','America/Denver':'Mountain time','America/Los_Angeles':'Pacific time'}[zone];
 const label=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(at).replace(/\b(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT)$/,z=>spokenZone||z);
 return {callback_at:new Date(at).toISOString(),timezone:zone,request_quote:quote,label,confirmation_line:'I can call you on '+label+'. Is that correct?'};
}
function confirmedCallback(args,transcript){
 const turns=(transcript||[]).filter(t=>['client','daisy'].includes(t.role)&&String(t.text||'').trim()),last=turns.at(-1);let readback=turns.at(-2);
 if(/^Just to make sure I understand you correctly, was that a yes or a no[?!. ]*$/i.test(String(readback?.text||''))&&turns.at(-3)?.role==='client'&&!/[0-9]|\b(?:instead|actually|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(String(turns.at(-3)?.text||'')))readback=turns.at(-4);
 if(last?.role!=='client'||!callbackAffirmative(last.text)||readback?.role!=='daisy'||/\bor\b/i.test(readback.text))return null;
 const at=Date.parse(args.callback_at);if(!Number.isFinite(at)||callbackZone(readback.text)!==args.timezone)return null;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:args.timezone,month:'long',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(at).map(p=>[p.type,p.value]));
 const words=String(readback.text).toLowerCase().replace(/[^a-z0-9: ]/g,' ').replace(/\s+/g,' ');
 const date=new RegExp('\\b'+parts.month.toLowerCase()+' '+parts.day+'(?:st|nd|rd|th)?\\b');
 const clock=new RegExp('\\b'+parts.hour+(parts.minute==='00'?'(?::00)?':':'+parts.minute)+'\\s*'+parts.dayPeriod.toLowerCase()+'\\b');
 return date.test(words)&&clock.test(words)?last.text:null;
}
module.exports={confirmedCallback,callbackProposal,callbackAffirmative,normalizeAffirmation};
