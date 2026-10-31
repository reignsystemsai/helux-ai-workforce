'use strict';
function fillerReply(words){const s=String(words||'').toLowerCase().replace(/[’]/g,"'").replace(/[^a-z' ]/g,' ').replace(/\s+/g,' ').trim();return /^(?:(?:um|uh|erm|hmm|hm|ah|hello|hi|hey|one moment|hold on|just a second|wait)(?:\s+|$))+$/.test(s);}
function greetingReply(words){return /\b(?:hello|hi|hey)\b/i.test(String(words||''));}
function speechParts(line){return String(line||'').split(/(?:\r?\n\s*){2,}|(?:\\n\s*){2,}/).map(s=>s.trim()).filter(Boolean);}
function priorityReply(words){return /\b(?:stop|don't call|do not call|remove me|wrong number|goodbye|bye|have to go|got to go|need to go|call.{0,25}back|callback|can't talk|cannot talk|instead|actually)\b/i.test(String(words||''));}
module.exports={fillerReply,greetingReply,speechParts,priorityReply};
