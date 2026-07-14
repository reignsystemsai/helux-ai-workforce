const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldInterrupt, isListeningAcknowledgement } = require("../src/realtime/interruption-manager");
const { semanticTurnDelay } = require("../src/realtime/turn-manager");

test("4 meaningful customer statement interrupts Daisy", () => assert.equal(shouldInterrupt({ transcript: "Wait, that income changed" }), true));
test("5 uh-huh while Daisy speaks is a listening cue, not an interruption", () => {
  assert.equal(isListeningAcknowledgement("uh-huh"), true);
  assert.equal(shouldInterrupt({ transcript: "uh-huh", speechDurationMs: 900 }), false);
});
test("financial recall receives a longer semantic completion window", () => assert.ok(semanticTurnDelay("Let me think about my debt payment") > semanticTurnDelay("yes")));
