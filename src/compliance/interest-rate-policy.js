const RATE_RESPONSE = "That's a great question. Mortgage interest rates can change and depend on factors specific to the borrower and loan. Your licensed lender will review the current available rates and financing options with you.";
const RATE_REDIRECT = "What I can help you with today is preparing your DPA application and estimating your homebuying power.";

function isInterestRateQuestion(value) {
  const text = String(value || "").toLowerCase();
  return /\b(?:interest|mortgage)\s+rates?\b|\brate\s+(?:today|now|lock|quote)\b/.test(text);
}

function assistantRateViolation(value) {
  const text = String(value || "").toLowerCase();
  return /\b(?:interest\s+)?rates?\b.{0,35}\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%.{0,35}\b(?:interest\s+)?rates?\b/.test(text) ||
    /\b(?:rates?|interest rates?)\s+(?:are|is|seem|look)\s+(?:high|low|good|bad)/.test(text) ||
    /\b(?:lock|wait for|expect|predict)\b.{0,30}\brates?\b/.test(text) ||
    /\brates?\b.{0,30}\b(?:rise|fall|drop|increase|decrease)\b/.test(text);
}

function interestRateResponse() { return `${RATE_RESPONSE} ${RATE_REDIRECT}`; }
module.exports = { RATE_RESPONSE, RATE_REDIRECT, isInterestRateQuestion, assistantRateViolation, interestRateResponse };
