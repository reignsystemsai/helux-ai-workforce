'use strict';
const SERVICES=['Workflow automation','Apps','CRMs','Landing pages','AI callers','Meta ads','TikTok ads','Google ads','Custom webinars'];
const GOALS=['Build something for my business','Start a new business','Offer services to clients','Learn a new skill'];
const BUDGET_QUESTION='For learning and building, which range fits: five hundred to under one thousand dollars, one thousand to under twenty-five hundred, twenty-five hundred to under five thousand, five thousand to under ten thousand, or ten thousand dollars and up? A smaller amount or still deciding is fine too.';
const tidy=(v,n=254)=>typeof v==='string'?v.trim().slice(0,n):'';
function nextStep(i,from){
 if(!i.first_name||!i.last_name)return {key:'name',question:'May I have your first and last name?'};
 if(!/^\S+@\S+\.\S+$/.test(i.email||''))return {key:'email',question:'What is the best email address to reach you?'};
 if(!i.email_confirmed)return {key:'email_confirm',question:`Is ${i.email} your correct email address?`};
 if(!i.role)return {key:'role',question:'What best describes you: a business owner, entrepreneur, AI enthusiast, or just getting started?'};
 if(!i.classes?.length)return {key:'classes',question:'What would you like to build: AI Workflows, Your Own Apps, Custom AI CRMs, Smart Landing Pages, AI Callers, Marketing Integrations, or Custom Webinars? You can choose more than one.'};
 if(!i.goal)return {key:'goal',question:'Is your main goal to build something for your business, start a new business, offer services to clients, or learn a new skill?'};
 if(i.budget_pending)return {key:'budget_clarify',question:'When you say no budget, do you mean no money set aside, still deciding, or no fixed spending limit?'};
 if(!i.budget)return {key:'budget',question:BUDGET_QUESTION};
 if(!i.timing)return {key:'timing',question:'When would you like to start: as soon as possible, within thirty days, within one to three months, or are you just exploring?'};
 if(!i.phone_confirmed){if(i.needs_phone||!from&&!i.phone)return {key:'phone',question:'What phone number would you prefer for follow-up, including the area code?'};return {key:'phone_confirm',question:i.phone&&i.phone!==from?`Is ${i.phone.replace(/^\+1/,'')} the best number for follow-up?`:'Is the number you are calling from the best number for follow-up?'};}
 return {key:'done',question:''};
}
function applyAnswer(current,a,from){
 const i={...current};if(a.do_not_call===true){i.do_not_call=true;return i;}
 if(a.answer_clear!==true)return i;
 const step=nextStep(i,from).key;
 if(step==='name'){if(tidy(a.first_name))i.first_name=tidy(a.first_name);if(tidy(a.last_name))i.last_name=tidy(a.last_name);}
 if(['email','email_confirm'].includes(step)){if(/^\S+@\S+\.\S+$/.test(a.email||'')&&a.email!==i.email){i.email=tidy(a.email);i.email_confirmed=false;}else if(step==='email_confirm'&&a.email_confirmed===true)i.email_confirmed=true;}
 if(step==='role'&&tidy(a.role))i.role=tidy(a.role);
 if(step==='classes'&&Array.isArray(a.classes)){const v=[...new Set(a.classes.filter(v=>SERVICES.includes(v)))];if(v.length)i.classes=v;}
 if(step==='goal'&&GOALS.includes(a.goal))i.goal=a.goal;
 if(['budget','budget_clarify'].includes(step)){
  const value=tidy(a.budget),ambiguous=/^(?:i (?:do not|don't) have (?:a )?budget|no budget|none)$/i.test(value);
  if(a.budget_meaning==='none'){i.budget='No money allocated';delete i.budget_pending;}
  else if(a.budget_meaning==='unknown'){i.budget='Still deciding';delete i.budget_pending;}
  else if(a.budget_meaning==='unlimited'){i.budget='No fixed spending limit';delete i.budget_pending;}
  else if(ambiguous){i.budget_pending=true;delete i.budget;}
  else if(value){i.budget=value;delete i.budget_pending;}
 }
 if(step==='timing'&&tidy(a.timing))i.timing=tidy(a.timing);
 if(['phone','phone_confirm'].includes(step)){
  const digits=String(a.phone||'').replace(/\D/g,'');const n=digits.length===10?'+1'+digits:'+'+digits;
  if(/^\+1[2-9]\d{9}$/.test(n)&&n!==i.phone){i.phone=n;i.phone_confirmed=false;delete i.needs_phone;}
  else if(a.phone_confirmed===true&&i.phone){i.phone_confirmed=true;delete i.needs_phone;}
  else if(a.use_incoming_number===true&&from){i.phone=from;i.phone_confirmed=true;delete i.needs_phone;}
  else if(a.use_incoming_number===false)i.needs_phone=true;
 }
 return i;
}
function summary(i){return [`Name: ${[i.first_name,i.last_name].filter(Boolean).join(' ')}`,`Role: ${i.role||'Not provided'}`,`Interests: ${(i.classes||[]).join(', ')||'Not provided'}`,`Goal: ${i.goal||'Not provided'}`,`Learning/building budget: ${i.budget||'Not provided'}`,`Timing: ${i.timing||'Not provided'}`,`Email: ${i.email||'Not provided'}${i.email_confirmed?' (confirmed)':''}`,`Phone: ${i.phone||'Not provided'}${i.phone_confirmed?' (confirmed)':''}`,i.do_not_call?'Caller requested no further calls.':''].filter(Boolean).join('. ');}
const isHesitation=t=>/^(?:um+|uh+|erm+|hmm+|ah+)[\s,.!?]*$/i.test(t.trim());
module.exports={SERVICES,GOALS,BUDGET_QUESTION,nextStep,applyAnswer,summary,isHesitation};
