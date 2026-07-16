const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CALLBACKS,
  SchedulingError,
  normalizeTimezone,
  localDateTimeToUtc,
  createConfirmedAppointment
} = require("../src/scheduling/confirmed-appointment");
const { REALTIME_TOOLS } = require("../src/intents/intent-types");
const { routeIntent } = require("../src/intents/intent-router");

function fakePool(options = {}) {
  const calls = [];
  const sourceCall = {
    call_id: "CALL-1",
    request_key: "lead:L-1",
    case_id: "CASE-1",
    lead_id: "LEAD-1",
    result: options.result || {},
    payload: options.payload || {}
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT \* FROM ai_calls WHERE call_id = \$1 FOR UPDATE/.test(text)) {
        return { rows: options.missingCall ? [] : [sourceCall], rowCount: options.missingCall ? 0 : 1 };
      }
      if (/SELECT result, payload FROM ai_calls/.test(text)) {
        return { rows: options.priorRows || [], rowCount: (options.priorRows || []).length };
      }
      if (/INSERT INTO scheduled_appointments/.test(text)) {
        return options.duplicate ? { rows: [], rowCount: 0 } : { rows: [{ appointment_id: params[0] }], rowCount: 1 };
      }
      if (/SELECT COALESCE\(MAX\(attempt_number\)/.test(text)) return { rows: [{ next_number: "2" }], rowCount: 1 };
      if (/INSERT INTO call_attempts/.test(text) || /UPDATE ai_calls SET timezone/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${text}`);
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); }
  };
  return { calls, connect: async () => client };
}

function validInput(overrides = {}) {
  return {
    customer_local_date: "2099-07-23",
    customer_local_time: "3:00 PM",
    timezone: "America/New_York",
    timezone_label: "Eastern",
    callback_type: "call_one_rescheduled",
    callback_reason: CALLBACKS.call_one_rescheduled.reason,
    prospect_confirmed: true,
    source_call_id: "CALL-1",
    discussion_summary: "Customer requested a later time.",
    ...overrides
  };
}

test("new scheduling tool is available to Daisy with every required field", () => {
  const definition = REALTIME_TOOLS.find((tool) => tool.name === "create_confirmed_appointment");
  assert.ok(definition);
  assert.deepEqual(definition.parameters.required, [
    "customer_local_date", "customer_local_time", "timezone", "timezone_label",
    "callback_type", "callback_reason", "prospect_confirmed", "source_call_id",
    "discussion_summary"
  ]);
});

test("Eastern local date and time convert to the correct future UTC datetime", () => {
  const value = localDateTimeToUtc("2099-07-23", "3:00 PM", "America/New_York");
  assert.equal(value.callbackAt.toISOString(), "2099-07-23T19:00:00.000Z");
  assert.equal(value.localTime, "15:00");
});

test("unsupported and mismatched timezones are rejected", () => {
  assert.throws(() => normalizeTimezone("America/Phoenix", "Mountain"), SchedulingError);
  assert.throws(() => normalizeTimezone("America/New_York", "Pacific"), /do not match/);
  assert.throws(() => normalizeTimezone("Eastern", "Pacific"), /do not match/);
});

test("appointment creation requires explicit true confirmation before any transaction", async () => {
  const pool = fakePool();
  await assert.rejects(
    createConfirmedAppointment({ pool, input: validInput({ prospect_confirmed: "yes" }) }),
    (error) => error.code === "CONFIRMATION_REQUIRED"
  );
  assert.equal(pool.calls.length, 0);
  const routed = await routeIntent({
    toolName: "create_confirmed_appointment",
    args: validInput({ prospect_confirmed: false }),
    call: { call_id: "CALL-1" },
    execute: async () => ({ success: true })
  });
  assert.equal(routed.success, false);
  assert.equal(routed.error.code, "APPOINTMENT_CONFIRMATION_REQUIRED");
});

test("past appointments roll back without creating an appointment or attempt", async () => {
  const pool = fakePool();
  await assert.rejects(
    createConfirmedAppointment({
      pool,
      input: validInput({ customer_local_date: "2020-01-01" }),
      now: new Date("2026-07-16T12:00:00Z")
    }),
    (error) => error.code === "APPOINTMENT_NOT_FUTURE"
  );
  assert.ok(pool.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(pool.calls.some((call) => /INSERT INTO scheduled_appointments/.test(call.sql)), false);
  assert.equal(pool.calls.some((call) => /INSERT INTO call_attempts/.test(call.sql)), false);
});

test("duplicate appointment is blocked and the transaction rolls back before an attempt is created", async () => {
  const pool = fakePool({ duplicate: true });
  await assert.rejects(
    createConfirmedAppointment({ pool, input: validInput() }),
    (error) => error.code === "DUPLICATE_APPOINTMENT"
  );
  assert.ok(pool.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(pool.calls.filter((call) => /INSERT INTO call_attempts/.test(call.sql)).length, 0);
});

test("Call One reschedule saves CRM details and exactly one pending future attempt", async () => {
  const pool = fakePool();
  const saved = await createConfirmedAppointment({ pool, input: validInput() });
  assert.equal(saved.success, true);
  assert.equal(saved.callback_type, "call_one_rescheduled");
  assert.match(saved.appointment_id, /^APPT-/);
  const attempts = pool.calls.filter((call) => /INSERT INTO call_attempts/.test(call.sql));
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].sql, /'pending'/);
  const crmUpdate = pool.calls.find((call) => /UPDATE ai_calls SET timezone/.test(call.sql));
  const crm = JSON.parse(crmUpdate.params[4]);
  for (const field of [
    "customer_timezone", "customer_timezone_label", "callback_at",
    "callback_local_date", "callback_local_time", "callback_timezone",
    "callback_timezone_label", "callback_reason", "callback_type",
    "callback_confirmed", "callback_source_call_id", "appointment_id", "next_action"
  ]) assert.notEqual(crm[field], undefined, field);
});

test("Call Two uses a saved confirmed timezone without requiring it again", async () => {
  const pool = fakePool({
    result: {
      customer_timezone: "America/Chicago",
      customer_timezone_label: "Central",
      customer_timezone_confirmed: true
    }
  });
  const saved = await createConfirmedAppointment({
    pool,
    input: validInput({
      timezone: undefined,
      timezone_label: undefined,
      callback_type: "call_two_application_follow_up",
      callback_reason: CALLBACKS.call_two_application_follow_up.reason
    })
  });
  assert.equal(saved.timezone, "America/Chicago");
  assert.equal(saved.timezone_label, "Central");
  assert.equal(saved.next_action, "Complete the application before Call Two");
});

test("an explicitly corrected timezone replaces the saved timezone and recalculates UTC", async () => {
  const pool = fakePool({
    result: {
      customer_timezone: "America/New_York",
      customer_timezone_label: "Eastern",
      customer_timezone_confirmed: true
    }
  });
  const saved = await createConfirmedAppointment({
    pool,
    input: validInput({ timezone: "America/Los_Angeles", timezone_label: "Pacific" })
  });
  assert.equal(saved.timezone, "America/Los_Angeles");
  assert.equal(saved.callback_at, "2099-07-23T22:00:00.000Z");
  const crm = JSON.parse(pool.calls.find((call) => /UPDATE ai_calls SET timezone/.test(call.sql)).params[4]);
  assert.equal(crm.customer_timezone_label, "Pacific");
});

test("scheduling implementation has no message delivery path and normal completion still suppresses reconnect", () => {
  const schedulingSource = fs.readFileSync(path.join(__dirname, "..", "src", "scheduling", "confirmed-appointment.js"), "utf8");
  assert.doesNotMatch(schedulingSource, /sms|text.message|send_resource_link|messages\.create/i);
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /unexpected_reconnect_skipped/);
  assert.match(serverSource, /normal_terminal_call/);
  assert.match(serverSource, /attempt_type = 'disconnect_reconnect'/);
  assert.match(serverSource, /callbackType === "call_one_rescheduled"/);
  assert.match(serverSource, /callbackType === "call_two_application_follow_up"/);
});
