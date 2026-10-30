'use strict';
function normalizeAffirmation(value){return String(value||'').trim().replace(/^(?:(?:oh|um|well)[,!. ]+)+/i,'').replace(/^(?:uh[ -]*huh|mhm|mm[ -]*hmm)\b/i,'Yes');}
function callbackAffirmative(value){const s=normalizeAffirmation(value).replace(/^(?:oh|um|uh)[, ]+/i,'');return /^(?:yes|yeah|yep|yup|sure|okay|ok|correct|absolutely|that (?:works|is fine|sounds good)|sounds good|perfect|please do|go ahead)\b/i.test(s)&&!/\b(?:not|don.t|do not|no|wait|but|instead|actually)\b/i.test(s);}
function callbackProposal(args,transcript,now=Date.now()){
 const at=Date.parse(args.callback_at),zone=String(args.timezone||''),quote=String(args.client_quote||'').trim();
 if(!/(Z|[+-]\d\d:\d\d)$/.test(String(args.callback_at))||!Number.isFinite(at)||at<now+60000||at>now+366*86400000)throw Error('Choose an exact future callback date and time, at least one minute from now');
 if(!quote||!(transcript||[]).some(t=>t.role==='client'&&String(t.text||'').includes(quote)))throw Error('Use the client’s actual requested time quotation');
 const label=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(at);
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(at));if(hour<9||hour>=18)throw Error('Offer a callback during 9 AM to 6 PM Eastern');
 return {callback_at:new Date(at).toISOString(),timezone:zone,request_quote:quote,label,confirmation_line:'I can call you on '+label+'. Is that correct?'};
}
module.exports={callbackProposal,callbackAffirmative,normalizeAffirmation};
