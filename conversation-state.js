'use strict';
// Call-local evidence, never verified filing status or a saved customer milestone.
function uncertainty(words){const s=String(words||'').replace(/[’]/g,"'");return /\b(?:no idea|(?:don't|do not|wouldn't|would not) know|not sure|unsure|uncertain|hard to (?:say|tell)|tough to (?:say|tell)|that's (?:tough|hard|difficult)|that is (?:tough|hard|difficult)|can't (?:say|tell|give)|cannot (?:say|tell|give)|no (?:date|timeline|timeframe)|haven't (?:decided|figured)|have not (?:decided|figured))\b/i.test(s);}
function recordAnswer(p,stage,words,turn){
 if(!turn||turn.hold||turn.clarification||turn.incompleteReply||turn.stage===stage||turn.stage?.startsWith('conversation_')||turn.requiredTool&&turn.stage===stage)return;
 const progress=p.conversation_progress||(p.conversation_progress={answers:{}});
 progress.answers[stage]={quote:String(words).slice(0,3000),status:turn.uncertain?'unknown':'answered',next_stage:turn.stage};
 progress.pending_stage=turn.stage;
}
module.exports={uncertainty,recordAnswer};
