'use strict';
const {booleanReply,positiveReaction}=require('./reply-clarification');
const {callbackZone}=require('./callback-relative');
const PLANS={self:{name:'Instant Prep Plan',price:'$49.97',includes:['Credit preparation priorities','DTI and student loan questions','Home affordability snapshot','Next-step checklist']},review:{name:'Agent Review + Plan',price:'$97',includes:['Everything in the preparation plan','Report and profile review','Priorities explained in plain language','Questions for your lender']},full:{name:'First-Time Homebuyer Credit Pathway',price:'$249',includes:['Personalized homebuyer roadmap','Credit, DTI and student loan priorities','Credit and affordability preparation','Follow-up and progress checkpoints']},sweep:{name:'Credit Sweep + Tradeline Assessment',price:'$599',includes:['Review of inaccurate or unverifiable items','Specialist dispute assistance','Tradeline profile assessment','Homebuying impact and next steps']}};
const BLOCKS={
 credit_intro:'{first_name}, credit can be a major hurdle when you’re preparing to buy your first home. PrepHub connects your credit preparation to that homebuying goal. I’ll be working alongside you as your personal PrepHub first-time homebuyer preparation assistant. Our focus is helping you understand the next step and keep moving toward a home. Does that sound helpful?',
 credit_overview:'Now that you’re inside PrepHub, here’s what’s available to help you. First, use the rent-cost calculator to see what you pay in rent over twelve months. Second, when you have time, gather your credit reports and use the free analysis to review possible discrepancies. You can review specific inaccuracies before starting disputes and track your progress here. You don’t need your reports in hand for this conversation.\n\nIf you’d rather have personal support, our optional preparation plans connect credit, affordability and your homebuying milestones. If you’ve tried credit repair before and felt you weren’t moving toward a home, this gives you a preparation roadmap focused on that goal. Your progress will depend on your situation and the work needed. Do you have two to three minutes now to look at the plans together, or would you prefer a callback?',
 credit_plan_overview:'The Instant Prep Plan is $49.97 for preparation priorities, an affordability snapshot and a next-step checklist. Agent Review + Plan is $97 for a personal report and profile review, explained priorities and questions for your lender.\n\nThe First-Time Homebuyer Credit Pathway is $249 for a personalized roadmap covering credit, DTI, affordability and progress checkpoints. Credit Sweep + Tradeline Assessment is $599 for specialist report review, assistance with specific inaccuracies and a tradeline profile assessment. All four prices are one-time.\n\nWhich plan would you like to know more about?',
 credit_plans:'Take a look at the four preparation plans below. Each lists its one-time price and what’s included. What questions can I answer about them?',
 credit_support_offer:'Would you like me to make a note and ask our team to follow up about the credit preparation plans?',
 credit_followup:'Your next step is {credit_next_step}. When would you like me to call you back—maybe in a few days, a few weeks, or a month?',
 credit_reports:'You can gather and upload your credit reports when you have time. Would you like to review the preparation tools and optional support plans now?',
 credit_gather:'You can come back to gather and upload your reports when you’re ready.',
 credit_tools:'You can use the rent-cost calculator, gather reports, review the free analysis, work through specific discrepancies and track your progress. Would you like to review the optional preparation plans?',
 credit_upload_offer:'You can upload your reports when you have time. Would you like to review the optional preparation plans now?',
 credit_upload:'Use Gather My Three Credit Reports when you’re ready to upload. We can review the optional preparation plans without uploading anything now.',
 credit_team_timing:'When is a good time for our team to reach you about the plan? I’ll record your preference so they can confirm availability.'
};
function planChoices(words){const s=String(words||''),matches=[];if(/instant|49[.,]97/i.test(s))matches.push('self');if(/agent|personal review|\b97(?:\.00)?\b/i.test(s))matches.push('review');if(/pathway|249/i.test(s))matches.push('full');if(/sweep|suite|tradeline|trade line|599/i.test(s))matches.push('sweep');return matches;}
function planChoice(words){const choices=planChoices(words);return choices.length===1?choices[0]:null;}
function planFacts(key){const plan=PLANS[key];return plan?plan.name+' is '+plan.price+' one-time. It includes '+plan.includes.join(', ')+'.'+(key==='sweep'?' This is a tradeline profile assessment, not an included tradeline purchase.':''):'';}
function lowEffort(words){return /\b(?:don.t|do not|can.t|cannot|no|little|less|least|minimal).{0,45}(?:time|effort|hands[ -]on|anything|myself)|\b(?:done[ -]for[ -]me|do it for me|handle it for me|hands[ -]off|someone.{0,20}(?:do|handle)|more (?:help|support))\b/i.test(words);}
function planQuestion(words){return /\b(?:plans?|pricing|prices?|cost|included|includes|information|info|details|support|options|benefits?|hands[ -]on|explain|tell me (?:more|about)|learn more|which one|what.{0,20}difference|top tier|coaching)\b/i.test(words)||!!planChoice(words);}
function waitingForTeam(words){return /\b(?:wait|waiting|expect|expected|request(?:ed)?|somebody|someone|team|response|recorded|requested)\b/i.test(words)&&/\b(?:call|contact|follow.?up|recorded|requested|response)\b/i.test(words);}
function noMoreQuestions(words){if(/^(?:no[,!. ]+)?(?:i (?:don't|do not) have (?:any|more) questions|that's (?:all|it)|everything's clear|i'm (?:good|all set))[.! ]*$/i.test(words))return true;return /^(?:(?:well|okay|ok|uh|um)[,!. ]+)*(?:no(?:pe)?(?:[,. ]+(?:thanks|thank you|that's all|that's it|i'm good|i'm all set))?|no (?:more )?questions|that.s (?:all|it)|all (?:set|clear)|nothing else|i (?:don't|do not) have (?:any|more) questions|everything.s clear|i.m good)[.! ]*$/i.test(words);}
function supportPrompt(p,line){return {stage:'credit_support_offer',scriptLine:line('credit_support_offer',p)};}
function creditFlowTurn(stage,words,p,line){
 const inCredit=stage.startsWith('credit_'),resume=stage==='callback_time'&&p.credit_active;
 if(!inCredit&&!resume)return null;if(stage==='credit_plans_questions')stage='credit_plan_questions';
 p.credit_active=true;
 const previousPlan=p.credit_selected_plan;
 const text=String(words||'').replace(/[’]/g,"'"),value=booleanReply(text),selected=planChoice(text),say=(next,scriptLine)=>({stage:next,scriptLine:scriptLine||line(next,p)});
 if(selected)p.credit_selected_plan=selected;
 const overview=()=>say('credit_plan_questions',line('credit_plan_overview',p));
 const questions=()=>say('credit_plan_questions',line('credit_plans',p));
 const close=()=>({stage:'wrapup',finishOutcome:'completed',finishReason:p.credit_support_recorded?'Credit-plan team follow-up requested; client questions addressed':'Credit preparation options reviewed; no team follow-up requested',finishNextAction:p.credit_support_recorded?'Team: review '+(PLANS[p.credit_selected_plan]?.name||'credit preparation plans')+(p.credit_preferred_window?'; preferred contact: '+p.credit_preferred_window:''):'Client may return to self-guided credit preparation; no callback arranged',finishLine:'Thank you for your time. '+(p.credit_support_recorded?'Your credit-plan follow-up request is recorded. Our team will review the details with you. ':'You can return to PrepHub anytime to use the tools and review your preparation options. ')+'I look forward to helping you with your homebuyer preparation. Have a great day. Goodbye.'});
 const checkRequest=()=>{p.credit_request_quote=text;return {stage:'credit_request_check',requiredTool:'get_prephub_status'};};
 // A genuine request to end this conversation or arrange a Daisy callback still uses the shared handlers.
 if(!['credit_team_timing','credit_team_zone'].includes(stage)&&/\b(?:call me back|give me a call back|call back later|another time|can.t talk|cannot talk|have to go|need to go)\b/i.test(text)&&!waitingForTeam(text)&&!planQuestion(text)&&!lowEffort(text))return null;
 if(waitingForTeam(text)&&!['credit_team_timing','credit_team_zone'].includes(stage))return p.credit_support_recorded&&stage==='credit_handoff_questions'?say('credit_team_timing'):checkRequest();
 if(resume){if(!planQuestion(text)&&!lowEffort(text)&&! /\b(?:right now|keep going|talk about it now)\b/i.test(text))return null;stage='credit_plan_questions';}
 if(stage==='credit_intro'){
  if(value===true||positiveReaction(text)||/sounds helpful|go ahead|tell me more/i.test(text))return say('credit_overview');
  if(value===false)return questions();
  return say(stage,'I’m sorry, I didn’t catch that. Would you like me to explain the credit preparation tools and support plans?');
 }
 if(['credit_overview','credit_reports','credit_upload_offer','credit_upload','credit_tools'].includes(stage)){
  if(lowEffort(text))return say('credit_plan_questions','If you want personal guidance, compare Agent Review + Plan at $97 and the First-Time Homebuyer Credit Pathway at $249. The pathway includes a personalized roadmap and progress checkpoints. Credit Sweep + Tradeline Assessment at $599 adds specialist support for specific report inaccuracies. Our team can confirm what support fits your situation and what you’ll need to provide. Which plan would you like to explore?');
  if(value===true||positiveReaction(text)||planQuestion(text)||/couple minutes|have.{0,15}minutes|right now|go ahead/i.test(text))return overview();
  if(value===false)return say('credit_close_offer','You can return to the tools and plans whenever you’re ready. Would you like a follow-up call to work through your next credit preparation step?');
  return say(stage,'I’m sorry, I didn’t catch that. Would you like to review the credit preparation plans now?');
 }
 if(stage==='credit_request_button'){
  if(!/\b(?:not|haven't|have not|can't|cannot|didn't|did not)\b/i.test(text)&&(/\b(?:requested|recorded|request received|clicked|selected|pressed|says|message|response|wait|done|finished|i did)\b/i.test(text)||value===true))return checkRequest();
  if(planQuestion(text))stage='credit_plan_questions';else if(/\b(?:you|team).{0,25}(?:note|request|call|contact)|rather.{0,20}(?:you|team)/i.test(text))return supportPrompt(p,line);else return say(stage,'The button says “I Want to Start This Plan.” It records a request for the team to contact you; it does not enroll you or collect payment. Let me know when it says “Requested,” or I can record a follow-up request here.');
 }
 if(stage==='credit_request_check')return checkRequest();
 if(stage==='credit_plan_questions'||stage==='credit_support_offer'){
  if(stage==='credit_support_offer'&&/\b(?:maybe|not sure|think about it|undecided)\b/i.test(text))return say('credit_plan_questions','Of course. What would you like clarified before deciding whether to request a team follow-up?');
  const compared=planChoices(text);if(compared.length>1)return say('credit_plan_questions',compared.map(planFacts).join(' ')+' Which one would you like to discuss?');
  if(/\b(?:not interested|do it myself|work through it myself)\b/i.test(text))return say('credit_close_offer','No problem. You can use the preparation tools yourself. Would you like Daisy to follow up on your next preparation step?');
  if(/\b(?:right now|keep going|talk about it now|more information|more info|tell me more)\b/i.test(text)&&!selected&&!lowEffort(text))return overview();
  if(lowEffort(text))return say('credit_plan_questions','For more personal support, Agent Review + Plan includes a personal report and profile review, while the First-Time Homebuyer Credit Pathway includes guided preparation and progress checkpoints. Credit Sweep + Tradeline Assessment includes specialist dispute assistance for specific inaccuracies. You’ll still need to provide information and review decisions. Our team can confirm the service scope before you start. Which of those plans would you like to discuss?');
  if(selected&&p.credit_support_recorded&&selected===previousPlan)return say('credit_handoff_questions',planFacts(selected)+' What other questions can I answer before we arrange the team follow-up?');
  if(selected){p.credit_next_step='reviewing '+PLANS[selected].name+' with our team';return say('credit_request_button',planFacts(selected)+' If you’d like the team to discuss it with you, click “I Want to Start This Plan.” That records a follow-up request, not enrollment or payment. Let me know when it says “Requested.”');}
  if(/\b(?:guarantee|how (?:fast|long)|months?|score|rapid|repair|delete|coaching|top tier)\b/i.test(text))return say('credit_plan_questions','The plans list specific preparation and review services. There is no guaranteed score increase, deletion or completion timeline. Our goal is to help you address the next homebuying milestone. Which named plan would you like me to explain?');
  if(planQuestion(text))return overview();
  if(stage==='credit_support_offer'&&(value===true||/\b(?:please do|have.{0,20}team|contact me|reach out|interested)\b/i.test(text)&&! /\b(?:not|don't|do not|maybe|not sure)\b/i.test(text))){p.credit_support_recorded=true;return {...say('credit_handoff_questions','I’ll record your interest and request a team follow-up. What other questions can I answer about the plans before we wrap up?'),creditInterest:{requested:true,fulfilled:false,plan_key:p.credit_selected_plan||null,client_quote:text,request_prompt:line('credit_support_offer',p),source:'client_confirmation'}};}
  if(stage==='credit_support_offer'&&value===false)return say('credit_close_offer','No problem. Would you like a Daisy follow-up for your self-guided credit preparation?');
  if(noMoreQuestions(text)||value===true||positiveReaction(text))return supportPrompt(p,line);
  return say('credit_plan_questions','Which plan or benefit would you like me to explain? You can also tell me whether you prefer self-guided tools or personal support.');
 }
 if(stage==='credit_handoff_questions'){
  if(noMoreQuestions(text)||value===false)return say('credit_team_timing');
  if(planQuestion(text)||lowEffort(text)){stage='credit_plan_questions';return creditFlowTurn(stage,text,p,line);}
  return say(stage,'What other question can I answer about the plan before we arrange the team follow-up?');
 }
 if(stage==='credit_team_timing'){
  if(planQuestion(text)||lowEffort(text))return creditFlowTurn('credit_plan_questions',text,p,line);
  if(/\b(?:not sure|don.t know|do not know|anytime|any time|whenever)\b/i.test(text)){p.credit_preferred_window=text;return {...close(),creditTiming:{preferred_window:text,window_quote:text,timezone:null,appointment_confirmed:false}};}
  if(!/\b(?:today|tomorrow|next|week|month|day|morning|afternoon|evening|tonight|after|before|around|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d/i.test(text))return say(stage,line('credit_team_timing',p));
  p.credit_preferred_window=text;const zone=callbackZone(text);if(zone)return {...close(),creditTiming:{preferred_window:text,window_quote:text,timezone:zone,appointment_confirmed:false}};
  return say('credit_team_zone','What time zone are you in, so I can include that with your preferred contact time?');
 }
 if(stage==='credit_team_zone'){const zone=callbackZone(text);if(!zone)return say(stage,'What city and state are you in? I can use that to identify the time zone.');return {...close(),creditTiming:{preferred_window:p.credit_preferred_window||'Not specified',window_quote:p.credit_preferred_window||'',timezone:zone,timezone_quote:text,appointment_confirmed:false}};}
 if(stage==='credit_close_offer'){if(value===false||noMoreQuestions(text))return close();if(value===true)return say('callback_time',line('credit_followup',p));if(planQuestion(text)||lowEffort(text))return creditFlowTurn('credit_plan_questions',text,p,line);return say(stage,'Would you like a follow-up call, or would you prefer to return to PrepHub on your own?');}
 return questions();
}
function creditRequestTurn(output,p,line){
 const request=output?.credit_plan_request,key=request?.plan_key;
 if(request?.status==='follow_up_needed'&&PLANS[key]&&(!p.credit_selected_plan||p.credit_selected_plan===key)){p.credit_selected_plan=key;p.credit_support_recorded=true;p.credit_next_step='reviewing '+PLANS[key].name+' with our team';return {stage:'credit_handoff_questions',scriptLine:'I can see your request for '+PLANS[key].name+' is saved. That is a request for a team follow-up, not enrollment or payment. The team can go over the details with you. What questions can I answer before we wrap up?',creditInterest:{requested:true,fulfilled:false,plan_key:key,client_quote:p.credit_request_quote||'',source:'saved_plan_request',requested_at:request.requested_at}};}
 return {stage:'credit_support_offer',scriptLine:'I couldn’t verify a saved plan request yet. '+line('credit_support_offer',p)};
}
module.exports={PLANS,BLOCKS,creditFlowTurn,creditRequestTurn,planChoice,lowEffort,waitingForTeam};
