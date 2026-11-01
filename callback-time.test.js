const {test}=require('node:test'),assert=require('node:assert/strict'),{callbackProposal,callbackAffirmative}=require('./callback-time');
const now=Date.parse('2026-10-20T15:00:00Z'),quote='Call me tomorrow at noon Eastern.';
test('Requested callback is converted to explicit timezone readback',()=>{const p=callbackProposal({callback_at:'2026-10-21T12:00:00-04:00',timezone:'America/New_York',client_quote:quote},[{role:'client',text:quote}],now);assert.equal(p.callback_at,'2026-10-21T16:00:00.000Z');assert.match(p.confirmation_line,/October 21, 2026/);assert.match(p.confirmation_line,/12:00 PM Eastern time/);});
test('Missing timezone, unsupported quote and past dates require clarification',()=>{const valid={callback_at:'2026-10-21T12:00:00-04:00',timezone:'America/New_York',client_quote:quote},transcript=[{role:'client',text:quote}];for(const args of [{...valid,timezone:''},{...valid,client_quote:'invented quote'},{...valid,callback_at:'2026-10-19T12:00:00Z'}])assert.throws(()=>callbackProposal(args,transcript,now));for(const answer of ['Yes.','That works for me.','Sounds good.'])assert.equal(callbackAffirmative(answer),true);for(const answer of ['Maybe.','Yes but later.','No.'])assert.equal(callbackAffirmative(answer),false);});

test('uh-huh confirms a callback while uh-uh and corrections do not',()=>{for(const a of ['Uh-huh.','Uh huh.','Mm-hmm.'])assert.equal(callbackAffirmative(a),true);for(const a of ['Uh-uh.','Uh-huh, but later.'])assert.equal(callbackAffirmative(a),false);});

test('one complete conversational confirmation is reused; partial or alternative readbacks are not',()=>{
 const {confirmedCallback}=require('./callback-time');const args={callback_at:'2026-11-30T18:00:00-05:00',timezone:'America/New_York'};
 const readback='Is the callback for November 30 at 6 PM Eastern Standard Time?';
 assert.equal(confirmedCallback(args,[{role:'daisy',text:readback},{role:'client',text:'Yes.'}]),'Yes.');
 for(const text of ['November 30 or December 1 at 6 PM Eastern?','November 30 at 5 PM Eastern?','November 30 at 6 PM Pacific?','Does that sound good?'])assert.equal(confirmedCallback(args,[{role:'daisy',text},{role:'client',text:'Yes.'}]),null);
 assert.equal(confirmedCallback(args,[{role:'daisy',text:readback},{role:'client',text:'Yes, but later.'}]),null);
});
test('explicit callback proposals may include client-selected evening times before confirmation',()=>{
 const args={callback_at:'2026-11-30T18:00:00-05:00',timezone:'America/New_York',client_quote:quote};assert.ok(callbackProposal(args,[{role:'client',text:quote}],now));assert.ok(callbackProposal({...args,callback_at:'2026-11-30T23:30:00-05:00'},[{role:'client',text:quote}],now));
});

test('one short confirmation clarification retains the existing full callback readback',()=>{const {confirmedCallback}=require('./callback-time');const args={callback_at:'2026-11-30T21:00:00-05:00',timezone:'America/New_York'};const ts=[{role:'daisy',text:'I can call you on Monday, November 30, 2026 at 9:00 PM EST. Is that correct?'},{role:'client',text:'Ja.'},{role:'daisy',text:'Just to make sure I understand you correctly, was that a yes or a no?'},{role:'client',text:'Yes.'}];assert.equal(confirmedCallback(args,ts),'Yes.');ts[1].text='Actually 4 PM.';assert.equal(confirmedCallback(args,ts),null);});

test('spoken timezone readback retains exact scheduling confirmation',()=>{const {confirmedCallback}=require('./callback-time');const args={callback_at:'2026-11-30T19:00:00-05:00',timezone:'America/New_York',client_quote:quote};const proposal=callbackProposal(args,[{role:'client',text:quote}],now);assert.match(proposal.label,/7:00 PM Eastern time/);assert.equal(confirmedCallback(args,[{role:'daisy',text:proposal.confirmation_line},{role:'client',text:'Yes.'}]),'Yes.');assert.equal(proposal.timezone,'America/New_York');});

test('callback proposals require client timezone evidence rather than a server default',()=>{const args={callback_at:'2026-11-30T19:00:00-05:00',timezone:'America/New_York',client_quote:'Call me back in a month.'};assert.throws(()=>callbackProposal(args,[{role:'client',text:args.client_quote}],now),/what time zone/);assert.doesNotThrow(()=>callbackProposal(args,[{role:'client',text:args.client_quote},{role:'daisy',text:'Are you in Eastern time?'},{role:'client',text:'Yes.'}],now));});
