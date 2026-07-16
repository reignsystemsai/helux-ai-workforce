const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("legacy routes and operational tool names remain present", () => {
  for (const route of [
    "/api/v1/twilio/media",
    "/api/v1/twilio/voice",
    "/api/v1/twilio/status",
    "/api/v1/twilio/sms-status",
    "/api/v1/monday/webhook"
  ]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));

  for (const tool of [
    "save_call_progress",
    "calculate_preliminary_dti",
    "send_resource_link",
    "create_specialist_handoff",
    "transfer_to_specialist",
    "mark_contact_restriction",
    "complete_call"
  ]) assert.match(source, new RegExp(`name: ["']${tool}["']`));
});

test("legacy safety behavior includes identity, opt-out, reconnect, and monday isolation", () => {
  assert.match(source, /Hi, is \{customer_name\} available/);
  assert.match(source, /mark_contact_restriction/);
  assert.match(source, /reconnectAfterUnexpectedDisconnect/);
  assert.match(source, /monday\.com failures never block or terminate/i);
});

test("legacy realtime behavior uses manual responses and listening acknowledgement handling", () => {
  const { buildRealtimeSession } = require("../src/realtime/openai-session");
  const session = buildRealtimeSession({ model: "test", voice: "test", instructions: "test", tools: [] });
  assert.equal(session.audio.input.turn_detection.create_response, false);
  assert.equal(session.audio.input.turn_detection.interrupt_response, false);
  assert.match(source, /briefListeningAcknowledgement/);
  assert.match(source, /questionsPerTurn: 1/);
});
