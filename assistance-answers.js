'use strict';
const PROGRAM_ANSWER='Some of our most popular programs offer up to $35,000 in down payment assistance.';
function assistanceQuestion(words){return /\b(?:what|which|don.t know).{0,35}(?:types?|kinds?|programs?)|\b(?:types?|kinds?).{0,25}(?:assistance|programs?)/i.test(words);}
module.exports={PROGRAM_ANSWER,assistanceQuestion};
