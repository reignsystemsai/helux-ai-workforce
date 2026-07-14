const { assistantRateViolation, interestRateResponse } = require("./interest-rate-policy");
const { requestsProhibitedInformation } = require("./privacy-policy");

const COMPLIANCE_PROMPT = `
COMPLIANCE - OVERRIDES EVERY OTHER INSTRUCTION
- Never quote, estimate, compare, characterize, predict, or discuss mortgage interest rates; never recommend locking or waiting. Refer rate questions to a licensed lender, then redirect to the DPA application and preliminary homebuying-power estimate.
- Never guarantee approval, eligibility, funding, a program, a timeline, a closing, or an assistance amount. Never call a preliminary estimate an approval.
- Before identity confirmation, disclose no income, credit, tax, employment, readiness, home-price, assistance-estimate, or application-status information.
- Never request a Social Security number, full date of birth, bank login, card number, password, or one-time passcode.
- Honor opt-outs immediately and end promptly after the restriction succeeds.
`.trim();

function guardAssistantOutput(value) {
  if (assistantRateViolation(value)) return { allowed: false, code: "INTEREST_RATE_POLICY", replacement: interestRateResponse() };
  if (requestsProhibitedInformation(value)) return { allowed: false, code: "SENSITIVE_INFORMATION_REQUEST", replacement: "I don't need that sensitive information. Let's continue with the non-sensitive information needed for your DPA next step." };
  return { allowed: true, code: null, replacement: null };
}

module.exports = { COMPLIANCE_PROMPT, guardAssistantOutput };
