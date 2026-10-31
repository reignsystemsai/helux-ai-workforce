const {test}=require('node:test'),assert=require('node:assert/strict');
const {callbackSuggestions,callbackNegotiation}=require('./callback-suggestions');
const now=Date.parse('2026-10-31T01:06:23Z'); // October 30 in Eastern time.
test('month suggestions use the client-local calendar date and offer a narrow window',()=>{
 const s=callbackSuggestions('Call me back in about a month in Eastern Time after 5 o’clock',now);
 assert.deepEqual(s.options.map(x=>x.date),['2026-11-30','2026-12-01']);
 assert.deepEqual(callbackSuggestions('Call me back a month from today',now).options.map(x=>x.date),['2026-11-30']);
 assert.deepEqual(callbackSuggestions('Call me back in a month',Date.parse('2027-01-31T17:00Z')).options.map(x=>x.date),['2027-02-28']);
});
test('a couple weeks means two; a few weeks offers three or four; few hours handles midnight',()=>{
 assert.deepEqual(callbackSuggestions('Call me back in a couple of weeks',now).options.map(x=>x.date),['2026-11-13']);
 assert.deepEqual(callbackSuggestions('Call me back in a few weeks',now).options.map(x=>x.date),['2026-11-20','2026-11-27']);
 const s=callbackSuggestions('Call me back in a few hours',now);assert.equal(s.options[0].at,'2026-10-31T04:06:23.000Z');assert.match(s.options[0].label,/October 31/);
 assert.equal(callbackSuggestions('Do not call me back in a month',now),null);
});
test('negotiation preserves supplied details and requires only the server confirmation',()=>{
 const n=callbackNegotiation('Call me back in about a month, Eastern time after 5',now,'America/New_York');assert.match(n.instructions,/Preserve any time or timezone/);assert.match(n.instructions,/ONE confirmation/);assert.match(n.instructions,/ALREADY in the transcript/);
});
