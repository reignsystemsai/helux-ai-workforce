'use strict';
const {booleanReply,positiveReaction,realQuestion}=require('./reply-clarification');
const PLANS={self:{name:'Instant Prep Plan',price:'$49.97',includes:['Credit preparation priorities','DTI and student loan questions','Home affordability snapshot','Next-step checklist']},review:{name:'Agent Review + Plan',price:'$97',includes:['Everything in the preparation plan','Report and profile review','Priorities explained in plain language','Questions for your lender']},full:{name:'First-Time Homebuyer Credit Pathway',price:'$249',includes:['Personalized homebuyer roadmap','Credit, DTI and student loan priorities','Credit and affordability preparation','Follow-up and progress checkpoints']},sweep:{name:'Credit Sweep + Tradeline Assessment',price:'$599',includes:['Review of inaccurate or unverifiable items','Specialist dispute assistance','Tradeline profile assessment','Homebuying impact and next steps']}};
const BLOCKS={credit_reports:'Go ahead and open “Gather My Three Credit Reports.” Do you already have any of your credit reports available?',credit_upload_offer:'Excellent. You can upload the reports you have here. Would you like to work through that together now?',credit_upload:'Use the upload control in Gather My Three Credit Reports to choose the report you have. Let me know when the upload is complete.',credit_gather:'No problem. Gathering your reports will be your first step. You can return here to upload them when you have them.',credit_tools:'You can start with the rent-cost calculator to see what you pay in rent over twelve months. Gather your three credit reports, then use the free analysis to review possible discrepancies. You can review specific inaccuracies before starting disputes and use Track Your Progress to follow your preparation. Would you like to hear about the preparation plans if you want more help?',credit_plans:'If you don’t have the time to work through this yourself, or you’ve used a credit repair service you weren’t happy with, take a look at the preparation plans below. Each lists its price and what’s included. While you’re looking at those plans, what questions can I answer for you?',credit_support_offer:'Would you like me to make a note and ask our team to follow up about the credit preparation plans?',credit_followup:'Your next step is {credit_next_step}. When would you like me to call you back—maybe in a few days, a few weeks, or a month?'};
function planChoice(words){const s=String(words||'');return /sweep|suite|tradeline|599/i.test(s)?'sweep':/pathway|249/i.test(s)?'full':/agent|personal review|\b97(?:\.00)?\b/i.test(s)?'review':/instant|49[.,]97/i.test(s)?'self':null;}
function creditFlowTurn(stage,words,p,line){
 if(!stage.startsWith('credit_'))return null;
 const value=booleanReply(words),question=realQuestion(words),say=(next,text)=>({stage:next,scriptLine:text||line(next,p)}),follow=()=>say('callback_time',line('credit_followup',p));
 const selected=planChoice(words);if(selected)p.credit_selected_plan=selected;
 const answerPlans=()=>({stage:'credit_support_offer',instructions:'Answer only the client’s actual question briefly using this approved catalog: '+JSON.stringify(PLANS)+'. All prices are one-time. Do not invent discounts, guarantees, service timelines, enrollment or payments. The tradeline plan is an assessment, not a tradeline purchase. If the question is unspecified, ask which question they have and listen. After answering a specific question, ask exactly: '+line('credit_support_offer',p)});
 if(stage==='credit_reports'){
  if(question)return {stage,instructions:'Answer the client’s actual report-access question briefly using the actual page controls; never claim reports are uploaded. Then clarify whether they already have any reports available.'};
  if(value===false||/don.t have|do not have|need to get|no reports/i.test(words)){p.credit_next_step='gathering your credit reports';return say('credit_tools',line('credit_gather',p)+' '+line('credit_tools',p));}
  if(value===true||/^(?:they|it)(?: are|'re| is|'s)? (?:on|in) my (?:phone|computer)/i.test(words)||/\b(?:experian|equifax|transunion|reports?.{0,20}(?:phone|computer)|have.{0,20}report)\b/i.test(words)){p.credit_next_step='uploading your available credit reports';return say('credit_upload_offer');}
  return say(stage,'Do you already have a credit report available, or do you still need to get one?');
 }
 if(stage==='credit_upload_offer')return value===true?say('credit_upload'):value===false?say('credit_tools'):{stage,instructions:'Address the actual upload question briefly, then ask whether they want help uploading now. Never request private report details aloud.'};
 if(stage==='credit_upload'){
  if(/\b(?:not|haven.t|have not|can.t|cannot|error|failed|trying|need to)\b/i.test(words))return {stage,instructions:'Address the reported upload difficulty. Do not claim success. Offer to continue later if needed.'};
  if(value===true||/uploaded|upload is complete|finished|done/i.test(words)){p.credit_next_step='reviewing your credit-report findings';return say('credit_tools','Thank you. Once your upload is saved, you can review the analysis. '+line('credit_tools',p));}
  return {stage,instructions:'Respond to the actual upload question or ask whether the upload finished. Client-reported completion is not verified visibility.'};
 }
 if(stage==='credit_tools')return value===false?follow():value===true||positiveReaction(words)?say('credit_plans_questions',line('credit_plans',p)):{stage,instructions:'Answer the actual credit-tool question within the approved preparation scope. Then ask whether they would like to hear about the optional preparation plans.'};
 if(stage==='credit_plans_questions'){
  if(question)return answerPlans();
  if(/\b(?:no questions|nope|nothing|all clear|makes sense|sounds good|not interested|do it myself)\b/i.test(words))return /not interested|do it myself/i.test(words)?follow():say('credit_support_offer');
  return say('credit_support_offer');
 }
 if(stage==='credit_support_offer'){
  if(question)return answerPlans();
  if(value===true||/\b(?:interested|have (?:the |your )?team|reach out|contact me|like.{0,15}help|want.{0,20}(?:plan|review|pathway|assessment))\b/i.test(words)&&! /\b(?:not|don't|do not)\b/i.test(words))return {...say('callback_time','I’ll note your interest and request a team follow-up. '+line('credit_followup',p)),creditInterest:{plan_key:p.credit_selected_plan||null,client_quote:String(words),request_prompt:line('credit_support_offer',p),requested:true,fulfilled:false}};
  if(value===false||/myself|not interested|no thanks/i.test(words))return follow();
  return say(stage,'Would you like our team to follow up with you about these plans?');
 }
 return null;
}
module.exports={PLANS,BLOCKS,creditFlowTurn,planChoice};
