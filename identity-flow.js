'use strict';
const ACCESS=new Set(['identity','identity_after_amount','recovery_identity','identity_availability','identity_holding','screening_wait']);
const WAITING=new Set(['identity_holding','screening_wait']);
function automatedPrompt(words){return /record (?:your|the) name|name and (?:the )?reason|screening (?:this |your )?call|please (?:stay|hold|wait) (?:on (?:the )?line|while)|automated (?:voice|voicemail)|forwarded to.{0,30}(?:voice|messag)|(?:at|after) the (?:tone|beep)|leave (?:a |your )?message|mailbox is|not available.{0,50}(?:tone|message)/i.test(words);}
function identityFlow(stage,words,payload,opening=''){
 if(!ACCESS.has(stage))return null;
 const text=String(words||'').trim(),name=String(payload.first_name||'the person I’m calling').replace(/[\r\n]/g,' ').slice(0,100);
 const instructions='Read only the supplied line, then wait. Do not disclose form, financial or preparation details before confirming the customer. Availability is not identity confirmation.';
 const turn=(stage,scriptLine)=>({stage,scriptLine,instructions,identityFlow:true});
 const message='Okay, no problem. If you don’t mind, could you please let '+name+' know Daisy with the Down Payment Assistance Help Center called to follow up on their inquiry? Thank you for your time. Have a great day.';
 const end=(outcome,line,reason,next)=>({...turn('wrapup',line),finishLine:line,finishOutcome:outcome,finishReason:reason,finishNextAction:next});
 if(/wrong number|(?:no one|nobody|no person).{0,20}(?:name|here|lives)|(?:doesn.t|does not|don.t|do not) (?:live|work) here|you have the wrong/i.test(text))return end('wrong_number','Thank you for letting me know. Sorry for the inconvenience. Have a great day.','Recipient reported wrong number','Review the customer phone number before calling again');
 if(automatedPrompt(text)){
  if(/voice(?:mail| messaging)|(?:at|after) the (?:tone|beep)|leave (?:a |your )?message|mailbox/i.test(text))return end('voicemail','This is Daisy with the Down Payment Assistance Help Center, calling to follow up on '+name+'’s inquiry. Thank you.','Reached automated voicemail','Customer not reached; follow the existing callback workflow');
  if(/record (?:your|the) name|name and (?:the )?reason|screening/i.test(text))return turn('screening_wait','Daisy with the Down Payment Assistance Help Center, returning '+name+'’s inquiry.');
  return {...turn('screening_wait',null),hold:true};
 }
 if(/\bwho(?:’s|'s| is| am i| are you)|may i ask who|who.{0,20}(?:speaking|calling)/i.test(text)){const confirming=payload.identity_confirming_reply===true;return turn(confirming?'identity_confirm':'identity','This is Daisy with the Down Payment Assistance Help Center. '+(confirming?'Am I speaking with '+name+'?':'Is '+name+' available to speak?'));}
 const no=/^(?:oh[, ]+)?(?:no(?! problem)|nope|nah|not me|not speaking|not here|not available|they(?:’re| are) not|he(?:’s| is) not|she(?:’s| is) not)\b/i.test(text);
 if(stage==='identity_availability'){
  if(no)return end('completed',message,'Customer unavailable; message left with person answering','Customer not reached; follow the existing callback workflow');
  if(/^(?:yes|yeah|yep|sure|okay|ok|one (?:moment|second)|hold|let me|i.ll get)\b/i.test(text))return turn('identity_holding','Thank you. I’ll hold.');
  if(/\b(?:this is|i am|speaking|that.s me)\b/i.test(text))return {identityFlow:true,recheckIdentity:true};
  return turn(stage,'Is '+name+' available to speak?');
 }
 if(WAITING.has(stage)){
  if(no)return end('completed',message,'Customer unavailable after transfer or screening','Customer not reached; follow the existing callback workflow');
  if(/one (?:moment|second)|hold on|please wait|getting (?:him|her|them)/i.test(text))return {...turn(stage,null),hold:true};
  if(/\b(?:this is|i am|speaking|that.s me)\b/i.test(text))return {identityFlow:true,recheckIdentity:true};
  return turn('identity_confirm','Oh, hi. Is this '+name+' speaking?');
 }
 if(stage==='identity'&&!payload.identity_confirming_reply&&/available/i.test(opening)){if(no)return end('completed',message,'Customer unavailable; message left with person answering','Customer not reached; follow the existing callback workflow');if(/(?:let me|i.ll|i will).{0,15}(?:get|find|grab)|one (?:moment|second)|hold (?:on|please)|get (?:him|her|them)/i.test(text))return turn('identity_holding','Thank you. I’ll hold.');if(/^(?:yes|yeah|yep|sure|okay|ok)[.! ]*$/i.test(text))return turn('identity_confirm','Am I speaking with '+name+'?');}
 if(no)return turn('identity_availability','Oh, okay. No problem. This is Daisy with the Down Payment Assistance Help Center. Is '+name+' available to speak?');
 return null;
}
module.exports={identityFlow,automatedPrompt,WAITING};
