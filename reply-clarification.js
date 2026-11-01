'use strict';
const {normalizeAffirmation}=require('./callback-time');
const {priorityReply}=require('./turn-taking');
const {accessComplete,sectionVisible}=require('./guided-access');
const BOOLEAN_CLARIFICATION='Just to make sure I understand you correctly, was that a yes or a no?';
const LOGIN_CLARIFICATION='Just to make sure I understand you correctly, were you able to log in?';
const BOOLEAN_STAGES=new Set(['identity','identity_after_amount','recovery_identity','amount','opening_explained','email','email_search','email_login','login','section_navigation','needs','orientation','orientation_checklist','tax_walkthrough_offer','tax_section_navigation','tax_select_both','tax_select_0','tax_select_1','tax_save','tax_assistant','tax_resources','tax_referral_offer']);
function booleanReply(words){const s=normalizeAffirmation(words).toLowerCase().replace(/[’]/g,"'").trim();if(/^(?:(?:it(?:'s| is)|that(?:'s| is)) (?:a )?no|no(?! problem)|nope|nah|not yet|not now|i (?:don't|do not|can't|cannot))\b/.test(s))return false;if(/\b(?:not|don't|do not|can't|cannot|but|instead)\b/.test(s)&&!/no problem/.test(s))return null;if(/^(?:it does(?: sound helpful)?|it makes sense|that makes sense|it sounds helpful|that sounds helpful|sounds helpful)[.! ]*$/i.test(s))return true;if(/^(?:yes|yeah|yep|yup|sure|okay|ok|correct|right|absolutely|done|ready|saved|finished|all set|of course|definitely|perfect|sounds (?:good|great|amazing)|that sounds (?:good|great|amazing)|that's (?:right|correct|great|good)|i (?:do|did)|no problem)\b/.test(s))return true;return null;}
function positiveReaction(words){return /^(?:amazing|great|good|awesome|wonderful|excellent|perfect|nice|love it|i like|(?:it |that )?sounds (?:amazing|great|good|awesome|wonderful)|that(?:'s| is) (?:amazing|great|good))\b/i.test(normalizeAffirmation(words));}
function referralDeclined(words){return /\b(?:have|got|using|use|work(?:ing)? with).{0,45}(?:someone|somebody|friend|accountant|tax (?:professional|preparer))\b/i.test(String(words||''));}
function realQuestion(words){return /\?|\b(?:questions?|concerns?|frustrated|don't understand|do not understand)\b|^(?:why|what|how|where|which|who|can you|could you|would you)\b/i.test(String(words||'').trim());}
function clarifyReply(stage,words,turn,payload){
 if(payload.reply_clarification?.stage===stage&&turn.stage!==stage)delete payload.reply_clarification;
 if(turn.hold||turn.requiredTool||turn.identityIncomplete||turn.resumingRecovery||realQuestion(words)||priorityReply(words)||/different first name|speaker gave a different/i.test(turn.instructions||''))return turn;
 const value=booleanReply(words),same=turn.stage===stage;
 if(['tax_assistant','tax_resources'].includes(stage)){if(positiveReaction(words)||value!==null)return turn;return {stage,clarification:true,scriptLine:'What do you think of that?',instructions:'Clarify the client reaction naturally. This is not a yes/no question.'};}
 if(stage==='tax_referral_offer'&&referralDeclined(words))return turn;
 if(['tax_years','tax_year_missing','tax_years_confirm'].includes(stage)&&same&&!turn.taxReport)return {...turn,scriptLine:'I’m sorry, which tax year did you say?',instructions:'Clarify only the missing tax year. Retain all previously supplied years; do not restart another step.'};
 const semanticValid=(['identity','identity_after_amount','recovery_identity'].includes(stage)&&['amount','follow_up'].includes(turn.stage))||(['email','email_search'].includes(stage)&&turn.stage==='email_login')||(['email_login','login'].includes(stage)&&accessComplete(words))||(stage==='section_navigation'&&sectionVisible(words,payload.prephub_target_tab))||(['tax_select_both','tax_select_0','tax_select_1','tax_save'].includes(stage)&&!same);
 if(BOOLEAN_STAGES.has(stage)&&(same||['needs','orientation','tax_assistant','tax_resources','tax_referral_offer'].includes(stage))&&value===null&&!semanticValid){payload.reply_clarification={stage};return {stage,clarification:true,scriptLine:['email_login','login'].includes(stage)?LOGIN_CLARIFICATION:BOOLEAN_CLARIFICATION,instructions:'Do not assume which option the client chose. Clarify the reply to the current step only. Retain the original question, accepted answers and workflow position.'};}
 if(payload.reply_clarification?.stage===stage)delete payload.reply_clarification;
 return turn;
}
module.exports={LOGIN_CLARIFICATION,BOOLEAN_CLARIFICATION,booleanReply,clarifyReply,realQuestion,positiveReaction,referralDeclined};
