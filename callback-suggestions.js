'use strict';
// Calendar suggestions are options, never a booked appointment or inferred consent.
function callbackSuggestions(value,now=Date.now(),zone='America/New_York'){
 let text=String(value||'').toLowerCase();
 if(!/call.{0,30}back|callback/.test(text)||/\b(?:don.t|do not|cancel|never|not in|instead of)\b/.test(text))return null;
 const numbers={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30,forty:40,sixty:60};
 text=text.replace(/\b(twenty|thirty|forty)[ -]+(one|two|three|four|five|six|seven|eight|nine)\b/g,(_,a,b)=>String(numbers[a]+numbers[b])).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty)\b/g,w=>String(numbers[w]));
 const match=text.match(/\b(?:(a\s+)?(couple)(?: of)?|(a\s+)?(few)|(\d+)\s*(?:to|or|-)\s*(\d+)|(\d+)|(?:a|an|next))\s+(days?|weeks?|months?|hours?)\b/);
 let counts,unit;
 if(match){unit=match[8].replace(/s$/,'');counts=match[2]?[2]:match[4]?[3,4]:match[5]?[Number(match[5]),Number(match[6])]:[Number(match[7]||1)];}
 else if(/\bmonth from (?:today|now)\b/.test(text)){unit='month';counts=[1];}
 else return null;
 const limit={hour:366*24,day:366,week:52,month:12}[unit];
 if(counts.some(n=>!Number.isInteger(n)||n<1||n>limit))return null;
 const date=new Date(now);if(!Number.isFinite(date.getTime()))return null;
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(date);}catch{return null;}
 const exact=/\bexactly\b|\bmonth from today\b/.test(text)&&!/\b(?:about|around|roughly)\b/.test(text);
 if(unit==='hour'){
  const options=counts.map(h=>{const at=+date+h*3600000;return {at:new Date(at).toISOString(),label:new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(at)};});
  if(options.length===1&&!exact){const at=Date.parse(options[0].at)+1800000;options.push({at:new Date(at).toISOString(),label:new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(at)});}
  return {kind:'hours',zone,options};
 }
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date).map(p=>[p.type,p.value]));
 const y=Number(parts.year),m=Number(parts.month)-1,d=Number(parts.day);
 const bases=counts.map(n=>unit==='month'?Date.UTC(y,m+n,Math.min(d,new Date(Date.UTC(y,m+n+1,0)).getUTCDate())):Date.UTC(y,m,d+n*(unit==='week'?7:1)));
 // A broad single interval gets a nearby alternative; explicit ranges retain their endpoints.
 if(bases.length===1&&!exact)bases.push(bases[0]+86400000);
 return {kind:'dates',zone,options:[...new Set(bases)].map(at=>({date:new Date(at).toISOString().slice(0,10),label:new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(at)}))};
}
function callbackNegotiation(value,now,zone){const suggestions=callbackSuggestions(value,now,zone);if(!suggestions)return null;return {suggestions,instructions:'The client requested an approximate callback. Help them choose, using these calendar-calculated options: '+JSON.stringify(suggestions)+'. Use natural spoken timezone names such as Eastern time, Central time, Mountain time or Pacific time; never read an IANA identifier such as America/New_York aloud. Ask the date or time question directly without announcing calculations, pinning down details, or setup filler. Offer at most TWO concrete choices in one short question, such as Would November 20 or November 21 work better? Use the actual calculated dates, never the example dates. A couple means two of the stated unit; a few means three or four. A month means the same local calendar day next month, clamped to the last day if needed; two months means two calendar months. Around 30 days means about 30 calendar days, not an assumed calendar month. These are suggested dates, not a booked appointment. Preserve any time or timezone they already supplied, including a time range such as after 5 PM: propose one specific time within it. If a timezone is missing, clarify it once; use their city/state if they do not know. Never ask them to calculate the calendar date. Once date, time and named timezone are selected, call propose_callback using an EXACT quotation ALREADY in the transcript. Do not ask the client to repeat their request for the tool. The server supplies the ONE confirmation; do not ask for a separate confirmation or readback before calling the tool. If they correct an option, use their correction.'};}
module.exports={callbackSuggestions,callbackNegotiation};
