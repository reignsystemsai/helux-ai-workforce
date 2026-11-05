'use strict';
function clockChoice(words){let s=words.toLowerCase().replace(/a\.?\s*m\.?/g,'am').replace(/p\.?\s*m\.?/g,'pm');const nums={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};s=s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,w=>nums[w]);const found=[...s.matchAll(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)?\b/g)];if(found.length!==1)return null;return {hour:+found[0][1],minute:+(found[0][2]||0),period:found[0][3]||(/\bmorning\b/.test(s)?'am':/\bevening|afternoon|night\b/.test(s)?'pm':null)};}

function ambiguousCallbackClock(transcript){
 const clients=(transcript||[]).filter(t=>t.role==='client').map(t=>String(t.text||''));
 const start=clients.findIndex(s=>/call.{0,30}back|callback/i.test(s));const relevant=clients.slice(Math.max(start,0));
 const clocks=relevant.map(text=>({text,clock:clockChoice(text)})).filter(x=>x.clock&&!(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(x.text)&&!/\bat\b/i.test(x.text)));
 const latest=clocks.at(-1);return !!latest&&!latest.clock.period&&!relevant.some(s=>/\bmorning|evening|afternoon|night\b/i.test(s));
}
module.exports={clockChoice,ambiguousCallbackClock};
