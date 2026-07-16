const test = require("node:test");
const assert = require("node:assert/strict");
const { routeIntent } = require("../src/intents/intent-router");

const call = { call_id: "CALL-1", current_state: "time_check" };

test("2 wrong number routes to the contact restriction action", async () => {
  const result = await routeIntent({ toolName: "mark_contact_restriction", args: { restriction_type: "wrong_number", reason: "Wrong person", stop_voice: true, stop_sms: true, stop_email: true }, call, execute: async () => ({ success: true }) });
  assert.equal(result.success, true); assert.equal(result.intent, "MARK_CONTACT_RESTRICTION");
});
test("7 DTI request returns only a preliminary structured result", async () => {
  const result = await routeIntent({ toolName: "calculate_preliminary_dti", args: { gross_monthly_household_income: 8000, monthly_recurring_debt: 2000 }, call, execute: async () => ({ success: true, preliminary_dti_percent: 25, preliminary_dti_classification: "strong_preliminary_range", internal_id: "secret" }) });
  assert.equal(result.data.preliminary_dti_percent, 25); assert.equal(result.data.internal_id, undefined);
});
test("8 SMS success permits a customer-safe delivery confirmation", async () => {
  const result = await routeIntent({ toolName: "send_resource_link", args: { resource_type: "dti_calculator", consent_confirmed: true }, call, execute: async () => ({ success: true, resource_type: "dti_calculator", message_sid: "SM-secret" }) });
  assert.equal(result.success, true); assert.match(result.customer_safe_message, /sent/i); assert.equal(result.data.message_sid, undefined);
});
test("9 SMS failure never claims delivery or exposes raw provider errors", async () => {
  const result = await routeIntent({ toolName: "send_resource_link", args: { resource_type: "dti_calculator", consent_confirmed: true }, call, execute: async () => ({ success: false, error: "Twilio stack trace and token" }) });
  assert.equal(result.success, false); assert.equal(result.customer_safe_message, null); assert.doesNotMatch(JSON.stringify(result), /Twilio|token|stack trace/);
});
test("18 opt-out routes immediately to contact restriction", async () => {
  const result = await routeIntent({ toolName: "mark_contact_restriction", args: { restriction_type: "do_not_call", reason: "Customer opted out", stop_voice: true, stop_sms: true, stop_email: true }, call, execute: async () => ({ success: true }) });
  assert.equal(result.success, true); assert.equal(result.intent, "MARK_CONTACT_RESTRICTION");
});
test("19 tool timeout returns a retryable sanitized failure", async () => {
  const result = await routeIntent({ toolName: "calculate_preliminary_dti", args: { gross_monthly_household_income: 8000, monthly_recurring_debt: 2000 }, call, execute: async () => { throw new Error("ETIMEDOUT secret"); } });
  assert.equal(result.success, false); assert.equal(result.error.retryable, true); assert.doesNotMatch(JSON.stringify(result), /ETIMEDOUT|secret/);
});
test("20 background integration failure cannot escape into the conversation result", async () => {
  const result = await routeIntent({ toolName: "save_call_progress", args: { current_state: "time_check", next_state: "roadmap", answers: {} }, call, execute: async () => ({ success: true, monday_error: "GraphQL internal failure", current_state: "time_check", next_state: "roadmap" }) });
  assert.equal(result.success, true); assert.equal(result.data.monday_error, undefined);
});
