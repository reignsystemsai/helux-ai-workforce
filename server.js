const express = require("express");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const { Pool } = require("pg");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { REALTIME_TOOLS } = require("./src/intents/intent-types");
const { routeIntent } = require("./src/intents/intent-router");
const { guardAssistantOutput } = require("./src/compliance/compliance-guardrails");
const { isInterestRateQuestion, interestRateResponse } = require("./src/compliance/interest-rate-policy");
const { isListeningAcknowledgement } = require("./src/realtime/interruption-manager");
const { semanticTurnDelay } = require("./src/realtime/turn-manager");
const { DEFAULTS: REALTIME_DEFAULTS } = require("./src/realtime/latency-manager");
const { buildRealtimeSession } = require("./src/realtime/openai-session");

/*
 * HELUX AI WORKFORCE - DAISY 3.2.0
 * Daisy, Doug's assistant: calling, callbacks, resources, and two-way monday.com control.
 * monday.com failures never block or terminate a customer call.
 */

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const HELUX_API_KEY = process.env.HELUX_API_KEY;

const HELUX_BASE_URL = String(
  process.env.HELUX_BASE_URL || "https://helux-os.onrender.com"
).replace(/\/+$/, "");
const HELUX_RESULTS_PATH =
  process.env.HELUX_RESULTS_PATH || "/api/v1/calls/results";

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || "https://helux-ai-workforce.onrender.com"
).replace(/\/+$/, "");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin";
const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const SPECIALIST_PHONE_NUMBER = process.env.SPECIALIST_PHONE_NUMBER || "";

const DPA_APPLICATION_URL =
  process.env.DPA_APPLICATION_URL || "https://www.dpahelpcenter.com";
const DTI_CALCULATOR_URL =
  process.env.DTI_CALCULATOR_URL || "https://www.dpahelpcenter.com/dti";
const PREPHUB_URL =
  process.env.PREPHUB_URL || "https://www.dpahelpcenter.com/prephub";
const CREDIT_READINESS_URL =
  process.env.CREDIT_READINESS_URL || "https://www.creditjump.ai/";
const TAX_READINESS_URL =
  process.env.TAX_READINESS_URL || "https://www.estimatemytaxreturn.com/";
const EMPLOYMENT_READINESS_URL =
  process.env.EMPLOYMENT_READINESS_URL || "https://www.dpahelpcenter.com/job";

const DAISY_RESOURCE_LIBRARY = Object.freeze({
  application: {
    url: DPA_APPLICATION_URL,
    description: "DPA Help Center application"
  },
  dti_calculator: {
    url: DTI_CALCULATOR_URL,
    description: "DPA Help Center DTI calculator"
  },
  prephub: {
    url: PREPHUB_URL,
    description: "DPA Help Center Prephub"
  },
  credit_readiness: {
    url: CREDIT_READINESS_URL,
    description: "CreditJump credit-readiness resource"
  },
  tax_readiness: {
    url: TAX_READINESS_URL,
    description: "tax-readiness resource"
  },
  employment_readiness: {
    url: EMPLOYMENT_READINESS_URL,
    description: "employment-readiness resource"
  }
});

const CALL_SCHEDULER_ENABLED =
  String(process.env.CALL_SCHEDULER_ENABLED || "false").toLowerCase() ===
  "true";
const ENFORCE_CALL_CONSENT =
  String(process.env.ENFORCE_CALL_CONSENT || "false").toLowerCase() ===
  "true";
const DEFAULT_TIMEZONE =
  process.env.DEFAULT_TIMEZONE || "America/New_York";
const SCHEDULER_INTERVAL_MS = Math.max(
  30000,
  Number(process.env.SCHEDULER_INTERVAL_MS || 60000)
);

/*
 * Daisy does not interrupt herself for a single VAD spike. A possible customer
 * interruption must remain active long enough to resemble sustained speech.
 * Short clicks, phone movement, dishes, static, and other brief sounds are
 * ignored locally even when the upstream VAD reports speech_started.
 */
const DAISY_SPEECH_CONFIRM_MS = Math.max(
  900,
  Number(process.env.DAISY_SPEECH_CONFIRM_MS || 1200)
);

const DAISY_MIN_TRANSCRIPT_SETTLE_MS = Math.max(
  450,
  Number(process.env.DAISY_MIN_TRANSCRIPT_SETTLE_MS || 700)
);

/* monday.com is optional and isolated from the live caller. */
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN || "";
const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || "2026-04";
const MONDAY_BOARD_ID = String(
  process.env.MONDAY_BOARD_ID || "18421626660"
);
const MONDAY_SUBITEM_BOARD_ID = String(
  process.env.MONDAY_SUBITEM_BOARD_ID || "18421626716"
);
const DPA_BOARD_ID = cleanText(process.env.DPA_BOARD_ID, 100);
const MONDAY_CALL_CONTROL_COLUMNS = Object.freeze({
  has_realtor: "color_mm57ev4f",
  applied_with_lender: "color_mm57bjwh",
  app_started_confirmation: "color_mm576a7j",
  time_frame: "color_mm57v24g"
});
const DPA_DEPARTMENT_COLUMNS = Object.freeze({
  app_started: "color_mm571hke",
  realtor_name: "text_mm57ngpn",
  realtor_phone: "phone_mm5790vb"
});
const MONDAY_SYNC_REQUESTED =
  String(process.env.MONDAY_SYNC_ENABLED || "false").toLowerCase() === "true";
const MONDAY_SYNC_ENABLED = Boolean(
  MONDAY_SYNC_REQUESTED &&
    MONDAY_API_TOKEN &&
    MONDAY_BOARD_ID &&
    MONDAY_SUBITEM_BOARD_ID
);
const MONDAY_METADATA_CACHE_MS = Math.max(
  60000,
  Number(process.env.MONDAY_METADATA_CACHE_MS || 900000)
);
const MONDAY_REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.MONDAY_REQUEST_TIMEOUT_MS || 12000)
);
const MONDAY_SYNC_DEBOUNCE_MS = Math.max(
  100,
  Number(process.env.MONDAY_SYNC_DEBOUNCE_MS || 750)
);
const MONDAY_INBOUND_SYNC_ENABLED =
  String(process.env.MONDAY_INBOUND_SYNC_ENABLED || "true").toLowerCase() ===
  "true";
const MONDAY_WEBHOOK_SECRET = String(
  process.env.MONDAY_WEBHOOK_SECRET ||
    createHash("sha256")
      .update(`${HELUX_API_KEY}:${MONDAY_BOARD_ID}:monday-inbound`)
      .digest("hex")
      .slice(0, 32)
);

const REQUIRED_ENVIRONMENT = {
  DATABASE_URL,
  HELUX_API_KEY,
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER
};

const missingEnvironment = Object.entries(REQUIRED_ENVIRONMENT)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnvironment.length) {
  console.error(
    `Missing required environment variables: ${missingEnvironment.join(", ")}`
  );
  process.exit(1);
}

const DOUG_CONFIG = Object.freeze({
  agentVersion: "daisy-3.2.0",
  promptVersion: "dpa-two-call-noise-resistant-v3.2",
  toolVersion: "intent-actions-v3.0",
  knowledgeVersion: "dpa-general-v1",
  routingVersion: "dpa-routing-v1",
  cadenceVersion: "dpa-ready-6-attempt-adaptive-v2",
  mondayAdapterVersion: "monday-call-control-v2.5-compatible",
  maxAttempts: 6,
  maxVoicemails: 2,
  minimumGapMinutes: 180,
  operatingWindow: {
    alwaysOpen: true,
    weekdayStart: "00:00",
    weekdayEnd: "23:59",
    saturdayStart: "00:00",
    saturdayEnd: "23:59",
    sundayStart: "00:00",
    sundayEnd: "23:59",
    sundayEnabled: true
  },
  preferredWindows: {
    morning: "09:15",
    lateAfternoon: "16:30"
  },
  voiceRules: {
    maximumResponseSeconds: 12,
    questionsPerTurn: 1,
    interruptible: true
  }
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const mediaServer = new WebSocketServer({ noServer: true });

let schedulerTimer = null;
let schedulerRunning = false;
let mondayMetadataCache = null;
let mondayMetadataExpiresAt = 0;
const mondaySyncTimers = new Map();
const mondaySyncChains = new Map();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cleanText(value, maximumLength = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maximumLength) : null;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "yes", "1", "confirmed", "granted"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0", "denied", "revoked"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizePhone(value) {
  const original = cleanText(value, 50);
  if (!original) return null;
  const digits = original.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return original;
}

function validE164Phone(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(normalizePhone(value) || ""));
}

function normalizeTimeFrame(value) {
  const normalized = normalizeMondayKey(value);
  if ([
    "3060",
    "3060days",
    "30to60",
    "30days60days",
    "2months",
    "twomonths",
    "within2months",
    "withintwomonths"
  ].includes(normalized)) {
    return "30 - 60";
  }
  if (["6090", "6090days", "60to90", "60days90days"].includes(normalized)) {
    return "60 - 90";
  }
  if ([
    "withinsixmonths",
    "within6months",
    "36months",
    "3to6months",
    "4months",
    "fourmonths",
    "within4months",
    "withinfourmonths",
    "6months",
    "sixmonths"
  ].includes(normalized)) {
    return "Within six months";
  }
  if ([
    "morethansixmonths",
    "morethan6months",
    "over6months",
    "justlooking",
    "looking",
    "nurture",
    "1year",
    "oneyear",
    "12months",
    "twelvemonths"
  ].includes(normalized)) {
    return "More than six months";
  }
  return null;
}

function interestForTimeFrame(value) {
  const timeFrame = normalizeTimeFrame(value);
  if (timeFrame === "30 - 60") return "High";
  if (timeFrame === "60 - 90") return "Medium";
  if (timeFrame === "Within six months") return "Medium";
  if (timeFrame === "More than six months") return "Nurture";
  return null;
}

function normalizeDaisyAnswers(input) {
  const answers = input && typeof input === "object" ? { ...input } : {};
  const timeFrame = normalizeTimeFrame(answers.time_frame);
  if (timeFrame) {
    answers.time_frame = timeFrame;
    answers.interest_level = interestForTimeFrame(timeFrame);
  }
  for (const key of ["has_realtor", "applied_with_lender"]) {
    const normalized = normalizeBoolean(answers[key]);
    if (normalized !== null) answers[key] = normalized ? "Yes" : "No";
  }
  if (answers.app_started_confirmation) {
    answers.app_started_confirmation = cleanText(
      answers.app_started_confirmation,
      80
    );
  }
  if (Object.prototype.hasOwnProperty.call(
    answers,
    "tentative_meeting_availability"
  )) {
    answers.tentative_meeting_availability = cleanText(
      answers.tentative_meeting_availability,
      1000
    );
  }
  if (answers.application_link_sent !== undefined) {
    answers.application_link_sent = answers.application_link_sent === true;
  }
  if (answers.application_follow_up_at) {
    const followUp = new Date(answers.application_follow_up_at);
    answers.application_follow_up_at = Number.isNaN(followUp.getTime())
      ? null
      : followUp.toISOString();
  }
  return answers;
}

function normalizeTimezone(value) {
  const candidate = cleanText(value, 100) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function formatAssistanceAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numericValue = Number(
    String(value)
      .replace(/[$,\s]/g, "")
      .trim()
  );

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(numericValue);
}

function authenticateHelux(req, res, next) {
  const provided = req.headers["x-helux-key"];
  if (!provided || Array.isArray(provided) || provided !== HELUX_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }
  next();
}

function createPublicId(prefix) {
  return `${prefix}-${Date.now()
    .toString(36)
    .toUpperCase()}-${randomUUID().split("-")[0].toUpperCase()}`;
}

function createStreamToken() {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

function safetyIdentifier(call) {
  return createHash("sha256")
    .update(String(call.case_id || call.lead_id || call.call_id))
    .digest("hex");
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function websocketBaseUrl() {
  return PUBLIC_BASE_URL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function callRequestKey(payload) {
  const caseId = cleanText(payload.case_id, 150);
  const leadId = cleanText(payload.lead_id, 150);
  if (caseId) return `case:${caseId}`;
  if (leadId) return `lead:${leadId}`;
  throw new HttpError(422, "case_id or lead_id is required.");
}

function terminalCallStatus(status) {
  return ["completed", "busy", "failed", "no-answer", "canceled"].includes(
    String(status || "").toLowerCase()
  );
}

function stopOutcome(outcome) {
  return [
    "qualified",
    "hot_transfer",
    "specialist_handoff",
    "application_link_sent",
    "dti_calculator_sent",
    "agent_notified",
    "needs_review",
    "not_interested",
    "wrong_number",
    "opt_out"
  ].includes(String(outcome || "").toLowerCase());
}

function confirmedConsent(payload) {
  const explicit = normalizeBoolean(
    payload.consent_confirmed ?? payload.ai_voice_consent
  );
  if (explicit !== null) return explicit;
  const status = String(payload.consent_status || "").toLowerCase();
  return ["confirmed", "granted", "approved", "yes"].includes(status);
}

const DOUGLAS_DAISY_SCRIPT = String.raw`
DAISY 3.2 — TWO-CALL DPA SCRIPT

These are internal operating instructions. Never read headings, rules, braces, or placeholders aloud.

==================================================
1. NON-NEGOTIABLE CALL BEHAVIOR
==================================================

- Say the complete opening sentence before waiting: "Hi, is {customer_name} available?"
- Never say only "Hi" and pause.
- The opening question is the identity check. Do not add a second identity-verification speech.
- After the customer confirms, continue: "Great, this is Daisy with the DPA Help Center. How are you?"
- Ask one question at a time.
- After every question, stop speaking and wait for a completed customer response.
- Never answer your own question or move forward without an answer.
- For a yes-or-no question, treat "yes," "yeah," "yep," "yup," "mmm-hmm," "mhm," "uh-huh," "sure," "absolutely," and "correct" as affirmative answers.
- Ignore background noise, clicks, phone movement, dishes, static, music, television, echo, and other brief non-speech sounds.
- Do not stop, pause, restart, or change the call because of background noise.
- Only yield for sustained meaningful customer speech or a clear command such as "wait," "stop," "hold on," or "excuse me."
- Do not interrupt the customer while they are finishing a thought.
- If the customer asks a separate question, answer it briefly, then return to the one pending script question.
- Use submitted information. Confirm it instead of repeating the intake form.
- Never manufacture, infer, or complete an answer for the customer.
- Never discuss or quote interest rates.
- Never guarantee approval, eligibility, a program, an assistance amount, a closing date, or a home price.
- DTI and homebuying power are preliminary estimates only.
- Only send a text link after the customer agrees to receive it.
- After scheduling a callback, ask permission before sending a text confirmation.
- Never claim a text, callback, handoff, or other action succeeded until the tool confirms success.
- Before ending a connected call, save the outcome, confirm the next step, use complete_call, give one brief closing, and end normally.

When the current call has no remaining question or action, Daisy says:
"If there's nothing else, thank you for your time, {customer_name}. Have a great day."

Then:
- Use complete_call.
- Allow the full closing audio to play.
- Disconnect the telephone line.
- Do not wait silently on the line.
- Do not restart the conversation.
- Do not trigger reconnect.

- A normal goodbye is not an unexpected disconnect.

Runtime mode: {call_mode}
Customer: {customer_name}
Estimated assistance: {estimated_dpa}
Submitted income: {income_submitted}
Submitted work history: {work_history_submitted}
Submitted tax-return information: {tax_return_submitted}
Readiness score: {readiness_score}
Saved purchase timeline: {purchase_timeframe}
Saved purchase area: {purchase_area}
Saved lender status: {has_lender}
Saved Realtor status: {has_realtor}
Previous call summary: {previous_call_summary}
Previous callback reason: {previous_callback_reason}

Never speak "not provided" as though it were customer data. When a value is unavailable, use a natural generic version of the sentence.

==================================================
2. INTERNAL SPECIALIST NOTIFICATION MODE
==================================================

Use this section only when Runtime mode says INTERNAL SPECIALIST NOTIFICATION.

Daisy says:
"Hi, is {agent_name} available?"

WAIT.

After confirmation Daisy says:
"Great, this is Daisy with the DPA Help Center. I'm calling to let you know that {internal_customer_name} has started the DPA application."

Briefly provide the saved purchase timeline and purchase area when available.

Daisy asks:
"Can you confirm you received that?"

WAIT.

After confirmation:
- Use complete_call with outcome agent_notified.
- Set stop_sequence true.
- Set pause_sequence false.
- Thank the specialist.
- End the call normally.

==================================================
3. RECONNECT MODE
==================================================

Use this section only when Runtime mode says RECONNECT.

Daisy says:
"Hi, is {customer_name} available?"

WAIT.

After confirmation Daisy says:
"Great, this is Daisy with the DPA Help Center. I think we got disconnected. Is now still a good time?"

WAIT.

Resume from the saved summary and next action.

Do not restart Call One.
Do not repeat confirmed answers.
A normal goodbye or a call ending at the end of the script must never trigger a reconnect call.

==================================================
4. CALL ONE — DISCOVERY AND CALL-TWO SCHEDULING
==================================================

Use this section when Runtime mode says CALL ONE.

OPENING

Daisy says:
"Hi, is {customer_name} available?"

WAIT.

After the customer confirms, Daisy says:
"Great, this is Daisy with the DPA Help Center. How are you?"

WAIT.

Respond naturally in one brief sentence based on the customer's mood and keep the call moving.

CONFIRM THE REQUEST

When the assistance estimate is available, Daisy says:
"I see you're a first-time homebuyer looking for up to {estimated_dpa} in down payment assistance to purchase a home. Is that correct?"

When the assistance estimate is unavailable, Daisy says:
"I see you're a first-time homebuyer looking for down payment assistance to purchase a home. Is that correct?"

WAIT.

The words "Is that correct?" are required and must not be omitted.

When the customer corrects the amount or first-time-homebuyer status:
- Acknowledge the correction.
- Save the updated information.
- Do not argue or repeat the original information.

CONFIRM SUBMITTED INFORMATION

When all submitted values are available, Daisy says:
"Excellent. Based on your submitted income of {income_submitted}, your work history of {work_history_submitted}, and your tax-return information of {tax_return_submitted}, reviewing down payment assistance options should be straightforward. Is all of that information still correct?"

When one or more values are unavailable:
- Confirm only the values that are available.
- End with: "Is that information still correct?"

WAIT.

Save corrections without asking the customer to repeat information that remains correct.

CONFIRM AVAILABILITY

Daisy says:
"Wonderful, {customer_name}. It sounds like you're ready to explore down payment assistance and take the next step toward becoming a homeowner. Do you have a minute or two so I can explain our simple two-call process?"

WAIT.

IF ANOTHER TIME IS BETTER

Daisy says:
"What date and time would work better for you?"

WAIT.

Collect:
- Callback date
- Callback time
- Customer timezone
- Callback reason

After collecting the date, time, and timezone, Daisy says:
"Excellent. I'll call you on {callback_date} at {callback_time} in your time zone. Is that correct?"

WAIT.

Daisy asks:
"Would you like me to text you a confirmation?"

WAIT.

After confirmation:
- Use schedule_callback with reason "Customer requested a better time."
- Pass the correct sms_confirmation_consent value.
- Use complete_call with outcome follow_up_scheduled.
- Set stop_sequence false.
- Set pause_sequence false.

After the callback tool succeeds, Daisy says:
"Perfect. I have us scheduled to speak again. Thank you for your time, {customer_name}. I'll speak with you then. Have a great day."

END THE CALL AND HANG UP.
DO NOT CONTINUE CALL ONE.

EXPLAIN THE TWO-CALL PROCESS

When the customer can continue, Daisy says:
"Perfect, this will be quick. Our two-call process is simple. Call one, which is now, quickly covers your purchase timeline, whether you're working with a lender or Realtor, and the area where you'd like to purchase. On call two, we'll review your application status, debt-to-income ratio, and potential program options, and make sure you're connected with DPA lender and Realtor specialists when needed. How does that sound?"

WAIT.

Do not provide another long explanation after the customer agrees.

QUESTION ONE — PURCHASE TIMELINE

Daisy says:
"As far as your timeline, how soon would you like to become a homeowner: within the next two months, four months, six months, or one year?"

WAIT.

Save the customer's exact choice as purchase_timeline_detail.

Also normalize time_frame as follows:
- Two months = "30 - 60"
- Four months = "Within six months"
- Six months = "Within six months"
- One year = "More than six months"

Map interest level as:
- Two months = "High"
- Four months = "Medium"
- Six months = "Medium"
- One year = "Nurture"

QUESTION TWO — LENDER

Daisy says:
"Understood. Are you currently working with a lender?"

WAIT.

Save applied_with_lender as Yes or No.

Do not treat the DPA Help Center as the outside lender referenced by this question.

QUESTION THREE — REALTOR

Daisy says:
"Okay. Are you currently working with a Realtor?"

WAIT.

Save has_realtor as Yes or No.

QUESTION FOUR — PURCHASE AREA

Daisy says:
"And one more question before we schedule your second call: what area would you like to purchase a home in?"

WAIT.

Save the customer's answer as purchase_area.

SCHEDULE CALL TWO

Daisy says:
"Well, that's everything for this call, and now you're one step closer to becoming a homeowner in {purchase_area}."

Daisy says:
"Your next step is to start the application so I can follow up with you about its status, review your debt-to-income ratio, and explore potential program options."

Daisy asks:
"{customer_name}, do you think you'll have time to start the application today?"

WAIT.

IF THE CUSTOMER SAYS YES

Daisy asks:
"Excellent. What time tomorrow would be best for our second call?"

WAIT.

Use the customer's answer to calculate a specific callback date and time for the following day.

IF THE CUSTOMER SAYS NO

Daisy says:
"No problem. What day do you think you'll have time to start it?"

WAIT.

Then Daisy asks:
"And what time would be best for me to follow up with you the following day?"

WAIT.

For both branches:
- Collect the exact callback date.
- Collect the exact callback time.
- Confirm the timezone.
- Repeat the exact appointment.

Daisy says:
"I have us scheduled to speak on {callback_date} at {callback_time} in your time zone. Is that correct?"

WAIT.

After confirmation, Daisy asks:
"Would you like me to text you a confirmation?"

WAIT.

Use schedule_callback with:
- reason: "Application checkpoint"
- prospect_confirmed: true
- the correct callback_at
- the correct timezone
- the correct sms_confirmation_consent

Then use complete_call with:
- outcome: follow_up_scheduled
- stop_sequence: false
- pause_sequence: false
- requested_next_call_at set to the confirmed callback time

After the callback tool succeeds, Daisy says:
"Excellent. I have our second call scheduled. Thank you for your time, {customer_name}. I look forward to speaking with you then. Have a great day."

END THE CALL AND HANG UP.
A SUCCESSFULLY COMPLETED CALL MUST NOT TRIGGER A RECONNECT.

==================================================
5. CALL TWO — APPLICATION STATUS, DTI, AND CONNECTIONS
==================================================

Use this section when Runtime mode says CALL TWO.

OPENING

Daisy says:
"Hi, is {customer_name} available?"

WAIT.

After confirmation Daisy says:
"Great, this is Daisy with the DPA Help Center. I'm following up like we discussed."

Briefly summarize the saved:
- Purchase timeline
- Purchase area

When the assistance amount is available, Daisy says:
"You were also looking for up to {estimated_dpa} in down payment assistance. Is that still correct?"

WAIT.

When the assistance amount is unavailable, Daisy says:
"You were also looking into down payment assistance. Is that still correct?"

WAIT.

Do not repeat all of Call One.

Ask:
"Did you have a chance to start the application?"

WAIT.

IF THE APPLICATION WAS STARTED

Daisy says:
"Excellent. That's great to hear."

Use record_application_checkpoint with:
- started: true
- a concise summary

Mark the lead hot through the existing tool workflow.

Daisy asks:
"Before I connect you with the next step, let's review your preliminary debt-to-income ratio. Do you have a few minutes to do that now?"

WAIT.

If the customer agrees, continue into the existing DTI section.

Do not tell the customer that a specialist will contact them before completing or appropriately addressing the DTI review.

IF THE APPLICATION WAS NOT STARTED

Daisy says:
"No worries. Would you like me to text you the application link now?"

WAIT.

When the customer agrees:
- Use send_resource_link.
- Set resource_type to "application".
- Set consent_confirmed to true.
- Do not ask permission twice.
- Do not claim the link was sent until the tool returns success.

DTI REVIEW

Daisy says:
"One of the main things that can affect your homebuying options is your debt-to-income ratio. Would you like me to help you calculate a preliminary DTI estimate now?"

WAIT.

IF THE CUSTOMER WANTS HELP NOW

Ask one number at a time.

Daisy asks:
"What is your gross monthly household income before taxes?"

WAIT.

Then Daisy asks:
"Approximately how much do you pay each month toward recurring debts, including credit-card minimums, vehicle payments, student loans, personal loans, child support, and alimony?"

WAIT.

Do not include:
- Groceries
- Utilities
- Phone service
- Internet
- Gas
- Normal household living expenses

After receiving both numbers:
- Use calculate_preliminary_dti.
- Call the result a preliminary estimate.
- Explain that a lender must verify income, debt, credit, and final homebuying power.
- Do not quote an interest rate.
- Do not guarantee an approved home price.

After the DTI review is completed, Daisy says:
"Excellent. Your application has been started, and we now have a clearer picture of your debt-to-income position."

Daisy says:
"A DPA specialist should reach out within 24 to 48 hours to help you continue with the next step."

IF THE CUSTOMER PREFERS THE CALCULATOR

Ask once whether the customer wants the calculator by text.

After an affirmative answer:
- Use send_resource_link.
- Set resource_type to "dti_calculator".
- Set consent_confirmed to true.
- Do not ask permission twice.
- Do not claim it was sent until the tool returns success.

PROFESSIONAL CONNECTIONS

Use the saved lender and Realtor answers.

- Do not re-ask a status already confirmed unless the customer says it changed.
- When a lender or Realtor connection is missing and human follow-up is appropriate, use create_specialist_handoff.
- Never claim a connection was completed before the tool confirms it.

CALL-TWO CLOSING WHEN THE APPLICATION WAS STARTED

When the next action belongs to a specialist:
- Confirm that a specialist should follow up within 24 to 48 hours.
- Use complete_call with the correct final outcome.
- Thank the customer.
- End normally.

CALL-TWO CLOSING WHEN THE APPLICATION WAS NOT STARTED

Ask:
"When do you think you'll have time to start it, so I can help you stay moving forward?"

WAIT.

Collect:
- Specific date
- Specific time
- Timezone
- SMS confirmation permission

Repeat and confirm the appointment.

Use schedule_callback with reason:
"Application checkpoint"

Use complete_call with:
- outcome: follow_up_scheduled
- stop_sequence: false
- pause_sequence: false
- requested_next_call_at set to the confirmed time

Daisy says:
"Perfect. I'll follow up with you on {callback_date} at {callback_time}. Thank you for your time, {customer_name}. Have a great day."

End normally.

==================================================
6. REQUIRED RHYTHM
==================================================

DAISY ASKS ONE QUESTION
↓
DAISY STOPS SPEAKING
↓
CUSTOMER ANSWERS
↓
DAISY UNDERSTANDS THE RESPONSE
↓
DAISY SAVES THE ANSWER WHEN APPROPRIATE
↓
DAISY MOVES TO THE NEXT STEP

Daisy must never:
- Ask multiple primary questions in one turn.
- Continue speaking after asking a question.
- Answer the question herself.
- Move to the next objective without an answer.
- Treat background noise as an interruption.
- Treat background noise as a customer answer.
- Treat a customer question as the answer to a pending structured question.
- End normally and then call back as though the call disconnected.
`;

function buildDouglasDaisyInstructions(call) {
  const lead = call.payload || {};
  const result = normalizeDaisyAnswers(call.result || {});
  const currentState = cleanText(call.current_state, 80) || "greeting";

  let callMode = "CALL ONE";

  if (lead.call_type === "dpa_agent_notification") {
    callMode = "INTERNAL SPECIALIST NOTIFICATION";
  } else if (
    ["reconnect_pending", "reconnect_in_progress"].includes(currentState)
  ) {
    callMode = "RECONNECT";
  } else if (currentState === "application_checkpoint") {
    callMode = "CALL TWO";
  }

  const values = {
    call_mode: callMode,
    customer_name:
      cleanText(
        lead.first_name || lead.customer_name || lead.name,
        160
      ) || "the customer",
    agent_name:
      cleanText(lead.agent_name || lead.first_name, 160) ||
      "the assigned specialist",
    internal_customer_name:
      cleanText(lead.customer_name, 160) || "the customer",
    estimated_dpa:
      formatAssistanceAmount(lead.estimated_dpa) || "not provided",
    income_submitted:
      cleanText(lead.household_income ?? lead.income, 160) ||
      "not provided",
    work_history_submitted:
      cleanText(
        lead.employment_history ?? lead.employment,
        200
      ) || "not provided",
    tax_return_submitted:
      cleanText(
        lead.tax_return_history ?? lead.taxes_filed,
        160
      ) || "not provided",
    readiness_score:
      lead.readiness_score ?? "not provided",
    has_lender:
      result.applied_with_lender ??
      lead.has_lender ??
      "not provided",
    has_realtor:
      result.has_realtor ??
      lead.has_realtor ??
      "not provided",
    purchase_timeframe:
      result.purchase_timeline_detail ??
      result.time_frame ??
      lead.purchase_timeframe ??
      lead.time_frame ??
      "not provided",
    purchase_area:
      result.purchase_area ??
      lead.purchase_area ??
      lead.city ??
      "not provided",
    previous_call_summary:
      cleanText(
        call.summary ??
          result.discussion_summary ??
          result.summary,
        4000
      ) || "not provided",
    previous_callback_reason:
      cleanText(result.callback_reason, 1000) ||
      "not provided",
    callback_date:
      cleanText(result.callback_date, 100) ||
      "the confirmed date",
    callback_time:
      cleanText(result.callback_time, 100) ||
      "the confirmed time"
  };

  return Object.entries(values).reduce(
    (script, [name, value]) => {
      return script.replaceAll(`{${name}}`, String(value));
    },
    DOUGLAS_DAISY_SCRIPT
  );
}

const DOUG_TOOLS = [
  {
    type: "function",
    name: "record_application_checkpoint",
    description:
      "Record whether the customer started the application at the scheduled checkpoint.",
    parameters: {
      type: "object",
      properties: {
        started: { type: "boolean" },
        summary: { type: "string" }
      },
      required: ["started", "summary"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "save_call_progress",
    description:
      "Save the current conversation state, structured answers, sentiment, and next state without ending the call.",
    parameters: {
      type: "object",
      properties: {
        current_state: { type: "string" },
        next_state: { type: "string" },
        answers: { type: "object" },
        sentiment: {
          type: "string",
          enum: [
            "positive",
            "neutral",
            "skeptical",
            "confused",
            "frustrated",
            "urgent",
            "excited"
          ]
        },
        notes: { type: "string" }
      },
      required: ["current_state", "next_state", "answers"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "calculate_preliminary_dti",
    description:
      "Calculate a preliminary debt-to-income percentage from gross monthly household income and recurring monthly debts.",
    parameters: {
      type: "object",
      properties: {
        gross_monthly_household_income: { type: "number", minimum: 1 },
        monthly_recurring_debt: { type: "number", minimum: 0 }
      },
      required: [
        "gross_monthly_household_income",
        "monthly_recurring_debt"
      ],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "send_resource_link",
    description:
      "Send an approved DPA Help Center readiness resource by SMS after customer confirmation.",
    parameters: {
      type: "object",
      properties: {
        resource_type: {
          type: "string",
          enum: [
            "application",
            "dti_calculator",
            "prephub",
            "credit_readiness",
            "tax_readiness",
            "employment_readiness"
          ]
        },
        consent_confirmed: { type: "boolean" }
      },
      required: ["resource_type", "consent_confirmed"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "schedule_callback",
    description:
      "Schedule a confirmed callback and pause the normal calling cadence.",
    parameters: {
      type: "object",
      properties: {
        callback_at: {
          type: "string",
          description: "ISO 8601 datetime including timezone offset."
        },
        timezone: { type: "string" },
        reason: { type: "string" },
        primary_concern: { type: "string" },
        hold_reason: { type: "string" },
        discussion_summary: { type: "string" },
        preferred_contact_method: {
          type: "string",
          enum: ["phone", "sms", "email"]
        },
        sms_confirmation_consent: { type: "boolean" },
        prospect_confirmed: { type: "boolean" }
      },
      required: [
        "callback_at",
        "timezone",
        "reason",
        "sms_confirmation_consent",
        "prospect_confirmed"
      ],
      additionalProperties: false
    }
  },

  {
    type: "function",
    name: "create_specialist_handoff",
    description: "Create a structured handoff for a DPA specialist.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        priority: {
          type: "string",
          enum: ["normal", "high", "urgent"]
        },
        summary: { type: "string" },
        requested_callback_at: { type: "string" }
      },
      required: ["reason", "priority", "summary"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "transfer_to_specialist",
    description:
      "Attempt a live transfer to an available DPA specialist after explicit customer agreement.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        priority: {
          type: "string",
          enum: ["normal", "high", "urgent"]
        },
        prospect_confirmed: { type: "boolean" }
      },
      required: ["reason", "priority", "prospect_confirmed"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "mark_contact_restriction",
    description:
      "Stop or restrict future contact when the number is wrong, invalid, not interested, or opted out.",
    parameters: {
      type: "object",
      properties: {
        restriction_type: {
          type: "string",
          enum: [
            "wrong_number",
            "invalid_number",
            "do_not_call",
            "not_interested"
          ]
        },
        reason: { type: "string" },
        stop_voice: { type: "boolean" },
        stop_sms: { type: "boolean" },
        stop_email: { type: "boolean" }
      },
      required: [
        "restriction_type",
        "reason",
        "stop_voice",
        "stop_sms",
        "stop_email"
      ],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "complete_call",
    description:
      "Complete the conversation with the final outcome, next action, summary, and cadence instruction.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "qualified",
            "hot_transfer",
            "specialist_handoff",
            "specialist_callback",
            "follow_up_scheduled",
            "application_link_sent",
            "dti_calculator_sent",
            "needs_review",
            "nurture",
            "voicemail",
            "no_answer",
            "busy",
            "not_interested",
            "wrong_number",
            "opt_out",
            "disconnected",
            "technical_failure",
            "agent_notified"
          ]
        },
        next_action: { type: "string" },
        summary: { type: "string" },
        stop_sequence: { type: "boolean" },
        pause_sequence: { type: "boolean" },
        requested_next_call_at: { type: "string" }
      },
      required: [
        "outcome",
        "next_action",
        "summary",
        "stop_sequence",
        "pause_sequence"
      ],
      additionalProperties: false
    }
  }
];

async function runMigrationStep(name, sql, options = {}) {
  const { optional = false } = options;
  try {
    await pool.query(sql);
    console.log(`Database migration complete: ${name}`);
  } catch (error) {
    console.error(`Database migration failed: ${name}`, error);
    if (!optional) throw error;
  }
}

async function initializeDatabase() {
  console.log("Initializing HELUX AI Workforce database...");

  await runMigrationStep(
    "create ai_calls",
    `
      CREATE TABLE IF NOT EXISTS ai_calls (
        id BIGSERIAL PRIMARY KEY,
        call_id VARCHAR(100) UNIQUE NOT NULL,
        request_key VARCHAR(320) UNIQUE NOT NULL,
        case_id VARCHAR(150),
        lead_id VARCHAR(150),
        phone VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'created',
        stream_token VARCHAR(160) NOT NULL,
        twilio_call_sid VARCHAR(80),
        attempts INTEGER NOT NULL DEFAULT 0,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
        result JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error TEXT,
        started_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  const aiCallColumns = [
    ["sequence_status", "VARCHAR(50) NOT NULL DEFAULT 'ready'"],
    ["max_attempts", "INTEGER NOT NULL DEFAULT 6"],
    ["next_attempt_at", "TIMESTAMPTZ"],
    ["timezone", "VARCHAR(100) NOT NULL DEFAULT 'America/New_York'"],
    ["consent_status", "VARCHAR(50) NOT NULL DEFAULT 'unverified'"],
    ["consent_timestamp", "TIMESTAMPTZ"],
    ["consent_source", "VARCHAR(255)"],
    ["do_not_call", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["wrong_number", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["invalid_number", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["current_state", "VARCHAR(80) NOT NULL DEFAULT 'greeting'"],
    ["next_state", "VARCHAR(80)"],
    ["sentiment", "VARCHAR(50)"],
    ["outcome", "VARCHAR(80)"],
    ["next_action", "TEXT"],
    ["summary", "TEXT"],
    ["callback_at", "TIMESTAMPTZ"],
    ["callback_timezone", "VARCHAR(100)"],
    ["actions", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ["voicemail_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_attempt_id", "VARCHAR(100)"],
    ["agent_version", "VARCHAR(50)"],
    ["prompt_version", "VARCHAR(80)"],
    ["tool_version", "VARCHAR(80)"],
    ["knowledge_version", "VARCHAR(80)"],
    ["routing_version", "VARCHAR(80)"],
    ["cadence_version", "VARCHAR(100)"],
    ["monday_item_id", "VARCHAR(100)"],
    ["monday_group_id", "VARCHAR(100)"],
    ["monday_last_sync_at", "TIMESTAMPTZ"],
    ["monday_last_error", "TEXT"],
    ["human_owner_id", "VARCHAR(100)"],
    ["priority", "VARCHAR(30) NOT NULL DEFAULT 'normal'"],
    ["last_attempt_at", "TIMESTAMPTZ"],
    ["callback_requested", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["awaiting_customer_response", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["pending_question_type", "VARCHAR(100)"],
    ["pending_question_text", "TEXT"],
    ["question_asked_at", "TIMESTAMPTZ"],
    ["response_reminder_count", "INTEGER NOT NULL DEFAULT 0"]
  ];

  for (const [columnName, definition] of aiCallColumns) {
    await runMigrationStep(
      `ai_calls.${columnName}`,
      `ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`
    );
  }

  await runMigrationStep(
    "create call_attempts",
    `
      CREATE TABLE IF NOT EXISTS call_attempts (
        id BIGSERIAL PRIMARY KEY,
        attempt_id VARCHAR(100) UNIQUE NOT NULL,
        call_id VARCHAR(100) NOT NULL,
        attempt_number INTEGER NOT NULL,
        call_leg INTEGER NOT NULL DEFAULT 1,
        scheduled_at TIMESTAMPTZ,
        dialed_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        twilio_call_sid VARCHAR(80),
        technical_status VARCHAR(50) NOT NULL DEFAULT 'created',
        business_outcome VARCHAR(80),
        answered_by VARCHAR(30) NOT NULL DEFAULT 'unknown',
        voicemail_left BOOLEAN NOT NULL DEFAULT FALSE,
        sms_sent BOOLEAN NOT NULL DEFAULT FALSE,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        disconnect_reason TEXT,
        next_attempt_at TIMESTAMPTZ,
        transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary TEXT,
        actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  const attemptColumns = [
    ["attempt_id", "VARCHAR(100)"],
    ["call_id", "VARCHAR(100)"],
    ["attempt_number", "INTEGER"],
    ["call_leg", "INTEGER NOT NULL DEFAULT 1"],
    ["scheduled_at", "TIMESTAMPTZ"],
    ["dialed_at", "TIMESTAMPTZ"],
    ["answered_at", "TIMESTAMPTZ"],
    ["completed_at", "TIMESTAMPTZ"],
    ["twilio_call_sid", "VARCHAR(80)"],
    ["technical_status", "VARCHAR(50) NOT NULL DEFAULT 'created'"],
    ["business_outcome", "VARCHAR(80)"],
    ["answered_by", "VARCHAR(30) NOT NULL DEFAULT 'unknown'"],
    ["voicemail_left", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["sms_sent", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["duration_seconds", "INTEGER NOT NULL DEFAULT 0"],
    ["disconnect_reason", "TEXT"],
    ["next_attempt_at", "TIMESTAMPTZ"],
    ["transcript", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ["summary", "TEXT"],
    ["actions", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ["last_error", "TEXT"],
    ["monday_subitem_id", "VARCHAR(100)"],
    ["monday_last_sync_at", "TIMESTAMPTZ"],
    ["monday_last_error", "TEXT"],
    ["attempt_type", "VARCHAR(50) NOT NULL DEFAULT 'cadence'"],
    ["idempotency_key", "VARCHAR(255)"],
    ["cancellation_reason", "TEXT"],
    ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
    ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"]
  ];

  for (const [columnName, definition] of attemptColumns) {
    await runMigrationStep(
      `call_attempts.${columnName}`,
      `ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`
    );
  }

  await runMigrationStep(
    "classify legacy explicit attempts",
    `UPDATE call_attempts ca
     SET attempt_type = CASE
       WHEN ac.payload->>'call_type' = 'dpa_agent_notification' THEN 'specialist_notification'
       WHEN ac.current_state IN ('reconnect_pending', 'reconnect_in_progress') THEN 'disconnect_reconnect'
       WHEN ac.current_state = 'application_checkpoint' THEN 'application_checkpoint'
       WHEN ac.callback_requested AND ca.scheduled_at = ac.callback_at THEN 'customer_callback'
       ELSE ca.attempt_type
     END
     FROM ai_calls ac
     WHERE ac.call_id = ca.call_id AND ca.attempt_type = 'cadence'
       AND ca.completed_at IS NULL
       AND ca.technical_status IN ('pending', 'scheduled', 'created')`
  );

  await runMigrationStep(
    "create integration_state",
    `
      CREATE TABLE IF NOT EXISTS integration_state (
        state_key VARCHAR(150) PRIMARY KEY,
        state_value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  await runMigrationStep(
    "create sms_deliveries",
    `
      CREATE TABLE IF NOT EXISTS sms_deliveries (
        message_sid VARCHAR(80) PRIMARY KEY,
        call_id VARCHAR(100) NOT NULL,
        message_type VARCHAR(80) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'accepted',
        error_code VARCHAR(50),
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  const indexSteps = [
    [
      "idx_ai_calls_case_id",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_case_id ON ai_calls(case_id)"
    ],
    [
      "idx_ai_calls_lead_id",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_lead_id ON ai_calls(lead_id)"
    ],
    [
      "idx_ai_calls_status",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_status ON ai_calls(status)"
    ],
    [
      "idx_ai_calls_due",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_due ON ai_calls(sequence_status, next_attempt_at)"
    ],
    [
      "idx_ai_calls_twilio_sid",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_twilio_sid ON ai_calls(twilio_call_sid)"
    ],
    [
      "idx_ai_calls_monday_item",
      "CREATE INDEX IF NOT EXISTS idx_ai_calls_monday_item ON ai_calls(monday_item_id)"
    ],
    [
      "idx_call_attempts_call_id",
      "CREATE INDEX IF NOT EXISTS idx_call_attempts_call_id ON call_attempts(call_id, attempt_number, call_leg)"
    ],
    [
      "idx_call_attempts_twilio_sid",
      "CREATE INDEX IF NOT EXISTS idx_call_attempts_twilio_sid ON call_attempts(twilio_call_sid)"
    ],
    [
      "idx_call_attempts_monday_subitem",
      "CREATE INDEX IF NOT EXISTS idx_call_attempts_monday_subitem ON call_attempts(monday_subitem_id)"
    ],
    [
      "idx_call_attempts_idempotency_key",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_call_attempts_idempotency_key ON call_attempts(idempotency_key) WHERE idempotency_key IS NOT NULL"
    ],
    [
      "idx_sms_deliveries_call_id",
      "CREATE INDEX IF NOT EXISTS idx_sms_deliveries_call_id ON sms_deliveries(call_id, message_type)"
    ]
  ];

  for (const [name, sql] of indexSteps) {
    await runMigrationStep(name, sql, { optional: true });
  }

  await cleanupPreResultDuplicateAttempts();
  await runMigrationStep(
    "idx_call_attempts_one_pending_cadence",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_attempts_one_pending_cadence
     ON call_attempts(call_id)
     WHERE attempt_type = 'cadence'
       AND technical_status IN ('pending', 'scheduled', 'created')
       AND completed_at IS NULL`
  );

  console.log("HELUX AI Workforce database initialized.");
}

async function getCallById(callId) {
  const result = await pool.query(
    "SELECT * FROM ai_calls WHERE call_id = $1 LIMIT 1",
    [callId]
  );
  return result.rows[0] || null;
}

async function getCallByRequestKey(requestKey) {
  const result = await pool.query(
    "SELECT * FROM ai_calls WHERE request_key = $1 LIMIT 1",
    [requestKey]
  );
  return result.rows[0] || null;
}

async function getAttemptById(attemptId) {
  const result = await pool.query(
    "SELECT * FROM call_attempts WHERE attempt_id = $1 LIMIT 1",
    [attemptId]
  );
  return result.rows[0] || null;
}

function pendingAttemptStatus(status) {
  return ["pending", "scheduled", "created"].includes(
    String(status || "").toLowerCase()
  );
}

function attemptTypeForCall(call, requestedType = null) {
  if (requestedType) return requestedType;
  if (call.payload?.call_type === "dpa_agent_notification") {
    return "specialist_notification";
  }
  if (call.current_state === "application_checkpoint") {
    return "application_checkpoint";
  }
  if (["reconnect_pending", "reconnect_in_progress"].includes(call.current_state)) {
    return "disconnect_reconnect";
  }
  if (call.callback_requested || call.sequence_status === "callback_scheduled") {
    return "customer_callback";
  }
  return "cadence";
}

async function ensurePendingAttempt(callId, options = {}) {
  const client = options.client || pool;
  const callResult = await client.query(
    "SELECT * FROM ai_calls WHERE call_id = $1 LIMIT 1",
    [callId]
  );
  const call = callResult.rows[0];
  if (!call) throw new Error("Call sequence not found.");

  const attemptType = attemptTypeForCall(call, options.attemptType);
  const scheduledAt = options.scheduledAt || call.next_attempt_at || new Date();
  const attemptNumber = Number(call.attempts || 0) + 1;
  const idempotencyKey =
    options.idempotencyKey || `${attemptType}:${call.call_id}:${attemptNumber}`;
  const attemptId = createPublicId("ATTEMPT");
  const inserted = await client.query(
    `
      INSERT INTO call_attempts (
        attempt_id, call_id, attempt_number, call_leg, scheduled_at,
        technical_status, attempt_type, idempotency_key
      )
      VALUES ($1, $2, $3, 1, $4, 'pending', $5, $6)
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [attemptId, call.call_id, attemptNumber, scheduledAt, attemptType, idempotencyKey]
  );

  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await client.query(
    `
      SELECT * FROM call_attempts
      WHERE call_id = $1 AND completed_at IS NULL
        AND technical_status IN ('pending', 'scheduled', 'created')
        AND (idempotency_key = $2 OR ($3 = 'cadence' AND attempt_type = 'cadence'))
      ORDER BY scheduled_at ASC NULLS FIRST, id ASC
      LIMIT 1
    `,
    [call.call_id, idempotencyKey, attemptType]
  );
  return existing.rows[0] || null;
}

async function sequenceHasUnresolvedWork(callId, client = pool) {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1 FROM ai_calls
        WHERE call_id = $1 AND (
          sequence_status = 'human_action'
          OR awaiting_customer_response = TRUE
          OR next_attempt_at IS NOT NULL
          OR (callback_requested AND callback_at > NOW())
        )
      ) OR EXISTS (
        SELECT 1 FROM call_attempts
        WHERE call_id = $1 AND completed_at IS NULL
          AND technical_status NOT IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')
      ) OR EXISTS (
        SELECT 1 FROM sms_deliveries
        WHERE call_id = $1 AND LOWER(status) IN ('accepted', 'queued', 'sending')
      ) AS unresolved
    `,
    [callId]
  );
  return Boolean(result.rows[0]?.unresolved);
}

async function reconcileScheduledAttempts() {
  const scheduled = await pool.query(
    `SELECT * FROM ai_calls
     WHERE sequence_status IN ('ready', 'active', 'scheduled', 'waiting_retry', 'callback_scheduled')
       AND next_attempt_at IS NOT NULL
       AND do_not_call = FALSE AND wrong_number = FALSE AND invalid_number = FALSE`
  );
  for (const call of scheduled.rows) {
    const attemptType = attemptTypeForCall(call);
    if (attemptType !== "cadence") {
      const cancelled = await pool.query(
        `UPDATE call_attempts SET technical_status = 'canceled', completed_at = NOW(),
         cancellation_reason = 'ordinary_cadence_paused_for_explicit_action', updated_at = NOW()
         WHERE call_id = $1 AND attempt_type = 'cadence' AND completed_at IS NULL
           AND technical_status IN ('pending', 'scheduled', 'created')
         RETURNING *`,
        [call.call_id]
      );
      for (const attempt of cancelled.rows) {
        logSchedulingDecision(
          call,
          attempt,
          "cancel",
          "ordinary_cadence_paused_for_explicit_action"
        );
      }
    }
    await ensurePendingAttempt(call.call_id, {
      attemptType,
      scheduledAt: call.next_attempt_at,
      idempotencyKey:
        attemptType === "cadence"
          ? `cadence:${call.call_id}:${Number(call.attempts || 0) + 1}`
          : `${attemptType}:${call.call_id}:${new Date(call.next_attempt_at).toISOString()}`
    });
  }
}

async function cleanupPreResultDuplicateAttempts() {
  const cancelled = await pool.query(
    `
      WITH ranked AS (
        SELECT ca.id,
          ROW_NUMBER() OVER (
            PARTITION BY ca.call_id
            ORDER BY ca.scheduled_at ASC NULLS FIRST, ca.id ASC
          ) AS pending_rank
        FROM call_attempts ca
        WHERE ca.attempt_type = 'cadence'
          AND ca.completed_at IS NULL
          AND ca.dialed_at IS NULL
          AND ca.technical_status IN ('pending', 'scheduled', 'created')
          AND NOT EXISTS (
            SELECT 1 FROM call_attempts result_attempt
            WHERE result_attempt.call_id = ca.call_id
              AND (
                result_attempt.completed_at IS NOT NULL
                OR result_attempt.dialed_at IS NOT NULL
                OR result_attempt.business_outcome IS NOT NULL
              )
          )
      )
      UPDATE call_attempts ca
      SET technical_status = 'canceled', completed_at = NOW(),
          cancellation_reason = 'pre_result_duplicate_cadence_cleanup',
          updated_at = NOW()
      FROM ranked
      WHERE ca.id = ranked.id AND ranked.pending_rank > 1
      RETURNING ca.call_id, ca.attempt_id, ca.attempt_type,
                ca.scheduled_at, ca.technical_status
    `
  );

  const remainingDuplicates = await pool.query(
    `
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY call_id ORDER BY scheduled_at ASC NULLS FIRST, id ASC
        ) AS pending_rank
        FROM call_attempts
        WHERE attempt_type = 'cadence' AND completed_at IS NULL
          AND technical_status IN ('pending', 'scheduled', 'created')
      )
      UPDATE call_attempts ca
      SET technical_status = 'canceled', completed_at = NOW(),
          cancellation_reason = 'concurrent_duplicate_cadence_cleanup',
          updated_at = NOW()
      FROM ranked
      WHERE ca.id = ranked.id AND ranked.pending_rank > 1
      RETURNING ca.call_id, ca.attempt_id, ca.attempt_type,
                ca.scheduled_at, ca.technical_status
    `
  );

  const due = await pool.query(
    `
      WITH earliest AS (
        SELECT DISTINCT ON (call_id) call_id, attempt_id
        FROM call_attempts
        WHERE attempt_type = 'cadence' AND completed_at IS NULL
          AND technical_status IN ('pending', 'scheduled', 'created')
        ORDER BY call_id, scheduled_at ASC NULLS FIRST, id ASC
      ), made_due AS (
        UPDATE call_attempts ca
        SET scheduled_at = NOW(), updated_at = NOW()
        FROM earliest
        WHERE ca.attempt_id = earliest.attempt_id AND ca.scheduled_at < NOW()
        RETURNING ca.call_id, ca.scheduled_at
      )
      UPDATE ai_calls ac
      SET next_attempt_at = made_due.scheduled_at,
          sequence_status = CASE WHEN ac.sequence_status = 'completed' THEN 'scheduled' ELSE ac.sequence_status END,
          completed_at = NULL, updated_at = NOW()
      FROM made_due
      WHERE ac.call_id = made_due.call_id
      RETURNING ac.call_id
    `
  );
  for (const attempt of cancelled.rows) {
    const call = await getCallById(attempt.call_id);
    logSchedulingDecision(
      call,
      attempt,
      "cancel",
      "pre_result_duplicate_cadence_cleanup"
    );
  }
  for (const attempt of remainingDuplicates.rows) {
    const call = await getCallById(attempt.call_id);
    logSchedulingDecision(
      call,
      attempt,
      "cancel",
      "concurrent_duplicate_cadence_cleanup"
    );
  }

  console.log(JSON.stringify({
    event: "scheduler_cleanup",
    decision: "cancel",
    reason: "pre_result_duplicate_cadence_cleanup",
    cancelled_attempts: cancelled.rowCount + remainingDuplicates.rowCount,
    overdue_attempts_made_due: due.rowCount
  }));
}

async function getCallByMondayItemId(itemId) {
  const result = await pool.query(
    "SELECT * FROM ai_calls WHERE monday_item_id = $1 LIMIT 1",
    [String(itemId)]
  );
  return result.rows[0] || null;
}

async function getIntegrationState(stateKey) {
  const result = await pool.query(
    "SELECT state_value FROM integration_state WHERE state_key = $1 LIMIT 1",
    [stateKey]
  );
  return result.rows[0]?.state_value || null;
}

async function setIntegrationState(stateKey, stateValue) {
  await pool.query(
    `
      INSERT INTO integration_state (state_key, state_value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()
    `,
    [stateKey, JSON.stringify(stateValue || {})]
  );
}

async function getAttemptsForCall(callId) {
  const result = await pool.query(
    `
      SELECT *
      FROM call_attempts
      WHERE call_id = $1
      ORDER BY attempt_number ASC, call_leg ASC
    `,
    [callId]
  );
  return result.rows;
}

async function validateCallToken(callId, token) {
  const result = await pool.query(
    `
      SELECT *
      FROM ai_calls
      WHERE call_id = $1 AND stream_token = $2
      LIMIT 1
    `,
    [callId, token]
  );
  return result.rows[0] || null;
}

async function appendTranscript(callId, speaker, text) {
  const cleaned = cleanText(text, 8000);
  if (!cleaned) return;

  const entry = { speaker, text: cleaned, at: new Date().toISOString() };
  await pool.query(
    `
      UPDATE ai_calls
      SET transcript = transcript || $2::jsonb, updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, JSON.stringify([entry])]
  );

  const call = await getCallById(callId);
  if (call && call.last_attempt_id) {
    await pool.query(
      `
        UPDATE call_attempts
        SET transcript = transcript || $2::jsonb, updated_at = NOW()
        WHERE attempt_id = $1
      `,
      [call.last_attempt_id, JSON.stringify([entry])]
    );
  }
}

async function appendAction(callId, action) {
  const entry = { ...action, at: new Date().toISOString() };
  await pool.query(
    `
      UPDATE ai_calls
      SET actions = actions || $2::jsonb, updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, JSON.stringify([entry])]
  );

  const call = await getCallById(callId);
  if (call && call.last_attempt_id) {
    await pool.query(
      `
        UPDATE call_attempts
        SET actions = actions || $2::jsonb, updated_at = NOW()
        WHERE attempt_id = $1
      `,
      [call.last_attempt_id, JSON.stringify([entry])]
    );
  }
}

async function mergeCallResult(callId, patch) {
  await pool.query(
    `
      UPDATE ai_calls
      SET result = result || $2::jsonb, updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, JSON.stringify(patch || {})]
  );
}

function extractPrimaryQuestion(value) {
  const text = cleanText(value, 8000);
  if (!text) return null;
  const questions = text.match(/[^?]+\?/g) || [];
  const rawQuestion = questions.at(-1) || "";
  const lastPeriod = rawQuestion.lastIndexOf(". ");
  const lastExclamation = rawQuestion.lastIndexOf("! ");
  const boundary = Math.max(lastPeriod, lastExclamation);
  const question = cleanText(
    boundary >= 0 ? rawQuestion.slice(boundary + 2) : rawQuestion,
    2000
  );
  if (!question) return null;
  return { text: question, count: questions.length };
}

function pendingQuestionType(value) {
  const text = normalizeMondayKey(value);
  if (/speakwith|isthis/.test(text)) return "identity_confirmation";
  if (/realtor|realestateagent/.test(text)) return "has_realtor";
  if (/lender|preapproved|preapproval/.test(text)) return "applied_with_lender";
  if (/start.*application|application.*start/.test(text)) {
    return "application_started";
  }
  if (/send.*link|text.*link|want.*link|receive.*link/.test(text)) {
    return "application_link_permission";
  }
  if (/when|whatday|whattime|timezone|followup|callback/.test(text)) {
    return "callback_time";
  }
  if (/correct|isthatright|stillaccurate|confirm/.test(text)) {
    return "confirmation";
  }
  if (/timeframe|timeline|purchase|buy|income|credit|employment|tax/.test(text)) {
    return "qualification";
  }
  return "general_question";
}

function normalizeCustomerUtterance(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\[\](){}]/g, " ")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function affirmativeCustomerResponse(value) {
  const normalized = normalizeCustomerUtterance(value);

  return [
    "yes",
    "yes sir",
    "yes ma'am",
    "yeah",
    "yep",
    "yup",
    "mmm hmm",
    "mm hmm",
    "mhm",
    "mmhm",
    "uh huh",
    "sure",
    "sure is",
    "absolutely",
    "correct",
    "that's correct",
    "that is correct",
    "sounds good",
    "that sounds good"
  ].includes(normalized);
}

function likelyBackgroundNoiseTranscript(value) {
  const normalized = normalizeCustomerUtterance(value);

  if (!normalized) return true;

  return [
    "noise",
    "background noise",
    "blank audio",
    "inaudible",
    "silence",
    "static",
    "click",
    "clicking",
    "clatter",
    "clattering",
    "dish",
    "dishes",
    "music",
    "television",
    "tv",
    "echo",
    "beep",
    "beeping",
    "rustling",
    "shuffling",
    "phone movement",
    "phone moving",
    "door",
    "door closes",
    "door slams"
  ].includes(normalized);
}

function isMeaningfulCustomerTranscript(value) {
  const normalized = normalizeCustomerUtterance(value);

  if (!normalized || likelyBackgroundNoiseTranscript(normalized)) {
    return false;
  }

  return ![
    "um",
    "uh",
    "hmm",
    "hm",
    "mm"
  ].includes(normalized);
}

function customerAskedSeparateQuestion(value) {
  const text = String(value || "").trim();
  return (
    /\?\s*$/.test(text) ||
    /^(what|why|when|where|who|how|can|could|would|will|do|does|did|is|are)\b/i.test(
      text
    )
  );
}

function customerRequestedMoreTime(value) {
  return /\b(give me (a |one )?(minute|moment|second)|one moment|hold on|let me (think|check)|need (a |one )?(minute|moment|second)|more time)\b/i.test(
    String(value || "")
  );
}

function customerExplicitlyInterrupted(value) {
  return /\b(wait|stop|hold on|hang on|excuse me|one moment)\b/i.test(
    String(value || "")
  );
}

function directYesNoQuestion(value) {
  const text = String(value || "").trim();

  return (
    /^(hi,?\s+)?(is|are|am|was|were|do|does|did|have|has|had|can|could|would|will|should)\b/i.test(
      text
    ) ||
    /\b(correct|right)\?$/i.test(text) ||
    /\bhow does that sound\?$/i.test(text) ||
    /\bdoes that sound (good|okay)\?$/i.test(text)
  );
}

function presenceOnlyResponse(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    "yes", "yeah", "yep", "i am", "i'm here", "im here", "still here",
    "yes i am", "yeah i'm here", "yeah im here"
  ].includes(normalized);
}

function logCustomerResponseState(callId, details = {}) {
  console.log(JSON.stringify({
    event: "customer_response_wait_state",
    call_id: callId,
    pending_question_type: details.pending_question_type || null,
    awaiting_customer_response: details.awaiting_customer_response === true,
    question_asked_at: details.question_asked_at || null,
    customer_speech_detected: details.customer_speech_detected === true,
    completed_transcript_received:
      details.completed_transcript_received === true,
    response_reminder_count: Number(details.response_reminder_count || 0),
    waiting_state_end_reason: details.waiting_state_end_reason || null
  }));
}

async function setAwaitingCustomerResponse(callId, question) {
  const askedAt = new Date();
  const questionType = pendingQuestionType(question.text);
  await pool.query(
    `
      UPDATE ai_calls
      SET awaiting_customer_response = TRUE,
          pending_question_type = $2,
          pending_question_text = $3,
          question_asked_at = $4,
          response_reminder_count = 0,
          updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, questionType, question.text, askedAt]
  );
  logCustomerResponseState(callId, {
    pending_question_type: questionType,
    awaiting_customer_response: true,
    question_asked_at: askedAt.toISOString(),
    response_reminder_count: 0
  });
  if (question.count > 1) {
    console.warn(JSON.stringify({
      event: "stacked_question_detected",
      call_id: callId,
      question_count: question.count,
      pending_question_text: question.text
    }));
  }
  return {
    pending_question_type: questionType,
    pending_question_text: question.text,
    question_asked_at: askedAt.toISOString(),
    response_reminder_count: 0
  };
}

async function clearAwaitingCustomerResponse(callId, reason) {
  const previous = await getCallById(callId);
  await pool.query(
    `
      UPDATE ai_calls
      SET awaiting_customer_response = FALSE,
          pending_question_type = NULL,
          pending_question_text = NULL,
          question_asked_at = NULL,
          response_reminder_count = 0,
          updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId]
  );
  logCustomerResponseState(callId, {
    pending_question_type: previous?.pending_question_type,
    question_asked_at: previous?.question_asked_at,
    awaiting_customer_response: false,
    response_reminder_count: 0,
    waiting_state_end_reason: reason
  });
}

async function setResponseReminderCount(callId, count, questionState) {
  await pool.query(
    `UPDATE ai_calls SET response_reminder_count = $2, updated_at = NOW()
     WHERE call_id = $1`,
    [callId, count]
  );
  logCustomerResponseState(callId, {
    ...questionState,
    awaiting_customer_response: true,
    response_reminder_count: count
  });
}

/* -------------------------------------------------------------------------- */
/* monday.com isolated adapter */
/* -------------------------------------------------------------------------- */

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeMondayKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseMondaySettings(settings) {
  if (!settings) return {};
  if (typeof settings === "object") return settings;
  try {
    return JSON.parse(settings);
  } catch {
    return {};
  }
}

async function mondayRequest(query, variables = {}, options = {}) {
  if (!MONDAY_SYNC_ENABLED) {
    throw new Error("monday.com sync is disabled or not fully configured.");
  }

  const mutation = /^\s*mutation\b/i.test(query);
  const maxRetries = Number.isInteger(options.maxRetries)
    ? options.maxRetries
    : 2;
  const idempotencyKey = options.idempotencyKey
    ? stableHash(options.idempotencyKey)
    : null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      MONDAY_REQUEST_TIMEOUT_MS
    );

    try {
      const headers = {
        Authorization: MONDAY_API_TOKEN,
        "Content-Type": "application/json",
        "API-Version": MONDAY_API_VERSION
      };

      if (mutation && idempotencyKey) {
        headers["Idempotency-Key"] = idempotencyKey;
      }

      const response = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });

      const rawBody = await response.text();
      let body = null;

      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        body = { raw: rawBody };
      }

      const retryableHttp = [408, 409, 429, 500, 502, 503, 504].includes(
        response.status
      );

      if (!response.ok) {
        const error = new Error(
          `monday.com HTTP ${response.status}: ${cleanText(rawBody, 1200)}`
        );
        error.statusCode = response.status;

        if (retryableHttp && attempt < maxRetries) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(500, retryAfterSeconds * 1000)
            : 500 * 2 ** attempt;
          await sleep(waitMs);
          continue;
        }

        throw error;
      }

      if (Array.isArray(body.errors) && body.errors.length) {
        const message = body.errors
          .map((entry) => entry.message || "Unknown monday.com error")
          .join(" | ");
        const error = new Error(`monday.com GraphQL error: ${message}`);
        error.mondayErrors = body.errors;
        throw error;
      }

      return body.data || {};
    } catch (error) {
      const retryableNetwork =
        error.name === "AbortError" ||
        ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(
          error.code
        );

      if (retryableNetwork && attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("monday.com request failed after retries.");
}
function buildMondayBoardMetadata(board) {
  const columns = Array.isArray(board.columns) ? board.columns : [];
  const groups = Array.isArray(board.groups) ? board.groups : [];

  const columnByTitle = new Map();
  for (const column of columns) {
    const key = normalizeMondayKey(column.title);
    if (key && !columnByTitle.has(key)) {
      columnByTitle.set(key, {
        ...column,
        settings: parseMondaySettings(column.settings)
      });
    }
  }

  const groupByTitle = new Map();
  for (const group of groups) {
    const key = normalizeMondayKey(group.title);
    if (key && !groupByTitle.has(key)) groupByTitle.set(key, group);
  }

  return {
    id: String(board.id),
    name: board.name,
    columns,
    groups,
    columnByTitle,
    groupByTitle
  };
}

async function loadMondayMetadata(options = {}) {
  if (!MONDAY_SYNC_ENABLED) return null;

  const force = options.force === true;
  if (
    !force &&
    mondayMetadataCache &&
    Date.now() < mondayMetadataExpiresAt
  ) {
    return mondayMetadataCache;
  }

  const query = `
    query HeluxMondayMetadata($mainIds: [ID!], $subitemIds: [ID!]) {
      main: boards(ids: $mainIds) {
        id
        name
        groups { id title }
        columns { id title type settings }
      }
      subitems: boards(ids: $subitemIds) {
        id
        name
        groups { id title }
        columns { id title type settings }
      }
    }
  `;

  const data = await mondayRequest(query, {
    mainIds: [MONDAY_BOARD_ID],
    subitemIds: [MONDAY_SUBITEM_BOARD_ID]
  });

  const mainBoard = Array.isArray(data.main) ? data.main[0] : null;
  const subitemBoard = Array.isArray(data.subitems) ? data.subitems[0] : null;

  if (!mainBoard) {
    throw new Error(`monday.com main board ${MONDAY_BOARD_ID} was not found.`);
  }

  if (!subitemBoard) {
    throw new Error(
      `monday.com subitem board ${MONDAY_SUBITEM_BOARD_ID} was not found.`
    );
  }

  mondayMetadataCache = {
    loadedAt: new Date().toISOString(),
    main: buildMondayBoardMetadata(mainBoard),
    subitems: buildMondayBoardMetadata(subitemBoard)
  };
  mondayMetadataExpiresAt = Date.now() + MONDAY_METADATA_CACHE_MS;

  return mondayMetadataCache;
}

function findMondayColumn(boardMetadata, aliases) {
  const list = Array.isArray(aliases) ? aliases : [aliases];

  for (const alias of list) {
    const exact = boardMetadata.columnByTitle.get(normalizeMondayKey(alias));
    if (exact) return exact;
  }

  for (const alias of list) {
    const normalizedAlias = normalizeMondayKey(alias);
    for (const column of boardMetadata.columns) {
      const normalizedTitle = normalizeMondayKey(column.title);
      if (
        normalizedAlias &&
        (normalizedTitle.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedTitle))
      ) {
        return {
          ...column,
          settings: parseMondaySettings(column.settings)
        };
      }
    }
  }

  return null;
}

function findMondayColumnById(boardMetadata, columnId) {
  const column = boardMetadata.columns.find(
    (candidate) => String(candidate.id) === String(columnId)
  );
  return column
    ? { ...column, settings: parseMondaySettings(column.settings) }
    : null;
}

function findMondayGroup(boardMetadata, aliases) {
  const list = Array.isArray(aliases) ? aliases : [aliases];
  for (const alias of list) {
    const exact = boardMetadata.groupByTitle.get(normalizeMondayKey(alias));
    if (exact) return exact;
  }
  return null;
}

function mondayDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19)
  };
}

function mondayPhoneCountry(phone) {
  const normalized = String(phone || "");
  if (normalized.startsWith("+55")) return "BR";
  if (normalized.startsWith("+57")) return "CO";
  if (normalized.startsWith("+52")) return "MX";
  if (normalized.startsWith("+44")) return "GB";
  if (normalized.startsWith("+61")) return "AU";
  if (normalized.startsWith("+1")) return "US";
  return "US";
}

function mondayStatusValue(column, desiredLabel) {
  if (!desiredLabel) return null;
  const settings = parseMondaySettings(column.settings);
  const labels = Array.isArray(settings.labels)
    ? settings.labels
    : Object.entries(settings.labels || {}).map(([id, label]) => ({
        id,
        label: typeof label === "object" ? label?.label || label?.name : label
      }));
  const wanted = normalizeMondayKey(desiredLabel);
  const found = labels.find(
    (label) => normalizeMondayKey(label.label) === wanted
  );

  if (!found) return null;
  return { index: Number(found.id) };
}

function mondayColumnValue(column, value) {
  if (value === undefined || value === null || value === "") return null;

  const type = String(column.type || "").toLowerCase();

  if (["status", "color"].includes(type)) {
    return mondayStatusValue(column, value);
  }

  if (type === "dropdown") {
    return { labels: [String(value)] };
  }

  if (["numbers", "numeric"].includes(type)) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? String(numberValue) : null;
  }

  if (["date", "timeline"].includes(type)) {
    return mondayDateValue(value);
  }

  if (["checkbox", "boolean"].includes(type)) {
    return value === true ? { checked: "true" } : null;
  }

  if (type === "phone") {
    return {
      phone: String(value),
      countryShortName: mondayPhoneCountry(value)
    };
  }

  if (["people", "multiple_person", "person"].includes(type)) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { personsAndTeams: [{ id, kind: "person" }] };
  }

  return String(value).slice(0, 10000);
}

function assignMondayValue(target, boardMetadata, aliases, value) {
  const column = findMondayColumn(boardMetadata, aliases);
  if (!column) return;
  const formatted = mondayColumnValue(column, value);
  if (formatted === null || formatted === undefined) return;
  target[column.id] = formatted;
}

function assignMondayValueById(target, boardMetadata, columnId, value) {
  const column = findMondayColumnById(boardMetadata, columnId);
  if (!column) return;
  const formatted = mondayColumnValue(column, value);
  if (formatted === null || formatted === undefined) return;
  target[column.id] = formatted;
}

function sequenceStatusLabel(call) {
  if (call.do_not_call) return "Do Not Call";
  if (call.wrong_number) return "Wrong Number";
  if (call.invalid_number) return "Invalid Number";

  const map = {
    ready: "Ready",
    scheduled: "Scheduled",
    calling: "Calling",
    waiting_retry: "Waiting Retry",
    callback_scheduled: "Callback Scheduled",
    human_action: "Human Action",
    completed: "Completed",
    exhausted: "Exhausted",
    paused: "Paused",
    suppressed: "Do Not Call"
  };

  return map[String(call.sequence_status || "").toLowerCase()] || null;
}

function lastCallResultLabel(call, latestAttempt) {
  const status = String(
    latestAttempt?.technical_status || call.status || ""
  ).toLowerCase();
  const answeredBy = String(latestAttempt?.answered_by || "").toLowerCase();

  if (answeredBy === "voicemail") return "Voicemail";
  if (status === "no-answer") return "No Answer";
  if (status === "busy") return "Busy";
  if (["failed", "canceled"].includes(status)) return "Failed";
  if (status === "disconnected") return "Disconnected";
  if (["answered", "in-progress", "completed"].includes(status)) {
    return "Connected";
  }
  return null;
}

function businessOutcomeLabel(outcome) {
  const map = {
    qualified: "Qualified",
    hot_transfer: "Hot Transfer",
    specialist_handoff: "Specialist Handoff",
    specialist_callback: "Specialist Callback",
    follow_up_scheduled: "Follow-Up Scheduled",
    application_link_sent: "Application Sent",
    dti_calculator_sent: "DTI Sent",
    agent_notified: "Agent Notified",
    application_started_hot_lead: "Application Started — Hot Lead",
    needs_review: "Needs Review",
    nurture: "Nurture",
    not_interested: "Not Interested",
    opt_out: "Opt-Out"
  };
  return map[String(outcome || "").toLowerCase()] || null;
}

function technicalStatusLabel(status) {
  const map = {
    created: "Queued",
    placing: "Queued",
    queued: "Queued",
    initiated: "Queued",
    ringing: "Ringing",
    answered: "In Progress",
    "in-progress": "In Progress",
    completed: "Completed",
    busy: "Busy",
    "no-answer": "No Answer",
    failed: "Failed",
    canceled: "Canceled"
  };
  return map[String(status || "").toLowerCase()] || null;
}

function answeredByLabel(answeredBy) {
  const map = {
    human: "Human",
    voicemail: "Voicemail",
    unknown: "Unknown"
  };
  return map[String(answeredBy || "unknown").toLowerCase()] || "Unknown";
}

function targetMondayGroupTitle(call) {
  const outcome = String(call.outcome || "").toLowerCase();

  if (
    call.do_not_call ||
    call.wrong_number ||
    call.invalid_number ||
    ["not_interested", "wrong_number", "opt_out"].includes(outcome)
  ) {
    return ["Do Not Call List", "Closed or Suppressed"];
  }

  const status = String(call.sequence_status || "").toLowerCase();
  if (
    ["ready", "scheduled", "calling", "waiting_retry", "paused"].includes(
      status
    )
  ) {
    return ["New Leads", "Active Sequences", "Ready to Call"];
  }
  if (status === "callback_scheduled") return ["Callbacks"];
  if (["human_action", "exhausted"].includes(status)) {
    return ["Agent Needed", "Human Action Needed"];
  }
  if (status === "completed") return ["Completed"];
  if (status === "suppressed") {
    return ["Do Not Call List", "Closed or Suppressed"];
  }
  return ["New Leads", "Active Sequences", "Ready to Call"];
}

function leadDisplayName(call) {
  const payload = call.payload || {};
  const fullName = [
    cleanText(payload.first_name, 80),
    cleanText(payload.last_name, 80)
  ]
    .filter(Boolean)
    .join(" ");

  return (
    fullName ||
    cleanText(payload.name, 160) ||
    call.case_id ||
    call.lead_id ||
    call.call_id
  );
}

function buildMainMondayValues(call, latestAttempt, metadata) {
  const values = {};
  const board = metadata.main;
  const result = normalizeDaisyAnswers(call.result || {});

  assignMondayValue(values, board, ["Lead ID"], call.lead_id);
  assignMondayValue(values, board, ["Case ID"], call.case_id);
  assignMondayValue(values, board, ["Phone"], call.phone);
  assignMondayValue(values, board, ["Time Zone", "Timezone"], call.timezone);
  assignMondayValue(values, board, ["AI Agent", "Agent"], "Daisy");
  assignMondayValue(
    values,
    board,
    ["Sequence Status"],
    sequenceStatusLabel(call)
  );
  assignMondayValue(values, board, ["Max Attempts"], call.max_attempts);
  assignMondayValue(values, board, ["Attempts Used"], call.attempts);
  assignMondayValue(
    values,
    board,
    ["Last Call Result"],
    lastCallResultLabel(call, latestAttempt)
  );
  assignMondayValue(
    values,
    board,
    ["Last Call"],
    call.last_attempt_at || latestAttempt?.dialed_at
  );
  assignMondayValue(values, board, ["Next Call"], call.next_attempt_at);
  assignMondayValue(values, board, ["Callback At"], call.callback_at);
  assignMondayValue(
    values,
    board,
    ["Business Outcome"],
    businessOutcomeLabel(call.outcome)
  );
  assignMondayValue(
    values,
    board,
    ["Priority"],
    String(call.priority || "normal").replace(/^./, (c) => c.toUpperCase())
  );
  assignMondayValue(
    values,
    board,
    ["Consent"],
    call.consent_status === "confirmed"
      ? "Confirmed"
      : call.consent_status === "unverified"
        ? "Pending Review"
        : "Not Authorized"
  );
  assignMondayValue(values, board, ["Do Not Call"], call.do_not_call === true);
  assignMondayValue(values, board, ["Next Action"], call.next_action);
  assignMondayValue(values, board, ["Call Summary"], call.summary);
  assignMondayValue(values, board, ["Owner"], call.human_owner_id);
  assignMondayValue(values, board, ["Cadence Version"], call.cadence_version);
  assignMondayValueById(
    values,
    board,
    MONDAY_CALL_CONTROL_COLUMNS.has_realtor,
    result.has_realtor
  );
  assignMondayValueById(
    values,
    board,
    MONDAY_CALL_CONTROL_COLUMNS.applied_with_lender,
    result.applied_with_lender
  );
  assignMondayValueById(
    values,
    board,
    MONDAY_CALL_CONTROL_COLUMNS.app_started_confirmation,
    result.app_started_confirmation
  );
  assignMondayValueById(
    values,
    board,
    MONDAY_CALL_CONTROL_COLUMNS.time_frame,
    result.time_frame
  );

  return values;
}

function buildAttemptMondayValues(attempt, metadata) {
  const values = {};
  const board = metadata.subitems;

  assignMondayValue(values, board, ["Attempt Number"], attempt.attempt_number);
  assignMondayValue(values, board, ["Call Leg"], attempt.call_leg);
  assignMondayValue(
    values,
    board,
    ["Duration Seconds"],
    attempt.duration_seconds
  );
  assignMondayValue(
    values,
    board,
    ["Technical Status"],
    technicalStatusLabel(attempt.technical_status)
  );
  assignMondayValue(
    values,
    board,
    ["Answered By"],
    answeredByLabel(attempt.answered_by)
  );
  assignMondayValue(values, board, ["Dialed At"], attempt.dialed_at);
  assignMondayValue(values, board, ["Scheduled At"], attempt.scheduled_at);
  assignMondayValue(values, board, ["Answered At"], attempt.answered_at);
  assignMondayValue(values, board, ["Twilio SID"], attempt.twilio_call_sid);
  assignMondayValue(values, board, ["Call ID"], attempt.call_id);
  assignMondayValue(values, board, ["Outcome"], attempt.business_outcome);
  assignMondayValue(values, board, ["Attempt Summary"], attempt.summary);
  assignMondayValue(values, board, ["Last Error"], attempt.last_error);

  return values;
}

async function changeMondayValuesResilient(
  boardId,
  itemId,
  columnValues,
  idempotencyPrefix
) {
  const entries = Object.entries(columnValues || {});
  if (!entries.length) return { updated: 0, failed: [] };

  const mutation = `
    mutation HeluxChangeValues(
      $boardId: ID!,
      $itemId: ID!,
      $columnValues: JSON!
    ) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $columnValues,
        create_labels_if_missing: true
      ) { id }
    }
  `;

  try {
    await mondayRequest(
      mutation,
      {
        boardId: String(boardId),
        itemId: String(itemId),
        columnValues: JSON.stringify(columnValues)
      },
      {
        idempotencyKey: `${idempotencyPrefix}:batch:${JSON.stringify(
          columnValues
        )}`
      }
    );

    return { updated: entries.length, failed: [] };
  } catch (batchError) {
    const failed = [];
    let updated = 0;

    for (const [columnId, value] of entries) {
      try {
        await mondayRequest(
          mutation,
          {
            boardId: String(boardId),
            itemId: String(itemId),
            columnValues: JSON.stringify({ [columnId]: value })
          },
          {
            idempotencyKey: `${idempotencyPrefix}:column:${columnId}:${JSON.stringify(
              value
            )}`
          }
        );
        updated += 1;
      } catch (error) {
        failed.push({
          columnId,
          error: cleanText(error.message, 1000)
        });
      }
    }

    if (!updated && failed.length) {
      const error = new Error(
        `monday.com could not update any columns: ${failed
          .map((entry) => `${entry.columnId}: ${entry.error}`)
          .join(" | ")}`
      );
      error.failedColumns = failed;
      throw error;
    }

    if (failed.length) {
      console.warn(
        `monday.com partial column update for item ${itemId}:`,
        failed
      );
    }

    return { updated, failed };
  }
}

async function ensureMondayMainItem(call, metadata) {
  if (call.monday_item_id) return String(call.monday_item_id);

  const targetGroup = findMondayGroup(metadata.main, targetMondayGroupTitle(call));
  const mutationWithGroup = `
    mutation HeluxCreateCallItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName
      ) { id }
    }
  `;
  const mutationWithoutGroup = `
    mutation HeluxCreateCallItem($boardId: ID!, $itemName: String!) {
      create_item(board_id: $boardId, item_name: $itemName) { id }
    }
  `;

  const data = targetGroup
    ? await mondayRequest(
        mutationWithGroup,
        {
          boardId: MONDAY_BOARD_ID,
          groupId: targetGroup.id,
          itemName: leadDisplayName(call)
        },
        { idempotencyKey: `create-main:${call.call_id}` }
      )
    : await mondayRequest(
        mutationWithoutGroup,
        {
          boardId: MONDAY_BOARD_ID,
          itemName: leadDisplayName(call)
        },
        { idempotencyKey: `create-main:${call.call_id}` }
      );

  const itemId = data.create_item?.id;
  if (!itemId) throw new Error("monday.com did not return a main item ID.");

  await pool.query(
    `
      UPDATE ai_calls
      SET
        monday_item_id = $2,
        monday_group_id = COALESCE($3, monday_group_id),
        monday_last_error = NULL,
        updated_at = NOW()
      WHERE call_id = $1
    `,
    [call.call_id, String(itemId), targetGroup?.id || null]
  );

  return String(itemId);
}
async function ensureMondayAttemptSubitem(attempt, parentItemId) {
  if (attempt.monday_subitem_id) return String(attempt.monday_subitem_id);

  const mutation = `
    mutation HeluxCreateAttemptSubitem(
      $parentItemId: ID!,
      $itemName: String!
    ) {
      create_subitem(
        parent_item_id: $parentItemId,
        item_name: $itemName
      ) { id }
    }
  `;

  const suffix = Number(attempt.call_leg || 1) > 1
    ? ` — Leg ${attempt.call_leg}`
    : "";
  const data = await mondayRequest(
    mutation,
    {
      parentItemId: String(parentItemId),
      itemName: `Attempt ${attempt.attempt_number}${suffix}`
    },
    { idempotencyKey: `create-subitem:${attempt.attempt_id}` }
  );

  const subitemId = data.create_subitem?.id;
  if (!subitemId) throw new Error("monday.com did not return a subitem ID.");

  await pool.query(
    `
      UPDATE call_attempts
      SET
        monday_subitem_id = $2,
        monday_last_error = NULL,
        updated_at = NOW()
      WHERE attempt_id = $1
    `,
    [attempt.attempt_id, String(subitemId)]
  );

  return String(subitemId);
}

async function moveMondayMainItem(call, itemId, metadata) {
  const targetGroup = findMondayGroup(metadata.main, targetMondayGroupTitle(call));
  if (!targetGroup || String(call.monday_group_id || "") === String(targetGroup.id)) {
    return;
  }

  const mutation = `
    mutation HeluxMoveCallItem($itemId: ID!, $groupId: String!) {
      move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
    }
  `;

  await mondayRequest(
    mutation,
    { itemId: String(itemId), groupId: String(targetGroup.id) },
    {
      idempotencyKey: `move-main:${call.call_id}:${targetGroup.id}:${call.updated_at}`
    }
  );

  await pool.query(
    `
      UPDATE ai_calls
      SET monday_group_id = $2, monday_last_error = NULL, updated_at = NOW()
      WHERE call_id = $1
    `,
    [call.call_id, String(targetGroup.id)]
  );
}

async function syncCallSequenceToMonday(callId, reason = "unspecified") {
  if (!MONDAY_SYNC_ENABLED) return;

  const call = await getCallById(callId);
  if (!call) return;

  try {
    const metadata = await loadMondayMetadata();
    const itemId = await ensureMondayMainItem(call, metadata);
    const attempts = await getAttemptsForCall(callId);
    const latestAttempt = attempts.length ? attempts[attempts.length - 1] : null;
    const refreshedCall = (await getCallById(callId)) || call;

    const mainValues = buildMainMondayValues(
      refreshedCall,
      latestAttempt,
      metadata
    );

    await changeMondayValuesResilient(
      MONDAY_BOARD_ID,
      itemId,
      mainValues,
      `update-main:${callId}:${reason}:${refreshedCall.updated_at}`
    );

    for (const attempt of attempts) {
      try {
        const subitemId = await ensureMondayAttemptSubitem(attempt, itemId);
        const refreshedAttempt =
          (await getAttemptById(attempt.attempt_id)) || attempt;
        const attemptValues = buildAttemptMondayValues(
          refreshedAttempt,
          metadata
        );

        await changeMondayValuesResilient(
          MONDAY_SUBITEM_BOARD_ID,
          subitemId,
          attemptValues,
          `update-subitem:${attempt.attempt_id}:${reason}:${refreshedAttempt.updated_at}`
        );

        await pool.query(
          `
            UPDATE call_attempts
            SET
              monday_last_sync_at = NOW(),
              monday_last_error = NULL,
              updated_at = NOW()
            WHERE attempt_id = $1
          `,
          [attempt.attempt_id]
        );
      } catch (attemptError) {
        await pool.query(
          `
            UPDATE call_attempts
            SET monday_last_error = $2, updated_at = NOW()
            WHERE attempt_id = $1
          `,
          [attempt.attempt_id, cleanText(attemptError.message, 4000)]
        );
        console.error(
          `monday.com attempt sync failed for ${attempt.attempt_id}:`,
          attemptError.message
        );
      }
    }

    const finalCall = (await getCallById(callId)) || refreshedCall;
    await moveMondayMainItem(finalCall, itemId, metadata);

    await pool.query(
      `
        UPDATE ai_calls
        SET
          monday_last_sync_at = NOW(),
          monday_last_error = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId]
    );
  } catch (error) {
    await pool.query(
      `
        UPDATE ai_calls
        SET monday_last_error = $2, updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId, cleanText(error.message, 4000)]
    );

    console.error(`monday.com sync failed for ${callId}:`, error.message);
  }
}

function queueMondaySync(callId, reason = "state_change") {
  if (!MONDAY_SYNC_ENABLED || !callId) return;

  const existingTimer = mondaySyncTimers.get(callId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    mondaySyncTimers.delete(callId);

    const previous = mondaySyncChains.get(callId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => syncCallSequenceToMonday(callId, reason))
      .catch((error) => {
        console.error(`monday.com queued sync failed for ${callId}:`, error);
      })
      .finally(() => {
        if (mondaySyncChains.get(callId) === next) {
          mondaySyncChains.delete(callId);
        }
      });

    mondaySyncChains.set(callId, next);
  }, MONDAY_SYNC_DEBOUNCE_MS);

  mondaySyncTimers.set(callId, timer);
}

function mondayWebhookUrl() {
  const url = new URL(`${PUBLIC_BASE_URL}/api/v1/monday/webhook`);
  url.searchParams.set("secret", MONDAY_WEBHOOK_SECRET);
  return url.toString();
}

function mondayEventStatusLabel(value) {
  if (!value) return null;
  return cleanText(
    value.label?.text ||
      value.label?.label ||
      value.label ||
      value.text ||
      value.name,
    100
  );
}

function mondayEventBoolean(value) {
  if (value === true || value === false) return value;
  const checked = value?.checked ?? value?.check ?? value;
  return normalizeBoolean(checked);
}

function mondayEventDateToUtc(value, timeZone) {
  if (!value || !value.date) return null;
  const [year, month, day] = String(value.date).split("-").map(Number);
  const [hour, minute, second] = String(value.time || "09:00:00")
    .split(":")
    .map(Number);

  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  return zonedDateTimeToUtc(
    {
      year,
      month,
      day,
      hour,
      minute,
      second: Number.isFinite(second) ? second : 0
    },
    normalizeTimezone(timeZone)
  );
}

async function discoverDpaDepartmentBoard() {
  const cached = await getIntegrationState("dpa_department_board");
  const configuredId = DPA_BOARD_ID || cleanText(cached?.board_id, 100);
  let boards = [];

  if (configuredId) {
    const data = await mondayRequest(
      `query DaisyDpaBoard($ids: [ID!]) {
        boards(ids: $ids) { id name columns { id title type settings } }
      }`,
      { ids: [configuredId] }
    );
    boards = data.boards || [];
  } else {
    const data = await mondayRequest(
      `query DaisyFindDpaBoard {
        boards(limit: 100) { id name columns { id title type settings } }
      }`
    );
    boards = (data.boards || []).filter(
      (board) => normalizeMondayKey(board.name) === "dpadepartment"
    );
  }

  const board = boards.find(
    (candidate) =>
      configuredId || normalizeMondayKey(candidate.name) === "dpadepartment"
  );
  if (!board) {
    if (DPA_BOARD_ID) {
      throw new Error(`Configured DPA board ${DPA_BOARD_ID} was not found.`);
    }
    console.warn('monday.com board named "DPA Department" was not found.');
    return null;
  }
  if (!findMondayColumnById(buildMondayBoardMetadata(board), DPA_DEPARTMENT_COLUMNS.app_started)) {
    throw new Error(
      `DPA Department board ${board.id} is missing App_started column ${DPA_DEPARTMENT_COLUMNS.app_started}.`
    );
  }
  await setIntegrationState("dpa_department_board", {
    board_id: String(board.id),
    board_name: board.name,
    discovered_at: new Date().toISOString()
  });
  return buildMondayBoardMetadata(board);
}

function mondayRawColumnValue(columnValue) {
  if (!columnValue) return null;
  if (columnValue.text) return cleanText(columnValue.text, 2000);
  try {
    const parsed = typeof columnValue.value === "string"
      ? JSON.parse(columnValue.value)
      : columnValue.value;
    return cleanText(
      parsed?.phone || parsed?.text || parsed?.label?.text || parsed?.label,
      2000
    );
  } catch {
    return cleanText(columnValue.value, 2000);
  }
}

async function createMondayItemUpdate(itemId, body) {
  await mondayRequest(
    `mutation DaisyDpaUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId: String(itemId), body: cleanText(body, 5000) },
    { idempotencyKey: `dpa-update:${itemId}:${body}` }
  );
}

async function claimIntegrationEvent(stateKey, value) {
  const result = await pool.query(
    `
      INSERT INTO integration_state (state_key, state_value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (state_key) DO NOTHING
      RETURNING state_key
    `,
    [stateKey, JSON.stringify(value || {})]
  );
  return result.rowCount === 1;
}

async function createDpaAgentNotification(itemId, statusLabel) {
  const data = await mondayRequest(
    `query DaisyDpaItem($ids: [ID!]) {
      items(ids: $ids) {
        id name
        column_values {
          id text value
          column { title }
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  const item = data.items?.[0];
  if (!item) throw new Error(`DPA Department item ${itemId} was not found.`);
  const byId = new Map((item.column_values || []).map((column) => [column.id, column]));
  const agentName = mondayRawColumnValue(byId.get(DPA_DEPARTMENT_COLUMNS.realtor_name));
  const agentPhone = normalizePhone(
    mondayRawColumnValue(byId.get(DPA_DEPARTMENT_COLUMNS.realtor_phone))
  );
  const byTitle = (aliases) => {
    const wanted = aliases.map(normalizeMondayKey);
    return (item.column_values || []).find((column) =>
      wanted.some((alias) => normalizeMondayKey(column.column?.title).includes(alias))
    );
  };
  const timeFrame = normalizeTimeFrame(
    mondayRawColumnValue(byTitle(["Time frame", "Purchase timeframe", "Timeline"]))
  );
  const availability = mondayRawColumnValue(
    byTitle(["Tentative meeting availability", "Meeting availability", "Availability"])
  );

  if (!agentPhone || !validE164Phone(agentPhone)) {
    await createMondayItemUpdate(
      item.id,
      `Daisy could not create the application-started notification call because the assigned DPA Realtor phone is missing or invalid. Please correct ${DPA_DEPARTMENT_COLUMNS.realtor_phone} and notify the specialist manually.`
    );
    return { created: false, reason: "invalid_agent_phone" };
  }

  const eventKey = `dpa-agent-notification:${item.id}:${normalizeMondayKey(statusLabel)}`;
  const claimed = await claimIntegrationEvent(eventKey, {
    status: "claimed",
    item_id: String(item.id),
    app_started_status: statusLabel,
    claimed_at: new Date().toISOString()
  });
  if (!claimed) return { created: false, reason: "duplicate" };

  const callId = createPublicId("DPA-NOTIFY");
  const streamToken = createStreamToken();
  const payload = {
    call_type: "dpa_agent_notification",
    first_name: agentName,
    agent_name: agentName,
    customer_name: cleanText(item.name, 160) || "the customer",
    dpa_item_id: String(item.id),
    time_frame: timeFrame,
    tentative_meeting_availability: availability,
    app_started_status: statusLabel
  };
  const inserted = await pool.query(
    `
      INSERT INTO ai_calls (
        call_id, request_key, phone, status, stream_token, payload,
        max_attempts, timezone, consent_status, current_state, next_state,
        agent_version, prompt_version, tool_version, knowledge_version,
        routing_version, cadence_version, priority
      ) VALUES (
        $1, $2, $3, 'created', $4, $5::jsonb, 1, $6, 'confirmed',
        'dpa_agent_notification', 'identity_confirmation',
        $7, $8, $9, $10, $11, $12, 'urgent'
      ) RETURNING *
    `,
    [
      callId,
      eventKey,
      agentPhone,
      streamToken,
      JSON.stringify(payload),
      DEFAULT_TIMEZONE,
      DOUG_CONFIG.agentVersion,
      DOUG_CONFIG.promptVersion,
      DOUG_CONFIG.toolVersion,
      DOUG_CONFIG.knowledgeVersion,
      DOUG_CONFIG.routingVersion,
      DOUG_CONFIG.cadenceVersion
    ]
  );
  const notificationCall = inserted.rows[0];
  const notificationAttempt = await ensurePendingAttempt(notificationCall.call_id, {
    attemptType: "specialist_notification",
    scheduledAt: new Date(),
    idempotencyKey: `specialist_notification:${notificationCall.call_id}:1`
  });
  if (insideOperatingWindow(new Date(), notificationCall.timezone)) {
    await placeTwilioCall(notificationCall, {
      force: true,
      attemptId: notificationAttempt.attempt_id
    });
  } else {
    const nextAttemptAt = nextValidWindow(
      notificationCall.timezone,
      new Date(),
      DOUG_CONFIG.preferredWindows.morning,
      0
    );
    await pool.query(
      `UPDATE ai_calls SET sequence_status = 'scheduled', next_attempt_at = $2,
       updated_at = NOW() WHERE call_id = $1`,
      [notificationCall.call_id, nextAttemptAt]
    );
  }
  await setIntegrationState(eventKey, {
    status: "notification_created",
    item_id: String(item.id),
    call_id: notificationCall.call_id,
    app_started_status: statusLabel,
    created_at: new Date().toISOString()
  });
  return { created: true, call_id: notificationCall.call_id };
}

async function processDpaDepartmentEvent(event) {
  if (!event) return false;
  const state = await getIntegrationState("dpa_department_board");
  const boardId = DPA_BOARD_ID || state?.board_id;
  if (!boardId || String(event.boardId) !== String(boardId)) return false;
  if (String(event.columnId) !== DPA_DEPARTMENT_COLUMNS.app_started) return true;
  const status = mondayEventStatusLabel(event.value);
  if (!["yes", "started", "confirmed", "complete", "completed"].includes(
    normalizeMondayKey(status)
  )) return true;
  const itemId = event.pulseId || event.itemId;
  if (itemId) await createDpaAgentNotification(itemId, status);
  return true;
}

async function ensureMondayWebhook(eventName, stateKey, boardId = MONDAY_BOARD_ID) {
  const currentState = await getIntegrationState(stateKey);
  const currentId = currentState?.webhook_id
    ? String(currentState.webhook_id)
    : null;

  if (currentId) {
    const data = await mondayRequest(
      `query HeluxWebhooks($boardId: ID!) {
        webhooks(board_id: $boardId) { id event board_id config }
      }`,
      { boardId },
      { maxRetries: 1 }
    );

    const exists = (data.webhooks || []).some(
      (webhook) =>
        String(webhook.id) === currentId && webhook.event === eventName
    );

    if (exists) return currentId;
  }

  const mutation = `
    mutation HeluxCreateWebhook($boardId: ID!, $url: String!) {
      create_webhook(
        board_id: $boardId,
        url: $url,
        event: ${eventName}
      ) { id board_id }
    }
  `;

  const data = await mondayRequest(
    mutation,
    { boardId, url: mondayWebhookUrl() },
    { idempotencyKey: `create-webhook:${eventName}:${boardId}` }
  );

  const webhookId = data.create_webhook?.id;
  if (!webhookId) {
    throw new Error(`monday.com did not return a ${eventName} webhook ID.`);
  }

  await setIntegrationState(stateKey, {
    webhook_id: String(webhookId),
    event: eventName,
    board_id: boardId,
    url: mondayWebhookUrl(),
    created_at: new Date().toISOString()
  });

  return String(webhookId);
}

async function ensureMondayInboundWebhooks() {
  if (!MONDAY_SYNC_ENABLED || !MONDAY_INBOUND_SYNC_ENABLED) return [];

  const results = [];
  results.push(
    await ensureMondayWebhook(
      "change_column_value",
      "monday_webhook_change_column_value"
    )
  );
  results.push(
    await ensureMondayWebhook(
      "item_moved_to_any_group",
      "monday_webhook_item_moved_to_any_group"
    )
  );
  const dpaBoard = await discoverDpaDepartmentBoard();
  if (dpaBoard) {
    results.push(
      await ensureMondayWebhook(
        "change_column_value",
        "monday_webhook_dpa_app_started",
        dpaBoard.id
      )
    );
  }
  return results;
}

function mondayDatesMatch(first, second, toleranceMs = 60000) {
  if (!first || !second) return false;
  const firstDate = first instanceof Date ? first : new Date(first);
  const secondDate = second instanceof Date ? second : new Date(second);
  if (Number.isNaN(firstDate.getTime()) || Number.isNaN(secondDate.getTime())) {
    return false;
  }
  return Math.abs(firstDate.getTime() - secondDate.getTime()) <= toleranceMs;
}

async function applyMondayGroupControl(call, event) {
  const groupName = cleanText(event.groupName || event.groupTitle, 150);
  if (!groupName) return false;

  const normalized = normalizeMondayKey(groupName);
  const expectedGroups = targetMondayGroupTitle(call).map(normalizeMondayKey);

  // Ignore the webhook generated by HELUX moving the item to its expected group.
  if (expectedGroups.includes(normalized)) return false;

  if (["newleads", "activesequences", "readytocall"].includes(normalized)) {
    if (call.do_not_call || call.wrong_number || call.invalid_number) return false;
    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = 'scheduled',
          next_attempt_at = COALESCE(next_attempt_at, NOW()),
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  if (normalized === "callbacks") {
    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = 'callback_scheduled',
          callback_requested = TRUE,
          next_attempt_at = COALESCE(callback_at, next_attempt_at, NOW()),
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  if (["agentneeded", "humanactionneeded"].includes(normalized)) {
    await pool.query(
      `
        UPDATE ai_calls
        SET sequence_status = 'human_action', next_attempt_at = NULL,
            updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  if (normalized === "completed") {
    if (await sequenceHasUnresolvedWork(call.call_id)) return false;
    await pool.query(
      `
        UPDATE ai_calls
        SET sequence_status = 'completed', next_attempt_at = NULL,
            updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  if (["donotcalllist", "closedorsuppressed"].includes(normalized)) {
    await pool.query(
      `
        UPDATE ai_calls
        SET
          do_not_call = TRUE,
          sequence_status = 'suppressed',
          outcome = COALESCE(outcome, 'opt_out'),
          next_attempt_at = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  return false;
}

async function applyMondayColumnControl(call, event) {
  const title = normalizeMondayKey(event.columnTitle || event.columnId);
  const value = event.value;
  const columnId = String(event.columnId || "");

  const structuredKey = Object.entries(MONDAY_CALL_CONTROL_COLUMNS).find(
    ([, configuredId]) => configuredId === columnId
  )?.[0];
  if (structuredKey) {
    let structuredValue = mondayEventStatusLabel(value);
    if (structuredKey === "time_frame") {
      structuredValue = normalizeTimeFrame(structuredValue);
    }
    if (!structuredValue) return false;
    const patch = normalizeDaisyAnswers({ [structuredKey]: structuredValue });
    const existing = normalizeDaisyAnswers(call.result || {});
    if (JSON.stringify(patch) === JSON.stringify(
      Object.fromEntries(Object.keys(patch).map((key) => [key, existing[key]]))
    )) return false;
    await mergeCallResult(call.call_id, patch);
    return true;
  }

  if (title === "nextcall") {
    const nextCall = mondayEventDateToUtc(value, call.timezone);

    if (nextCall && mondayDatesMatch(nextCall, call.next_attempt_at)) {
      return false;
    }

    if (!nextCall && !call.next_attempt_at) return false;

    if (!nextCall) {
      await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'paused', next_attempt_at = NULL,
              updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      return true;
    }

    const callbackMode =
      call.callback_requested || call.sequence_status === "callback_scheduled";

    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = $2,
          next_attempt_at = $3,
          callback_at = CASE WHEN $4 THEN $3 ELSE callback_at END,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        callbackMode ? "callback_scheduled" : "scheduled",
        nextCall,
        callbackMode
      ]
    );
    return true;
  }

  if (title === "callbackat") {
    const callbackAt = mondayEventDateToUtc(value, call.timezone);
    if (!callbackAt) return false;
    if (mondayDatesMatch(callbackAt, call.callback_at)) return false;

    await pool.query(
      `
        UPDATE ai_calls
        SET
          callback_at = $2,
          callback_requested = TRUE,
          sequence_status = 'callback_scheduled',
          next_attempt_at = $2,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id, callbackAt]
    );
    return true;
  }

  if (title === "sequencestatus") {
    const label = normalizeMondayKey(mondayEventStatusLabel(value));
    const expectedLabel = normalizeMondayKey(sequenceStatusLabel(call));

    // Ignore status changes written by HELUX itself.
    if (label && label === expectedLabel) return false;

    if (["ready", "callnow"].includes(label)) {
      await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'scheduled', next_attempt_at = NOW(),
              updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      return true;
    }

    if (label === "scheduled") {
      await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'scheduled',
              next_attempt_at = COALESCE(next_attempt_at, NOW()),
              updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      return true;
    }

    if (label === "waitingretry") {
      await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'waiting_retry',
              next_attempt_at = COALESCE(next_attempt_at, NOW()),
              updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      return true;
    }

    if (label === "callbackscheduled") {
      await pool.query(
        `
          UPDATE ai_calls
          SET
            sequence_status = 'callback_scheduled',
            callback_requested = TRUE,
            next_attempt_at = COALESCE(callback_at, next_attempt_at, NOW()),
            updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      return true;
    }

    if (label === "paused") {
      await pool.query(
        `UPDATE ai_calls SET sequence_status = 'paused', next_attempt_at = NULL,
         updated_at = NOW() WHERE call_id = $1`,
        [call.call_id]
      );
      return true;
    }

    if (["humanaction", "agentneeded", "exhausted"].includes(label)) {
      await pool.query(
        `UPDATE ai_calls SET sequence_status = 'human_action',
         next_attempt_at = NULL, updated_at = NOW() WHERE call_id = $1`,
        [call.call_id]
      );
      return true;
    }

    if (label === "completed") {
      if (await sequenceHasUnresolvedWork(call.call_id)) return false;
      await pool.query(
        `UPDATE ai_calls SET sequence_status = 'completed',
         next_attempt_at = NULL, updated_at = NOW() WHERE call_id = $1`,
        [call.call_id]
      );
      return true;
    }

    if (["donotcall", "wrongnumber", "invalidnumber"].includes(label)) {
      await pool.query(
        `
          UPDATE ai_calls
          SET
            do_not_call = do_not_call OR $2,
            wrong_number = wrong_number OR $3,
            invalid_number = invalid_number OR $4,
            sequence_status = 'suppressed',
            next_attempt_at = NULL,
            updated_at = NOW()
          WHERE call_id = $1
        `,
        [
          call.call_id,
          label === "donotcall",
          label === "wrongnumber",
          label === "invalidnumber"
        ]
      );
      return true;
    }
  }

  if (title === "donotcall") {
    const checked = mondayEventBoolean(value);
    if (checked !== true || call.do_not_call) return false;

    await pool.query(
      `
        UPDATE ai_calls
        SET do_not_call = TRUE, sequence_status = 'suppressed',
            outcome = COALESCE(outcome, 'opt_out'), next_attempt_at = NULL,
            updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id]
    );
    return true;
  }

  if (title === "priority") {
    const label = cleanText(mondayEventStatusLabel(value), 30);
    if (!label || label.toLowerCase() === String(call.priority || "").toLowerCase()) {
      return false;
    }
    await pool.query(
      `UPDATE ai_calls SET priority = $2, updated_at = NOW() WHERE call_id = $1`,
      [call.call_id, label.toLowerCase()]
    );
    return true;
  }

  if (title === "owner") {
    const ownerId = value?.personsAndTeams?.[0]?.id || value?.persons?.[0]?.id;
    if (!ownerId || String(ownerId) === String(call.human_owner_id || "")) {
      return false;
    }
    await pool.query(
      `UPDATE ai_calls SET human_owner_id = $2, updated_at = NOW()
       WHERE call_id = $1`,
      [call.call_id, String(ownerId)]
    );
    return true;
  }

  return false;
}
async function processMondayInboundEvent(event) {
  if (await processDpaDepartmentEvent(event)) return;
  if (!event || String(event.boardId) !== String(MONDAY_BOARD_ID)) return;

  const itemId = event.pulseId || event.itemId;
  if (!itemId) return;

  const call = await getCallByMondayItemId(itemId);
  if (!call) return;

  const changed = event.columnId
    ? await applyMondayColumnControl(call, event)
    : await applyMondayGroupControl(call, event);

  if (!changed) return;

  await appendAction(call.call_id, {
    action: "monday_manual_control",
    success: true,
    column_title: cleanText(event.columnTitle, 150),
    group_name: cleanText(event.groupName, 150),
    changed_at: event.changedAt || event.triggerTime || null,
    monday_user_id: event.userId || null
  });

  queueMondaySync(call.call_id, "monday_manual_control");
}

async function updateCallStatus(callId, status, extra = {}) {
  const statusValue = cleanText(status, 50) || "unknown";
  const lastError = cleanText(extra.last_error, 4000);
  const twilioCallSid = cleanText(extra.twilio_call_sid, 80);

  await pool.query(
    `
      UPDATE ai_calls
      SET
        status = $2::VARCHAR(50),
        twilio_call_sid = COALESCE($3::VARCHAR(80), twilio_call_sid),
        last_error = CASE
          WHEN $4::TEXT IS NOT NULL THEN $4::TEXT
          WHEN $2::VARCHAR(50) IN (
            'queued', 'initiated', 'ringing', 'answered',
            'in-progress', 'completed'
          ) THEN NULL
          ELSE last_error
        END,
        started_at = CASE
          WHEN $2::VARCHAR(50) IN (
            'queued', 'initiated', 'ringing', 'answered', 'in-progress'
          ) THEN COALESCE(started_at, NOW())
          ELSE started_at
        END,
        answered_at = CASE
          WHEN $2::VARCHAR(50) IN ('answered', 'in-progress')
            THEN COALESCE(answered_at, NOW())
          ELSE answered_at
        END,
        completed_at = CASE
          WHEN $2::VARCHAR(50) IN (
            'completed', 'busy', 'failed', 'no-answer', 'canceled'
          ) THEN COALESCE(completed_at, NOW())
          ELSE completed_at
        END,
        updated_at = NOW()
      WHERE call_id = $1::VARCHAR(100)
    `,
    [callId, statusValue, twilioCallSid, lastError]
  );

  const call = await getCallById(callId);
  if (call && call.last_attempt_id) {
    await pool.query(
      `
        UPDATE call_attempts
        SET
          technical_status = $2::VARCHAR(50),
          twilio_call_sid = COALESCE($3::VARCHAR(80), twilio_call_sid),
          last_error = CASE
            WHEN $4::TEXT IS NOT NULL THEN $4::TEXT
            WHEN $2::VARCHAR(50) IN (
              'queued', 'initiated', 'ringing', 'answered',
              'in-progress', 'completed'
            ) THEN NULL
            ELSE last_error
          END,
          answered_at = CASE
            WHEN $2::VARCHAR(50) IN ('answered', 'in-progress')
              THEN COALESCE(answered_at, NOW())
            ELSE answered_at
          END,
          completed_at = CASE
            WHEN $2::VARCHAR(50) IN (
              'completed', 'busy', 'failed', 'no-answer', 'canceled'
            ) THEN COALESCE(completed_at, NOW())
            ELSE completed_at
          END,
          updated_at = NOW()
        WHERE attempt_id = $1
      `,
      [call.last_attempt_id, statusValue, twilioCallSid, lastError]
    );
  }

  queueMondaySync(callId, `call_status_${statusValue}`);
}

async function notifyHelux(call) {
  if (!call) return;

  try {
    const attempts = await getAttemptsForCall(call.call_id);
    const response = await fetch(`${HELUX_BASE_URL}${HELUX_RESULTS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-helux-key": HELUX_API_KEY
      },
      body: JSON.stringify({
        case_id: call.case_id,
        lead_id: call.lead_id,
        call_id: call.call_id,
        twilio_call_sid: call.twilio_call_sid,
        status: call.status,
        sequence_status: call.sequence_status,
        attempts_used: call.attempts,
        max_attempts: call.max_attempts,
        next_attempt_at: call.next_attempt_at,
        callback_at: call.callback_at,
        outcome: call.outcome,
        sentiment: call.sentiment,
        awaiting_customer_response: call.awaiting_customer_response,
        pending_question_type: call.pending_question_type,
        pending_question_text: call.pending_question_text,
        question_asked_at: call.question_asked_at,
        response_reminder_count: call.response_reminder_count,
        next_action: call.next_action,
        summary: call.summary,
        transcript: call.transcript || [],
        actions: call.actions || [],
        result: call.result || {},
        monday: {
          enabled: MONDAY_SYNC_ENABLED,
          board_id: MONDAY_BOARD_ID,
          item_id: call.monday_item_id,
          group_id: call.monday_group_id,
          last_sync_at: call.monday_last_sync_at,
          last_error: call.monday_last_error,
          attempt_subitems: attempts.map((attempt) => ({
            attempt_id: attempt.attempt_id,
            monday_subitem_id: attempt.monday_subitem_id,
            last_sync_at: attempt.monday_last_sync_at,
            last_error: attempt.monday_last_error
          }))
        },
        versions: {
          agent: call.agent_version,
          prompt: call.prompt_version,
          tools: call.tool_version,
          knowledge: call.knowledge_version,
          routing: call.routing_version,
          cadence: call.cadence_version,
          monday_adapter: DOUG_CONFIG.mondayAdapterVersion,
          realtime_model: OPENAI_REALTIME_MODEL,
          voice: OPENAI_VOICE
        }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `HELUX result callback failed with ${response.status}: ${body.slice(
          0,
          500
        )}`
      );
    }
  } catch (error) {
    console.error("HELUX result callback failed:", error.message);
  }
}

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      })
    );
  }
  return formatterCache.get(timeZone);
}

function zonedParts(date, timeZone) {
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function zonedDateTimeToUtc(localParts, timeZone) {
  let guess = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second || 0
  );

  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const desiredEpoch = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second || 0
    );
    const actualEpoch = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second || 0
    );
    guess += desiredEpoch - actualEpoch;
  }

  return new Date(guess);
}

function addLocalCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function localDayOfWeek(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function parseClock(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return { hour, minute };
}

function validCallingDay(parts) {
  const day = localDayOfWeek(parts);
  return day !== 0 || DOUG_CONFIG.operatingWindow.sundayEnabled;
}

function operatingWindowForParts(parts) {
  const day = localDayOfWeek(parts);

 if (day === 0) {
  if (!DOUG_CONFIG.operatingWindow.sundayEnabled) {
    return null;
  }

  return {
    start: parseClock(DOUG_CONFIG.operatingWindow.sundayStart),
    end: parseClock(DOUG_CONFIG.operatingWindow.sundayEnd)
  };
}

  if (day === 6) {
    return {
      start: parseClock(DOUG_CONFIG.operatingWindow.saturdayStart),
      end: parseClock(DOUG_CONFIG.operatingWindow.saturdayEnd)
    };
  }
  return {
    start: parseClock(DOUG_CONFIG.operatingWindow.weekdayStart),
    end: parseClock(DOUG_CONFIG.operatingWindow.weekdayEnd)
  };
}

function minutesOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

function insideOperatingWindow(date, timeZone) {
  if (DOUG_CONFIG.operatingWindow.alwaysOpen) return true;
  const parts = zonedParts(date, timeZone);
  const window = operatingWindowForParts(parts);
  if (!window) return false;
  const current = minutesOfDay(parts);
  const start = window.start.hour * 60 + window.start.minute;
  const end = window.end.hour * 60 + window.end.minute;
  return current >= start && current <= end;
}

function candidateLocalDate(baseParts, dayOffset, clock) {
  const date = addLocalCalendarDays(baseParts, dayOffset);
  const parsed = parseClock(clock);
  return {
    ...date,
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0
  };
}

function nextValidWindow(timeZone, afterDate, preferredClock, minimumGapMinutes) {
  const minimumDate = new Date(
    afterDate.getTime() + Math.max(0, minimumGapMinutes || 0) * 60000
  );
  if (DOUG_CONFIG.operatingWindow.alwaysOpen) return minimumDate;
  const base = zonedParts(afterDate, timeZone);

  for (let dayOffset = 0; dayOffset < 21; dayOffset += 1) {
    const localCandidate = candidateLocalDate(base, dayOffset, preferredClock);
    if (!validCallingDay(localCandidate)) continue;
    const candidate = zonedDateTimeToUtc(localCandidate, timeZone);
    if (candidate >= minimumDate && insideOperatingWindow(candidate, timeZone)) {
      return candidate;
    }
  }

  return new Date(afterDate.getTime() + 24 * 60 * 60 * 1000);
}

function calculateNextAttemptAt(call) {
  const now = new Date();
  const attempt = Number(call.attempts || 0);
  const delayHours =
    attempt <= 1
      ? 3
      : attempt === 2
        ? 12
        : attempt === 3
          ? 36
          : attempt === 4
            ? 60
            : 72;
  return new Date(now.getTime() + delayHours * 60 * 60 * 1000);
}

async function scheduleUnexpectedReconnect(callId) {
  const call = await getCallById(callId);
  if (!call || call.payload?.call_type === "dpa_agent_notification") return false;
  if (!call.last_attempt_id) return false;
  const attempt = await getAttemptById(call.last_attempt_id);
  const transcript = Array.isArray(attempt?.transcript) ? attempt.transcript : [];
  const actions = Array.isArray(attempt?.actions) ? attempt.actions : [];
  const completedByTool = actions.some(
    (action) => action && action.action === "complete_call" && action.success
  );
  const alreadyScheduled = call.result?.unexpected_disconnect_reconnect_scheduled;
  if (transcript.length < 2 || completedByTool || alreadyScheduled) return false;

  const reconnectAt = new Date(Date.now() + 60 * 1000);
  const savedSummary = cleanText(
    call.summary ||
      transcript
        .slice(-6)
        .map((entry) => `${entry.speaker}: ${entry.text}`)
        .join(" | "),
    4000
  );
  const updated = await pool.query(
    `
      UPDATE ai_calls
      SET current_state = 'reconnect_pending',
          next_state = COALESCE(next_state, 'resume_conversation'),
          sequence_status = 'callback_scheduled', callback_requested = TRUE,
          callback_at = $2, next_attempt_at = $2,
          summary = COALESCE(summary, $3),
          next_action = COALESCE(next_action, 'Resume after unexpected disconnect'),
          completed_at = NULL, result = result || $4::jsonb, updated_at = NOW()
      WHERE call_id = $1
        AND COALESCE(result->>'unexpected_disconnect_reconnect_scheduled', 'false') <> 'true'
      RETURNING call_id
    `,
    [
      callId,
      reconnectAt,
      savedSummary,
      JSON.stringify({
        unexpected_disconnect_reconnect_scheduled: true,
        unexpected_disconnect_at: new Date().toISOString(),
        reconnect_at: reconnectAt.toISOString()
      })
    ]
  );
  if (!updated.rowCount) return false;
  await ensurePendingAttempt(callId, {
    attemptType: "disconnect_reconnect",
    scheduledAt: reconnectAt,
    idempotencyKey: `disconnect_reconnect:${callId}:${reconnectAt.toISOString()}`
  });
  await appendAction(callId, {
    action: "unexpected_disconnect_reconnect_scheduled",
    success: true,
    reconnect_at: reconnectAt.toISOString()
  });
  queueMondaySync(callId, "unexpected_disconnect_reconnect");
  return true;
}

async function finalizeCadenceAfterTerminal(callId, technicalStatus) {
  const call = await getCallById(callId);
  if (!call) return;

  const transcriptCount = Array.isArray(call.transcript)
    ? call.transcript.length
    : 0;
  const outcome = String(call.outcome || "").toLowerCase();
  const callbackAt = call.callback_at ? new Date(call.callback_at) : null;
  const hasFutureCallback = Boolean(
    callbackAt &&
      !Number.isNaN(callbackAt.getTime()) &&
      callbackAt > new Date()
  );

  if (
    call.result?.unexpected_disconnect_reconnect_attempted &&
    !call.result?.unexpected_disconnect_reconnect_completed
  ) {
    const attempt = call.last_attempt_id
      ? await getAttemptById(call.last_attempt_id)
      : null;
    const attemptTranscript = Array.isArray(attempt?.transcript)
      ? attempt.transcript
      : [];
    if (attemptTranscript.length < 2) {
      const retryAt = nextValidWindow(
        call.timezone || DEFAULT_TIMEZONE,
        new Date(Date.now() + 48 * 60 * 60 * 1000),
        DOUG_CONFIG.preferredWindows.morning,
        0
      );
      await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'waiting_retry', callback_requested = FALSE,
              callback_at = NULL, next_attempt_at = $2,
              current_state = 'reconnect_not_answered', completed_at = NULL,
              result = result || $3::jsonb, updated_at = NOW()
          WHERE call_id = $1
        `,
        [
          callId,
          retryAt,
          JSON.stringify({
            unexpected_disconnect_reconnect_completed: true,
            next_customer_attempt_at: retryAt.toISOString()
          })
        ]
      );
      queueMondaySync(callId, "reconnect_not_answered_48h_retry");
      return;
    }
  }

  if (
    call.sequence_status === "callback_scheduled" &&
    hasFutureCallback
  ) {
    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = 'callback_scheduled',
          next_attempt_at = $2,
          completed_at = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId, callbackAt]
    );

    queueMondaySync(callId, "cadence_callback_preserved");
    return;
  }

  if (call.do_not_call || call.wrong_number || call.invalid_number) {
    await pool.query(
      `
        UPDATE ai_calls
        SET sequence_status = 'suppressed', next_attempt_at = NULL,
            updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId]
    );
    queueMondaySync(callId, "cadence_suppressed");
    return;
  }

  if (stopOutcome(outcome)) {
    if (await sequenceHasUnresolvedWork(callId)) {
      await pool.query(
        `UPDATE ai_calls SET sequence_status = CASE
           WHEN callback_requested THEN 'callback_scheduled'
           WHEN sequence_status = 'human_action' THEN 'human_action'
           ELSE 'scheduled' END,
         completed_at = NULL, updated_at = NOW() WHERE call_id = $1`,
        [callId]
      );
      queueMondaySync(callId, "cadence_completion_blocked_unresolved_work");
      return;
    }
    await pool.query(
      `
        UPDATE ai_calls
        SET sequence_status = 'completed', next_attempt_at = NULL,
            updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId]
    );
    queueMondaySync(callId, "cadence_completed");
    return;
  }

  if (
    String(technicalStatus).toLowerCase() === "completed" &&
    transcriptCount > 1
  ) {
    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = 'human_action',
          next_action = COALESCE(next_action, 'Review connected call'),
          next_attempt_at = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId]
    );
    queueMondaySync(callId, "cadence_human_action");
    return;
  }

  if (Number(call.attempts || 0) >= Number(call.max_attempts || 6)) {
    await pool.query(
      `
        UPDATE ai_calls
        SET
          sequence_status = 'exhausted',
          next_action = 'Human review or approved non-voice nurture',
          next_attempt_at = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [callId]
    );
    queueMondaySync(callId, "cadence_exhausted");
    return;
  }

  const nextAttemptAt = calculateNextAttemptAt(call);
  await pool.query(
    `
      UPDATE ai_calls
      SET
        sequence_status = 'waiting_retry',
        next_attempt_at = $2,
        completed_at = NULL,
        updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, nextAttemptAt]
  );

  await ensurePendingAttempt(callId, {
    attemptType: "cadence",
    scheduledAt: nextAttemptAt,
    idempotencyKey: `cadence:${callId}:${Number(call.attempts || 0) + 1}`
  });

  if (call.last_attempt_id) {
    await pool.query(
      `
        UPDATE call_attempts
        SET next_attempt_at = $2, updated_at = NOW()
        WHERE attempt_id = $1
      `,
      [call.last_attempt_id, nextAttemptAt]
    );
  }

  queueMondaySync(callId, "cadence_waiting_retry");
}

async function placeTwilioCall(call, options = {}) {
  let refreshedCall = await getCallById(call.call_id);
  if (!refreshedCall) throw new Error("Call sequence not found.");

  if (
    refreshedCall.do_not_call ||
    refreshedCall.wrong_number ||
    refreshedCall.invalid_number
  ) {
    throw new HttpError(409, "This contact is suppressed from future calls.");
  }

  if (
    ENFORCE_CALL_CONSENT &&
    refreshedCall.consent_status !== "confirmed" &&
    options.force !== true
  ) {
    throw new HttpError(409, "Confirmed AI voice consent is required.");
  }

  if (
    attemptTypeForCall(refreshedCall, options.attemptType) === "cadence" &&
    Number(refreshedCall.attempts || 0) >=
    Number(refreshedCall.max_attempts || DOUG_CONFIG.maxAttempts)
  ) {
    throw new HttpError(409, "Maximum call attempts have been reached.");
  }

  let pendingAttempt = options.attemptId
    ? await getAttemptById(options.attemptId)
    : await ensurePendingAttempt(refreshedCall.call_id, {
        attemptType: options.attemptType,
        scheduledAt: refreshedCall.next_attempt_at || new Date()
      });
  if (!pendingAttempt) throw new HttpError(409, "No pending attempt is available.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedCallResult = await client.query(
      "SELECT * FROM ai_calls WHERE call_id = $1 FOR UPDATE",
      [refreshedCall.call_id]
    );
    const lockedAttemptResult = await client.query(
      "SELECT * FROM call_attempts WHERE attempt_id = $1 FOR UPDATE",
      [pendingAttempt.attempt_id]
    );
    refreshedCall = lockedCallResult.rows[0];
    pendingAttempt = lockedAttemptResult.rows[0];
    if (!refreshedCall || !pendingAttempt || !pendingAttemptStatus(pendingAttempt.technical_status)) {
      throw new HttpError(409, "Pending attempt was already claimed.");
    }
    if (
      refreshedCall.sequence_status === "calling" &&
      refreshedCall.last_attempt_id !== pendingAttempt.attempt_id
    ) {
      throw new HttpError(409, "Another attempt is already dialing.");
    }

    if (refreshedCall.current_state === "reconnect_pending") {
      await client.query(
        `UPDATE ai_calls SET current_state = 'reconnect_in_progress',
         result = result || $2::jsonb, updated_at = NOW() WHERE call_id = $1`,
        [
          refreshedCall.call_id,
          JSON.stringify({ unexpected_disconnect_reconnect_attempted: true })
        ]
      );
    }
    await client.query(
      `UPDATE call_attempts SET technical_status = 'placing',
       dialed_at = NOW(), scheduled_at = COALESCE(scheduled_at, NOW()),
       updated_at = NOW() WHERE attempt_id = $1`,
      [pendingAttempt.attempt_id]
    );
    await client.query(
      `UPDATE ai_calls SET status = 'placing', sequence_status = 'calling',
       attempts = attempts + 1, last_attempt_id = $2, last_attempt_at = NOW(),
       next_attempt_at = NULL, last_error = NULL, completed_at = NULL,
       callback_requested = CASE WHEN $3::BOOLEAN THEN FALSE ELSE callback_requested END,
       callback_at = CASE WHEN $3::BOOLEAN THEN NULL ELSE callback_at END,
       updated_at = NOW() WHERE call_id = $1`,
      [
        refreshedCall.call_id,
        pendingAttempt.attempt_id,
        [
          "customer_callback",
          "application_checkpoint",
          "disconnect_reconnect"
        ].includes(pendingAttempt.attempt_type)
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const attemptId = pendingAttempt.attempt_id;
  const attemptNumber = Number(pendingAttempt.attempt_number);
  const voiceUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/voice`);
  voiceUrl.searchParams.set("call_id", refreshedCall.call_id);
  voiceUrl.searchParams.set("token", refreshedCall.stream_token);
  const statusUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/status`);
  statusUrl.searchParams.set("call_id", refreshedCall.call_id);
  statusUrl.searchParams.set("token", refreshedCall.stream_token);
  queueMondaySync(refreshedCall.call_id, "attempt_created");

  try {
    const twilioCall = await twilioClient.calls.create({
      to: refreshedCall.phone,
      from: TWILIO_FROM_NUMBER,
      url: voiceUrl.toString(),
      method: "POST",
      statusCallback: statusUrl.toString(),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    await updateCallStatus(
      refreshedCall.call_id,
      twilioCall.status || "queued",
      { twilio_call_sid: twilioCall.sid }
    );

    await appendAction(refreshedCall.call_id, {
      action: "outbound_call_placed",
      success: true,
      attempt_number: attemptNumber,
      twilio_call_sid: twilioCall.sid
    });

    queueMondaySync(refreshedCall.call_id, "twilio_call_placed");
    return twilioCall;
  } catch (error) {
    const safeError =
      cleanText(error.message, 4000) || "Twilio call creation failed.";

    await pool.query(
      `
        UPDATE call_attempts
        SET
          technical_status = 'pending',
          scheduled_at = NOW() + INTERVAL '15 minutes',
          dialed_at = NULL,
          completed_at = NULL,
          last_error = $2,
          updated_at = NOW()
        WHERE attempt_id = $1
      `,
      [attemptId, safeError]
    );

    await pool.query(
      `
        UPDATE ai_calls
        SET
          status = 'failed',
          sequence_status = 'waiting_retry',
          attempts = GREATEST(attempts - 1, 0),
          last_attempt_id = NULL,
          next_attempt_at = NOW() + INTERVAL '15 minutes',
          last_error = $2,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [refreshedCall.call_id, safeError]
    );

    await appendAction(refreshedCall.call_id, {
      action: "outbound_call_placed",
      success: false,
      technical_failure: true,
      customer_attempt_consumed: false,
      attempt_number: attemptNumber,
      error: safeError
    });

    queueMondaySync(refreshedCall.call_id, "twilio_call_failed");
    throw error;
  }
}

function formatCustomerCallbackTime(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimezone(timeZone),
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function smsStatusCallbackUrl(call) {
  const url = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/sms-status`);
  url.searchParams.set("call_id", call.call_id);
  url.searchParams.set("token", call.stream_token);
  return url.toString();
}

async function trackSmsMessage(callId, message, messageType) {
  await pool.query(
    `
      INSERT INTO sms_deliveries (
        message_sid, call_id, message_type, status, updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (message_sid)
      DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
    `,
    [
      message.sid,
      callId,
      messageType,
      cleanText(message.status, 50) || "accepted"
    ]
  );

}

async function executeDougTool(call, name, args) {
  const safeArgs = args && typeof args === "object" ? args : {};
  const permittedWaitingEnd =
    name === "mark_contact_restriction" ||
    (name === "complete_call" &&
      ["opt_out", "wrong_number", "disconnected", "technical_failure"].includes(
        cleanText(safeArgs.outcome, 80)
      ));
  if (call.awaiting_customer_response && !permittedWaitingEnd) {
    return {
      success: false,
      awaiting_customer_response: true,
      pending_question_type: call.pending_question_type,
      pending_question_text: call.pending_question_text,
      error:
        "Wait for a meaningful completed customer answer before advancing the workflow or saving structured fields."
    };
  }
  if (call.awaiting_customer_response && permittedWaitingEnd) {
    await clearAwaitingCustomerResponse(
      call.call_id,
      name === "mark_contact_restriction"
        ? "call_ended_contact_restriction"
        : `call_ended_${cleanText(safeArgs.outcome, 80) || "complete_call"}`
    );
  }

  if (name === "save_call_progress") {
    const currentState = cleanText(safeArgs.current_state, 80) || "unknown";
    const nextState = cleanText(safeArgs.next_state, 80);
    const sentiment = cleanText(safeArgs.sentiment, 50);
    const answers = normalizeDaisyAnswers(safeArgs.answers || {});

    await pool.query(
      `
        UPDATE ai_calls
        SET
          current_state = $2,
          next_state = $3,
          sentiment = COALESCE($4, sentiment),
          result = result || $5::jsonb,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        currentState,
        nextState,
        sentiment,
        JSON.stringify({
          ...answers,
          progress_notes: cleanText(safeArgs.notes, 2000),
          conversation_state: {
            current_stage: currentState,
            current_objective: cleanText(safeArgs.current_objective, 1000),
            last_confirmed_fact: cleanText(safeArgs.last_confirmed_fact, 2000),
            pending_question: cleanText(safeArgs.pending_question, 1000),
            next_best_action: cleanText(safeArgs.next_best_action, 1000) || nextState
          }
        })
      ]
    );

    await appendAction(call.call_id, {
      action: name,
      success: true,
      current_state: currentState,
      next_state: nextState
    });

    return {
      success: true,
      current_state: currentState,
      next_state: nextState,
      saved_fields: Object.keys(answers)
    };
  }

  if (name === "calculate_preliminary_dti") {
    const income = Number(safeArgs.gross_monthly_household_income);
    const debt = Number(safeArgs.monthly_recurring_debt);

    if (!Number.isFinite(income) || income <= 0) {
      return { success: false, error: "Monthly income must be greater than zero." };
    }
    if (!Number.isFinite(debt) || debt < 0) {
      return { success: false, error: "Monthly debt cannot be negative." };
    }

    const dti = Number(((debt / income) * 100).toFixed(2));
    let classification = "strong_preliminary_range";
    if (dti > 57) classification = "needs_dei_review";
    else if (dti > 50) classification = "higher_range_lender_review";
    else if (dti > 45) classification = "review_range";

    const result = {
      gross_monthly_household_income: income,
      monthly_recurring_debt: debt,
      preliminary_dti_percent: dti,
      preliminary_dti_classification: classification
    };

    await mergeCallResult(call.call_id, result);
    await appendAction(call.call_id, { action: name, success: true, ...result });

    return {
      success: true,
      ...result,
      disclaimer: "This is a preliminary estimate, not an underwriting result."
    };
  }

  if (name === "record_application_checkpoint") {
    if (safeArgs.started !== true) {
      return {
        success: false,
        error: "Confirm a new callback date, time, and timezone, then use schedule_callback."
      };
    }

    const summary =
      cleanText(safeArgs.summary, 4000) ||
      "Customer confirmed the DPA application was started.";
    await pool.query(
      `
        UPDATE ai_calls
        SET
          current_state = 'application_started',
          next_state = 'human_action',
          outcome = 'application_started_hot_lead',
          priority = 'urgent',
          sequence_status = 'human_action',
          next_action = 'Agent Needed: review started application',
          summary = $2,
          callback_at = NULL,
          callback_requested = FALSE,
          next_attempt_at = NULL,
          result = result || $3::jsonb,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        summary,
        JSON.stringify({
          app_started_confirmation: "Started",
          interest_level: "Hot",
          business_outcome: "Application Started — Hot Lead"
        })
      ]
    );
    await appendAction(call.call_id, {
      action: name,
      success: true,
      app_started_confirmation: "Started",
      priority: "urgent"
    });
    queueMondaySync(call.call_id, "application_started_hot_lead");
    return {
      success: true,
      app_started_confirmation: "Started",
      interest_level: "Hot",
      priority: "Urgent",
      business_outcome: "Application Started — Hot Lead",
      sequence_status: "human_action"
    };
  }

  if (name === "send_resource_link") {
    if (safeArgs.consent_confirmed !== true) {
      return {
        success: false,
        error: "Customer confirmation is required before sending SMS."
      };
    }

    const resourceType = cleanText(safeArgs.resource_type, 50);
    const resource = DAISY_RESOURCE_LIBRARY[resourceType];
    if (!resource) {
      return { success: false, error: "Unsupported resource type." };
    }

    try {
      const message = await twilioClient.messages.create({
        to: call.phone,
        from: TWILIO_FROM_NUMBER,
        body: `Here is the ${resource.description} Daisy mentioned: ${resource.url}`,
        statusCallback: smsStatusCallbackUrl(call)
      });

      await trackSmsMessage(call.call_id, message, resourceType);

      console.log(
        JSON.stringify({
          event: "outbound_sms_accepted",
          call_id: call.call_id,
          message_type: resourceType,
          message_sid: message.sid,
          message_status: message.status || "accepted",
          destination_last_four: String(call.phone || "").slice(-4)
        })
      );

      const patch = normalizeDaisyAnswers({
        [`${resourceType}_sent`]: true,
        last_resource_sent: resourceType,
        last_resource_url: resource.url,
        ...(resourceType === "application"
          ? {
              application_link_sent: true,
              app_started_confirmation: "Agreed to Start",
              application_sms_sid: message.sid,
              application_sms_status:
                cleanText(message.status, 50) || "accepted"
            }
          : {})
      });

      await mergeCallResult(call.call_id, patch);
      if (resourceType === "application") {
        await pool.query(
          `
            UPDATE ai_calls
            SET current_state = 'application_link_sent',
                next_state = 'confirm_application_checkpoint',
                next_action = 'Confirm next-day application checkpoint date, time, and timezone',
                updated_at = NOW()
            WHERE call_id = $1
          `,
          [call.call_id]
        );
      }
      await appendAction(call.call_id, {
        action: name,
        success: true,
        resource_type: resourceType,
        resource_url: resource.url,
        message_sid: message.sid
      });

      if (call.last_attempt_id) {
        await pool.query(
          `
            UPDATE call_attempts
            SET sms_sent = TRUE, updated_at = NOW()
            WHERE attempt_id = $1
          `,
          [call.last_attempt_id]
        );
      }

      queueMondaySync(call.call_id, `resource_${resourceType}_sent`);

      return {
        success: true,
        resource_type: resourceType,
        resource_url: resource.url,
        destination: call.phone.replace(/.(?=.{4})/g, "*"),
        message_sid: message.sid,
        message_status: cleanText(message.status, 50) || "accepted"
      };
    } catch (error) {
      await appendAction(call.call_id, {
        action: name,
        success: false,
        resource_type: resourceType,
        error: cleanText(error.message, 1000)
      });
      return {
        success: false,
        error: "The SMS could not be sent. Create a specialist follow-up instead."
      };
    }
  }

  if (name === "schedule_callback") {
    if (safeArgs.prospect_confirmed !== true) {
      return {
        success: false,
        error: "The callback time must be confirmed by the customer."
      };
    }

    const callbackAt = new Date(safeArgs.callback_at);
    if (Number.isNaN(callbackAt.getTime()) || callbackAt <= new Date()) {
      return { success: false, error: "The callback time must be in the future." };
    }

    const timezone = normalizeTimezone(safeArgs.timezone || call.timezone);
    const reason =
      cleanText(safeArgs.reason, 1000) || "Customer requested callback";
    const primaryConcern = cleanText(safeArgs.primary_concern, 1200);
    const holdReason = cleanText(safeArgs.hold_reason, 2000);
    const discussionSummary = cleanText(
      safeArgs.discussion_summary,
      4000
    );
    const callbackOutcome =
      primaryConcern || holdReason
        ? "follow_up_scheduled"
        : "specialist_callback";

    await pool.query(
      `
        UPDATE ai_calls
        SET
          callback_at = $2,
          callback_timezone = $3,
          callback_requested = TRUE,
          next_attempt_at = $2,
          sequence_status = 'callback_scheduled',
          outcome = $5,
          next_action = $4,
          summary = COALESCE($6, summary),
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        callbackAt,
        timezone,
        reason,
        callbackOutcome,
        discussionSummary
      ]
    );

    const isApplicationCheckpoint = normalizeMondayKey(reason).includes(
      "applicationcheckpoint"
    );
    await mergeCallResult(call.call_id, {
      callback_at: callbackAt.toISOString(),
      callback_timezone: timezone,
      callback_reason: reason,
      primary_concern: primaryConcern,
      hold_reason: holdReason,
      discussion_summary: discussionSummary,
      follow_up_outcome: callbackOutcome,
      preferred_contact_method:
        cleanText(safeArgs.preferred_contact_method, 30) || "phone",
      ...(isApplicationCheckpoint
        ? {
            application_follow_up_at: callbackAt.toISOString(),
            app_started_confirmation: "Agreed to Start"
          }
        : {})
    });

    if (isApplicationCheckpoint) {
      await pool.query(
        `UPDATE ai_calls SET current_state = 'application_checkpoint',
         next_state = 'application_checkpoint', updated_at = NOW()
         WHERE call_id = $1`,
        [call.call_id]
      );
    }

    const callbackAttemptType = isApplicationCheckpoint
      ? "application_checkpoint"
      : "customer_callback";
    await pool.query(
      `UPDATE call_attempts SET technical_status = 'canceled', completed_at = NOW(),
       cancellation_reason = 'explicit_callback_rescheduled', updated_at = NOW()
       WHERE call_id = $1 AND attempt_type = $2 AND completed_at IS NULL
         AND technical_status IN ('pending', 'scheduled', 'created')
         AND scheduled_at IS DISTINCT FROM $3`,
      [call.call_id, callbackAttemptType, callbackAt]
    );

    await ensurePendingAttempt(call.call_id, {
      attemptType: callbackAttemptType,
      scheduledAt: callbackAt,
      idempotencyKey: `${callbackAttemptType}:${call.call_id}:${callbackAt.toISOString()}`
    });

    await appendAction(call.call_id, {
      action: name,
      success: true,
      callback_at: callbackAt.toISOString(),
      timezone,
      reason,
      primary_concern: primaryConcern,
      hold_reason: holdReason,
      outcome: callbackOutcome
    });

    let confirmationSmsSent = false;
    let confirmationMessageSid = null;
    let confirmationSmsError = null;

    if (safeArgs.sms_confirmation_consent === true) {
      try {
        const formattedCallback = formatCustomerCallbackTime(
          callbackAt,
          timezone
        );
        const confirmation = await twilioClient.messages.create({
          to: call.phone,
          from: TWILIO_FROM_NUMBER,
          body: `Your follow-up call with Daisy is scheduled for ${formattedCallback}. Reply STOP to opt out.`,
          statusCallback: smsStatusCallbackUrl(call)
        });
        await trackSmsMessage(
          call.call_id,
          confirmation,
          "callback_confirmation"
        );
        console.log(
          JSON.stringify({
            event: "outbound_sms_accepted",
            call_id: call.call_id,
            message_type: "callback_confirmation",
            message_sid: confirmation.sid,
            message_status: confirmation.status || "accepted",
            destination_last_four: String(call.phone || "").slice(-4)
          })
        );
        confirmationSmsSent = true;
        confirmationMessageSid = confirmation.sid;
      } catch (error) {
        confirmationSmsError = cleanText(error.message, 1000);
        console.error(
          `Callback confirmation SMS failed for ${call.call_id}:`,
          confirmationSmsError
        );
      }
    }

    await mergeCallResult(call.call_id, {
      callback_confirmation_sms_sent: confirmationSmsSent,
      callback_confirmation_message_sid: confirmationMessageSid,
      callback_confirmation_sms_error: confirmationSmsError
    });

    await appendAction(call.call_id, {
      action: "callback_confirmation_sms",
      success:
        confirmationSmsSent || safeArgs.sms_confirmation_consent !== true,
      skipped: safeArgs.sms_confirmation_consent !== true,
      consent_confirmed: safeArgs.sms_confirmation_consent === true,
      message_sid: confirmationMessageSid,
      error: confirmationSmsError
    });

    queueMondaySync(call.call_id, "callback_scheduled");

    return {
      success: true,
      callback_at: callbackAt.toISOString(),
      timezone,
      outcome: callbackOutcome,
      sequence_status: "callback_scheduled",
      confirmation_sms_sent: confirmationSmsSent
    };
  }

  if (name === "create_specialist_handoff") {
    const handoff = {
      reason: cleanText(safeArgs.reason, 1000),
      priority: cleanText(safeArgs.priority, 30) || "normal",
      summary: cleanText(safeArgs.summary, 4000),
      requested_callback_at: cleanText(safeArgs.requested_callback_at, 100)
    };

    await pool.query(
      `
        UPDATE ai_calls
        SET
          outcome = 'specialist_handoff',
          sequence_status = 'human_action',
          priority = $4,
          next_action = 'DPA specialist follow-up',
          summary = COALESCE($2, summary),
          result = result || $3::jsonb,
          next_attempt_at = NULL,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        handoff.summary,
        JSON.stringify({ specialist_handoff: handoff }),
        handoff.priority
      ]
    );

    await appendAction(call.call_id, { action: name, success: true, ...handoff });
    queueMondaySync(call.call_id, "specialist_handoff");

    return {
      success: true,
      handoff_status: "created",
      priority: handoff.priority,
      next_action: "DPA specialist follow-up"
    };
  }

  if (name === "transfer_to_specialist") {
    if (safeArgs.prospect_confirmed !== true) {
      return {
        success: false,
        transfer_status: "not_confirmed",
        error: "Customer agreement is required before a live transfer."
      };
    }

    if (!SPECIALIST_PHONE_NUMBER) {
      return {
        success: false,
        transfer_status: "specialist_unavailable",
        fallback: "Create a specialist handoff and schedule a callback."
      };
    }

    const current = await getCallById(call.call_id);
    if (!current || !current.twilio_call_sid) {
      return {
        success: false,
        transfer_status: "transfer_failed",
        fallback: "Create a specialist handoff and schedule a callback."
      };
    }

    try {
      const transferResponse = new twilio.twiml.VoiceResponse();
      const dial = transferResponse.dial({
        callerId: TWILIO_FROM_NUMBER,
        answerOnBridge: true
      });
      dial.number(SPECIALIST_PHONE_NUMBER);

      await twilioClient.calls(current.twilio_call_sid).update({
        twiml: transferResponse.toString()
      });

      await pool.query(
        `
          UPDATE ai_calls
          SET
            outcome = 'hot_transfer',
            sequence_status = 'active',
            priority = $2,
            next_action = 'Live specialist transfer',
            next_attempt_at = NULL,
            updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id, cleanText(safeArgs.priority, 30) || "high"]
      );

      await appendAction(call.call_id, {
        action: name,
        success: true,
        transfer_status: "initiated",
        priority: cleanText(safeArgs.priority, 30),
        reason: cleanText(safeArgs.reason, 1000)
      });

      queueMondaySync(call.call_id, "hot_transfer");
      return { success: true, transfer_status: "initiated" };
    } catch (error) {
      await appendAction(call.call_id, {
        action: name,
        success: false,
        transfer_status: "transfer_failed",
        error: cleanText(error.message, 1000)
      });
      return {
        success: false,
        transfer_status: "transfer_failed",
        fallback: "Create a specialist handoff and schedule a callback."
      };
    }
  }

  if (name === "mark_contact_restriction") {
    const restrictionType = cleanText(safeArgs.restriction_type, 50);
    if (
      ![
        "wrong_number",
        "invalid_number",
        "do_not_call",
        "not_interested"
      ].includes(restrictionType)
    ) {
      return { success: false, error: "Unsupported restriction type." };
    }

    const wrongNumber = restrictionType === "wrong_number";
    const invalidNumber = restrictionType === "invalid_number";
    const doNotCall = restrictionType === "do_not_call";
    const notInterested = restrictionType === "not_interested";
    const reason = cleanText(safeArgs.reason, 1000);

    await pool.query(
      `
        UPDATE ai_calls
        SET
          wrong_number = wrong_number OR $2,
          invalid_number = invalid_number OR $3,
          do_not_call = do_not_call OR $4,
          outcome = $5,
          sequence_status = CASE
            WHEN $2 OR $3 OR $4 THEN 'suppressed'
            ELSE 'active'
          END,
          next_attempt_at = NULL,
          next_action = $6,
          awaiting_customer_response = FALSE,
          pending_question_type = NULL,
          pending_question_text = NULL,
          question_asked_at = NULL,
          response_reminder_count = 0,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        wrongNumber,
        invalidNumber,
        doNotCall,
        doNotCall ? "opt_out" : restrictionType,
        reason
      ]
    );

    await mergeCallResult(call.call_id, {
      contact_restriction: {
        type: restrictionType,
        reason,
        stop_voice: safeArgs.stop_voice === true,
        stop_sms: safeArgs.stop_sms === true,
        stop_email: safeArgs.stop_email === true
      }
    });

    await appendAction(call.call_id, {
      action: name,
      success: true,
      restriction_type: restrictionType
    });

    queueMondaySync(call.call_id, `restriction_${restrictionType}`);

    return {
      success: true,
      restriction_type: restrictionType,
      future_voice_calls_stopped:
        wrongNumber || invalidNumber || doNotCall || notInterested
    };
  }
  if (name === "complete_call") {
    const outcome = cleanText(safeArgs.outcome, 80) || "disconnected";
    const nextAction = cleanText(safeArgs.next_action, 2000);
    const summary = cleanText(safeArgs.summary, 4000);
    const stopSequence = safeArgs.stop_sequence === true;
    const pauseSequence = safeArgs.pause_sequence === true;
    const requestedNext = cleanText(safeArgs.requested_next_call_at, 100);

    const hardTerminalOutcome = [
      "qualified",
      "hot_transfer",
      "specialist_handoff",
      "dti_calculator_sent",
      "agent_notified",
      "not_interested",
      "wrong_number",
      "opt_out"
    ].includes(outcome);

    let callbackAt = call.callback_at ? new Date(call.callback_at) : null;
    if (callbackAt && Number.isNaN(callbackAt.getTime())) {
      callbackAt = null;
    }

    let nextAttemptAt = null;
    let sequenceStatus = stopSequence ? "completed" : "waiting_retry";

    if (pauseSequence) {
      sequenceStatus = "paused";
    }

    if (requestedNext) {
      const parsed = new Date(requestedNext);
      if (!Number.isNaN(parsed.getTime()) && parsed > new Date()) {
        nextAttemptAt = parsed;
        callbackAt = parsed;
        sequenceStatus = [
          "follow_up_scheduled",
          "specialist_callback",
          "nurture"
        ].includes(outcome)
          ? "callback_scheduled"
          : "scheduled";
      }
    }

    const hasFutureCallback = Boolean(
      callbackAt && callbackAt > new Date()
    );

    if (hasFutureCallback) {
      nextAttemptAt = callbackAt;
      sequenceStatus = "callback_scheduled";
    }

    if (sequenceStatus === "completed" && (await sequenceHasUnresolvedWork(call.call_id))) {
      sequenceStatus = "active";
      nextAttemptAt = null;
    }

    const clearCallback = hardTerminalOutcome && !hasFutureCallback;

    await pool.query(
      `
        UPDATE ai_calls
        SET
          outcome = $2,
          next_action = $3,
          summary = $4,
          sequence_status = $5,
          next_attempt_at = $6,
          callback_at = CASE
            WHEN $8::BOOLEAN THEN NULL
            WHEN $7::TIMESTAMPTZ IS NOT NULL THEN $7::TIMESTAMPTZ
            ELSE callback_at
          END,
          callback_requested = CASE
            WHEN $8::BOOLEAN THEN FALSE
            WHEN $5 = 'callback_scheduled' THEN TRUE
            ELSE callback_requested
          END,
          awaiting_customer_response = FALSE,
          pending_question_type = NULL,
          pending_question_text = NULL,
          question_asked_at = NULL,
          response_reminder_count = 0,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        outcome,
        nextAction,
        summary,
        sequenceStatus,
        nextAttemptAt,
        callbackAt,
        clearCallback
      ]
    );

    if (call.last_attempt_id) {
      await pool.query(
        `
          UPDATE call_attempts
          SET business_outcome = $2, summary = $3, updated_at = NOW()
          WHERE attempt_id = $1
        `,
        [call.last_attempt_id, outcome, summary]
      );
    }

    await mergeCallResult(call.call_id, {
      final_outcome: outcome,
      next_action: nextAction,
      summary,
      stop_sequence_requested: stopSequence,
      pause_sequence_requested: pauseSequence,
      actual_sequence_status: sequenceStatus,
      callback_preserved: sequenceStatus === "callback_scheduled",
      requested_next_call_at: nextAttemptAt
        ? nextAttemptAt.toISOString()
        : null
    });

    await appendAction(call.call_id, {
      action: name,
      success: true,
      outcome,
      stop_sequence_requested: stopSequence,
      pause_sequence_requested: pauseSequence,
      actual_sequence_status: sequenceStatus,
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null
    });

    queueMondaySync(call.call_id, `complete_call_${outcome}`);

    return {
      success: true,
      outcome,
      sequence_status: sequenceStatus,
      callback_preserved: sequenceStatus === "callback_scheduled",
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null
    };
  }

  return { success: false, error: `Unknown tool: ${name}` };
}

app.get("/", (req, res) => {
  res.json({
    message: "HELUX AI Workforce is online.",
    version: DOUG_CONFIG.agentVersion,
    worker: "Daisy — Doug's DPA assistant",
    realtime_model: OPENAI_REALTIME_MODEL,
    voice: OPENAI_VOICE,
    cadence: DOUG_CONFIG.cadenceVersion,
    scheduler: CALL_SCHEDULER_ENABLED ? "enabled" : "disabled",
    monday_sync: MONDAY_SYNC_ENABLED ? "enabled" : "disabled",
    monday_adapter: DOUG_CONFIG.mondayAdapterVersion
  });
});

app.get("/health", async (req, res) => {
  try {
    const database = await pool.query("SELECT NOW() AS database_time");
    res.json({
      status: "healthy",
      service: "helux-ai-workforce",
      version: DOUG_CONFIG.agentVersion,
      database: "connected",
      database_time: database.rows[0].database_time,
      openai: Boolean(OPENAI_API_KEY),
      twilio: Boolean(
        TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER
      ),
      scheduler: CALL_SCHEDULER_ENABLED,
      consent_enforcement: ENFORCE_CALL_CONSENT,
      monday: {
        requested: MONDAY_SYNC_REQUESTED,
        enabled: MONDAY_SYNC_ENABLED,
        token_present: Boolean(MONDAY_API_TOKEN),
        board_id: MONDAY_BOARD_ID,
        subitem_board_id: MONDAY_SUBITEM_BOARD_ID,
        api_version: MONDAY_API_VERSION,
        metadata_cached: Boolean(mondayMetadataCache),
        inbound_sync_enabled: MONDAY_INBOUND_SYNC_ENABLED
      }
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      service: "helux-ai-workforce",
      database: "disconnected",
      error: error.message
    });
  }
});

app.get(
  "/api/v1/monday/health",
  authenticateHelux,
  async (req, res, next) => {
    try {
      if (!MONDAY_SYNC_ENABLED) {
        throw new HttpError(
          409,
          "monday.com sync is disabled or not fully configured."
        );
      }

      const metadata = await loadMondayMetadata({ force: true });
      res.json({
        success: true,
        api_version: MONDAY_API_VERSION,
        main_board: {
          id: metadata.main.id,
          name: metadata.main.name,
          groups: metadata.main.groups.map((group) => ({
            id: group.id,
            title: group.title
          })),
          columns: metadata.main.columns.map((column) => ({
            id: column.id,
            title: column.title,
            type: column.type
          }))
        },
        subitem_board: {
          id: metadata.subitems.id,
          name: metadata.subitems.name,
          columns: metadata.subitems.columns.map((column) => ({
            id: column.id,
            title: column.title,
            type: column.type
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/v1/monday/webhook", (req, res) => {
  if (String(req.query.secret || "") !== MONDAY_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body?.event || null;
  res.status(200).json({ success: true });

  if (MONDAY_INBOUND_SYNC_ENABLED && event) {
    void processMondayInboundEvent(event).catch((error) => {
      console.error("monday.com inbound event failed:", error);
    });
  }
});

app.post(
  "/api/v1/monday/register-webhooks",
  authenticateHelux,
  async (req, res, next) => {
    try {
      const webhookIds = await ensureMondayInboundWebhooks();
      res.json({
        success: true,
        inbound_sync_enabled: MONDAY_INBOUND_SYNC_ENABLED,
        webhook_ids: webhookIds
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/v1/calls",
  authenticateHelux,
  async (req, res, next) => {
    try {
      const payload = req.body || {};
      const requestKey = callRequestKey(payload);
      const phone = normalizePhone(payload.phone);

      if (!phone) {
        throw new HttpError(422, "A valid phone number is required.");
      }

      const existing = await getCallByRequestKey(requestKey);
      if (existing) {
        queueMondaySync(existing.call_id, "duplicate_request_refresh");
        return res.status(200).json({
          success: true,
          duplicate: true,
          call_id: existing.call_id,
          status: existing.status,
          sequence_status: existing.sequence_status,
          attempts_used: existing.attempts,
          max_attempts: existing.max_attempts,
          next_attempt_at: existing.next_attempt_at,
          twilio_call_sid: existing.twilio_call_sid,
          monday_item_id: existing.monday_item_id
        });
      }

      const callId = createPublicId("CALL");
      const streamToken = createStreamToken();
      const timezone = normalizeTimezone(payload.timezone);
      const consentConfirmed = confirmedConsent(payload);
      const consentStatus = consentConfirmed ? "confirmed" : "unverified";
      const forceCallNow =
        payload.force_call_now === true || payload.test_mode === true;

      if (ENFORCE_CALL_CONSENT && !consentConfirmed && !forceCallNow) {
        throw new HttpError(422, "Confirmed AI voice consent is required.");
      }

      const maxAttempts = Math.min(
        6,
        Math.max(1, Number(payload.max_attempts || DOUG_CONFIG.maxAttempts))
      );

      const consentTimestamp = payload.consent_timestamp
        ? new Date(payload.consent_timestamp)
        : null;

      const safeConsentTimestamp =
        consentTimestamp && !Number.isNaN(consentTimestamp.getTime())
          ? consentTimestamp
          : null;

      const insertResult = await pool.query(
        `
          INSERT INTO ai_calls (
            call_id, request_key, case_id, lead_id, phone, status,
            sequence_status, stream_token, payload, max_attempts,
            timezone, consent_status, consent_timestamp, consent_source,
            agent_version, prompt_version, tool_version, knowledge_version,
            routing_version, cadence_version, priority, human_owner_id
          )
          VALUES (
            $1, $2, $3, $4, $5, 'created', 'ready', $6, $7::jsonb,
            $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20
          )
          RETURNING *
        `,
        [
          callId,
          requestKey,
          cleanText(payload.case_id, 150),
          cleanText(payload.lead_id, 150),
          phone,
          streamToken,
          JSON.stringify(payload),
          maxAttempts,
          timezone,
          consentStatus,
          safeConsentTimestamp,
          cleanText(payload.consent_source, 255),
          DOUG_CONFIG.agentVersion,
          DOUG_CONFIG.promptVersion,
          DOUG_CONFIG.toolVersion,
          DOUG_CONFIG.knowledgeVersion,
          DOUG_CONFIG.routingVersion,
          DOUG_CONFIG.cadenceVersion,
          cleanText(payload.priority, 30) || "normal",
          cleanText(payload.human_owner_id || payload.owner_id, 100)
        ]
      );

      const call = insertResult.rows[0];
      await mergeCallResult(
        call.call_id,
        normalizeDaisyAnswers({
          has_realtor: payload.has_realtor ?? payload.realtor_status ?? null,
          applied_with_lender:
            payload.applied_with_lender ?? payload.applied_other_lender ?? null,
          app_started_confirmation:
            payload.app_started_confirmation ?? payload.application_status ?? null,
          time_frame: payload.time_frame ?? payload.timeframe ?? null,
          interest_level: null,
          tentative_meeting_availability:
            payload.tentative_meeting_availability ?? null,
          application_link_sent: false,
          application_follow_up_at: null
        })
      );
      queueMondaySync(call.call_id, "sequence_created");

      const now = new Date();
      const shouldDialNow = forceCallNow || insideOperatingWindow(now, timezone);
      const nextAttemptAt = shouldDialNow
        ? now
        : nextValidWindow(
            timezone,
            now,
            DOUG_CONFIG.preferredWindows.morning,
            0
          );
      await pool.query(
        `UPDATE ai_calls SET sequence_status = 'scheduled', next_attempt_at = $2,
         completed_at = NULL, updated_at = NOW() WHERE call_id = $1`,
        [call.call_id, nextAttemptAt]
      );
      const firstAttempt = await ensurePendingAttempt(call.call_id, {
        attemptType: "cadence",
        scheduledAt: nextAttemptAt,
        idempotencyKey: `cadence:${call.call_id}:1`
      });

      if (!shouldDialNow) {
        queueMondaySync(call.call_id, "sequence_scheduled");

        return res.status(202).json({
          success: true,
          duplicate: false,
          call_id: call.call_id,
          status: "scheduled",
          sequence_status: "scheduled",
          next_attempt_at: nextAttemptAt.toISOString(),
          monday_sync_queued: MONDAY_SYNC_ENABLED
        });
      }

      const twilioCall = await placeTwilioCall(call, {
        force: forceCallNow,
        attemptId: firstAttempt.attempt_id
      });

      res.status(201).json({
        success: true,
        duplicate: false,
        call_id: call.call_id,
        status: twilioCall.status || "queued",
        sequence_status: "calling",
        attempts_used: 1,
        max_attempts: call.max_attempts,
        twilio_call_sid: twilioCall.sid,
        monday_sync_queued: MONDAY_SYNC_ENABLED
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/v1/calls/:callId/retry",
  authenticateHelux,
  async (req, res, next) => {
    try {
      const call = await getCallById(req.params.callId);
      if (!call) throw new HttpError(404, "Call not found.");

      if (!terminalCallStatus(call.status)) {
        throw new HttpError(
          409,
          `Call cannot be retried while status is ${call.status}.`
        );
      }

      const newStreamToken = createStreamToken();
      await pool.query(
        `
          UPDATE ai_calls
          SET
            stream_token = $2,
            status = 'created',
            sequence_status = 'ready',
            twilio_call_sid = NULL,
            last_error = NULL,
            completed_at = NULL,
            next_attempt_at = NULL,
            updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id, newStreamToken]
      );

      queueMondaySync(call.call_id, "manual_retry_ready");
      const refreshed = await getCallById(call.call_id);
      const twilioCall = await placeTwilioCall(refreshed, {
        force: req.body && req.body.force === true
      });

      res.json({
        success: true,
        call_id: call.call_id,
        status: twilioCall.status || "queued",
        twilio_call_sid: twilioCall.sid,
        attempts: Number(call.attempts || 0) + 1
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/v1/calls/:callId/sync-monday",
  authenticateHelux,
  async (req, res, next) => {
    try {
      if (!MONDAY_SYNC_ENABLED) {
        throw new HttpError(
          409,
          "monday.com sync is disabled or not fully configured."
        );
      }

      const call = await getCallById(req.params.callId);
      if (!call) throw new HttpError(404, "Call not found.");

      await syncCallSequenceToMonday(call.call_id, "manual_sync");
      const refreshed = await getCallById(call.call_id);
      const attempts = await getAttemptsForCall(call.call_id);

      res.json({
        success: !refreshed.monday_last_error,
        call_id: call.call_id,
        monday_item_id: refreshed.monday_item_id,
        monday_group_id: refreshed.monday_group_id,
        monday_last_sync_at: refreshed.monday_last_sync_at,
        monday_last_error: refreshed.monday_last_error,
        attempt_subitems: attempts.map((attempt) => ({
          attempt_id: attempt.attempt_id,
          monday_subitem_id: attempt.monday_subitem_id,
          monday_last_sync_at: attempt.monday_last_sync_at,
          monday_last_error: attempt.monday_last_error
        }))
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/v1/calls/:callId",
  authenticateHelux,
  async (req, res, next) => {
    try {
      const call = await getCallById(req.params.callId);
      if (!call) throw new HttpError(404, "Call not found.");
      const attempts = await getAttemptsForCall(call.call_id);

      res.json({
        success: true,
        call: {
          call_id: call.call_id,
          case_id: call.case_id,
          lead_id: call.lead_id,
          phone: call.phone,
          status: call.status,
          sequence_status: call.sequence_status,
          twilio_call_sid: call.twilio_call_sid,
          attempts_used: call.attempts,
          max_attempts: call.max_attempts,
          next_attempt_at: call.next_attempt_at,
          callback_at: call.callback_at,
          timezone: call.timezone,
          current_state: call.current_state,
          next_state: call.next_state,
          awaiting_customer_response: call.awaiting_customer_response,
          pending_question_type: call.pending_question_type,
          pending_question_text: call.pending_question_text,
          question_asked_at: call.question_asked_at,
          response_reminder_count: call.response_reminder_count,
          sentiment: call.sentiment,
          outcome: call.outcome,
          next_action: call.next_action,
          summary: call.summary,
          transcript: call.transcript,
          actions: call.actions,
          result: call.result,
          last_error: call.last_error,
          monday_item_id: call.monday_item_id,
          monday_group_id: call.monday_group_id,
          monday_last_sync_at: call.monday_last_sync_at,
          monday_last_error: call.monday_last_error,
          created_at: call.created_at,
          started_at: call.started_at,
          answered_at: call.answered_at,
          completed_at: call.completed_at,
          attempt_records: attempts
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/v1/twilio/voice", async (req, res, next) => {
  try {
    const callId = cleanText(req.query.call_id, 100);
    const token = cleanText(req.query.token, 160);
    const call = await validateCallToken(callId, token);

    if (!call) throw new HttpError(401, "Invalid call token.");

    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({
      url: `${websocketBaseUrl()}/api/v1/twilio/media`
    });

    stream.parameter({ name: "call_id", value: call.call_id });
    stream.parameter({ name: "stream_token", value: call.stream_token });

    res.type("text/xml").send(response.toString());
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/twilio/sms-status", async (req, res, next) => {
  try {
    const callId = cleanText(req.query.call_id, 100);
    const token = cleanText(req.query.token, 160);
    const call = await validateCallToken(callId, token);
    if (!call) throw new HttpError(401, "Invalid call token.");

    const messageSid = cleanText(req.body.MessageSid, 80);
    const status = cleanText(req.body.MessageStatus, 50) || "unknown";
    const errorCode = cleanText(req.body.ErrorCode, 50);
    const errorMessage = cleanText(req.body.ErrorMessage, 2000);
    if (!messageSid) throw new HttpError(422, "MessageSid is required.");

    const tracked = await pool.query(
      `
        UPDATE sms_deliveries
        SET status = $2, error_code = $3, error_message = $4,
            updated_at = NOW()
        WHERE message_sid = $1
        RETURNING message_type
      `,
      [messageSid, status, errorCode, errorMessage]
    );
    const messageType =
      tracked.rows[0]?.message_type ||
      (call.result?.application_sms_sid === messageSid
        ? "application"
        : "unknown");
    const failed = ["failed", "undelivered"].includes(status.toLowerCase());

    console.log(
      JSON.stringify({
        event: "outbound_sms_status",
        call_id: call.call_id,
        message_type: messageType,
        message_sid: messageSid,
        message_status: status,
        error_code: errorCode,
        error_message: errorMessage
      })
    );

    await mergeCallResult(call.call_id, {
      [`${messageType}_sms_status`]: status,
      [`${messageType}_sms_error_code`]: errorCode,
      [`${messageType}_sms_error`]: errorMessage,
      ...(messageType === "application"
        ? { application_sms_status: status, application_sms_failed: failed }
        : {})
    });
    await appendAction(call.call_id, {
      action: "sms_delivery_status",
      success: !failed,
      message_type: messageType,
      message_sid: messageSid,
      status,
      error_code: errorCode,
      error: errorMessage
    });

    if (failed) {
      const humanReviewNote = messageType === "application"
        ? "Human must send the DPA application link manually"
        : `Human review required for failed ${messageType} text delivery`;
      await pool.query(
        `
          UPDATE ai_calls
          SET next_action = $2,
              last_error = $3,
              updated_at = NOW()
          WHERE call_id = $1
        `,
        [
          call.call_id,
          humanReviewNote,
          `${messageType} SMS ${status}${errorCode ? ` (${errorCode})` : ""}`
        ]
      );
      queueMondaySync(call.call_id, `${messageType}_sms_${status}`);
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/twilio/status", async (req, res, next) => {
  try {
    const callId = cleanText(req.query.call_id, 100);
    const token = cleanText(req.query.token, 160);
    const call = await validateCallToken(callId, token);

    if (!call) throw new HttpError(401, "Invalid call token.");

    const status = cleanText(req.body.CallStatus, 50) || "unknown";
    const twilioCallSid = cleanText(req.body.CallSid, 80);
    const durationSeconds = Number(req.body.CallDuration || 0);
    const answeredByRaw = cleanText(req.body.AnsweredBy, 50);
    const answeredBy = answeredByRaw
      ? answeredByRaw.toLowerCase().startsWith("human")
        ? "human"
        : answeredByRaw.toLowerCase().startsWith("machine")
          ? "voicemail"
          : "unknown"
      : null;

    await updateCallStatus(call.call_id, status, {
      twilio_call_sid: twilioCallSid
    });

    const refreshed = await getCallById(call.call_id);
    if (refreshed && refreshed.last_attempt_id && durationSeconds >= 0) {
      await pool.query(
        `
          UPDATE call_attempts
          SET
            duration_seconds = $2,
            answered_by = COALESCE($3::VARCHAR(30), answered_by),
            updated_at = NOW()
          WHERE attempt_id = $1
        `,
        [refreshed.last_attempt_id, durationSeconds, answeredBy]
      );
      queueMondaySync(call.call_id, `twilio_status_${status}_details`);
    }

    if (terminalCallStatus(status)) {
      await finalizeCadenceAfterTerminal(call.call_id, status);
      const finalCall = await getCallById(call.call_id);
      queueMondaySync(call.call_id, `twilio_terminal_${status}`);
      void notifyHelux(finalCall);
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
mediaServer.on("connection", (twilioSocket) => {
  let openaiSocket = null;
  let call = null;
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItemId = null;
  let markCounter = 0;
  let initialGreetingStarted = false;
  let pendingAudio = [];
  let closed = false;
  let assistantResponseActive = false;
  let responseCreatePending = false;
  let queuedResponseOptions = null;
  let pendingResponsePreservesQuestion = false;
  let activeResponsePreservesQuestion = false;
  let assistantResponseFinished = true;
  let hangupAfterPlaybackRequested = false;
  let hangupInProgress = false;
  let hangupCompleted = false;
  let sustainedSpeechTimer = null;
  let speechCandidateStartedAt = 0;
  let speechCandidateConfirmed = false;
  let speechCandidateWhileAssistantSpeaking = false;
  let silenceReminderTimer = null;
  let customerTranscriptDebounceTimer = null;
  let pendingCustomerTranscripts = [];
  let customerSpeaking = false;
  let customerTurnBeganWhileAssistantSpeaking = false;
  let pendingTranscriptWasWhileAssistantSpeaking = false;
  let awaitingCustomerResponse = false;
  let pendingQuestionType = null;
  let pendingQuestionText = null;
  let questionAskedAt = null;
  let responseReminderCount = 0;
  let assistantTranscriptBuffer = "";
  let assistantTranscriptSaved = false;
  let questionCapturedForResponse = false;
  let pendingResponseWaitingPromptKind = null;
  let activeResponseWaitingPromptKind = null;
  let lastWaitingPromptKind = null;
  let suspendedQuestionState = null;
  let complianceRecoveryActive = false;
  const handledToolCalls = new Set();
  const handledUserTurns = new Set();
  const pendingMarkNames = new Set();

  function briefListeningAcknowledgement(value) {
    return isListeningAcknowledgement(value);
  }

  function sendToOpenAI(event) {
    if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
      openaiSocket.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  function sendToTwilio(message) {
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function sendMark() {
    if (!streamSid) return;
    markCounter += 1;
    const name = `openai-${markCounter}`;
    if (sendToTwilio({
      event: "mark",
      streamSid,
      mark: { name }
    })) pendingMarkNames.add(name);
  }

  async function handleInterruption() {
    if (
      !streamSid ||
      !lastAssistantItemId ||
      responseStartTimestamp === null
    ) {
      return;
    }

    const elapsed = Math.max(
      0,
      latestMediaTimestamp - responseStartTimestamp
    );

    sendToTwilio({ event: "clear", streamSid });
    pendingMarkNames.clear();
    sendToOpenAI({
      type: "conversation.item.truncate",
      item_id: lastAssistantItemId,
      content_index: 0,
      audio_end_ms: elapsed
    });

    responseStartTimestamp = null;
    lastAssistantItemId = null;
  }

  function requestAssistantResponse(options = {}) {
    if (awaitingCustomerResponse && options.allowWhileAwaiting !== true) {
      return false;
    }
    if (assistantResponseActive || responseCreatePending) {
      if (options.queueIfBusy === true) queuedResponseOptions = { ...options };
      return false;
    }
    responseCreatePending = true;
    assistantResponseFinished = false;
    pendingResponsePreservesQuestion = options.preservePendingQuestion === true;
    pendingResponseWaitingPromptKind = options.waitingPromptKind || null;
    const event = { type: "response.create" };
    if (options.response) event.response = options.response;
    if (!sendToOpenAI(event)) {
      responseCreatePending = false;
      assistantResponseFinished = true;
      pendingResponsePreservesQuestion = false;
      pendingResponseWaitingPromptKind = null;
      return false;
    }
    return true;
  }

  function currentQuestionState() {
    return {
      pending_question_type: pendingQuestionType,
      pending_question_text: pendingQuestionText,
      question_asked_at: questionAskedAt,
      response_reminder_count: responseReminderCount
    };
  }

  function cancelSilenceReminder() {
    if (silenceReminderTimer) clearTimeout(silenceReminderTimer);
    silenceReminderTimer = null;
  }

  function scheduleSilenceReminder() {
    cancelSilenceReminder();
    if (
      !awaitingCustomerResponse ||
      customerSpeaking ||
      !assistantResponseFinished ||
      pendingMarkNames.size ||
      responseReminderCount >= 2 ||
      closed
    ) return;

    silenceReminderTimer = setTimeout(() => {
      silenceReminderTimer = null;
      void (async () => {
        if (!awaitingCustomerResponse || customerSpeaking || closed) return;
        const nextCount = responseReminderCount + 1;
        responseReminderCount = nextCount;
        await setResponseReminderCount(
          call.call_id,
          nextCount,
          currentQuestionState()
        );
        const instructions = nextCount === 1
          ? 'Say exactly: "Are you still with me?" Say nothing else.'
          : `Repeat this pending question once, using the same meaning and no additional question: ${JSON.stringify(
              pendingQuestionText
            )}`;
        requestAssistantResponse({
          allowWhileAwaiting: true,
          preservePendingQuestion: true,
          waitingPromptKind:
            nextCount === 1 ? "presence_reminder" : "pending_repeat",
          response: { output_modalities: ["audio"], instructions }
        });
      })().catch((error) => {
        console.error("Daisy silence reminder failed:", error);
      });
    }, 8000);
  }

  async function captureAssistantQuestion(transcript) {
    if (activeResponsePreservesQuestion) return;
    const question = extractPrimaryQuestion(transcript);
    if (!question) return;
    const state = await setAwaitingCustomerResponse(call.call_id, question);
    awaitingCustomerResponse = true;
    pendingQuestionType = state.pending_question_type;
    pendingQuestionText = state.pending_question_text;
    questionAskedAt = state.question_asked_at;
    responseReminderCount = 0;
    queuedResponseOptions = null;
    scheduleSilenceReminder();
  }

  async function endLocalWaitingState(reason) {
    cancelSilenceReminder();
    await clearAwaitingCustomerResponse(call.call_id, reason);
    awaitingCustomerResponse = false;
    pendingQuestionType = null;
    pendingQuestionText = null;
    questionAskedAt = null;
    responseReminderCount = 0;
  }

  async function processCompletedCustomerTranscript(
    transcript,
    beganWhileAssistantSpeaking = false
  ) {
    logCustomerResponseState(call.call_id, {
      ...currentQuestionState(),
      awaiting_customer_response: awaitingCustomerResponse,
      completed_transcript_received: true
    });

    if (!isMeaningfulCustomerTranscript(transcript)) {
      console.log(
        JSON.stringify({
          event: "background_noise_ignored",
          call_id: call.call_id,
          transcript: cleanText(transcript, 200)
        })
      );
      scheduleSilenceReminder();
      return;
    }

    const overlappedAssistant =
      beganWhileAssistantSpeaking ||
      assistantResponseActive ||
      responseCreatePending;

    if (
      overlappedAssistant &&
      !customerExplicitlyInterrupted(transcript)
    ) {
      console.log(
        JSON.stringify({
          event: "non_explicit_overlap_ignored",
          call_id: call.call_id,
          transcript: cleanText(transcript, 200)
        })
      );

      return;
    }

    if (
      assistantResponseActive &&
      customerExplicitlyInterrupted(transcript)
    ) {
      await stopAssistantForCustomer();
    }

    const pendingQuestionAcceptsAffirmative =
      directYesNoQuestion(pendingQuestionText) ||
      [
        "identity_confirmation",
        "confirmation",
        "application_link_permission"
      ].includes(String(pendingQuestionType || ""));

    if (isInterestRateQuestion(transcript)) {
      const returnToQuestion = awaitingCustomerResponse && pendingQuestionText
        ? ` Then ask this still-pending question once and stop: ${JSON.stringify(pendingQuestionText)}`
        : "";
      requestAssistantResponse({
        queueIfBusy: true,
        allowWhileAwaiting: true,
        preservePendingQuestion: awaitingCustomerResponse,
        response: {
          output_modalities: ["audio"],
          instructions: `Say exactly: ${JSON.stringify(interestRateResponse())}.${returnToQuestion}`
        }
      });
      return;
    }

    if (!awaitingCustomerResponse) {
      requestAssistantResponse({ queueIfBusy: true });
      return;
    }

    if (customerRequestedMoreTime(transcript)) {
      await endLocalWaitingState("customer_requested_more_time");
      requestAssistantResponse({
        queueIfBusy: true,
        response: {
          output_modalities: ["audio"],
          instructions: 'Say exactly: "Of course—take your time." Say nothing else.'
        }
      });
      return;
    }


    if (
      lastWaitingPromptKind === "presence_reminder" &&
      presenceOnlyResponse(transcript)
    ) {
      const nextCount = 2;
      responseReminderCount = nextCount;
      await setResponseReminderCount(
        call.call_id,
        nextCount,
        currentQuestionState()
      );
      requestAssistantResponse({
        queueIfBusy: true,
        allowWhileAwaiting: true,
        preservePendingQuestion: true,
        waitingPromptKind: "pending_repeat",
        response: {
          output_modalities: ["audio"],
          instructions: `Repeat this pending question once, using the same meaning and no additional question: ${JSON.stringify(
            pendingQuestionText
          )}`
        }
      });
      return;
    }

    if (customerAskedSeparateQuestion(transcript)) {
      requestAssistantResponse({
        queueIfBusy: true,
        allowWhileAwaiting: true,
        preservePendingQuestion: true,
        response: {
          output_modalities: ["audio"],
          instructions: `Answer the customer's separate question briefly and accurately. Then return naturally to this still-pending question, ask it once, and stop: ${JSON.stringify(
            pendingQuestionText
          )}`
        }
      });
      return;
    }

    if (
      pendingQuestionAcceptsAffirmative &&
      affirmativeCustomerResponse(transcript)
    ) {
      await endLocalWaitingState("affirmative_customer_answer");
      requestAssistantResponse({ queueIfBusy: true });
      return;
    }

    if (briefListeningAcknowledgement(transcript)) {
      if (directYesNoQuestion(pendingQuestionText)) {
        requestAssistantResponse({
          queueIfBusy: true,
          allowWhileAwaiting: true,
          preservePendingQuestion: true,
          response: {
            output_modalities: ["audio"],
            instructions: 'Say exactly: "Was that a yes?" Say nothing else.'
          }
        });
      } else {
        scheduleSilenceReminder();
      }
      return;
    }

    await endLocalWaitingState("meaningful_completed_customer_answer");
    if (suspendedQuestionState) {
      const suspended = suspendedQuestionState;
      suspendedQuestionState = null;
      requestAssistantResponse({
        queueIfBusy: true,
        response: {
          output_modalities: ["audio"],
          instructions: `Continue the identity-confirmed introduction briefly without asking another question. Then return to this previously pending question, ask it once, and stop: ${JSON.stringify(
            suspended.pending_question_text
          )}`
        }
      });
    } else {
      requestAssistantResponse({ queueIfBusy: true });
    }
  }

  async function stopAssistantForCustomer() {
    if (!assistantResponseActive) return;
    sendToOpenAI({ type: "response.cancel" });
    await handleInterruption();
  }

  async function hangupTwilioCallAfterPlayback() {
    if (
      !hangupAfterPlaybackRequested ||
      hangupInProgress ||
      hangupCompleted ||
      !assistantResponseFinished ||
      pendingMarkNames.size > 0 ||
      !call
    ) {
      return false;
    }

    hangupInProgress = true;

    try {
      const refreshedCall =
        (await getCallById(call.call_id)) || call;

      if (refreshedCall.awaiting_customer_response === true) {
        return false;
      }

      const twilioCallSid =
        refreshedCall.twilio_call_sid ||
        call.twilio_call_sid;

      if (!twilioCallSid) {
        throw new Error(
          "Twilio Call SID is unavailable for final hangup."
        );
      }

      await twilioClient.calls(twilioCallSid).update({
        status: "completed"
      });

      hangupCompleted = true;

      await appendAction(call.call_id, {
        action: "twilio_call_hangup",
        success: true,
        reason: "completed_call_after_final_audio"
      });

      console.log(
        JSON.stringify({
          event: "twilio_call_hangup",
          call_id: call.call_id,
          twilio_call_sid: twilioCallSid,
          success: true,
          reason: "completed_call_after_final_audio"
        })
      );

      return true;
    } catch (error) {
      const safeError =
        cleanText(error.message, 1000) ||
        "Twilio call hangup failed.";

      await appendAction(call.call_id, {
        action: "twilio_call_hangup",
        success: false,
        reason: "completed_call_after_final_audio",
        error: safeError
      });

      console.error(
        JSON.stringify({
          event: "twilio_call_hangup",
          call_id: call.call_id,
          success: false,
          error: safeError
        })
      );

      return false;
    } finally {
      hangupInProgress = false;
    }
  }

  async function handleToolCall(name, toolCallId, argumentText) {
    if (!call || !toolCallId || handledToolCalls.has(toolCallId)) return;
    handledToolCalls.add(toolCallId);

    let args = {};
    try {
      args = argumentText ? JSON.parse(argumentText) : {};
    } catch {
      args = {};
    }

    let output;
    try {
      const refreshed = await getCallById(call.call_id);
      output = await routeIntent({
        toolName: name,
        args,
        call: refreshed || call,
        execute: executeDougTool
      });
    } catch (error) {
      console.error(`Daisy tool ${name} failed for ${call.call_id}:`, error);
      output = {
        success: false,
        intent: "UNKNOWN_INTENT",
        customer_safe_message: null,
        data: {},
        error: { code: "ACTION_FAILED", retryable: true }
      };
    }

    const completeCallSucceeded =
      name === "complete_call" &&
      output?.success === true &&
      output?.intent === "complete_call" &&
      output?.error === null;

    if (completeCallSucceeded) {
      hangupAfterPlaybackRequested = true;
    }

    sendToOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(output)
      }
    });
    requestAssistantResponse({ queueIfBusy: true });
  }

  function connectToOpenAI() {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`;

    openaiSocket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Safety-Identifier": safetyIdentifier(call)
      }
    });

    openaiSocket.on("open", () => {
      const realtimeSession = buildRealtimeSession({
        model: OPENAI_REALTIME_MODEL,
        voice: OPENAI_VOICE,
        transcriptionModel: OPENAI_TRANSCRIPTION_MODEL,
        instructions: buildDouglasDaisyInstructions(call),
        tools: REALTIME_TOOLS
      });

      realtimeSession.audio.input.turn_detection = {
        ...(realtimeSession.audio.input.turn_detection || {}),
        type: "server_vad",
        threshold: 0.75,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
        create_response: false,
        interrupt_response: false
      };

      sendToOpenAI({
        type: "session.update",
        session: realtimeSession
      });

      for (const audio of pendingAudio) {
        sendToOpenAI({ type: "input_audio_buffer.append", audio });
      }
      pendingAudio = [];
    });

    openaiSocket.on("message", async (rawMessage) => {
      try {
        let event;
        try {
          event = JSON.parse(rawMessage.toString());
        } catch {
          return;
        }

     if (!initialGreetingStarted) {
  initialGreetingStarted = true;

  const openingName = cleanText(call?.payload?.first_name, 80);
  const internalCustomerName = cleanText(call?.payload?.customer_name, 160);
  requestAssistantResponse({
    response: {
      output_modalities: ["audio"],
      instructions: openingName
        ? `Say exactly: "Hi, is ${openingName} available?" Say nothing else until they answer.`
        : call?.payload?.call_type === "dpa_agent_notification"
          ? `Say exactly: "Hi, is the DPA specialist assigned to ${internalCustomerName || "this application"} available?" Say nothing else until they answer.`
          : "Say exactly: \"Hello, is this the person who recently reached out to DPA Help Center?\" Do not speak a name placeholder. Say nothing else until they answer."
    }
  });
}

        if (event.type === "response.created") {
          responseCreatePending = false;
          assistantResponseActive = true;
          assistantResponseFinished = false;
          activeResponsePreservesQuestion = pendingResponsePreservesQuestion;
          pendingResponsePreservesQuestion = false;
          activeResponseWaitingPromptKind = pendingResponseWaitingPromptKind;
          pendingResponseWaitingPromptKind = null;
          assistantTranscriptBuffer = "";
          assistantTranscriptSaved = false;
          questionCapturedForResponse = false;
          return;
        }

        if (event.type === "response.output_audio_transcript.delta") {
          assistantTranscriptBuffer += event.delta || "";
          const compliance = guardAssistantOutput(assistantTranscriptBuffer);
          if (!compliance.allowed && !complianceRecoveryActive) {
            complianceRecoveryActive = true;
            sendToOpenAI({ type: "response.cancel" });
            if (streamSid) sendToTwilio({ event: "clear", streamSid });
            pendingMarkNames.clear();
            queuedResponseOptions = null;
            requestAssistantResponse({
              queueIfBusy: true,
              response: {
                output_modalities: ["audio"],
                instructions: `Say exactly: ${JSON.stringify(compliance.replacement)} Say nothing else.`
              }
            });
            await appendAction(call.call_id, {
              action: "compliance_output_intercepted",
              success: true,
              policy_code: compliance.code
            });
            return;
          }
          return;
        }

        if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.created"
        ) {
          if (event.item && event.item.id) lastAssistantItemId = event.item.id;
          return;
        }

        if (
          event.type === "response.output_audio.delta" ||
          event.type === "response.audio.delta"
        ) {
          if (!event.delta || !streamSid) return;
          if (responseStartTimestamp === null) {
            responseStartTimestamp = latestMediaTimestamp;
          }
          sendToTwilio({
            event: "media",
            streamSid,
            media: { payload: event.delta }
          });
          sendMark();
          return;
        }

        if (event.type === "input_audio_buffer.speech_started") {
          const assistantWasSpeaking =
            assistantResponseActive || responseCreatePending;

          speechCandidateStartedAt = Date.now();
          speechCandidateConfirmed = false;
          speechCandidateWhileAssistantSpeaking =
            assistantWasSpeaking;

          if (sustainedSpeechTimer) {
            clearTimeout(sustainedSpeechTimer);
          }

          sustainedSpeechTimer = setTimeout(() => {
            sustainedSpeechTimer = null;

            if (
              closed ||
              !speechCandidateStartedAt ||
              speechCandidateConfirmed
            ) {
              return;
            }

            speechCandidateConfirmed = true;
            customerSpeaking = true;
            customerTurnBeganWhileAssistantSpeaking =
              customerTurnBeganWhileAssistantSpeaking ||
              speechCandidateWhileAssistantSpeaking;

            cancelSilenceReminder();

            if (customerTranscriptDebounceTimer) {
              clearTimeout(customerTranscriptDebounceTimer);
              customerTranscriptDebounceTimer = null;
            }

            logCustomerResponseState(call.call_id, {
              ...currentQuestionState(),
              awaiting_customer_response:
                awaitingCustomerResponse,
              customer_speech_detected: true
            });

          }, Math.max(
            DAISY_SPEECH_CONFIRM_MS,
            Number(
              REALTIME_DEFAULTS.meaningfulInterruptionMs || 0
            )
          ));

          return;
        }

        if (event.type === "input_audio_buffer.speech_stopped") {
          const candidateDurationMs = speechCandidateStartedAt
            ? Date.now() - speechCandidateStartedAt
            : 0;

          const wasConfirmedSpeech = speechCandidateConfirmed;

          if (sustainedSpeechTimer) {
            clearTimeout(sustainedSpeechTimer);
          }

          sustainedSpeechTimer = null;
          speechCandidateStartedAt = 0;
          speechCandidateConfirmed = false;
          speechCandidateWhileAssistantSpeaking = false;
          customerSpeaking = false;

          if (!wasConfirmedSpeech) {
            console.log(
              JSON.stringify({
                event: "short_vad_noise_ignored",
                call_id: call.call_id,
                duration_ms: candidateDurationMs
              })
            );

            if (!pendingMarkNames.size) {
              scheduleSilenceReminder();
            }
          }

          return;
        }

        if (event.type === "response.output_audio_transcript.done") {
          if (!assistantTranscriptSaved) {
            await appendTranscript(call.call_id, "assistant", event.transcript);
            assistantTranscriptSaved = true;
          }
          if (!questionCapturedForResponse) {
            await captureAssistantQuestion(event.transcript);
            questionCapturedForResponse = Boolean(
              extractPrimaryQuestion(event.transcript)
            );
          }
          return;
        }

        if (
          event.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          await appendTranscript(call.call_id, "lead", event.transcript);
          const turnKey = String(
            event.item_id ||
              stableHash(`${event.transcript}:${event.audio_end_ms || ""}`)
          );
          if (handledUserTurns.has(turnKey)) return;
          handledUserTurns.add(turnKey);
          pendingCustomerTranscripts.push(cleanText(event.transcript, 8000));
          pendingTranscriptWasWhileAssistantSpeaking =
            pendingTranscriptWasWhileAssistantSpeaking ||
            customerTurnBeganWhileAssistantSpeaking;
          customerTurnBeganWhileAssistantSpeaking = false;
          if (customerTranscriptDebounceTimer) {
            clearTimeout(customerTranscriptDebounceTimer);
          }
          customerTranscriptDebounceTimer = setTimeout(() => {
            customerTranscriptDebounceTimer = null;
            const completedTranscript = pendingCustomerTranscripts
              .filter(Boolean)
              .join(" ");
            pendingCustomerTranscripts = [];
            const beganWhileAssistantSpeaking =
              pendingTranscriptWasWhileAssistantSpeaking;
            pendingTranscriptWasWhileAssistantSpeaking = false;
            void processCompletedCustomerTranscript(
              completedTranscript,
              beganWhileAssistantSpeaking
            ).catch(
              (error) => {
                console.error("Daisy completed transcript handling failed:", error);
              }
            );
          }, Math.max(
            DAISY_MIN_TRANSCRIPT_SETTLE_MS,
            semanticTurnDelay(event.transcript)
          ));
          return;
        }

        if (event.type === "response.function_call_arguments.done") {
          await handleToolCall(
            event.name,
            event.call_id,
            event.arguments || "{}"
          );
          return;
        }

        if (
          event.type === "response.output_item.done" &&
          event.item &&
          event.item.type === "function_call"
        ) {
          await handleToolCall(
            event.item.name,
            event.item.call_id,
            event.item.arguments || "{}"
          );
          return;
        }

        if (event.type === "response.done") {
          assistantResponseActive = false;
          responseCreatePending = false;
          assistantResponseFinished = true;
          if (!assistantTranscriptSaved && assistantTranscriptBuffer) {
            await appendTranscript(
              call.call_id,
              "assistant",
              assistantTranscriptBuffer
            );
            assistantTranscriptSaved = true;
          }
          if (!questionCapturedForResponse && assistantTranscriptBuffer) {
            await captureAssistantQuestion(assistantTranscriptBuffer);
            questionCapturedForResponse = Boolean(
              extractPrimaryQuestion(assistantTranscriptBuffer)
            );
          }
          for (const item of event.response?.output || []) {
            if (item && item.type === "function_call") {
              await handleToolCall(
                item.name,
                item.call_id,
                item.arguments || "{}"
              );
            }
          }
          activeResponsePreservesQuestion = false;
          lastWaitingPromptKind = activeResponseWaitingPromptKind;
          activeResponseWaitingPromptKind = null;
          if (queuedResponseOptions) {
            const options = queuedResponseOptions;
            queuedResponseOptions = null;
            requestAssistantResponse(options);
          }
          complianceRecoveryActive = false;
          scheduleSilenceReminder();
          void hangupTwilioCallAfterPlayback();
          return;
        }

        if (event.type === "error") {
          const message =
            event.error?.message || event.message || "OpenAI Realtime error";
          console.error(
            `OpenAI Realtime error for ${call.call_id}:`,
            message
          );
          await updateCallStatus(call.call_id, "in-progress", {
            last_error: message
          });
        }
      } catch (error) {
        console.error(
          `OpenAI event handler failed for ${call ? call.call_id : "unknown"}:`,
          error
        );
      }
    });

    openaiSocket.on("error", async (error) => {
      try {
        console.error(
          `OpenAI socket error for ${call.call_id}:`,
          error.message
        );
        await updateCallStatus(call.call_id, "in-progress", {
          last_error: error.message
        });
      } catch (updateError) {
        console.error("Failed to save OpenAI socket error:", updateError);
      }
    });

    openaiSocket.on("close", (code, reason) => {
      console.log(
        `OpenAI socket closed for ${call ? call.call_id : "unknown"}: ${code} ${String(
          reason || ""
        )}`
      );
      if (!closed && twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.close();
      }
    });
  }

  twilioSocket.on("message", async (rawMessage) => {
    try {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch {
        return;
      }

      if (message.event === "start") {
        const parameters = message.start?.customParameters || {};
        const callId = cleanText(parameters.call_id, 100);
        const token = cleanText(parameters.stream_token, 160);

        call = await validateCallToken(callId, token);
        if (!call) {
          twilioSocket.close(1008, "Invalid stream token");
          return;
        }

        streamSid = message.start?.streamSid || message.streamSid;
        await updateCallStatus(call.call_id, "in-progress", {
          twilio_call_sid: message.start?.callSid
        });
        call = await getCallById(call.call_id);
        awaitingCustomerResponse = call.awaiting_customer_response === true;
        pendingQuestionType = call.pending_question_type || null;
        pendingQuestionText = call.pending_question_text || null;
        questionAskedAt = call.question_asked_at
          ? new Date(call.question_asked_at).toISOString()
          : null;
        responseReminderCount = Number(call.response_reminder_count || 0);
        if (awaitingCustomerResponse && pendingQuestionText) {
          suspendedQuestionState = currentQuestionState();
          awaitingCustomerResponse = false;
          pendingQuestionType = null;
          pendingQuestionText = null;
          questionAskedAt = null;
          responseReminderCount = 0;
        }
        connectToOpenAI();
        return;
      }

      if (message.event === "mark") {
        const name = cleanText(message.mark?.name, 100);
        if (name) pendingMarkNames.delete(name);
        if (!pendingMarkNames.size) {
          scheduleSilenceReminder();
          void hangupTwilioCallAfterPlayback();
        }
        return;
      }

      if (message.event === "media") {
        const payload = message.media?.payload;
        latestMediaTimestamp = Number(message.media?.timestamp || 0);
        if (!payload) return;

        if (
          !sendToOpenAI({
            type: "input_audio_buffer.append",
            audio: payload
          })
        ) {
          if (pendingAudio.length < 200) pendingAudio.push(payload);
        }
        return;
      }

      if (message.event === "stop") {
        closed = true;
        cancelSilenceReminder();
        if (customerTranscriptDebounceTimer) {
          clearTimeout(customerTranscriptDebounceTimer);
        }
        if (call) {
          void scheduleUnexpectedReconnect(call.call_id).catch((error) => {
            console.error("Failed to schedule disconnect reconnect:", error);
          });
        }
        if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
          openaiSocket.close();
        }
      }
    } catch (error) {
      console.error("Twilio media message handler failed:", error);
      if (call) {
        try {
          await updateCallStatus(call.call_id, "in-progress", {
            last_error: error.message
          });
        } catch (updateError) {
          console.error("Failed to save Twilio handler error:", updateError);
        }
      }
    }
  });

  twilioSocket.on("close", () => {
    closed = true;
    cancelSilenceReminder();
    if (customerTranscriptDebounceTimer) {
      clearTimeout(customerTranscriptDebounceTimer);
    }
    if (sustainedSpeechTimer) clearTimeout(sustainedSpeechTimer);
    if (call) {
      void scheduleUnexpectedReconnect(call.call_id).catch((error) => {
        console.error("Failed to schedule disconnect reconnect:", error);
      });
    }
    if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
      openaiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("Twilio media socket error:", error.message);
  });
});

server.on("upgrade", (request, socket, head) => {
  try {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    if (requestUrl.pathname !== "/api/v1/twilio/media") {
      socket.destroy();
      return;
    }

    mediaServer.handleUpgrade(request, socket, head, (websocket) => {
      mediaServer.emit("connection", websocket, request);
    });
  } catch {
    socket.destroy();
  }
});

function logSchedulingDecision(call, attempt, decision, reason, currentTime = new Date()) {
  console.log(JSON.stringify({
    event: "scheduler_decision",
    sequence_id: call?.call_id || null,
    attempt_id: attempt?.attempt_id || null,
    attempt_type: attempt?.attempt_type || null,
    scheduled_at: attempt?.scheduled_at || call?.next_attempt_at || null,
    current_time: currentTime.toISOString(),
    stored_timezone: call?.timezone || null,
    sequence_status: call?.sequence_status || null,
    attempt_status: attempt?.technical_status || null,
    decision,
    reason
  }));
}

async function runScheduler() {
  if (!CALL_SCHEDULER_ENABLED || schedulerRunning) return;
  schedulerRunning = true;

  try {
    await reconcileScheduledAttempts();
    const due = await pool.query(
      `
        SELECT ca.attempt_id, ca.call_id
        FROM call_attempts ca
        JOIN ai_calls ac ON ac.call_id = ca.call_id
        WHERE
          ac.sequence_status IN (
            'ready',
            'active',
            'scheduled',
            'waiting_retry',
            'callback_scheduled'
          )
          AND ca.technical_status IN ('pending', 'scheduled', 'created')
          AND ca.completed_at IS NULL
          AND ca.scheduled_at IS NOT NULL
          AND ca.scheduled_at <= NOW()
          AND (ca.attempt_type <> 'cadence' OR ac.attempts < ac.max_attempts)
        ORDER BY ca.scheduled_at ASC
        LIMIT 10
      `
    );

    for (const row of due.rows) {
      try {
        const call = await getCallById(row.call_id);
        const attempt = await getAttemptById(row.attempt_id);
        const currentTime = new Date();
        if (!call || !attempt || !pendingAttemptStatus(attempt.technical_status)) {
          logSchedulingDecision(call, attempt, "skip", "attempt_missing_or_already_claimed", currentTime);
          continue;
        }

        if (call.do_not_call || call.wrong_number || call.invalid_number) {
          logSchedulingDecision(call, attempt, "skip", "contact_suppressed", currentTime);
          continue;
        }
        if (ENFORCE_CALL_CONSENT && call.consent_status !== "confirmed") {
          logSchedulingDecision(call, attempt, "skip", "consent_not_confirmed", currentTime);
          continue;
        }

        if (!insideOperatingWindow(currentTime, call.timezone || DEFAULT_TIMEZONE)) {
          const nextAttemptAt = nextValidWindow(
            call.timezone || DEFAULT_TIMEZONE,
            currentTime,
            DOUG_CONFIG.preferredWindows.morning,
            0
          );

          await pool.query(
            `
              UPDATE call_attempts SET scheduled_at = $2, updated_at = NOW()
              WHERE attempt_id = $1 AND technical_status IN ('pending', 'scheduled', 'created')
            `,
            [attempt.attempt_id, nextAttemptAt]
          );
          await pool.query(
            `UPDATE ai_calls SET sequence_status = 'scheduled', next_attempt_at = $2,
             updated_at = NOW() WHERE call_id = $1`,
            [call.call_id, nextAttemptAt]
          );
          logSchedulingDecision(call, attempt, "defer", "outside_operating_window", currentTime);
          queueMondaySync(call.call_id, "scheduler_rescheduled_window");
          continue;
        }

        await pool.query(
          `
            UPDATE ai_calls
            SET
              stream_token = $2,
              status = 'created',
              twilio_call_sid = NULL,
              completed_at = NULL,
              updated_at = NOW()
            WHERE call_id = $1
          `,
          [call.call_id, createStreamToken()]
        );

        const refreshed = await getCallById(call.call_id);
        logSchedulingDecision(refreshed, attempt, "dispatch", "due_attempt_dispatched_immediately", currentTime);
        await placeTwilioCall(refreshed, { attemptId: attempt.attempt_id });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409) {
          const call = await getCallById(row.call_id);
          const attempt = await getAttemptById(row.attempt_id);
          logSchedulingDecision(call, attempt, "skip", "concurrent_worker_already_claimed");
          continue;
        }
        console.error(`Scheduler failed for ${row.call_id}:`, error.message);

        await pool.query(
          `
            UPDATE ai_calls
            SET
              sequence_status = 'waiting_retry',
              next_attempt_at = NOW() + INTERVAL '15 minutes',
              last_error = $2,
              updated_at = NOW()
            WHERE call_id = $1
          `,
          [row.call_id, cleanText(error.message, 4000)]
        );

        await pool.query(
          `UPDATE call_attempts SET technical_status = 'pending',
           scheduled_at = NOW() + INTERVAL '15 minutes', completed_at = NULL,
           updated_at = NOW() WHERE attempt_id = $1 AND completed_at IS NULL`,
          [row.attempt_id]
        );

        queueMondaySync(row.call_id, "scheduler_failure");
      }
    }
  } catch (error) {
    console.error("HELUX call scheduler failed:", error);
  } finally {
    schedulerRunning = false;
  }
}

app.use((error, req, res, next) => {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;

  if (statusCode >= 500) {
    console.error("HELUX AI Workforce request failed:", error);
  }

  if (res.headersSent) {
    return next(error);
  }

  res.status(statusCode).json({
    success: false,
    error: statusCode >= 500 ? "Internal server error." : error.message
  });
});

async function start() {
  try {
    await initializeDatabase();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`HELUX AI Workforce running on port ${PORT}`);
      console.log(`Agent version: ${DOUG_CONFIG.agentVersion}`);
      console.log(`Realtime model: ${OPENAI_REALTIME_MODEL}`);
      console.log(`Voice: ${OPENAI_VOICE}`);
      console.log(`Cadence: ${DOUG_CONFIG.cadenceVersion}`);
      console.log(
        `Call scheduler: ${CALL_SCHEDULER_ENABLED ? "enabled" : "disabled"}`
      );
      console.log(
        `Consent enforcement: ${ENFORCE_CALL_CONSENT ? "enabled" : "disabled"}`
      );
      console.log(
        `monday.com sync: ${MONDAY_SYNC_ENABLED ? "enabled" : "disabled"}`
      );
      console.log(
        `monday.com inbound controls: ${
          MONDAY_INBOUND_SYNC_ENABLED ? "enabled" : "disabled"
        }`
      );
      if (MONDAY_SYNC_REQUESTED && !MONDAY_SYNC_ENABLED) {
        console.warn(
          "monday.com sync was requested but MONDAY_API_TOKEN, MONDAY_BOARD_ID, or MONDAY_SUBITEM_BOARD_ID is missing. The caller remains online."
        );
      }
    });

    if (CALL_SCHEDULER_ENABLED) {
      schedulerTimer = setInterval(() => {
        void runScheduler();
      }, SCHEDULER_INTERVAL_MS);
      void runScheduler();
    }

    if (MONDAY_SYNC_ENABLED) {
      void loadMondayMetadata({ force: true })
        .then(async (metadata) => {
          console.log(
            `monday.com connected: ${metadata.main.name} (${metadata.main.id})`
          );

          if (MONDAY_INBOUND_SYNC_ENABLED) {
            try {
              const webhookIds = await ensureMondayInboundWebhooks();
              console.log(
                `monday.com inbound controls connected: ${webhookIds.join(", ")}`
              );
            } catch (error) {
              console.error(
                "monday.com inbound controls could not be registered. Outbound sync and calling remain online:",
                error.message
              );
            }
          }
        })
        .catch((error) => {
          console.error(
            "monday.com metadata warm-up failed. The caller remains online:",
            error.message
          );
        });
    }
  } catch (error) {
    console.error("HELUX AI Workforce failed to start:", error);
    process.exit(1);
  }
}

async function shutdown() {
  console.log("HELUX AI Workforce shutting down.");

  if (schedulerTimer) clearInterval(schedulerTimer);
  for (const timer of mondaySyncTimers.values()) clearTimeout(timer);
  mondaySyncTimers.clear();

  server.close(async () => {
    await Promise.allSettled([...mondaySyncChains.values()]);
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

start();
