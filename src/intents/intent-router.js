const { TOOL_TO_INTENT } = require("./intent-types");
const { validateIntent } = require("./intent-validator");
const { success, failure } = require("../actions/action-result");
const { MESSAGES } = require("../actions/action-messages");

const handlers = Object.freeze({
  send_resource_link: require("../actions/send-resource-link"), schedule_callback: require("../actions/schedule-callback"),
  save_call_progress: require("../actions/save-call-progress"), calculate_preliminary_dti: require("../actions/calculate-dti"),
  create_specialist_handoff: require("../actions/specialist-handoff"), transfer_to_specialist: require("../actions/transfer-specialist"),
  mark_contact_restriction: require("../actions/contact-restriction"), complete_call: require("../actions/complete-call"),
  record_application_checkpoint: require("../actions/record-application-checkpoint")
});

function publicData(result = {}) {
  const allowed = ["resource_type", "preliminary_dti_percent", "preliminary_dti_classification", "callback_at", "timezone", "outcome", "sequence_status", "next_attempt_at", "saved_fields", "current_state", "next_state", "confirmation_sms_sent"];
  return Object.fromEntries(allowed.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}

async function routeIntent({ toolName, args, call, execute }) {
  const intent = TOOL_TO_INTENT[toolName] || "UNKNOWN_INTENT";
  const validation = validateIntent(toolName, args, call || {});
  if (!validation.valid) return failure(intent, validation.error.code, validation.error.retryable);
  try {
    const raw = await handlers[toolName](execute, call, args);
    if (!raw || raw.success !== true) return failure(intent, `${intent}_FAILED`, raw?.retryable === true);
    return success(intent, MESSAGES[intent], publicData(raw));
  } catch {
    return failure(intent, `${intent}_FAILED`, true);
  }
}

module.exports = { routeIntent, publicData };
