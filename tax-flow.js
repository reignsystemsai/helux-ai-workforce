'use strict';
const {recentTaxYears}=require('./tax-years');
const INVITE='When would you like me to call you back—maybe in a few days, a few weeks, or a month?';
function taxFlowTurn(stage,words,p,line){
 if(!stage.startsWith('tax_')||['tax_years','tax_year_missing','tax_years_confirm'].includes(stage))return null;
 const text=String(words||''),yes=/^(?:yes|yeah|yep|sure|okay|ok|done|saved|ready|i did|i have|i.m in|i am in|i.ve|that.s done|it.s done|sounds good|absolutely)\b/i.test(text),no=/^(?:no|not yet|nope|i can.t|i cannot)\b/i.test(text);
 const years=recentTaxYears(p),values=p.client_reported_tax_years?.years||{},missing=years.filter(y=>values[y]===false),say=(next,scriptLine)=>({stage:next,scriptLine,instructions:'Read only this approved tax-guidance step, then wait. Do not restart the introduction or reassurance. Never claim to see an unsaved click.'});
 const select=i=>say('tax_select_'+i,'For '+years[i]+', select “I have '+(values[years[i]]===true?'filed ':'not filed ')+years[i]+'.” Let me know when you’ve selected that.');
 if(stage==='tax_walkthrough_offer')return yes?say('tax_login','Excellent. Open the PrepHub link in that email and sign in. Are you inside PrepHub now?'):no?{stage:'callback_time',scriptLine:INVITE}:{stage,instructions:'Briefly address their actual question, then clarify whether they have two to three minutes for the preparation checklist now or want a callback. Do not restart the introduction.'};
 if(stage==='tax_login')return yes?say('tax_tab','Please open the Taxes tab. Do you see the tax-year choices?'):say(stage,'Let me know when you’re signed into PrepHub. Are you inside now?');
 if(stage==='tax_tab')return yes?select(0):{stage,instructions:'Ask what page heading they see, then give one navigation instruction to the existing Taxes tab. Never invent a control. Offer a callback if they cannot continue.'};
 if(stage==='tax_select_0')return yes?select(1):select(0);
 if(stage==='tax_select_1')return yes?say('tax_save','Your filing plan fills in from those selections. Click Save Progress, then let me know when it’s saved. You can come back and upload your filed returns here when you have time.'):select(1);
 if(stage==='tax_save')return yes?{stage:'tax_saved_review',instructions:'Call get_prephub_status now to read saved tax selections and preparation progress. Do not claim to see unsaved clicks or verified IRS filing. Do not restart the orientation.'}:say(stage,'Click Save Progress when you’re ready, and let me know when it’s saved.');
 if(stage==='tax_assistant')return {stage:'tax_resources',instructions:'Briefly address the client reaction, then read the saved tax_resources block. Use only the fresh saved percentage if supplied; otherwise omit any numeric progress claim. Do not claim 100% is loan approval.' ,scriptLine:line('tax_resources',p)};
 if(stage==='tax_resources')return missing.length?say('tax_obstacle','Based on what we covered, you still need to file your '+missing.join(' and ')+' '+(missing.length===1?'return.':'returns.')+' If you don’t mind me asking, what’s been holding you back?'):say('callback_time','When you have time, you can upload your filed returns here so everything stays in one place. '+INVITE);
 if(stage==='tax_obstacle')return {stage:'tax_referral_offer',instructions:'Acknowledge their actual obstacle in one short sentence without tax advice, then ask the saved tax_referral_offer question. Do not add a new intake interview.',scriptLine:line('tax_referral_offer',p)};
 if(stage==='tax_referral_offer')return {...say('callback_time',(yes?'I’ll note your request for a tax-professional referral. ':'')+INVITE),...(yes?{referralRequest:true}:{})};
 return null;
}
function taxSavedTurn(output,p,line){
 const people=output.tax_progress?.people||[],expected=p.client_reported_tax_years?.years||{},match=people.length===1&&Object.entries(expected).every(([y,filed])=>people[0].years?.[y]===filed);
 p.prephub_live_status=output;
 const acknowledgment=match?'Excellent. I can see those filing-status selections are saved. ':'';
 return {stage:'tax_assistant',scriptLine:acknowledgment+line('tax_assistant',p),instructions:'Render the saved assistant introduction and tie-down. Saved selections are client-reported, not IRS verification. No claim about unsaved clicks.'};
}
module.exports={taxFlowTurn,taxSavedTurn,INVITE};
