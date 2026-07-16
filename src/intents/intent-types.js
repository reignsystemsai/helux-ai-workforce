const INTENTS = Object.freeze({
  SAVE_CALL_PROGRESS: "save_call_progress",
  CALCULATE_PRELIMINARY_DTI: "calculate_preliminary_dti",
  SEND_RESOURCE_LINK: "send_resource_link",
  CREATE_SPECIALIST_HANDOFF: "create_specialist_handoff",
  TRANSFER_TO_SPECIALIST: "transfer_to_specialist",
  MARK_CONTACT_RESTRICTION: "mark_contact_restriction",
  COMPLETE_CALL: "complete_call"
});

const TOOL_TO_INTENT = Object.freeze(Object.fromEntries(
  Object.entries(INTENTS).map(([intent, tool]) => [tool, intent])
));

const REALTIME_TOOLS = Object.freeze([
  tool("save_call_progress", "Save confirmed progress and an allowed conversation transition.", {
    current_state: { type: "string" }, next_state: { type: "string" }, answers: { type: "object" },
    sentiment: { type: "string", enum: ["positive", "neutral", "skeptical", "confused", "frustrated", "urgent", "excited", "hesitant", "fearful", "disappointed"] },
    notes: { type: "string" }, current_objective: { type: "string" }, last_confirmed_fact: { type: "string" }, pending_question: { type: ["string", "null"] }, next_best_action: { type: "string" }
  }, ["current_state", "next_state", "answers"]),
  tool("calculate_preliminary_dti", "Calculate a preliminary DTI planning estimate.", {
    gross_monthly_household_income: { type: "number", minimum: 1 }, monthly_recurring_debt: { type: "number", minimum: 0 }
  }, ["gross_monthly_household_income", "monthly_recurring_debt"]),
  tool("send_resource_link", "Send one approved resource after customer consent.", {
    resource_type: { type: "string", enum: ["application", "dti_calculator", "prephub", "credit_readiness", "tax_readiness", "employment_readiness"] },
    consent_confirmed: { type: "boolean" }
  }, ["resource_type", "consent_confirmed"]),
  tool("create_specialist_handoff", "Create a structured specialist handoff.", {
    reason: { type: "string" }, priority: { type: "string", enum: ["normal", "high", "urgent"] }, summary: { type: "string" }
  }, ["reason", "priority", "summary"]),
  tool("transfer_to_specialist", "Attempt a live transfer only after explicit agreement.", {
    reason: { type: "string" }, priority: { type: "string", enum: ["normal", "high", "urgent"] }, prospect_confirmed: { type: "boolean" }
  }, ["reason", "priority", "prospect_confirmed"]),
  tool("mark_contact_restriction", "Apply a wrong-number, invalid-number, opt-out, or not-interested restriction.", {
    restriction_type: { type: "string", enum: ["wrong_number", "invalid_number", "do_not_call", "not_interested"] }, reason: { type: "string" }, stop_voice: { type: "boolean" }, stop_sms: { type: "boolean" }, stop_email: { type: "boolean" }
  }, ["restriction_type", "reason", "stop_voice", "stop_sms", "stop_email"]),
  tool("complete_call", "Record the connected-call result and sequence instruction.", {
    outcome: { type: "string", enum: ["qualified", "hot_transfer", "specialist_handoff", "application_link_sent", "dti_calculator_sent", "needs_review", "nurture", "voicemail", "no_answer", "busy", "not_interested", "wrong_number", "opt_out", "disconnected", "technical_failure", "agent_notified"] },
    next_action: { type: "string" }, summary: { type: "string" }, stop_sequence: { type: "boolean" }, pause_sequence: { type: "boolean" }
  }, ["outcome", "next_action", "summary", "stop_sequence", "pause_sequence"])
]);

function tool(name, description, properties, required) {
  return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

module.exports = { INTENTS, TOOL_TO_INTENT, REALTIME_TOOLS };
