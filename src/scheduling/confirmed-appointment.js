const { randomUUID } = require("crypto");

const TIMEZONES = Object.freeze({
  Eastern: "America/New_York",
  Central: "America/Chicago",
  Mountain: "America/Denver",
  Pacific: "America/Los_Angeles"
});

const CALLBACKS = Object.freeze({
  call_one_rescheduled: {
    reason: "Customer requested another time to complete Call One",
    nextAction: "Resume Call One at the scheduled time"
  },
  call_two_application_follow_up: {
    reason: "Application status, program options, and preliminary DTI follow-up",
    nextAction: "Complete the application before Call Two"
  }
});

class SchedulingError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = "SchedulingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value, maximum = 4000) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maximum) : null;
}

function normalizeTimezone(timezone, timezoneLabel) {
  const zone = clean(timezone, 100);
  const label = clean(timezoneLabel, 30);
  const zoneLabelMatch = Object.keys(TIMEZONES).find(
    (candidate) => candidate.toLowerCase() === String(zone || "").toLowerCase()
  );
  const labelMatch = Object.keys(TIMEZONES).find(
    (candidate) => candidate.toLowerCase() === String(label || "").toLowerCase()
  );
  const zoneMatch = Object.entries(TIMEZONES).find(
    ([, candidate]) => candidate === zone
  );
  const resolvedLabel = zoneLabelMatch || zoneMatch?.[0] || labelMatch || null;
  const resolvedZone = zoneLabelMatch
    ? TIMEZONES[zoneLabelMatch]
    : zoneMatch?.[1] || (labelMatch ? TIMEZONES[labelMatch] : null);

  if (!resolvedLabel || !resolvedZone) {
    throw new SchedulingError(
      "INVALID_TIMEZONE",
      "Timezone must be Eastern, Central, Mountain, or Pacific."
    );
  }
  if (zone && !zoneLabelMatch && !zoneMatch) {
    throw new SchedulingError("INVALID_TIMEZONE", "Unsupported timezone.");
  }
  if (label && !labelMatch) {
    throw new SchedulingError("INVALID_TIMEZONE_LABEL", "Unsupported timezone label.");
  }
  if (zone && label && TIMEZONES[labelMatch] !== resolvedZone) {
    throw new SchedulingError("TIMEZONE_MISMATCH", "Timezone and timezone label do not match.");
  }
  return { timezone: resolvedZone, timezoneLabel: resolvedLabel };
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value, 10) || "");
  if (!match) throw new SchedulingError("INVALID_DATE", "Date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) throw new SchedulingError("INVALID_DATE", "Date is not a valid calendar date.");
  return { year, month, day, value: match[0] };
}

function parseLocalTime(value) {
  const text = clean(value, 20) || "";
  let match = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(text);
  let hour;
  let minute;
  if (match) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) {
      throw new SchedulingError("INVALID_TIME", "Time is invalid.");
    }
    if (match[3].toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (match[3].toLowerCase() === "am" && hour === 12) hour = 0;
  } else {
    match = /^(\d{2}):(\d{2})$/.exec(text);
    if (!match) {
      throw new SchedulingError("INVALID_TIME", "Time must include an exact hour and minute.");
    }
    hour = Number(match[1]);
    minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new SchedulingError("INVALID_TIME", "Time is invalid.");
  }
  return { hour, minute, value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function localPartsAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function localDateTimeToUtc(localDate, localTime, timezone) {
  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  const target = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const matches = [];
  for (let deltaMinutes = -14 * 60; deltaMinutes <= 14 * 60; deltaMinutes += 1) {
    const candidate = new Date(target + deltaMinutes * 60000);
    const parts = localPartsAt(candidate, timezone);
    if (
      parts.year === date.year && parts.month === date.month && parts.day === date.day &&
      parts.hour === time.hour && parts.minute === time.minute
    ) matches.push(candidate);
  }
  if (matches.length === 0) {
    throw new SchedulingError("NONEXISTENT_LOCAL_TIME", "That local time does not exist because of a daylight-saving transition.");
  }
  if (matches.length > 1) {
    throw new SchedulingError("AMBIGUOUS_LOCAL_TIME", "That local time occurs twice because of a daylight-saving transition; choose another exact time.");
  }
  return { callbackAt: matches[0], localDate: date.value, localTime: time.value };
}

function confirmedTimezoneFromCall(call) {
  const result = call?.result || {};
  const payload = call?.payload || {};
  const candidates = [
    result.customer_timezone_confirmed === true
      ? [result.customer_timezone, result.customer_timezone_label, result.customer_timezone_confirmed_at]
      : null,
    payload.customer_timezone_confirmed === true
      ? [payload.customer_timezone || payload.timezone, payload.customer_timezone_label || payload.timezone_label, payload.customer_timezone_confirmed_at]
      : null
  ].filter(Boolean);
  for (const [timezone, label, confirmedAt] of candidates) {
    try {
      return {
        ...normalizeTimezone(timezone, label),
        confirmedAt: clean(confirmedAt, 100)
      };
    } catch { /* Invalid saved values are ignored. */ }
  }
  return null;
}

function customerKey(call) {
  if (clean(call.lead_id, 150)) return `lead:${clean(call.lead_id, 150)}`;
  if (clean(call.case_id, 150)) return `case:${clean(call.case_id, 150)}`;
  return `request:${clean(call.request_key, 320) || call.call_id}`;
}

async function findSavedTimezone(client, call) {
  const active = confirmedTimezoneFromCall(call);
  if (active) return active;
  const prior = await client.query(
    `SELECT result, payload FROM ai_calls
     WHERE call_id <> $1
       AND (($2::text IS NOT NULL AND case_id = $2) OR ($3::text IS NOT NULL AND lead_id = $3))
       AND (result->>'customer_timezone_confirmed' = 'true'
         OR payload->>'customer_timezone_confirmed' = 'true')
     ORDER BY updated_at DESC LIMIT 20`,
    [call.call_id, call.case_id || null, call.lead_id || null]
  );
  for (const row of prior.rows) {
    const saved = confirmedTimezoneFromCall(row);
    if (saved) return saved;
  }
  return null;
}

function validateCallback(callbackType, callbackReason) {
  const definition = CALLBACKS[clean(callbackType, 80)];
  if (!definition) throw new SchedulingError("UNSUPPORTED_CALLBACK_TYPE", "Unsupported callback type.");
  if (clean(callbackReason, 500) !== definition.reason) {
    throw new SchedulingError("UNSUPPORTED_CALLBACK_REASON", "Callback reason does not match the callback type.");
  }
  return definition;
}

function publicId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().split("-")[0].toUpperCase()}`;
}

async function createConfirmedAppointment({ pool, input, now = new Date() }) {
  if (input?.prospect_confirmed !== true) {
    throw new SchedulingError("CONFIRMATION_REQUIRED", "Explicit customer confirmation is required.");
  }
  const localDate = clean(input.customer_local_date, 10);
  const localTime = clean(input.customer_local_time, 20);
  if (!localDate) throw new SchedulingError("DATE_REQUIRED", "Customer local date is required.");
  if (!localTime) throw new SchedulingError("TIME_REQUIRED", "Customer local time is required.");
  const callbackType = clean(input.callback_type, 80);
  const callbackReason = clean(input.callback_reason, 500);
  const callback = validateCallback(callbackType, callbackReason);
  const sourceCallId = clean(input.source_call_id, 100);
  if (!sourceCallId) throw new SchedulingError("SOURCE_CALL_REQUIRED", "Source call ID is required.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const callResult = await client.query("SELECT * FROM ai_calls WHERE call_id = $1 FOR UPDATE", [sourceCallId]);
    const call = callResult.rows[0];
    if (!call) throw new SchedulingError("CALL_NOT_FOUND", "Current call was not found.", 404);

    const savedTimezone = await findSavedTimezone(client, call);
    let timezoneSelection;
    if (clean(input.timezone, 100) || clean(input.timezone_label, 30)) {
      timezoneSelection = normalizeTimezone(input.timezone, input.timezone_label);
      if (
        savedTimezone?.timezone === timezoneSelection.timezone &&
        savedTimezone?.timezoneLabel === timezoneSelection.timezoneLabel
      ) timezoneSelection.confirmedAt = savedTimezone.confirmedAt;
    } else {
      timezoneSelection = savedTimezone;
      if (!timezoneSelection) {
        throw new SchedulingError("TIMEZONE_REQUIRED", "A confirmed customer timezone is required.");
      }
    }

    const converted = localDateTimeToUtc(localDate, localTime, timezoneSelection.timezone);
    if (converted.callbackAt.getTime() <= now.getTime()) {
      throw new SchedulingError("APPOINTMENT_NOT_FUTURE", "Appointment must be in the future.");
    }

    const appointmentId = publicId("APPT");
    const createdAt = now.toISOString();
    const nextAction = callback.nextAction;
    const key = customerKey(call);
    const appointmentInsert = await client.query(
      `INSERT INTO scheduled_appointments (
         appointment_id, customer_key, source_call_id, case_id, lead_id,
         callback_at, customer_local_date, customer_local_time, timezone,
         timezone_label, callback_type, callback_reason, discussion_summary,
         prospect_confirmed, next_action, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$15,$15)
       ON CONFLICT (customer_key, callback_type, callback_at) DO NOTHING RETURNING *`,
      [
        appointmentId, key, call.call_id, call.case_id, call.lead_id,
        converted.callbackAt, converted.localDate, converted.localTime,
        timezoneSelection.timezone, timezoneSelection.timezoneLabel,
        callbackType, callbackReason, clean(input.discussion_summary, 4000),
        nextAction, now
      ]
    );
    if (!appointmentInsert.rows[0]) {
      throw new SchedulingError("DUPLICATE_APPOINTMENT", "This appointment already exists.", 409);
    }

    const attemptNumberResult = await client.query(
      "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number FROM call_attempts WHERE call_id = $1",
      [call.call_id]
    );
    const attemptId = publicId("ATTEMPT");
    await client.query(
      `INSERT INTO call_attempts (
         attempt_id, call_id, attempt_number, call_leg, technical_status,
         attempt_type, idempotency_key, scheduled_for, appointment_id,
         callback_type, callback_reason, callback_timezone,
         callback_timezone_label, source_call_id
       ) VALUES ($1,$2,$3,1,'pending',$4,$5,$6,$7,$4,$8,$9,$10,$2)`,
      [
        attemptId, call.call_id, Number(attemptNumberResult.rows[0].next_number),
        callbackType, `appointment:${appointmentId}`, converted.callbackAt,
        appointmentId, callbackReason, timezoneSelection.timezone,
        timezoneSelection.timezoneLabel
      ]
    );

    const crm = {
      customer_timezone: timezoneSelection.timezone,
      customer_timezone_label: timezoneSelection.timezoneLabel,
      customer_timezone_confirmed: true,
      customer_timezone_confirmed_at: timezoneSelection.confirmedAt || createdAt,
      callback_at: converted.callbackAt.toISOString(),
      callback_local_date: converted.localDate,
      callback_local_time: converted.localTime,
      callback_timezone: timezoneSelection.timezone,
      callback_timezone_label: timezoneSelection.timezoneLabel,
      callback_reason: callbackReason,
      callback_type: callbackType,
      callback_confirmed: true,
      callback_created_at: createdAt,
      callback_source_call_id: call.call_id,
      appointment_id: appointmentId,
      next_action: nextAction,
      discussion_summary: clean(input.discussion_summary, 4000)
    };
    await client.query(
      `UPDATE ai_calls SET timezone = $2, next_action = $3,
         summary = COALESCE($4, summary), result = result || $5::jsonb,
         actions = actions || $6::jsonb, updated_at = NOW()
       WHERE call_id = $1`,
      [
        call.call_id, timezoneSelection.timezone, nextAction,
        crm.discussion_summary, JSON.stringify(crm),
        JSON.stringify([{ action: "create_confirmed_appointment", success: true, appointment_id: appointmentId, callback_at: crm.callback_at, callback_type: callbackType, created_at: createdAt }])
      ]
    );
    await client.query("COMMIT");
    return {
      success: true,
      callback_at: crm.callback_at,
      customer_local_date: converted.localDate,
      customer_local_time: converted.localTime,
      timezone: timezoneSelection.timezone,
      timezone_label: timezoneSelection.timezoneLabel,
      callback_type: callbackType,
      callback_reason: callbackReason,
      appointment_id: appointmentId,
      next_action: nextAction
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  TIMEZONES,
  CALLBACKS,
  SchedulingError,
  normalizeTimezone,
  parseLocalDate,
  parseLocalTime,
  localDateTimeToUtc,
  confirmedTimezoneFromCall,
  createConfirmedAppointment
};
