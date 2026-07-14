const test = require("node:test");
const assert = require("node:assert/strict");
const { createResumeSnapshot } = require("../src/realtime/transcript-manager");

test("16 unexpected disconnect snapshot preserves state, pending question, facts, summary, and next action", () => {
  const snapshot = createResumeSnapshot({ current_state: "realtor_discovery", pending_question_text: "Have you started working with a Realtor?", result: { time_frame: "30 - 60" }, summary: "Timeline confirmed", next_action: "Confirm Realtor status" });
  assert.deepEqual(Object.keys(snapshot), ["current_state", "pending_question", "confirmed_answers", "summary", "next_intended_action"]);
  assert.equal(snapshot.current_state, "realtor_discovery"); assert.equal(snapshot.confirmed_answers.time_frame, "30 - 60");
});
