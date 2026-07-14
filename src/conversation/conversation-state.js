const STATES = Object.freeze([
  "identity_verification", "introduction", "trust_confirmation", "time_check",
  "roadmap", "need", "dpa_education", "knowledge_discovery",
  "timeline_discovery", "realtor_discovery", "lender_discovery", "urgency",
  "dti_offer", "dti_in_progress", "application_next_step",
  "callback_scheduling", "follow_up", "nurture", "specialist_handoff",
  "closing", "completed"
]);

const NEXT = Object.freeze({
  identity_verification: ["introduction", "closing"],
  introduction: ["trust_confirmation", "closing"],
  trust_confirmation: ["time_check", "closing"],
  time_check: ["roadmap", "callback_scheduling", "closing"],
  roadmap: ["need", "closing"],
  need: ["dpa_education", "closing"],
  dpa_education: ["knowledge_discovery", "timeline_discovery", "closing"],
  knowledge_discovery: ["dpa_education", "timeline_discovery", "closing"],
  timeline_discovery: ["realtor_discovery", "nurture", "closing"],
  realtor_discovery: ["lender_discovery", "closing"],
  lender_discovery: ["urgency", "closing"],
  urgency: ["dti_offer", "application_next_step", "nurture", "closing"],
  dti_offer: ["dti_in_progress", "callback_scheduling", "application_next_step", "closing"],
  dti_in_progress: ["application_next_step", "callback_scheduling", "closing"],
  application_next_step: ["callback_scheduling", "specialist_handoff", "closing"],
  callback_scheduling: ["closing", "completed"],
  follow_up: ["application_next_step", "callback_scheduling", "nurture", "closing"],
  nurture: ["callback_scheduling", "closing", "completed"],
  specialist_handoff: ["closing", "completed"],
  closing: ["completed"]
});

const LEGACY_ALIASES = Object.freeze({
  greeting: "identity_verification",
  readiness_confirmation: "trust_confirmation",
  qualification: "timeline_discovery",
  application_checkpoint: "follow_up",
  application_link_sent: "application_next_step",
  reconnect_pending: "identity_verification",
  reconnect_in_progress: "identity_verification"
});

function normalizeState(value) {
  const state = String(value || "").trim().toLowerCase();
  return LEGACY_ALIASES[state] || (STATES.includes(state) ? state : null);
}

function canTransition(from, to, options = {}) {
  const current = normalizeState(from);
  const next = normalizeState(to);
  if (!current || !next) return options.allowLegacy !== false;
  if (current === next || next === "closing") return true;
  return (NEXT[current] || []).includes(next);
}

function normalizeTimeline(value) {
  const text = String(value || "").toLowerCase().replace(/[–—]/g, "-");
  if (/30\s*(?:-|to)\s*60/.test(text)) return "30-60 days";
  if (/60\s*(?:-|to)\s*90/.test(text)) return "60-90 days";
  if (/within\s+(?:six|6)\s+months?|[3-6]\s+months?/.test(text)) return "Within six months";
  if (/more than\s+(?:six|6)|over\s+(?:six|6)|[7-9]|1[0-2]\s+months?|next year/.test(text)) return "More than six months";
  return null;
}

function createConversationState(saved = {}) {
  return {
    current_stage: normalizeState(saved.current_stage || saved.current_state) || "identity_verification",
    current_objective: saved.current_objective || "Verify the customer's identity",
    last_confirmed_fact: saved.last_confirmed_fact || null,
    pending_question: saved.pending_question || saved.pending_question_text || null,
    next_best_action: saved.next_best_action || saved.next_action || "Continue the current objective",
    confirmed_answers: { ...(saved.confirmed_answers || saved.result || {}) }
  };
}

module.exports = { STATES, NEXT, normalizeState, canTransition, normalizeTimeline, createConversationState };
