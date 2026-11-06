const {taxObservation,selectionSummary,observedTaxTurn}=require('./tax-observation');
const {sectionVisible,sectionPrompt}=require('./guided-access');
'use strict';
const {fillerReply}=require('./turn-taking');
const {booleanReply,realQuestion,positiveReaction}=require('./reply-clarification');
const {recentTaxYears}=require('./tax-years');
function followupPurpose(p){const missing=recentTaxYears(p).filter(y=>p.client_reported_tax_years?.years?.[y]===false);return 'I’d like to call you back for a follow-up to check on '+(missing.length?'your '+missing.join(' and ')+' tax filing':'your next preparation milestone')+' and help you keep moving forward. ';}
const INVITE='When would you like me to call you back—maybe in a few days, a few weeks, or a month?';
function taxSelections(p){const observed=observedTaxTurn(p.prephub_live_status,p);if(observed)return observed;const values=p.client_reported_tax_years?.years||{},years=recentTaxYears(p).slice().sort((a,b)=>Number(values[b]===true)-Number(values[a]===true));const choices=years.map(y=>'“I have '+(values[y]===true?'filed ':'not filed ')+y+'”');return {stage:'tax_select_both',scriptLine:'In the Taxes tab, select '+choices.join(', then select ')+'. Let me know when you’ve selected both.',instructions:'Read these two approved tax selections, then stop and listen. Do not ask another tax-year confirmation.'};}
function taxActionStart(p){return p.prephub_section_confirmed==='taxes'?taxSelections(p):{stage:'tax_section_navigation',scriptLine:sectionPrompt('taxes',p.prephub_live_status),instructions:'Guide the Taxes section by its actual heading. Do not repeat tax-year questions.'};}
function completedTaxAction(words,stage){
 const s=String(words||'').toLowerCase().replace(/[’]/g,"'").replace(/\b(?:not a problem|no problem|no worries)\b/g,'');
 if(/\b(?:not|neither|none|not yet|haven't|have not|didn't|did not|can't|cannot|couldn't|only one|just one|first one|one of|trying to|going to|about to|need to|will)\b/.test(s))return false;
 if(/^(?:yes|yeah|yep|sure|okay|ok|done|saved|ready|all set|absolutely)\b/.test(s))return true;
 if(stage==='tax_save'&&/^save[.! ]*$/.test(s.trim()))return true;
 if(stage==='tax_select_both'&&/^select(?:ed| it) both[.! ]*$/.test(s.trim()))return true;
 if(stage==='tax_save')return /\b(?:saved|clicked(?: on)? (?:save|the save)|pressed(?: the)? save|hit save)\b/.test(s);
 return /\b(?:selected|checked|marked|chosen|clicked|completed|finished|done)\b/.test(s)&&(/\b(?:both|boxes|selections|years|them|everything|all|it|that|done)\b/.test(s)||/\b(?:i am|i'm|i have|i've|that's|that is|it is|it's) (?:done|finished|completed)\b/.test(s));
}
function taxFlowTurn(stage,words,p,line){
 if(!stage.startsWith('tax_')||['tax_years','tax_missing_year','tax_year_missing','tax_years_confirm','tax_intake_confirm'].includes(stage))return null;
 if(fillerReply(words))return {stage,hold:true};
 const text=String(words||''),yes=/^(?:yes|yeah|yep|sure|okay|ok|done|saved|ready|i did|i have|i.m in|i am in|i.ve|that.s done|it.s done|sounds good|absolutely)\b/i.test(text),no=/^(?:no|not yet|nope|i can.t|i cannot)\b/i.test(text);
 const years=recentTaxYears(p),values=p.client_reported_tax_years?.years||{},missing=years.filter(y=>values[y]===false),say=(next,scriptLine)=>({stage:next,scriptLine,instructions:'Read only this approved tax-guidance step, then wait. Do not restart the introduction or reassurance. Never claim to see an unsaved click.'});
 const purpose=line('tax_followup_purpose',p)||followupPurpose(p)+'How does that sound?';
 const select=i=>say('tax_select_'+i,'For '+years[i]+', select “I have '+(values[years[i]]===true?'filed ':'not filed ')+years[i]+'.” Let me know when you’ve selected that.');
 if(stage==='tax_walkthrough_offer')return yes?taxActionStart(p):no?{stage:'callback_time',scriptLine:INVITE}:{stage,instructions:'Briefly address their actual question, then clarify whether they have two to three minutes for the preparation checklist now or want a callback. Do not restart the introduction.'};
 if(stage==='tax_login')return taxActionStart(p);
 if(stage==='tax_section_navigation'){if(sectionVisible(text,'taxes')){p.prephub_section_confirmed='taxes';return taxSelections(p);}return say(stage,sectionPrompt('taxes',p.prephub_live_status));}
 if(stage==='tax_tab')return yes?taxSelections(p):{stage,instructions:'Ask what page heading they see, then give one navigation instruction to the existing Taxes tab. Never invent a control. Offer a callback if they cannot continue.'};
 if(stage==='tax_select_both')return completedTaxAction(text,stage)?say('tax_save','Excellent. Scroll down to Your filing plan. Your selections and any remaining filing steps appear there. Click Save Progress, and let me know when it’s saved.'):say(stage,'Have you selected both filing-status boxes?');
 if(stage==='tax_select_0')return yes?select(1):select(0);
 if(stage==='tax_select_1')return yes?say('tax_save','Your filing plan fills in from those selections. Click Save Progress, then let me know when it’s saved. You can come back and upload your filed returns here when you have time.'):select(1);
 if(stage==='tax_saved_review')return {stage,requiredTool:'get_prephub_status'};
 if(stage==='tax_save')return completedTaxAction(text,stage)?{stage:'tax_saved_review',requiredTool:'get_prephub_status',instructions:'Call get_prephub_status now to read saved tax selections and preparation progress. Do not claim to see unsaved clicks or verified IRS filing. Do not restart the orientation.'}:say(stage,'Have you saved your progress?');
 if(stage==='tax_next_step'){if(/\?|^(?:what|why|how|where|can you|could you)\b/i.test(text))return {stage,instructions:'Answer the actual question briefly using the approved tax resources, then return to when they expect to file. Do not invent a filing date or promise a referral.'};if(/need.{0,25}(?:help|someone|accountant|professional)|don.t know|not sure|cannot|can.t/i.test(text))return say('tax_referral_offer',line('tax_referral_offer',p));if(!/[0-9]|\b(?:today|tomorrow|tonight|next|weeks?|months?|days?|years?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|after|before|once|when|soon)\b/i.test(text))return say(stage,'When do you think you’ll be able to get the missing return filed?');const milestone='File '+missing.join(' and ')+' tax return'+(missing.length===1?'':'s');p.tax_filing_target_quote=text;return {...say('tax_followup_purpose',purpose),preparationCommitment:{milestone,target_quote:text,source:'client_reported',filing_verified:false}};}
 if(stage==='tax_assistant'&&missing.length)return say('tax_next_step','The next step is to file your '+missing.join(' and ')+' '+(missing.length===1?'return.':'returns.')+' When do you think you’ll be able to get that filed?');
 if(stage==='tax_assistant')return {stage:'tax_resources',instructions:'Briefly address the client reaction, then read the saved tax_resources block. Use only the fresh saved percentage if supplied; otherwise omit any numeric progress claim. Do not claim 100% is loan approval.' ,scriptLine:line('tax_resources',p)};
 if(stage==='tax_resources')return missing.length?say('tax_obstacle','Based on what we covered, you still need to file your '+missing.join(' and ')+' '+(missing.length===1?'return.':'returns.')+' If you don’t mind me asking, what’s been holding you back?'):say('callback_time','When you have time, you can upload your filed returns here so everything stays in one place. '+INVITE);
 if(stage==='tax_obstacle')return {stage:'tax_referral_offer',instructions:'Acknowledge their actual obstacle in one short sentence without tax advice, then ask the saved tax_referral_offer question. Do not add a new intake interview.',scriptLine:line('tax_referral_offer',p)};
 if(stage==='tax_followup_purpose'){if(booleanReply(text)===true||positiveReaction(text))return say('callback_time',INVITE);if(booleanReply(text)===false)return {stage:'wrapup',finishOutcome:'completed',finishReason:'Client declined the offered follow-up',finishLine:'No problem. You can continue in PrepHub whenever you’re ready. Thank you for your time. Goodbye.'};return say(stage,'I’d like to follow up to help you keep moving forward with your preparation. How does that sound?');}
 if(stage==='tax_month_offer'){if(booleanReply(text)===true&&!realQuestion(text))return {stage:'callback_time',callbackRequest:'Call me back in about a month.'};if(no)return say('callback_time','No problem. What callback timing would work better for you?');return say(stage,'Would a callback in about a month work for you?');}
 if(stage==='tax_referral_offer'&&(no||booleanReply(text)===false))return say('tax_month_offer','Okay, I don’t want to be pushy. '+followupPurpose(p)+'Would it be okay if I give you a callback in about a month?');
 if(stage==='tax_referral_offer')return {...say('tax_followup_purpose',(booleanReply(text)===true?'I’ll note your request for a tax-professional referral. ':'')+purpose),...(booleanReply(text)===true?{referralRequest:true}:{})};
 return null;
}
function taxSavedTurn(output,p,line){
 const observation=taxObservation(output,p),expected=p.client_reported_tax_years?.years||{},match=observation?.source==='saved'&&Object.keys(expected).length===2&&Object.entries(expected).every(([y,filed])=>observation.years[y]===filed);
 p.prephub_live_status=output;
 const acknowledgment=match?'Excellent. I can see your filing-status selections are saved: '+selectionSummary(observation)+'. ':'';
 const missing=recentTaxYears(p).filter(y=>expected[y]===false);if(missing.length)return {stage:'tax_next_step',scriptLine:acknowledgment+'If you don’t mind me asking, '+(p.first_name||'')+', when do you think you’ll have time to file your missing '+missing.join(' and ')+' tax '+(missing.length===1?'return':'returns')+' so I can follow up with you to help you keep moving forward?',instructions:'Ask for the actual filing target, then offer a callback in a couple of days, a couple of weeks or a month. Only the existing scheduler can save an agreed appointment. Do not repeat the orientation or a general resource tour.'};return {stage:'callback_time',scriptLine:acknowledgment+INVITE};
}
module.exports={completedTaxAction,taxActionStart,taxSelections,taxFlowTurn,taxSavedTurn,INVITE};
