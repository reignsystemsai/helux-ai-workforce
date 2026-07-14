const PROHIBITED_REQUESTS = Object.freeze([
  /social security|\bssn\b/i, /full date of birth|\bdob\b/i, /bank(?:ing)? (?:login|password)/i,
  /card number/i, /password/i, /one[- ]time (?:passcode|code)|\botp\b/i
]);
const PRIVATE_FIELDS = Object.freeze(["income", "credit score", "tax", "employment", "readiness score", "home price", "assistance", "application status"]);

function requestsProhibitedInformation(value) { return PROHIBITED_REQUESTS.some((pattern) => pattern.test(String(value || ""))); }
function disclosesPrivateInformation(value) {
  const text = String(value || "").toLowerCase();
  return PRIVATE_FIELDS.some((field) => text.includes(field));
}
module.exports = { requestsProhibitedInformation, disclosesPrivateInformation, PRIVATE_FIELDS };
