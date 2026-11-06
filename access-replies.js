'use strict';
function accessReply(words){
 const text=String(words||'').replace(/[’]/g,"'").trim().replace(/^(?:(?:um|uh|well|oh)[,!. ]+)+/i,'');
 const waiting=/\b(?:not yet|not ready|not done|not in|haven't|have not|can't|cannot|don't|do not|still looking|looking for|trying|going to|need to|ready to(?! go\b)|about to|let me|i'll|i will)\b/i.test(text)&&!/no problem/i.test(text);
 const ready=!waiting&&/^(?:(?:yes|yeah|yep|yup|okay|ok|sure)[,!. ]+)?(?:(?:i(?:'m| am)|we(?:'re| are)) (?:ready|in|done|finished|all set|there|good to go)|ready|done|finished|all set|got it|there it is|good to go|ready to go|it(?:'s| is) open|i have it open|i've got it|ready when you are)(?: now)?[.! ]*$/i.test(text);
 const loggedIn=!waiting&&/\b(?:logged in|signed in|(?:in|inside) (?:my )?prep\s*hub)\b/i.test(text);
 const acknowledgment=/^(?:(?:okay|ok)[,!. ]+)?(?:thank you|thanks|thank you very much|thanks a lot)[.! ]*$/i.test(text);
 return {ready,loggedIn,acknowledgment,waiting};
}
module.exports={accessReply};
