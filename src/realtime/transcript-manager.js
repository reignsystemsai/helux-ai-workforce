function createResumeSnapshot(call = {}) {
  return { current_state: call.current_state || null, pending_question: call.pending_question_text || null, confirmed_answers: { ...(call.result || {}) }, summary: call.summary || null, next_intended_action: call.next_action || null };
}
module.exports = { createResumeSnapshot };
