const test = require("node:test");
const assert = require("node:assert/strict");
const { interestRateResponse, assistantRateViolation } = require("../src/compliance/interest-rate-policy");
const { guardAssistantOutput } = require("../src/compliance/compliance-guardrails");

test("6 interest-rate response quotes no rate, gives no estimate or characterization, refers to lender, and redirects", () => {
  const response = interestRateResponse();
  assert.doesNotMatch(response, /\d+(?:\.\d+)?\s*%/);
  assert.doesNotMatch(response, /rates? (?:are|is) (?:high|low|good|bad)/i);
  assert.match(response, /licensed lender/i);
  assert.match(response, /DPA application.*homebuying power/i);
});
test("code-level guard blocks prohibited rate claims", () => {
  assert.equal(assistantRateViolation("Rates are low, so lock now."), true);
  assert.equal(guardAssistantOutput("I can quote a rate of 6.5%.").allowed, false);
  assert.equal(guardAssistantOutput("Your preliminary DTI is 25%.").allowed, true);
});
