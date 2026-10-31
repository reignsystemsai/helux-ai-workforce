const {cleanCallerText,sectionPrompt,LOGIN_LINE}=require('./guided-access');
'use strict';
const terminal=s=>['completed','failed','no-answer','busy','canceled'].includes(s);
function recoveryDecision(call){
 const p=call.payload||{},r=call.result||{},turns=call.transcript||[];
 if(p.disconnect_recovery_policy!==1||!terminal(call.status)||r.owner_ended_call||r.normal_end_requested||r.duration_wrapup||r.stop_calls||r.callback_schedule?.scheduled||r.outcome)return null;
 if(turns.some(t=>t.role==='client'&&/\b(?:stop calling|do not call|don't call|remove me|wrong number|goodbye|bye|hang up|getting off|come back when|come back whenever|return when|have to go|got to go|need to go|can't talk|cannot talk|not interested)\b/i.test(t.text||'')))return null;
 const recovery=p.disconnect_recovery;
 if(recovery?.attempt===1)return {policy:1,operation:'email',root_action_id:recovery.root_action_id};
 if(call.status!=='completed'&&call.status!=='failed')return null;
 if(turns.filter(t=>t.role==='client'&&String(t.text||'').trim()).length<2||!r.recovery_checkpoint)return null;
 return {policy:1,operation:'call',root_action_id:call.action_id};
}
function recoveryOpening(p){const name=String(p.first_name||'').trim();return 'Hi'+(name?', '+name:'')+'. This is Daisy with the DPA Help Center. It looks like we got disconnected. '+(name?'Is this '+name+' speaking?':'Am I speaking with the person I was just talking with?');}
function resumeCheckpoint(p){const cp=p.disconnect_recovery?.checkpoint;if(!cp||typeof cp.stage!=='string'||cp.stage==='wrapup')return null;if(cp.stage==='tax_login')return {stage:'tax_section_navigation',scriptLine:sectionPrompt('taxes')};if(cp.stage==='login_confirm')return {stage:'section_status',instructions:'Call get_prephub_status and guide the relevant section by its actual heading.'};if(cp.stage==='login')return {stage:'email_login',scriptLine:LOGIN_LINE};return {stage:cp.stage,scriptLine:cleanCallerText(cp.script_line)||null,instructions:cp.instructions||'Continue from the last unanswered question in the approved script. Do not repeat the introduction.',pendingCallback:cp.pending_callback||null,relativeCallback:cp.relative_callback||null};}
module.exports={recoveryDecision,recoveryOpening,resumeCheckpoint};
