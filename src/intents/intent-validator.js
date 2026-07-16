const { TOOL_TO_INTENT } = require("./intent-types");
const { canTransition } = require("../conversation/conversation-state");

function fail(code, retryable = false) { return { valid: false, error: { code, retryable } }; }

function validateIntent(toolName, args = {}, context = {}) {
  if (!TOOL_TO_INTENT[toolName]) return fail("UNKNOWN_INTENT");
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("INVALID_ARGUMENTS");
  if (toolName === "send_resource_link" && args.consent_confirmed !== true) return fail("SMS_CONSENT_REQUIRED");
  if (toolName === "transfer_to_specialist" && args.prospect_confirmed !== true) return fail("TRANSFER_CONFIRMATION_REQUIRED");
  if (toolName === "create_confirmed_appointment" && args.prospect_confirmed !== true) return fail("APPOINTMENT_CONFIRMATION_REQUIRED");
  if (toolName === "save_call_progress" && !canTransition(context.current_state || args.current_state, args.next_state, { allowLegacy: true })) return fail("INVALID_STATE_TRANSITION");
  return { valid: true, intent: TOOL_TO_INTENT[toolName], error: null };
}

module.exports = { validateIntent };
