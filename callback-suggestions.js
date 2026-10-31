'use strict';
// Calendar suggestions are options, never a booked appointment or inferred consent.
function callbackSuggestions(value,now=Date.now(),zone='America/New_York'){
 const text=String(value||'').toLowerCase();
 if(!/call.{0,30}back|callback/.test(text)||/\b(?:don.t|do not|cancel|never|instead of)\b/.test(text))return null;
 let days=null,months=null,hours=null;
 if(/\b(?:a|one|1)\s+month\b|\bmonth from (?:today|now)\b/.test(text))months=1;
 else if(/\b(?:a\s+)?couple(?: of)?\s+weeks\b/.test(text))days=[14];
 else if(/\b(?:a\s+)?few\s+weeks\b/.test(text))days=[21,28];
 else if(/\b(?:a\s+)?few\s+hours\b/.test(text))hours=[3,4];
 else {const match=text.match(/\b(one|two|three|four|\d+)\s+weeks?\b/);if(match)days=[7*({one:1,two:2,three:3,four:4}[match[1]]||Number(match[1]))];}
 if(months===null&&!days&&!hours)return null;
 const date=new Date(now);if(!Number.isFinite(date.getTime()))return null;
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(date);}catch{return null;}
 const label=at=>new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric',...(hours?{hour:'numeric',minute:'2-digit',timeZoneName:'short'}:{})}).format(at);
 if(hours)return {kind:'hours',zone,options:hours.map(h=>({at:new Date(+date+h*3600000).toISOString(),label:label(+date+h*3600000)}))};
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date).map(p=>[p.type,p.value]));
 const y=Number(parts.year),m=Number(parts.month)-1,d=Number(parts.day);
 let bases;if(months){const last=new Date(Date.UTC(y,m+2,0)).getUTCDate();bases=[Date.UTC(y,m+1,Math.min(d,last))];if(/\babout|\baround|\broughly/.test(text))bases.push(bases[0]+86400000);}else bases=days.map(n=>Date.UTC(y,m,d+n));
 return {kind:'dates',zone,options:bases.map(at=>{const iso=new Date(at).toISOString().slice(0,10);return {date:iso,label:new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(at)};})};
}
function callbackNegotiation(value,now,zone){const suggestions=callbackSuggestions(value,now,zone);if(!suggestions)return null;return {suggestions,instructions:'The client requested an approximate callback. Help them choose, using these calendar-calculated options: '+JSON.stringify(suggestions)+'. Offer at most TWO concrete choices in one short question. A couple of weeks means two weeks; a few weeks means three or four. A month means the same local calendar day next month, clamped to the last day if needed. These are suggested dates, not a booked appointment. Preserve any time or timezone they already supplied, including a time range such as after 5 PM: propose one specific time within it. If a timezone is missing, clarify it once; use their city/state if they do not know. Never ask them to calculate the calendar date. Once date, time and named timezone are selected, call propose_callback using an EXACT quotation ALREADY in the transcript. Do not ask the client to repeat their request for the tool. The server supplies the ONE confirmation; do not ask for a separate confirmation or readback before calling the tool. If they correct an option, use their correction.'};}
module.exports={callbackSuggestions,callbackNegotiation};
