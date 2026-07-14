const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, normalizeTimeline, createConversationState } = require("../src/conversation/conversation-state");
const { spokenFacts } = require("../src/conversation/daisy-script");
const { buildSystemPrompt } = require("../src/conversation/system-prompt");

test("1 correct customer answer can continue to the next journey state", () => assert.equal(canTransition("identity_verification", "introduction"), true));
test("10 timeline normalizes 30-60 days", () => assert.equal(normalizeTimeline("about 30 to 60 days"), "30-60 days"));
test("11 timeline normalizes more than six months for nurture", () => assert.equal(normalizeTimeline("probably 9 months from now"), "More than six months"));
test("12 Realtor status is retained as an early confirmed answer", () => assert.equal(createConversationState({ result: { has_realtor: "Yes" } }).confirmed_answers.has_realtor, "Yes"));
test("13 lender status is retained as an early confirmed answer", () => assert.equal(createConversationState({ result: { applied_with_lender: "Yes" } }).confirmed_answers.applied_with_lender, "Yes"));
test("14 changed income is spoken from the current supplied value without placeholders", () => {
  const facts = spokenFacts({ household_income: "$8,000 monthly" });
  assert.deepEqual(facts, ["household income of approximately $8,000 monthly"]);
  assert.doesNotMatch(facts.join(" "), /not provided|undefined|null/i);
});
test("17 reconnect prompt resumes saved state instead of restarting intake", () => {
  const prompt = buildSystemPrompt({ current_state: "reconnect_pending", next_action: "Ask Realtor status", result: { time_frame: "30 - 60" }, payload: { first_name: "Ava" } });
  assert.match(prompt, /got disconnected/i);
  assert.match(prompt, /Resume the saved objective/i);
  assert.match(prompt, /Ask Realtor status/);
});
