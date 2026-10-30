'use strict';
function relativeDelay(value){
 let s=String(value||'').toLowerCase();if(!/call.{0,25}back|call back|callback/.test(s)||/\b(?:don.t|do not|cancel|never|not in|instead of)\b/.test(s))return null;
 const words={fifty:50,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30,forty:40,fortyfive:45,sixty:60};
 s=s.replace(/\b(twenty|thirty|forty|fifty)[ -]+(one|two|three|four|five|six|seven|eight|nine)\b/g,(_,t,u)=>String(words[t]+words[u]));
 s=s.replace(/half an? hour/g,'30 minutes').replace(/(?:a )?couple(?: of)?/g,'2').replace(/\b(?:a|an) (?=minute|hour)/g,'1 ').replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty)\b/g,w=>String(words[w]));
 let seconds=0;for(const m of s.matchAll(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/g))seconds+=Number(m[1])*(/^h/.test(m[2])?3600:60);
 if(!Number.isFinite(seconds)||seconds<60||seconds>366*86400)return null;
 const label=seconds%3600===0?(seconds/3600)+' hour'+(seconds===3600?'':'s'):seconds%60===0?(seconds/60)+' minute'+(seconds===60?'':'s'):null;
 return label?{seconds,label}:null;
}
function callbackZone(value){
 const s=String(value||'').toLowerCase().replace(/[.,!?]/g,' ').replace(/\s+/g,' ').trim();
 if(/\b(?:don.t know|do not know|not sure|maybe|either)\b/.test(s))return null;
 const groups=[['America/New_York',/\b(?:eastern|est|edt|new york|miami|orlando|tampa|atlanta|boston|philadelphia|detroit|washington dc|georgia|massachusetts|new jersey|ohio|virginia|north carolina|south carolina)\b/],['America/Chicago',/\b(?:central|cst|cdt|chicago|dallas|houston|austin|san antonio|minneapolis|wisconsin|illinois|alabama|mississippi)\b/],['America/Denver',/\b(?:mountain|mst|mdt|denver|colorado|utah|salt lake city)\b/],['America/Los_Angeles',/\b(?:pacific|pst|pdt|los angeles|sacramento|san francisco|san diego|seattle|las vegas|california|nevada)\b/],['America/Phoenix',/\b(?:phoenix|tucson)\b/],['Pacific/Honolulu',/\b(?:hawaii|honolulu)\b/],['America/Anchorage',/\banchorage\b/],['America/Bogota',/\b(?:bogota|cartagena|medellin|colombia)\b/]];
 const found=[...new Set(groups.filter(([,r])=>r.test(s)).map(([z])=>z))];return found.length===1?found[0]:null;
}
module.exports={relativeDelay,callbackZone};
