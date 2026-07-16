const express = require("express");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const { Pool } = require("pg");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const {
  REALTIME_TOOLS: BASE_REALTIME_TOOLS
} = require("./src/intents/intent-types");
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
const OUTBOUND_CALLS_ENABLED =
  String(
    process.env.OUTBOUND_CALLS_ENABLED || "false"
  ).toLowerCase() === "true";
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

function normalizeExplicitYesNo(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const negativePatterns = [
    /\bno\b/,
    /\bnope\b/,
    /\bnot yet\b/,
    /\bdon't\b/,
    /\bdo not\b/,
    /\bi don't have\b/,
    /\bi do not have\b/,
    /\bnot working with\b/,
    /\bwithout a lender\b/,
    /\bwithout a realtor\b/,
    /\bneed a lender\b/,
    /\bneed a realtor\b/
  ];
  if (negativePatterns.some((pattern) => pattern.test(normalized))) return false;

  const positivePatterns = [
    /\byes\b/,
    /\byeah\b/,
    /\byep\b/,
    /\byup\b/,
    /\bcorrect\b/,
    /\babsolutely\b/,
    /\bi do\b/,
    /\bi have one\b/,
    /\bi already have one\b/,
    /\bi'm working with\b/,
    /\bi am working with\b/
  ];
  if (positivePatterns.some((pattern) => pattern.test(normalized))) return true;
  return null;
}
function normalizeApplicationStartedAnswer(value) {
  const explicitAnswer = normalizeExplicitYesNo(value);
  if (explicitAnswer !== null) return explicitAnswer;

  const normalized = normalizeCustomerUtterance(value);

  const negativePatterns = [
    /\bi haven'?t\b/,
    /\bi have not\b/,
    /\bi didn'?t\b/,
    /\bi did not\b/,
    /\bnot started\b/,
    /\bhaven'?t started\b/,
    /\bdidn'?t get to it\b/,
    /\bstill need to\b/
  ];

  if (negativePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const positivePatterns = [
    /\bi did\b/,
    /\bi have\b/,
    /\bi started\b/,
    /\balready started\b/,
    /\bstarted it\b/,
    /\bi began\b/,
    /\bcompleted it\b/,
    /\bsubmitted it\b/,
    /\bfilled it out\b/
  ];

  if (positivePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return null;
}
function wholeNumberToWords(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isSafeInteger(number) || number < 0) return null;
  if (number === 0) return "zero";
  const ones = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen"
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety"
  ];
  const underThousand = (amount) => {
    const parts = [];
    if (amount >= 100) {
      parts.push(`${ones[Math.floor(amount / 100)]} hundred`);
      amount %= 100;
    }
    if (amount >= 20) {
      parts.push(tens[Math.floor(amount / 10)]);
      amount %= 10;
    }
    if (amount > 0) parts.push(ones[amount]);
    return parts.join(" ");
  };
  const scales = [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"]
  ];
  let remaining = number;
  const words = [];
  for (const [scale, label] of scales) {
    if (remaining >= scale) {
      words.push(`${underThousand(Math.floor(remaining / scale))} ${label}`);
      remaining %= scale;
    }
  }
  if (remaining > 0) words.push(underThousand(remaining));
  return words.join(" ");
}

function formatIncomeForDaisy(value) {
  const numeric = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return cleanText(value, 160);
  const wholeDollars = Math.round(numeric);
  const words = wholeNumberToWords(wholeDollars);
  const display = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(wholeDollars);
  return words ? `${words} dollars (${display})` : display;
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
  for (const key of ["has_realtor", "applied_with_lender", "has_lender"]) {
    if (!Object.prototype.hasOwnProperty.call(answers, key)) continue;
    const normalized = normalizeExplicitYesNo(answers[key]);
    if (normalized === null) delete answers[key];
    else answers[key] = normalized ? "Yes" : "No";
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
- Never narrate internal thinking, planning, tool execution, retries, calculations, or next-step selection. Never say "Okay, let's line up your next step," "Let's line up your next step," "Let me line that up," "Okay, let me line up the next step," "let me think," "let me figure that out," "one moment," or similar filler.
- After a customer answers, transition directly to the next scripted sentence.
- Do not fill tool-execution time with narration.
- If a tool fails, do not narrate a retry.
- Never discuss or quote interest rates.
- Never guarantee approval, eligibility, a program, an assistance amount, a closing date, or a home price.
- DTI and homebuying power are preliminary estimates only.
- Read income and dollar amounts as natural currency. Never read a multi-digit dollar amount one digit at a time.
- Daisy cannot offer, send, or claim to have sent text messages.
- Do not ask for SMS consent.
- Do not call or mention send_resource_link.
- After a confirmed callback, proceed directly to the closing.
- Never claim a callback, handoff, or other action succeeded until the tool confirms success.
- Before ending a connected call, save the outcome, confirm the next step, use complete_call, give one brief closing, and end normally.

When the current call has no remaining question or action:
- Use complete_call.
- After the tool succeeds, say exactly: "If there's nothing else, thank you for your time, {customer_name}. Have a great day."
- Allow the full closing audio to play.
- The server controls the physical hangup.
- Do not decide whether the telephone line should remain connected.
- Do not continue after the final closing.
- Disconnect the telephone line.
- Do not wait silently on the line.
- Do not restart the conversation.
- Do not trigger reconnect.

- A normal goodbye is not an unexpected disconnect.

Runtime mode: {call_mode}
Customer: {customer_name}
Estimated assistance: {estimated_dpa}
Submitted credit score:  {credit_score_submitted}
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
"Excellent. Based on your submitted credit score of (credit_score_submitted}, income of {income_submitted}, your work history of {work_history_submitted}, and your tax-return information of {tax_return_submitted}, reviewing down payment assistance options should be in your favor. Is all of that information correct?"

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

After collecting the date, time, and timezone, Daisy asks:
"Excellent. I'll call you on {callback_date} at {callback_time} in your time zone. Is that correct?"

WAIT.

After confirmation, Daisy says:
"Excellent. I have us scheduled to speak on {callback_date} at {callback_time} in your time zone."

Then:
- Use schedule_callback with reason "Customer requested a better time."

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

Save the customer's exact meaningful answer as purchase_area without changing its spelling or location. Never infer it from lead city, ZIP code, intake data, Monday.com, another lead, or a nearby city. If the answer is unclear, ask exactly: "What city or area would you like to purchase in?" Do not guess.

SCHEDULE CALL TWO

Daisy says:
"{purchase_area_closing}"

Daisy says:
"Your next step is to start the application so I can follow up with you about its status, review your debt-to-income ratio, and explore potential program options."

Daisy asks:
"{customer_name}, do you think you'll have time to start the application today?"

WAIT.

IF THE CUSTOMER SAYS YES

Daisy asks:
"Excellent. What time zone are you in, and what time tomorrow would be best for our second call?"

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

After confirmation, Daisy says:
"Excellent. I have us scheduled to speak on {callback_date} at {callback_time} in your time zone."

Then use schedule_callback with:
- reason: "Application checkpoint"
- prospect_confirmed: true
- the correct callback_at
- the correct timezone

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
"No worries."

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

Repeat and confirm the appointment.

Daisy says:
"Excellent. I have us scheduled to speak on {callback_date} at {callback_time} in your time zone."

Then use schedule_callback with reason:
"Application checkpoint"

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

function resolveSessionCallPhase(call, attempt = null) {
  const callType = normalizeMondayKey(call?.payload?.call_type);
  const outboundReason = normalizeMondayKey(
    call?.result?.outbound_call_reason || call?.payload?.outbound_call_reason
  );
  const attemptType = normalizeMondayKey(attempt?.attempt_type);
  const scheduledPurpose = normalizeMondayKey(
    call?.result?.scheduled_second_call_purpose
  );

  if (
    callType === "dpaagentnotification" ||
    attemptType === "specialistnotification"
  ) return "SPECIALIST_NOTIFICATION";
  if (
    outboundReason === "unexpecteddisconnectreconnect" ||
    attemptType === "disconnectreconnect" ||
    call?.result?.reconnect_source_call_id
  ) return "RECONNECT";
  if (
    callType === "calltwo" ||
    outboundReason === "calltwo" ||
    attemptType === "applicationcheckpoint" ||
    scheduledPurpose === "applicationcheckpoint"
  ) return "CALL_TWO";
  return "CALL_ONE";
}

function buildDouglasDaisyInstructions(call, sessionCallPhase) {
  const lead = call.payload || {};
  const result = normalizeDaisyAnswers(call.result || {});
  const confirmedPurchaseArea = cleanText(result.purchase_area, 1000);
  const callMode = {
    CALL_ONE: "CALL ONE",
    CALL_TWO: "CALL TWO",
    RECONNECT: "RECONNECT",
    SPECIALIST_NOTIFICATION: "INTERNAL SPECIALIST NOTIFICATION"
  }[sessionCallPhase] || "CALL ONE";

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
credit_score_submitted:
  cleanText(
    lead.credit_score ??
      lead.mid_fico ??
      lead.fico_score ??
      lead.fico,
    50
  ) || "not provided",
income_submitted:
  formatIncomeForDaisy(lead.household_income ?? lead.income) ||
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
      confirmedPurchaseArea || "not provided",
   purchase_area_closing: confirmedPurchaseArea
  ? `Well, that's everything for this call, and now you're one step closer to becoming a homeowner in ${confirmedPurchaseArea}.`
  : "Well, that's everything for this call, and now you're one step closer to becoming a homeowner.",
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
        customer_local_date: {
          type: "string",
          description: "Customer-confirmed local date or relative date phrase."
        },
        customer_local_time: {
          type: "string",
          description: "Customer-confirmed local time."
        },
        application_local_date: {
          type: "string",
          description: "Stated application date when the callback is the following day."
        },
        timezone: { type: "string" },
        reason: { type: "string" },
        primary_concern: { type: "string" },
        hold_reason: { type: "string" },
        discussion_summary: { type: "string" },
        preferred_contact_method: {
          type: "string",
          enum: ["phone", "email"]
        },
        prospect_confirmed: { type: "boolean" }
      },
      required: [reason],
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

const LOCAL_SCHEDULE_CALLBACK_TOOL = DOUG_TOOLS.find(
  (toolDefinition) => toolDefinition.name === "schedule_callback"
);
const REALTIME_TOOLS = Object.freeze(
  BASE_REALTIME_TOOLS
    .filter((toolDefinition) => toolDefinition.name !== "send_resource_link")
    .map((toolDefinition) =>
    toolDefinition.name === "schedule_callback"
      ? {
          ...toolDefinition,
          parameters: {
            ...LOCAL_SCHEDULE_CALLBACK_TOOL.parameters,
            properties: {
              ...LOCAL_SCHEDULE_CALLBACK_TOOL.parameters.properties
            }
          }
        }
      : toolDefinition
    )
);

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

const PERMITTED_OUTBOUND_CALL_REASONS = Object.freeze([
  "initial_lead_call",
  "scheduled_second_call",
  "unexpected_disconnect_reconnect"
]);

function permittedOutboundCallReason(value) {
  return PERMITTED_OUTBOUND_CALL_REASONS.includes(
    String(value || "").trim()
  );
}

function internalNotificationCallReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  return [
    "dpa_agent_notification",
    "specialist_notification",
    "department_notification",
    "internal_notification"
  ].includes(reason) || (
    reason.endsWith("_notification") &&
    /(?:dpa|agent|specialist|department|internal)/.test(reason)
  );
}

function resolveOutboundCallReason(call, attempt, options = {}) {
  const explicitReason = cleanText(
    options.callReason ||
      call?.result?.outbound_call_reason ||
      call?.payload?.outbound_call_reason,
    100
  );
  if (explicitReason) return explicitReason;
  const notificationReason =
    call?.payload?.call_type || attempt?.attempt_type;
  if (internalNotificationCallReason(notificationReason)) {
    return String(notificationReason).trim().toLowerCase();
  }
  return null;
}

function outboundLeadId(call) {
  return cleanText(
    call?.lead_id || call?.payload?.lead_id || call?.case_id || call?.request_key,
    320
  );
}

function logOutboundCallRejected(call, resolvedCallReason, rejectionReason) {
  console.log(JSON.stringify({
    event: "outbound_call_rejected",
    call_id: call?.call_id || null,
    lead_id: outboundLeadId(call),
    call_reason: resolvedCallReason || null,
    reason: rejectionReason
  }));
}

function logOutboundCallFinalEligibility(call, resolvedCallReason) {
  console.log(JSON.stringify({
    event: "outbound_call_final_eligibility",
    call_id: call.call_id,
    lead_id: outboundLeadId(call),
    call_reason: resolvedCallReason,
    callback_at: call.callback_at || null,
    reconnect_source_call_id:
      call.result?.reconnect_source_call_id || null,
    eligible: true
  }));
}

function callHasSuccessfulCompleteCall(call, attempt = null) {
  const actions = Array.isArray(attempt?.actions)
    ? attempt.actions
    : Array.isArray(call?.actions)
      ? call.actions
      : [];
  return Boolean(
    actions.some(
      (action) =>
        action?.action === "complete_call" && action?.success === true
    ) ||
      call?.result?.normal_completion_recorded === true ||
      call?.result?.completion_reason === "normal_completion"
  );
}

function outboundCallSource(attempt, requestedSource) {
  if (requestedSource) return requestedSource;
  if (attempt?.attempt_type === "disconnect_reconnect") {
    return "unexpected_reconnect";
  }
  if (
    ["customer_callback", "application_checkpoint"].includes(
      attempt?.attempt_type
    )
  ) {
    return "callback";
  }
  return "scheduler";
}

function outboundCallDueAt(call, resolvedCallReason) {
  if (resolvedCallReason === "initial_lead_call") {
    return call?.next_attempt_at || null;
  }
  if (
    ["scheduled_second_call", "unexpected_disconnect_reconnect"].includes(
      resolvedCallReason
    )
  ) {
    return call?.callback_at || null;
  }
  return null;
}

function legitimateScheduledAppointment(call, attempt, resolvedCallReason) {
  if (
    resolvedCallReason !== "scheduled_second_call" ||
    !["customer_callback", "application_checkpoint"].includes(
      attempt?.attempt_type
    ) ||
    call?.callback_requested !== true ||
    !call?.result?.scheduled_second_call_appointment_id ||
    !call?.result?.scheduled_second_call_source_call_id ||
    call?.result?.scheduled_second_call_dialed_at
  ) {
    return false;
  }
  const callbackAt = call.callback_at ? new Date(call.callback_at) : null;
  const scheduledAt = attempt?.scheduled_at
    ? new Date(attempt.scheduled_at)
    : null;
  return Boolean(
    callbackAt &&
      scheduledAt &&
      !Number.isNaN(callbackAt.getTime()) &&
      !Number.isNaN(scheduledAt.getTime()) &&
      callbackAt.getTime() === scheduledAt.getTime() &&
      attempt.attempt_id !== call.last_attempt_id
  );
}

function outboundCallEligibility(
  call,
  attempt,
  resolvedCallReason,
  currentTime = new Date()
) {
  const dueAtValue = outboundCallDueAt(call, resolvedCallReason);
  const dueAt = dueAtValue ? new Date(dueAtValue) : null;
  const attemptDueAt = attempt?.scheduled_at
    ? new Date(attempt.scheduled_at)
    : null;
  const scheduledAppointment = legitimateScheduledAppointment(
    call,
    attempt,
    resolvedCallReason
  );
  const status = String(call?.status || "").toLowerCase();
  const sequenceStatus = String(call?.sequence_status || "").toLowerCase();
  const activeStatuses = [
    "placing",
    "queued",
    "initiated",
    "ringing",
    "answered",
    "in-progress"
  ];

  let reason = "eligible_due_call";
  if (!call) reason = "call_missing";
  else if (!attempt) reason = "attempt_missing";
  else if (internalNotificationCallReason(resolvedCallReason)) {
    reason = "specialist_notification_phone_calls_disabled";
  } else if (!permittedOutboundCallReason(resolvedCallReason)) {
    reason = "missing_permitted_call_reason";
  } else if (
    resolvedCallReason === "initial_lead_call" &&
    attempt.attempt_type !== "initial_lead_call"
  ) {
    reason = "missing_permitted_call_reason";
  } else if (
    resolvedCallReason === "scheduled_second_call" &&
    !["customer_callback", "application_checkpoint"].includes(
      attempt.attempt_type
    )
  ) {
    reason = "missing_permitted_call_reason";
  } else if (
    resolvedCallReason === "unexpected_disconnect_reconnect" &&
    attempt.attempt_type !== "disconnect_reconnect"
  ) {
    reason = "missing_permitted_call_reason";
  } else if (!pendingAttemptStatus(attempt.technical_status)) {
    reason = "attempt_already_claimed_or_cancelled";
  } else if (
    resolvedCallReason === "initial_lead_call" &&
    (Number(call.attempts || 0) > 0 ||
      call.last_attempt_id ||
      call.result?.initial_call_claimed_at)
  ) {
    reason = "initial_call_already_exists";
  } else if (
    resolvedCallReason === "scheduled_second_call" &&
    call.result?.scheduled_second_call_dialed_at
  ) {
    reason = "scheduled_second_call_already_dialed";
  } else if (
    resolvedCallReason === "scheduled_second_call" &&
    !scheduledAppointment
  ) {
    reason = "invalid_callback_date";
  } else if (
    resolvedCallReason === "unexpected_disconnect_reconnect" &&
    call.result?.unexpected_disconnect_reconnect_attempted === true
  ) {
    reason = "reconnect_already_attempted";
  } else if (
    resolvedCallReason === "unexpected_disconnect_reconnect" &&
    (
      call.result?.unexpected_disconnect_reconnect_scheduled !== true ||
      !call.result?.reconnect_source_call_id ||
      !call.result?.reconnect_source_twilio_call_sid
    )
  ) {
    reason = "normal_completion_not_reconnectable";
  } else if (
    callHasSuccessfulCompleteCall(call, attempt) &&
    !scheduledAppointment
  ) {
    reason = "complete_call_already_succeeded";
  } else if (
    (status === "completed" || sequenceStatus === "completed") &&
    !scheduledAppointment
  ) {
    reason = "completed_call";
  } else if (["canceled", "cancelled"].includes(status)) {
    reason = "call_cancelled";
  } else if (call.do_not_call) reason = "do_not_call";
  else if (call.wrong_number || call.invalid_number) {
    reason = "contact_suppressed";
  } else if (sequenceStatus === "paused") reason = "manual_hold";
  else if (["suppressed", "exhausted", "human_action"].includes(sequenceStatus)) {
    reason = "sequence_not_callable";
  } else if (activeStatuses.includes(status) || sequenceStatus === "calling") {
    reason = "call_already_dialing_or_connected";
  } else if (
    call.twilio_call_sid &&
    !["busy", "failed", "no-answer", "completed"].includes(status)
  ) {
    reason = "active_twilio_call_exists";
  } else if (!dueAtValue) {
    reason = resolvedCallReason === "scheduled_second_call"
      ? "invalid_callback_date"
      : "due_timestamp_missing";
  } else if (!dueAt || Number.isNaN(dueAt.getTime())) {
    reason = resolvedCallReason === "scheduled_second_call"
      ? "invalid_callback_date"
      : "due_timestamp_invalid";
  } else if (dueAt > currentTime) {
    reason = resolvedCallReason === "scheduled_second_call"
      ? "callback_not_due"
      : "call_not_due_yet";
  } else if (!attempt?.scheduled_at) reason = "attempt_due_timestamp_missing";
  else if (!attemptDueAt || Number.isNaN(attemptDueAt.getTime())) {
    reason = "attempt_due_timestamp_invalid";
  } else if (attemptDueAt > currentTime) reason = "attempt_not_due_yet";

  return {
    eligible: reason === "eligible_due_call",
    reason,
    dueAt: dueAt && !Number.isNaN(dueAt.getTime())
      ? dueAt.toISOString()
      : cleanText(dueAtValue, 100),
    scheduledAppointment
  };
}

function logOutboundCallEligibility(call, attempt, source, eligibility) {
  console.log(JSON.stringify({
    event: "outbound_call_eligibility",
    call_id: call?.call_id || null,
    source,
    due_at: eligibility?.dueAt || null,
    eligible: eligibility?.eligible === true,
    reason: eligibility?.reason || "unknown"
  }));
}

function blockDisabledOutboundCall(call, source, dueAt = null) {
  console.log(JSON.stringify({
    event: "outbound_call_blocked",
    call_id: call?.call_id || null,
    reason: "OUTBOUND_CALLS_ENABLED_is_false"
  }));
  logOutboundCallEligibility(call, null, source, {
    dueAt: dueAt ? cleanText(dueAt, 100) : null,
    eligible: false,
    reason: "OUTBOUND_CALLS_ENABLED_is_false"
  });
}

function attemptTypeForCall(call, requestedType = null) {
  if (requestedType) return requestedType;
  const outboundReason = resolveOutboundCallReason(call, null);
  if (outboundReason === "initial_lead_call") {
    return "initial_lead_call";
  }
  if (outboundReason === "scheduled_second_call") {
    return call.current_state === "application_checkpoint"
      ? "application_checkpoint"
      : "customer_callback";
  }
  if (outboundReason === "unexpected_disconnect_reconnect") {
    return "disconnect_reconnect";
  }
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
       AND COALESCE(
         result->>'outbound_call_reason',
         payload->>'outbound_call_reason',
         ''
       ) IN (
         'initial_lead_call',
         'scheduled_second_call',
         'unexpected_disconnect_reconnect'
       )
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
        SELECT DISTINCT ON (ca.call_id) ca.call_id, ca.attempt_id
        FROM call_attempts ca
        JOIN ai_calls ac ON ac.call_id = ca.call_id
        WHERE ca.attempt_type = 'cadence' AND ca.completed_at IS NULL
          AND ca.technical_status IN ('pending', 'scheduled', 'created')
          AND ac.status <> 'completed'
          AND ac.sequence_status <> 'completed'
          AND COALESCE(ac.result->>'normal_completion_recorded', 'false') <> 'true'
          AND COALESCE(ac.result->>'completion_reason', '') <> 'normal_completion'
        ORDER BY ca.call_id, ca.scheduled_at ASC NULLS FIRST, ca.id ASC
      ), made_due AS (
        UPDATE call_attempts ca
        SET scheduled_at = NOW(), updated_at = NOW()
        FROM earliest
        WHERE ca.attempt_id = earliest.attempt_id AND ca.scheduled_at < NOW()
        RETURNING ca.call_id, ca.scheduled_at
      )
      UPDATE ai_calls ac
      SET next_attempt_at = made_due.scheduled_at,
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
  if (/what.*(?:city|area).*purchase|area.*purchase.*home/.test(text)) {
    return "purchase_area";
  }
  if (
  /didyouhaveachancetostarttheapplication/.test(text) ||
  /haveyoustartedtheapplication/.test(text) ||
  /didyoustarttheapplication/.test(text)
) {
  return "application_started";
}

if (
  /thinkyoullhavetimetostarttheapplication/.test(text) ||
  /havetimetostarttheapplicationtoday/.test(text) ||
  /plantostarttheapplicationtoday/.test(text)
) {
  return "application_start_plan";
}
  if (/send.*link|text.*link|want.*link|receive.*link/.test(text)) {
    return "application_link_permission";
  }
  if (
  /scheduledtospeakon.*isthatcorrect/.test(text) ||
  /call.*on.*at.*isthatcorrect/.test(text)
) {
  return "callback_confirmation";
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

function exactMeaningfulPurchaseArea(value) {
  const area = cleanText(value, 1000);
  if (!area) return null;
  if (
    /\b(i don'?t know|not sure|unsure|anywhere|no preference|whatever|doesn'?t matter)\b/i.test(
      area
    )
  ) {
    return null;
  }
  return cleanText(area.replace(/[.!?]+$/, ""), 1000);
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

function mondayStatusLabels(column) {
  const settings = parseMondaySettings(column?.settings);
  return Array.isArray(settings.labels)
    ? settings.labels
    : Object.entries(settings.labels || {}).map(([id, label]) => ({
        id,
        label: typeof label === "object" ? label?.label || label?.name : label
      }));
}

function timeFrameMeaning(value) {
  const normalized = normalizeMondayKey(value);
  if (!normalized) return null;
  if (/justlooking|lookingonly/.test(normalized)) {
    return { normalized, category: "just_looking", months: null };
  }
  if (/notsure|unsure|dontknow|donotknow/.test(normalized)) {
    return { normalized, category: "not_sure", months: null };
  }
  if (/3060/.test(normalized)) {
    return { normalized, category: "timeframe", months: 2 };
  }
  if (/6090/.test(normalized)) {
    return { normalized, category: "timeframe", months: 3 };
  }
  const wordMonths = [
    [/(?:two|2)months?/, 2],
    [/(?:four|4)months?/, 4],
    [/(?:six|6)months?/, 6],
    [/(?:one|1)year|(?:twelve|12)months?/, 12]
  ];
  const matched = wordMonths.find(([pattern]) => pattern.test(normalized));
  if (matched) {
    return { normalized, category: "timeframe", months: matched[1] };
  }
  return null;
}

function mondayTimeFrameValue(column, customerAnswer, callId) {
  const answerMeaning = timeFrameMeaning(customerAnswer);
  const labels = mondayStatusLabels(column);
  let best = null;

  if (answerMeaning) {
    for (const label of labels) {
      const labelText = cleanText(label.label, 160);
      const labelMeaning = timeFrameMeaning(labelText);
      if (!labelText || !labelMeaning) continue;
      let score = 0;
      if (normalizeMondayKey(labelText) === answerMeaning.normalized) score = 100;
      else if (
        answerMeaning.category !== "timeframe" &&
        answerMeaning.category === labelMeaning.category
      ) score = 95;
      else if (
        answerMeaning.months !== null &&
        answerMeaning.months === labelMeaning.months
      ) score = 90;
      else if (
        answerMeaning.months !== null &&
        labelMeaning.months !== null &&
        /within/.test(normalizeMondayKey(labelText)) &&
        answerMeaning.months <= labelMeaning.months
      ) score = Math.max(60, 80 - (labelMeaning.months - answerMeaning.months));
      if (score > (best?.score || 0)) best = { ...label, label: labelText, score };
    }
  }

  const success = Boolean(best && best.score >= 60);
  console.log(JSON.stringify({
    event: "monday_time_frame_mapping",
    call_id: callId,
    customer_answer: cleanText(customerAnswer, 160),
    normalized_answer: answerMeaning?.normalized || null,
    matched_label: success ? best.label : null,
    matched_index: success ? String(best.id) : null,
    success
  }));
  return success ? { index: Number(best.id) } : null;
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

function terminalCompletionValidation(call, sessionCallPhase) {
  const result = normalizeDaisyAnswers(call.result || {});
  const lender = normalizeExplicitYesNo(
    result.applied_with_lender ?? result.has_lender
  );
  const realtor = normalizeExplicitYesNo(result.has_realtor);
  const missing = [];

  if (sessionCallPhase === "CALL_ONE") {
    if (!cleanText(result.purchase_timeline_detail || result.time_frame, 220)) {
      missing.push("timeline");
    }
    if (lender === null) missing.push("lender");
    if (realtor === null) missing.push("realtor");
    if (!cleanText(result.purchase_area, 220)) missing.push("purchase area");
    if (!cleanText(result.callback_local_date, 100)) missing.push("callback date");
    if (!cleanText(result.callback_local_time, 100)) missing.push("callback time");
    if (!cleanText(result.callback_timezone || call.callback_timezone, 100)) {
      missing.push("callback timezone");
    }
  } else if (sessionCallPhase === "CALL_TWO") {
    if (
      result.application_status_explicitly_answered !== true ||
      typeof result.application_started_confirmed !== "boolean"
    ) missing.push("application started");
    if (lender === null) missing.push("lender");
    if (realtor === null) missing.push("realtor");
    if (!cleanText(call.next_action || result.conversation_state?.next_best_action, 220)) {
      missing.push("next step");
    }
  }

  return { complete: missing.length === 0, missing, lender, realtor };
}

function buildStructuredMondayCallSummary(call, sessionCallPhase) {
  const result = normalizeDaisyAnswers(call.result || {});
  const validation = terminalCompletionValidation(call, sessionCallPhase);
  const actions = Array.isArray(call.actions) ? call.actions : [];
  const terminalRecorded =
    actions.some((action) =>
      ["complete_call", "schedule_callback"].includes(action?.action) &&
      action?.success === true
    ) || call.result?.normal_completion_recorded === true;
  const completed = terminalRecorded && validation.complete;

  if (sessionCallPhase === "CALL_TWO") {
    const dti = Number.isFinite(Number(result.preliminary_dti_percent))
      ? `${Number(result.preliminary_dti_percent)}%`
      : "Not completed";
    const nextStep = cleanText(
      call.next_action || result.conversation_state?.next_best_action,
      220
    ) || "Not confirmed";
    return cleanText(
      `Call Two ${completed ? "completed" : "incomplete"}. ` +
      `Application started: ${typeof result.application_started_confirmed === "boolean" ? (result.application_started_confirmed ? "Yes" : "No") : "Not confirmed"}. ` +
      `Preliminary DTI: ${dti}. ` +
      `Lender needed: ${validation.lender === null ? "Not confirmed" : (validation.lender ? "No" : "Yes")}. ` +
      `Realtor needed: ${validation.realtor === null ? "Not confirmed" : (validation.realtor ? "No" : "Yes")}. ` +
      `Next step: ${nextStep}.`,
      800
    );
  }

  const timeline = cleanText(
    result.purchase_timeline_detail || result.time_frame,
    220
  ) || "Not confirmed";
  const purchaseArea = cleanText(result.purchase_area, 220) || "Not confirmed";
  const secondCall = call.callback_at
    ? formatCustomerCallbackTime(
        call.callback_at,
        result.callback_timezone || call.callback_timezone || call.timezone
      )
    : null;
  return cleanText(
    `Call One ${completed ? "completed" : "incomplete"}. ` +
    `Timeline: ${timeline}. ` +
    `Lender: ${validation.lender === null ? "Not confirmed" : (validation.lender ? "Yes" : "No")}. ` +
    `Realtor: ${validation.realtor === null ? "Not confirmed" : (validation.realtor ? "Yes" : "No")}. ` +
    `Purchase area: ${purchaseArea}. ` +
    `Second call: ${secondCall || "Not confirmed"}. ` +
    "Next step: Start application.",
    800
  );
}

function buildMainMondayValues(call, latestAttempt, metadata) {
  const values = {};
  const board = metadata.main;
  const result = normalizeDaisyAnswers(call.result || {});
  const recordedSessionPhase = [...(Array.isArray(call.actions) ? call.actions : [])]
    .reverse()
    .find((action) =>
      ["CALL_ONE", "CALL_TWO", "RECONNECT", "SPECIALIST_NOTIFICATION"].includes(
        action?.session_call_phase
      )
    )?.session_call_phase;

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
  assignMondayValue(
    values,
    board,
    ["Call Summary"],
    buildStructuredMondayCallSummary(
      call,
      recordedSessionPhase || resolveSessionCallPhase(call, latestAttempt)
    )
  );
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
  const timeFrameColumn = findMondayColumnById(
    board,
    MONDAY_CALL_CONTROL_COLUMNS.time_frame
  );
  const timeFrameAnswer =
    result.purchase_timeline_detail ||
    call.result?.time_frame ||
    result.time_frame;
  if (timeFrameColumn && timeFrameAnswer) {
    const timeFrameValue = mondayTimeFrameValue(
      timeFrameColumn,
      timeFrameAnswer,
      call.call_id
    );
    if (timeFrameValue) values[timeFrameColumn.id] = timeFrameValue;
  }

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
  logOutboundCallRejected(
    notificationCall,
    "specialist_notification",
    "specialist_notification_phone_calls_disabled"
  );
  await pool.query(
    `UPDATE call_attempts
     SET technical_status = 'canceled', completed_at = NOW(),
         cancellation_reason = 'specialist_notification_phone_calls_disabled',
         updated_at = NOW()
     WHERE attempt_id = $1`,
    [notificationAttempt.attempt_id]
  );
  await pool.query(
    `UPDATE ai_calls
     SET sequence_status = 'human_action', next_attempt_at = NULL,
         result = result || $2::jsonb, updated_at = NOW()
     WHERE call_id = $1`,
    [
      notificationCall.call_id,
      JSON.stringify({
        specialist_notification_phone_calls_disabled: true
      })
    ]
  );
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
  const intentionallyEnded = actions.some(
    (action) =>
      action &&
      [
        "twilio_call_hangup",
        "twilio_final_hangup",
        "twilio_physical_hangup"
      ].includes(action.action) &&
      action.success &&
      (
        action.action === "twilio_physical_hangup" ||
        action.completion_reason === "normal_completion"
      )
  );
  const callbackConcluded = actions.some(
    (action) =>
      action && action.action === "schedule_callback" && action.success
  );
  const alreadyScheduled = Boolean(
    call.result?.unexpected_disconnect_reconnect_scheduled ||
      call.result?.unexpected_disconnect_reconnect_attempted
  );
  const connectedCall = Boolean(
    ["answered", "in-progress"].includes(
      String(call.status || "").toLowerCase()
    ) && call.twilio_call_sid
  );
  const normalCompletion = Boolean(
    completedByTool ||
    intentionallyEnded ||
    call.result?.normal_completion_recorded === true ||
    call.result?.final_hangup_requested === true ||
    call.result?.final_hangup_completed === true ||
    call.result?.completion_reason === "normal_completion" ||
    String(call.status || "").toLowerCase() === "completed"
  );
  if (normalCompletion) {
    console.log(JSON.stringify({
      event: "unexpected_reconnect_skipped",
      call_id: call.call_id,
      reason: "normal_terminal_call"
    }));
    return false;
  }
  const callbackAt = call.callback_at ? new Date(call.callback_at) : null;
  const hasFutureCallback = Boolean(
    callbackAt && !Number.isNaN(callbackAt.getTime()) && callbackAt > new Date()
  );
  if (
    hasFutureCallback ||
    callbackConcluded ||
    call.result?.outbound_call_reason === "scheduled_second_call"
  ) {
    logOutboundCallRejected(
      call,
      "unexpected_disconnect_reconnect",
      "normal_completion_not_reconnectable"
    );
    return false;
  }
  if (!connectedCall || transcript.length < 2) {
    logOutboundCallRejected(
      call,
      "unexpected_disconnect_reconnect",
      "normal_completion_not_reconnectable"
    );
    return false;
  }
  if (alreadyScheduled) {
    logOutboundCallRejected(
      call,
      "unexpected_disconnect_reconnect",
      "reconnect_already_attempted"
    );
    return false;
  }

  const reconnectAt = new Date(Date.now() + 60 * 1000);
  const reconnectSourceTwilioCallSid = call.twilio_call_sid;
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
          status = 'disconnected', twilio_call_sid = NULL,
          summary = COALESCE(summary, $3),
          next_action = COALESCE(next_action, 'Resume after unexpected disconnect'),
          completed_at = NULL, result = result || $4::jsonb, updated_at = NOW()
      WHERE call_id = $1
        AND COALESCE(result->>'unexpected_disconnect_reconnect_scheduled', 'false') <> 'true'
        AND COALESCE(result->>'normal_completion_recorded', 'false') <> 'true'
        AND COALESCE(result->>'final_hangup_requested', 'false') <> 'true'
        AND COALESCE(result->>'final_hangup_completed', 'false') <> 'true'
        AND COALESCE(result->>'completion_reason', '') <> 'normal_completion'
        AND status <> 'completed'
        AND status IN ('answered', 'in-progress')
        AND twilio_call_sid = $5
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(actions) AS callback_action
          WHERE callback_action->>'action' = 'schedule_callback'
            AND COALESCE((callback_action->>'success')::BOOLEAN, FALSE) = TRUE
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(actions) AS action
          WHERE action->>'action' = 'complete_call'
            AND COALESCE((action->>'success')::BOOLEAN, FALSE) = TRUE
        )
      RETURNING call_id
    `,
    [
      callId,
      reconnectAt,
      savedSummary,
      JSON.stringify({
        unexpected_disconnect_reconnect_scheduled: true,
        unexpected_disconnect_at: new Date().toISOString(),
        reconnect_at: reconnectAt.toISOString(),
        reconnect_source_call_id: callId,
        reconnect_source_twilio_call_sid: reconnectSourceTwilioCallSid,
        outbound_call_reason: "unexpected_disconnect_reconnect"
      }),
      reconnectSourceTwilioCallSid
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
    reconnect_at: reconnectAt.toISOString(),
    reconnect_source_call_id: callId,
    reconnect_source_twilio_call_sid: reconnectSourceTwilioCallSid,
    outbound_call_reason: "unexpected_disconnect_reconnect"
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
    await pool.query(
      `
        UPDATE ai_calls
        SET sequence_status = 'human_action', callback_requested = FALSE,
            callback_at = NULL, next_attempt_at = NULL,
            current_state = 'reconnect_attempt_completed',
            result = result || $2::jsonb, updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        callId,
        JSON.stringify({
          unexpected_disconnect_reconnect_completed: true,
          automatic_redial_disabled: true
        })
      ]
    );
    queueMondaySync(callId, "reconnect_attempt_completed_no_redial");
    return;
  }

  if (
    call.sequence_status === "callback_scheduled" &&
    hasFutureCallback &&
    call.result?.outbound_call_reason === "scheduled_second_call" &&
    call.result?.scheduled_second_call_appointment_id
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

  await pool.query(
    `
      UPDATE ai_calls
      SET
        sequence_status = 'human_action',
        next_action = COALESCE(next_action, 'Manual review required; automatic redial disabled'),
        next_attempt_at = NULL,
        result = result || $2::jsonb,
        updated_at = NOW()
      WHERE call_id = $1
    `,
    [callId, JSON.stringify({ automatic_redial_disabled: true })]
  );

  await pool.query(
    `UPDATE call_attempts
     SET technical_status = 'canceled', completed_at = NOW(),
         cancellation_reason = 'automatic_redial_disabled', updated_at = NOW()
     WHERE call_id = $1 AND completed_at IS NULL
       AND technical_status IN ('pending', 'scheduled', 'created')
       AND attempt_id IS DISTINCT FROM $2`,
    [callId, call.last_attempt_id]
  );
  queueMondaySync(callId, "automatic_redial_disabled");
}

async function placeTwilioCall(call, options = {}) {
  let refreshedCall = await getCallById(call.call_id);
  if (!refreshedCall) throw new Error("Call sequence not found.");
  let source = outboundCallSource(null, options.source);
  let resolvedCallReason = resolveOutboundCallReason(
    refreshedCall,
    null,
    options
  );

  if (!OUTBOUND_CALLS_ENABLED) {
    blockDisabledOutboundCall(
      refreshedCall,
      source,
      refreshedCall.callback_at || refreshedCall.next_attempt_at
    );
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "outbound_calls_disabled"
    );
    throw new HttpError(409, "Outbound calls are disabled.");
  }

  if (internalNotificationCallReason(resolvedCallReason)) {
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "specialist_notification_phone_calls_disabled"
    );
    throw new HttpError(409, "Specialist notification phone calls are disabled.");
  }
  if (!permittedOutboundCallReason(resolvedCallReason)) {
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "missing_permitted_call_reason"
    );
    throw new HttpError(409, "A permitted outbound call reason is required.");
  }

  if (
    refreshedCall.do_not_call ||
    refreshedCall.wrong_number ||
    refreshedCall.invalid_number
  ) {
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      refreshedCall.do_not_call ? "do_not_call" : "contact_suppressed"
    );
    throw new HttpError(409, "This contact is suppressed from future calls.");
  }

  if (
    ENFORCE_CALL_CONSENT &&
    refreshedCall.consent_status !== "confirmed" &&
    options.force !== true
  ) {
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "consent_not_confirmed"
    );
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
  if (!pendingAttempt) {
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "atomic_claim_failed"
    );
    throw new HttpError(409, "No pending attempt is available.");
  }
  source = outboundCallSource(pendingAttempt, options.source);
  resolvedCallReason = resolveOutboundCallReason(
    refreshedCall,
    pendingAttempt,
    options
  );

  const initialEligibility = outboundCallEligibility(
    refreshedCall,
    pendingAttempt,
    resolvedCallReason
  );
  if (!initialEligibility.eligible) {
    logOutboundCallEligibility(
      refreshedCall,
      pendingAttempt,
      source,
      initialEligibility
    );
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      initialEligibility.reason
    );
    throw new HttpError(409, `Outbound call blocked: ${initialEligibility.reason}.`);
  }

  const client = await pool.connect();
  let claimedDueAt = initialEligibility.dueAt;
  try {
    await client.query("BEGIN");
    if (resolvedCallReason === "initial_lead_call") {
      const leadIdentity = outboundLeadId(refreshedCall);
      if (!leadIdentity) {
        throw new HttpError(409, "Initial call lead identity is unavailable.");
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`initial_lead_call:${leadIdentity}`]
      );
      const priorInitialCall = await client.query(
        `SELECT call_id FROM ai_calls
         WHERE call_id <> $1
           AND COALESCE(NULLIF(lead_id, ''), NULLIF(payload->>'lead_id', ''),
                        NULLIF(case_id, ''), request_key) = $2
           AND COALESCE(
             result->>'outbound_call_reason',
             payload->>'outbound_call_reason',
             ''
           ) = 'initial_lead_call'
           AND (
             attempts > 0 OR last_attempt_id IS NOT NULL OR twilio_call_sid IS NOT NULL
             OR result->>'initial_call_claimed_at' IS NOT NULL
           )
         LIMIT 1`,
        [refreshedCall.call_id, leadIdentity]
      );
      if (priorInitialCall.rowCount) {
        logOutboundCallRejected(
          refreshedCall,
          resolvedCallReason,
          "initial_call_already_exists"
        );
        throw new HttpError(409, "An initial call already exists for this lead.");
      }
    }
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
    resolvedCallReason = resolveOutboundCallReason(
      refreshedCall,
      pendingAttempt,
      options
    );
    const lockedEligibility = outboundCallEligibility(
      refreshedCall,
      pendingAttempt,
      resolvedCallReason
    );
    if (!lockedEligibility.eligible) {
      logOutboundCallEligibility(
        refreshedCall,
        pendingAttempt,
        source,
        lockedEligibility
      );
      logOutboundCallRejected(
        refreshedCall,
        resolvedCallReason,
        lockedEligibility.reason
      );
      throw new HttpError(409, `Outbound call blocked: ${lockedEligibility.reason}.`);
    }
    claimedDueAt = lockedEligibility.dueAt;

    const explicitAppointment = lockedEligibility.scheduledAppointment;
    const lifecycleHistoryExemption = Boolean(
      explicitAppointment ||
        resolvedCallReason === "unexpected_disconnect_reconnect"
    );
    const consumesScheduledTime = [
      "scheduled_second_call",
      "unexpected_disconnect_reconnect"
    ].includes(resolvedCallReason);
    const claimedAt = new Date().toISOString();
    const claimResultPatch = {
      outbound_call_reason: resolvedCallReason,
      outbound_call_claimed_at: claimedAt,
      ...(resolvedCallReason === "initial_lead_call"
        ? { initial_call_claimed_at: claimedAt }
        : {}),
      ...(resolvedCallReason === "scheduled_second_call"
        ? { scheduled_second_call_dialed_at: claimedAt }
        : {}),
      ...(resolvedCallReason === "unexpected_disconnect_reconnect"
        ? { unexpected_disconnect_reconnect_attempted: true }
        : {})
    };
    const claimedCallResult = await client.query(
      `UPDATE ai_calls
       SET status = 'placing', sequence_status = 'calling',
           current_state = CASE
             WHEN $10 = 'unexpected_disconnect_reconnect'
               THEN 'reconnect_in_progress'
             ELSE current_state
           END,
           stream_token = $4, twilio_call_sid = NULL,
           attempts = attempts + 1, last_attempt_id = $2, last_attempt_at = NOW(),
           last_error = NULL, completed_at = NULL,
           callback_requested = CASE WHEN $3::BOOLEAN THEN FALSE ELSE callback_requested END,
           result = (CASE
             WHEN $5::BOOLEAN THEN result
               - 'normal_completion_recorded'
               - 'normal_completion_recorded_at'
               - 'final_hangup_requested'
               - 'final_hangup_completed'
               - 'final_hangup_completed_at'
               - 'completion_reason'
               - 'intentional_twilio_hangup'
             ELSE result
           END) || $11::jsonb,
           updated_at = NOW()
       WHERE call_id = $1
         AND status = $6
         AND sequence_status = $7
         AND twilio_call_sid IS NOT DISTINCT FROM $8::VARCHAR
         AND do_not_call = FALSE
         AND wrong_number = FALSE
         AND invalid_number = FALSE
         AND status NOT IN ('placing', 'queued', 'initiated', 'ringing', 'answered', 'in-progress', 'canceled', 'cancelled')
         AND sequence_status IN ('ready', 'active', 'scheduled', 'waiting_retry', 'callback_scheduled')
         AND ($5::BOOLEAN OR (
           status <> 'completed'
           AND sequence_status <> 'completed'
           AND COALESCE(result->>'normal_completion_recorded', 'false') <> 'true'
           AND COALESCE(result->>'completion_reason', '') <> 'normal_completion'
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(actions) AS action
             WHERE action->>'action' = 'complete_call'
               AND COALESCE((action->>'success')::BOOLEAN, FALSE) = TRUE
           )
         ))
         AND $9::TIMESTAMPTZ <= NOW()
         AND COALESCE(result->>'outbound_call_reason', payload->>'outbound_call_reason', '') = $10
         AND (
           ($10 = 'initial_lead_call' AND next_attempt_at = $9::TIMESTAMPTZ)
           OR ($10 IN ('scheduled_second_call', 'unexpected_disconnect_reconnect')
               AND callback_at = $9::TIMESTAMPTZ)
         )
       RETURNING *`,
      [
        refreshedCall.call_id,
        pendingAttempt.attempt_id,
        consumesScheduledTime,
        createStreamToken(),
        lifecycleHistoryExemption,
        refreshedCall.status,
        refreshedCall.sequence_status,
        refreshedCall.twilio_call_sid || null,
        claimedDueAt,
        resolvedCallReason,
        JSON.stringify(claimResultPatch)
      ]
    );
    if (!claimedCallResult.rowCount) {
      logOutboundCallRejected(
        refreshedCall,
        resolvedCallReason,
        "atomic_claim_failed"
      );
      throw new HttpError(409, "Call row was not eligible for atomic claim.");
    }
    const claimedAttemptResult = await client.query(
      `UPDATE call_attempts
       SET technical_status = 'placing', dialed_at = NOW(), updated_at = NOW()
       WHERE attempt_id = $1
         AND call_id = $2
         AND technical_status IN ('pending', 'scheduled', 'created')
         AND completed_at IS NULL
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()
       RETURNING *`,
      [pendingAttempt.attempt_id, refreshedCall.call_id]
    );
    if (!claimedAttemptResult.rowCount) {
      logOutboundCallRejected(
        refreshedCall,
        resolvedCallReason,
        "atomic_claim_failed"
      );
      throw new HttpError(409, "Call attempt was not eligible for atomic claim.");
    }
    refreshedCall = claimedCallResult.rows[0];
    pendingAttempt = claimedAttemptResult.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  refreshedCall = await getCallById(refreshedCall.call_id);
  pendingAttempt = await getAttemptById(pendingAttempt.attempt_id);
  const postClaimReason = resolveOutboundCallReason(
    refreshedCall,
    pendingAttempt,
    options
  );
  const postClaimDueAt = outboundCallDueAt(
    refreshedCall,
    postClaimReason
  );
  const claimMarkerRecorded = Boolean(
    (postClaimReason === "initial_lead_call" &&
      refreshedCall?.result?.initial_call_claimed_at) ||
    (postClaimReason === "scheduled_second_call" &&
      refreshedCall?.result?.scheduled_second_call_dialed_at) ||
    (postClaimReason === "unexpected_disconnect_reconnect" &&
      refreshedCall?.result?.unexpected_disconnect_reconnect_attempted === true)
  );
  const claimedEligibility = {
    dueAt: claimedDueAt,
    eligible: Boolean(
      refreshedCall &&
        pendingAttempt &&
        refreshedCall.status === "placing" &&
        refreshedCall.sequence_status === "calling" &&
        refreshedCall.last_attempt_id === pendingAttempt.attempt_id &&
        pendingAttempt.technical_status === "placing" &&
        postClaimReason === resolvedCallReason &&
        permittedOutboundCallReason(postClaimReason) &&
        postClaimDueAt &&
        new Date(postClaimDueAt).toISOString() === claimedDueAt &&
        claimMarkerRecorded &&
        !refreshedCall.twilio_call_sid &&
        !refreshedCall.do_not_call &&
        !refreshedCall.wrong_number &&
        !refreshedCall.invalid_number
    ),
    reason: "atomic_claim_confirmed"
  };
  if (!claimedEligibility.eligible) {
    claimedEligibility.reason = "post_claim_recheck_failed";
    logOutboundCallEligibility(
      refreshedCall,
      pendingAttempt,
      source,
      claimedEligibility
    );
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "atomic_claim_failed"
    );
    throw new HttpError(409, "Outbound call blocked after atomic claim recheck.");
  }
  logOutboundCallEligibility(
    refreshedCall,
    pendingAttempt,
    source,
    claimedEligibility
  );

  const attemptId = pendingAttempt.attempt_id;
  const attemptNumber = Number(pendingAttempt.attempt_number);
  const voiceUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/voice`);
  voiceUrl.searchParams.set("call_id", refreshedCall.call_id);
  voiceUrl.searchParams.set("token", refreshedCall.stream_token);
  const statusUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/status`);
  statusUrl.searchParams.set("call_id", refreshedCall.call_id);
  statusUrl.searchParams.set("token", refreshedCall.stream_token);
  queueMondaySync(refreshedCall.call_id, "attempt_created");

  await appendAction(refreshedCall.call_id, {
    action: "outbound_call_claimed",
    success: true,
    call_reason: resolvedCallReason,
    attempt_id: attemptId,
    due_at: claimedDueAt,
    ...(resolvedCallReason === "unexpected_disconnect_reconnect"
      ? { reconnect_source_call_id: refreshedCall.result?.reconnect_source_call_id }
      : {})
  });

  if (!OUTBOUND_CALLS_ENABLED) {
    blockDisabledOutboundCall(refreshedCall, source, claimedDueAt);
    logOutboundCallRejected(
      refreshedCall,
      resolvedCallReason,
      "outbound_calls_disabled"
    );
    throw new HttpError(409, "Outbound calls are disabled.");
  }

  logOutboundCallFinalEligibility(refreshedCall, resolvedCallReason);

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
    await pool.query(
      `UPDATE ai_calls
       SET next_attempt_at = NULL,
           callback_at = CASE
             WHEN $2 = 'unexpected_disconnect_reconnect' THEN NULL
             ELSE callback_at
           END,
           result = result || $3::jsonb,
           updated_at = NOW()
       WHERE call_id = $1`,
      [
        refreshedCall.call_id,
        resolvedCallReason,
        JSON.stringify({
          outbound_call_placed_at: new Date().toISOString(),
          outbound_call_reason: resolvedCallReason
        })
      ]
    );

    await appendAction(refreshedCall.call_id, {
      action: "outbound_call_placed",
      success: true,
      call_reason: resolvedCallReason,
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
          technical_status = 'failed',
          completed_at = NOW(),
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
          sequence_status = 'human_action',
          next_attempt_at = NULL,
          callback_requested = FALSE,
          last_error = $2,
          result = result || $3::jsonb,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        refreshedCall.call_id,
        safeError,
        JSON.stringify({
          outbound_call_failed_at: new Date().toISOString(),
          outbound_call_reason: resolvedCallReason,
          automatic_redial_disabled: true
        })
      ]
    );

    await appendAction(refreshedCall.call_id, {
      action: "outbound_call_placed",
      success: false,
      call_reason: resolvedCallReason,
      technical_failure: true,
      customer_attempt_consumed: false,
      attempt_number: attemptNumber,
      error: safeError
    });

    queueMondaySync(refreshedCall.call_id, "twilio_call_failed_no_redial");
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

function localDateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimezone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function addDaysToLocalDateText(dateText, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseConfirmedLocalDate(value, timeZone) {
  const raw = cleanText(value, 160);
  if (!raw) return null;
  const normalized = normalizeCustomerUtterance(raw);
  const nowParts = localDateParts(new Date(), timeZone);
  const today = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  if (/\bfollowing day\b/.test(normalized)) {
    return addDaysToLocalDateText(today, 1);
  }
  if (/\btomorrow\b/.test(normalized)) return addDaysToLocalDateText(today, 1);
  if (/\btoday\b/.test(normalized)) return today;
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(raw);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(`${raw} 12:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function parseConfirmedLocalTime(value) {
  const raw = cleanText(value, 100);
  if (!raw) return null;
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(raw);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = String(match[3] || "").toLowerCase().replace(/\./g, "");
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localDateTimeToUtc(dateText, timeText, timeZone) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeText || ""));
  if (!dateMatch || !timeMatch) return null;
  const desired = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0
  );
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second)
    );
    guess += desired - actualAsUtc;
  }
  const result = new Date(guess);
  const check = localDateParts(result, timeZone);
  const matches =
    `${check.year}-${check.month}-${check.day}` === dateText &&
    `${check.hour}:${check.minute}` === timeText;
  return matches ? result : null;
}
function resolveCustomerTimezone(value, fallback = null) {
  const raw =
    cleanText(value, 100) ||
    cleanText(fallback, 100);

  if (!raw) return null;

  const timezoneKey = normalizeMondayKey(raw);
  let timeZone = raw;

  if (
    timezoneKey.includes("eastern") ||
    ["et", "est", "edt"].includes(timezoneKey)
  ) {
    timeZone = "America/New_York";
  } else if (
    timezoneKey.includes("central") ||
    ["ct", "cst", "cdt"].includes(timezoneKey)
  ) {
    timeZone = "America/Chicago";
  } else if (
    timezoneKey.includes("mountain") ||
    ["mt", "mst", "mdt"].includes(timezoneKey)
  ) {
    timeZone = "America/Denver";
  } else if (
    timezoneKey.includes("pacific") ||
    ["pt", "pst", "pdt"].includes(timezoneKey)
  ) {
    timeZone = "America/Los_Angeles";
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone
    }).format(new Date());

    return timeZone;
  } catch {
    return null;
  }
function resolveConfirmedCallbackDateTime(args, call) {
  const requestedTimezone =
    cleanText(args.timezone, 100) ||
    cleanText(call?.callback_timezone, 100) ||
    cleanText(call?.result?.callback_timezone, 100);

  if (!requestedTimezone) return null;

  const timezoneKey = normalizeMondayKey(requestedTimezone);

  const timeZone =
    timezoneKey.includes("eastern") ||
    ["et", "est", "edt"].includes(timezoneKey)
      ? "America/New_York"
      : timezoneKey.includes("central") ||
          ["ct", "cst", "cdt"].includes(timezoneKey)
        ? "America/Chicago"
        : timezoneKey.includes("mountain") ||
            ["mt", "mst", "mdt"].includes(timezoneKey)
          ? "America/Denver"
          : timezoneKey.includes("pacific") ||
              ["pt", "pst", "pdt"].includes(timezoneKey)
            ? "America/Los_Angeles"
            : requestedTimezone;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    return null;
  }

  let customerLocalDate = parseConfirmedLocalDate(
    args.customer_local_date,
    timeZone
  );

  let customerLocalTime = parseConfirmedLocalTime(
    args.customer_local_time
  );

  let callbackAt =
    customerLocalDate && customerLocalTime
      ? localDateTimeToUtc(
          customerLocalDate,
          customerLocalTime,
          timeZone
        )
      : null;

  if (!callbackAt) {
    const directCallbackAt = new Date(args.callback_at);

    if (Number.isNaN(directCallbackAt.getTime())) {
      return null;
    }

    const localParts = localDateParts(directCallbackAt, timeZone);

    customerLocalDate =
      `${localParts.year}-${localParts.month}-${localParts.day}`;

    customerLocalTime =
      `${localParts.hour}:${localParts.minute}`;

    callbackAt = directCallbackAt;
  }

  return {
    callbackAt,
    customerLocalDate,
    customerLocalTime,
    timeZone
  };
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

async function executeDougTool(call, name, args, sessionCallPhase) {
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
    const existingAnswers = normalizeDaisyAnswers(call.result || {});
    const confirmedPurchaseArea = Object.prototype.hasOwnProperty.call(
      safeArgs.answers || {},
      "purchase_area"
    )
      ? exactMeaningfulPurchaseArea(safeArgs.answers.purchase_area)
      : null;
    if (confirmedPurchaseArea) {
      answers.purchase_area = confirmedPurchaseArea;
    } else if (Object.prototype.hasOwnProperty.call(answers, "purchase_area")) {
      delete answers.purchase_area;
    }
    for (const key of ["has_realtor", "applied_with_lender", "has_lender"]) {
      if (existingAnswers[key] !== undefined && answers[key] !== undefined) {
        answers[key] = existingAnswers[key];
      }
    }

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

    if (confirmedPurchaseArea) {
      console.log(JSON.stringify({
        event: "purchase_area_confirmed",
        call_id: call.call_id,
        purchase_area: confirmedPurchaseArea
      }));
    }

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
      saved_fields: Object.keys(answers),
      confirmed_purchase_area: confirmedPurchaseArea
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
    const confirmedStarted = call.result?.application_started_confirmed;
    if (
      sessionCallPhase !== "CALL_TWO" ||
      call.result?.application_status_explicitly_answered !== true ||
      typeof confirmedStarted !== "boolean" ||
      safeArgs.started !== confirmedStarted
    ) {
      return {
        success: false,
        error:
          "Application status can only be recorded in Call Two after the customer explicitly answers the application-status question."
      };
    }
    if (confirmedStarted !== true) {
      return {
        success: true,
        app_started_confirmation: "No",
        application_started: false
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
          app_started_confirmation: "Yes",
          application_started_confirmed: true,
          application_status_explicitly_answered: true,
          interest_level: "Hot",
          business_outcome: "Application Started — Hot Lead"
        })
      ]
    );
    await appendAction(call.call_id, {
      action: name,
      success: true,
      app_started_confirmation: "Yes",
      priority: "urgent"
    });
    queueMondaySync(call.call_id, "application_started_hot_lead");
    return {
      success: true,
      app_started_confirmation: "Yes",
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
if (
  call.result?.callback_confirmation_explicitly_answered !== true ||
  call.result?.callback_confirmation_confirmed !== true
) {
  return {
    success: false,
    error:
      "The customer must explicitly confirm the exact callback date, time, and timezone during the live conversation."
  };
}
    const confirmedCallback = resolveConfirmedCallbackDateTime(safeArgs, call);
    if (!confirmedCallback) {
      return {
        success: false,
        error: "A confirmed local callback date, time, and timezone are required."
      };
    }
    const {
      callbackAt,
      customerLocalDate,
      customerLocalTime,
      timeZone: timezone
    } = confirmedCallback;
    const isFuture = callbackAt > new Date();
    console.log(JSON.stringify({
      event: "callback_datetime_confirmed",
      call_id: call.call_id,
      customer_local_date: customerLocalDate,
      customer_local_time: customerLocalTime,
      timezone,
      callback_at_utc: callbackAt.toISOString(),
      is_future: isFuture
    }));
    if (!isFuture) {
      return { success: false, error: "The callback time must be in the future." };
    }
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
    if (call.result?.scheduled_second_call_dialed_at) {
      return {
        success: false,
        error: "The explicitly scheduled second call has already been dialed."
      };
    }
    const isApplicationCheckpoint = normalizeMondayKey(reason).includes(
      "applicationcheckpoint"
    );
    if (
  isApplicationCheckpoint &&
  sessionCallPhase === "CALL_ONE" &&
  call.result?.application_start_plan_explicitly_answered !== true
) {
  return {
    success: false,
    error:
      "Call One must reach and answer the application-start planning question before scheduling Call Two."
  };
}

if (
  isApplicationCheckpoint &&
  sessionCallPhase === "CALL_TWO" &&
  (
    call.result?.application_status_explicitly_answered !== true ||
    call.result?.application_started_confirmed !== false
  )
) {
  return {
    success: false,
    error:
      "A Call Two application checkpoint may only be scheduled after the customer explicitly says the application was not started."
  };
}
    const callbackAttemptType = isApplicationCheckpoint
      ? "application_checkpoint"
      : "customer_callback";
    const scheduledSecondCallSourceId =
      cleanText(call.result?.scheduled_second_call_source_call_id, 100) ||
      call.call_id;
    const scheduledSecondCallAppointmentId =
      cleanText(call.result?.scheduled_second_call_appointment_id, 100) ||
      stableHash(`${scheduledSecondCallSourceId}:scheduled_second_call`).slice(0, 40);
    const leadIdentity = outboundLeadId(call);
    const existingAppointment = leadIdentity
      ? await pool.query(
          `SELECT * FROM ai_calls
           WHERE call_id <> $1
             AND COALESCE(NULLIF(lead_id, ''), NULLIF(payload->>'lead_id', ''),
                          NULLIF(case_id, ''), request_key) = $2
             AND result->>'scheduled_second_call_source_call_id' = $3
             AND result->>'outbound_call_reason' = 'scheduled_second_call'
             AND callback_at > NOW()
             AND sequence_status IN ('callback_scheduled', 'calling', 'completed')
           ORDER BY updated_at DESC
           LIMIT 1`,
          [call.call_id, leadIdentity, scheduledSecondCallSourceId]
        )
      : { rows: [] };
    const appointmentCall = existingAppointment.rows[0] || call;
    const appointmentCallId = appointmentCall.call_id;

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
        appointmentCallId,
        callbackAt,
        timezone,
        reason,
        callbackOutcome,
        discussionSummary
      ]
    );

    await mergeCallResult(appointmentCallId, {
      callback_at: callbackAt.toISOString(),
      callback_local_date: customerLocalDate,
      callback_local_time: customerLocalTime,
      callback_timezone: timezone,
      callback_confirmation_explicitly_answered: false,
callback_confirmation_confirmed: false,
      outbound_call_reason: "scheduled_second_call",
      scheduled_second_call_source_call_id: scheduledSecondCallSourceId,
      scheduled_second_call_appointment_id: scheduledSecondCallAppointmentId,
      scheduled_second_call_purpose: callbackAttemptType,
      ...(safeArgs.application_local_date
        ? {
            application_local_date: parseConfirmedLocalDate(
              safeArgs.application_local_date,
              timezone
            )
          }
        : {}),
      callback_reason: reason,
      primary_concern: primaryConcern,
      hold_reason: holdReason,
      discussion_summary: discussionSummary,
      follow_up_outcome: callbackOutcome,
      preferred_contact_method:
        cleanText(safeArgs.preferred_contact_method, 30) || "phone",
      ...(isApplicationCheckpoint
        ? { application_follow_up_at: callbackAt.toISOString() }
        : {})
    });

    await pool.query(
      `UPDATE call_attempts SET technical_status = 'canceled', completed_at = NOW(),
       cancellation_reason = 'explicit_callback_rescheduled', updated_at = NOW()
       WHERE call_id = $1 AND attempt_type = $2 AND completed_at IS NULL
         AND technical_status IN ('pending', 'scheduled', 'created')
         AND scheduled_at IS DISTINCT FROM $3`,
      [appointmentCallId, callbackAttemptType, callbackAt]
    );

    await ensurePendingAttempt(appointmentCallId, {
      attemptType: callbackAttemptType,
      scheduledAt: callbackAt,
      idempotencyKey: `${callbackAttemptType}:${scheduledSecondCallAppointmentId}:${callbackAt.toISOString()}`
    });

    await appendAction(appointmentCallId, {
      action: name,
      success: true,
      session_call_phase: sessionCallPhase,
      outbound_call_reason: "scheduled_second_call",
      scheduled_second_call_source_call_id: scheduledSecondCallSourceId,
      scheduled_second_call_appointment_id: scheduledSecondCallAppointmentId,
      callback_at: callbackAt.toISOString(),
      customer_local_date: customerLocalDate,
      customer_local_time: customerLocalTime,
      timezone,
      reason,
      primary_concern: primaryConcern,
      hold_reason: holdReason,
      outcome: callbackOutcome
    });

    queueMondaySync(call.call_id, "callback_scheduled");

    return {
      success: true,
      callback_at: callbackAt.toISOString(),
      timezone,
      outcome: callbackOutcome,
      sequence_status: "callback_scheduled"
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
    const completionValidation = terminalCompletionValidation(
      call,
      sessionCallPhase
    );

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
      completion_validation: completionValidation,
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
      session_call_phase: sessionCallPhase,
      completion_validation: completionValidation,
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null
    });

    queueMondaySync(call.call_id, `complete_call_${outcome}`);

    return {
      success: true,
      outcome,
      sequence_status: sequenceStatus,
      completion_validation: completionValidation,
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
          JSON.stringify({
            ...payload,
            outbound_call_reason: "initial_lead_call"
          }),
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
          application_follow_up_at: null,
          outbound_call_reason: "initial_lead_call",
          initial_call_source_lead_id:
            cleanText(payload.lead_id || payload.case_id, 150) || requestKey
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
        attemptType: "initial_lead_call",
        scheduledAt: nextAttemptAt,
        idempotencyKey: `initial_lead_call:${call.call_id}:1`
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
        attemptId: firstAttempt.attempt_id,
        source: "initial",
        callReason: "initial_lead_call"
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

      logOutboundCallRejected(
        call,
        resolveOutboundCallReason(call, null),
        "missing_permitted_call_reason"
      );
      throw new HttpError(
        409,
        "Generic retry calls are disabled. Use a confirmed scheduled second call."
      );

      if (!terminalCallStatus(call.status)) {
        throw new HttpError(
          409,
          `Call cannot be retried while status is ${call.status}.`
        );
      }

      if (callHasSuccessfulCompleteCall(call)) {
        throw new HttpError(409, "A normally completed call cannot be retried.");
      }

      const retryResult = await pool.query(
        `
          UPDATE ai_calls
          SET
            sequence_status = 'ready',
            last_error = NULL,
            completed_at = NULL,
            next_attempt_at = NOW(),
            updated_at = NOW()
          WHERE call_id = $1
            AND status <> 'completed'
            AND sequence_status NOT IN ('completed', 'suppressed', 'paused')
            AND do_not_call = FALSE
            AND wrong_number = FALSE
            AND invalid_number = FALSE
          RETURNING *
        `,
        [call.call_id]
      );
      if (!retryResult.rowCount) {
        throw new HttpError(409, "Call is not eligible for a manual retry.");
      }

      queueMondaySync(call.call_id, "manual_retry_ready");
      const refreshed = retryResult.rows[0];
      const retryAttempt = await ensurePendingAttempt(call.call_id, {
        attemptType: "cadence",
        scheduledAt: refreshed.next_attempt_at,
        idempotencyKey: `manual_retry:${call.call_id}:${Date.now()}`
      });
      if (!retryAttempt) {
        throw new HttpError(409, "No retry attempt is available.");
      }
      await pool.query(
        `UPDATE call_attempts SET scheduled_at = $2, updated_at = NOW()
         WHERE attempt_id = $1
           AND completed_at IS NULL
           AND technical_status IN ('pending', 'scheduled', 'created')`,
        [retryAttempt.attempt_id, refreshed.next_attempt_at]
      );
      const twilioCall = await placeTwilioCall(refreshed, {
        force: req.body && req.body.force === true,
        attemptId: retryAttempt.attempt_id,
        source: "initial"
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
  let normalCompletionRecorded = false;
  let normalEndRequested = false;
  let sessionCallPhase = "";
  let finalClosingRequested = false;
  let finalClosingResponseId = "";
  let finalPlaybackMarkName = "";
  let finalHangupInProgress = false;
  let finalHangupCompleted = false;
  let finalHangupAttemptCount = 0; 
  let finalHangupFallbackTimer = null;
  let finalAbsoluteHangupTimer = null;
  let activeTwilioCallSid = "";
  let activeTwilioStreamSid = "";
  let assistantAudioQueuedForResponse = false;
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

  function lockSessionCallPhase(loadedCall, attempt) {
    if (sessionCallPhase) return sessionCallPhase;
    sessionCallPhase = resolveSessionCallPhase(loadedCall, attempt);
    return sessionCallPhase;
  }

  function refreshActiveRealtimeInstructions() {
    if (!call || !sessionCallPhase) return false;
    return sendToOpenAI({
      type: "session.update",
      session: {
        instructions: buildDouglasDaisyInstructions(call, sessionCallPhase)
      }
    });
  }

  function currentCallIsTerminal() {
    return (
      normalEndRequested ||
      normalCompletionRecorded ||
      finalHangupCompleted ||
      String(call?.status || "").toLowerCase() === "completed"
    );
  }

  function exactFinalClosingSpoken(value) {
    const lead = call?.payload || {};
    const customerName =
      cleanText(lead.first_name || lead.customer_name || lead.name, 160) ||
      "the customer";
    const expected = `If there's nothing else, thank you for your time, ${customerName}. Have a great day.`;
    return normalizeCustomerUtterance(value) === normalizeCustomerUtterance(expected);
  }

  function stopCurrentCallAutomation() {
    cancelSilenceReminder();
    if (customerTranscriptDebounceTimer) {
      clearTimeout(customerTranscriptDebounceTimer);
      customerTranscriptDebounceTimer = null;
    }
    if (sustainedSpeechTimer) {
      clearTimeout(sustainedSpeechTimer);
      sustainedSpeechTimer = null;
    }
    speechCandidateStartedAt = 0;
    speechCandidateConfirmed = false;
    speechCandidateWhileAssistantSpeaking = false;
    customerSpeaking = false;
    pendingCustomerTranscripts = [];
    pendingTranscriptWasWhileAssistantSpeaking = false;
    queuedResponseOptions = null;
  }

  function beginNormalCallTermination(reason) {
    if (normalEndRequested) return false;
    normalEndRequested = true;
    finalClosingRequested = true;
    stopCurrentCallAutomation();
    finalAbsoluteHangupTimer = setTimeout(() => {
      void physicallyEndActiveTwilioCall("absolute_normal_end_timeout");
    }, 15000);
    console.log(JSON.stringify({
      event: "normal_call_termination_started",
      call_id: call?.call_id || null,
      reason,
      absolute_timeout_ms: 15000
    }));
    return true;
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

  function sendFinalHangupMark() {
    if (
      !normalEndRequested ||
      finalPlaybackMarkName ||
      finalHangupCompleted ||
      !activeTwilioStreamSid
    ) return false;

    finalPlaybackMarkName =
      "daisy_final_hangup_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8);
    if (!sendToTwilio({
      event: "mark",
      streamSid: activeTwilioStreamSid,
      mark: { name: finalPlaybackMarkName }
    })) {
      finalPlaybackMarkName = "";
      return false;
    }
    pendingMarkNames.add(finalPlaybackMarkName);
    console.log(JSON.stringify({
      event: "final_hangup_mark_sent",
      call_id: call.call_id,
      mark_name: finalPlaybackMarkName,
      stream_sid: activeTwilioStreamSid
    }));
    finalHangupFallbackTimer = setTimeout(() => {
      void physicallyEndActiveTwilioCall("final_mark_timeout");
    }, 8000);
    return true;
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
    if (
      currentCallIsTerminal() &&
      options.allowTerminalClosing !== true
    ) return false;
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
      currentCallIsTerminal() ||
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
    if (currentCallIsTerminal()) return;
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

    if (pendingQuestionType === "purchase_area") {
      const confirmedPurchaseArea = exactMeaningfulPurchaseArea(transcript);
      if (!confirmedPurchaseArea) {
        requestAssistantResponse({
          queueIfBusy: true,
          allowWhileAwaiting: true,
          preservePendingQuestion: true,
          response: {
            output_modalities: ["audio"],
            instructions:
              'Say exactly: "What city or area would you like to purchase in?" Say nothing else.'
          }
        });
        return;
      }
      await mergeCallResult(call.call_id, {
        purchase_area: confirmedPurchaseArea
      });
      console.log(JSON.stringify({
        event: "purchase_area_confirmed",
        call_id: call.call_id,
        purchase_area: confirmedPurchaseArea
      }));
      call = (await getCallById(call.call_id)) || call;

const customerName =
  cleanText(
    call?.payload?.first_name ||
      call?.payload?.customer_name ||
      call?.payload?.name,
    160
  ) || "there";

refreshActiveRealtimeInstructions();
await endLocalWaitingState("purchase_area_confirmed");

requestAssistantResponse({
  queueIfBusy: true,
  response: {
    output_modalities: ["audio"],
    instructions: `Say exactly: ${JSON.stringify(
      `Well, that's everything for this call, and now you're one step closer to becoming a homeowner in ${confirmedPurchaseArea}. Your next step is to start the application so I can follow up with you about its status, review your debt-to-income ratio, and explore potential program options. ${customerName}, do you think you'll have time to start the application today?`
    )} Say nothing else.`
  }
});

return;
    }
if (pendingQuestionType === "application_start_plan") {
  const explicitAnswer = normalizeExplicitYesNo(transcript);

  if (explicitAnswer === null) {
    requestAssistantResponse({
      queueIfBusy: true,
      allowWhileAwaiting: true,
      preservePendingQuestion: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          'Ask exactly: "Was that a yes or a no?" Say nothing else.'
      }
    });
    return;
  }

  await mergeCallResult(call.call_id, {
    application_start_plan_explicitly_answered: true,
    application_start_today_confirmed: explicitAnswer,
    callback_confirmation_explicitly_answered: false,
    callback_confirmation_confirmed: false
  });

  call = (await getCallById(call.call_id)) || call;
  await endLocalWaitingState("explicit_application_start_plan_answer");

  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions: explicitAnswer
        ? 'Ask exactly: "Excellent. What time zone are you in and what tomorrow would be best for our second call?" Say nothing else.'
        : 'Ask exactly: "No problem. What day do you think you will have time to start it?" Say nothing else.'
    }
  });

  return;
    }
if (pendingQuestionType === "application_started") {
  const explicitAnswer = normalizeApplicationStartedAnswer(transcript);

  if (explicitAnswer === null) {
    const clarificationUsed =
      call.result?.application_status_clarification_used === true;

    if (!clarificationUsed) {
      await mergeCallResult(call.call_id, {
        application_status_clarification_used: true
      });

      call = (await getCallById(call.call_id)) || call;

      requestAssistantResponse({
        queueIfBusy: true,
        allowWhileAwaiting: true,
        preservePendingQuestion: true,
        response: {
          output_modalities: ["audio"],
          instructions:
            'Ask exactly: "Was that a yes or a no?" Say nothing else.'
        }
      });

      return;
    }

    await endLocalWaitingState(
      "application_status_unclear_after_clarification"
    );

    requestAssistantResponse({
      queueIfBusy: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          'Say exactly: "No problem. We can come back to that. Would you like me to help you calculate a preliminary debt-to-income estimate now?" Say nothing else.'
      }
    });

    return;
  }

  if (sessionCallPhase !== "CALL_TWO") {
    sessionCallPhase = "CALL_TWO";

    await appendAction(call.call_id, {
      action: "session_call_phase_recovered",
      success: true,
      recovered_phase: "CALL_TWO",
      reason: "explicit_application_status_question"
    });

    refreshActiveRealtimeInstructions();
  }

  await mergeCallResult(call.call_id, {
    application_status_explicitly_answered: true,
    application_started_confirmed: explicitAnswer,
    app_started_confirmation: explicitAnswer ? "Yes" : "No",
    application_status_clarification_used: false
  });

  call = (await getCallById(call.call_id)) || call;
  refreshActiveRealtimeInstructions();

  await endLocalWaitingState(
    "explicit_application_status_answer"
  );

  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions: explicitAnswer
        ? 'Say exactly: "Excellent. That’s great to hear. Before I connect you with the next step, let’s review your preliminary debt-to-income ratio. Do you have a few minutes to do that now?" Say nothing else.'
        : 'Say exactly: "No worries. One of the main things that can affect your homebuying options is your debt-to-income ratio. Would you like me to help you calculate a preliminary DTI estimate now?" Say nothing else.'
    }
  });

  return;
}
    if (pendingQuestionType === "callback_time") {
  const answerText = cleanText(transcript, 500);
  const normalizedPrompt = normalizeMondayKey(pendingQuestionText);

  const applicationStartDateOnly =
    /whatday.*(?:startit|start.*application)/.test(normalizedPrompt);

  if (applicationStartDateOnly) {
    await mergeCallResult(call.call_id, {
      application_start_date_answer: answerText,
      callback_confirmation_explicitly_answered: false,
      callback_confirmation_confirmed: false
    });

    call = (await getCallById(call.call_id)) || call;
    await endLocalWaitingState("application_start_date_collected");

    requestAssistantResponse({
      queueIfBusy: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          'Ask exactly: "And what time zone are you in—Eastern, Central, Mountain, or Pacific—and what time would be best for me to follow up with you the following day?" Say nothing else.'
      }
    });

    return;
  }
const previousCallbackAnswer =
  cleanText(call.result?.callback_datetime_answer, 500);

const combinedAnswer = [previousCallbackAnswer, answerText]
  .filter(Boolean)
  .join(" ");

const savedTimezone =
  cleanText(call.callback_timezone, 100) ||
  cleanText(call.result?.callback_timezone, 100);

const timeZone = resolveCustomerTimezone(
  combinedAnswer,
  savedTimezone
);

const customerLocalTime =
  parseConfirmedLocalTime(answerText) ||
  parseConfirmedLocalTime(previousCallbackAnswer);

await mergeCallResult(call.call_id, {
  callback_datetime_answer: combinedAnswer,
  ...(timeZone ? { callback_timezone: timeZone } : {}),
  callback_confirmation_explicitly_answered: false,
  callback_confirmation_confirmed: false
});

call = (await getCallById(call.call_id)) || call;
await endLocalWaitingState("callback_datetime_collected");

if (!timeZone) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What time zone are you in—Eastern, Central, Mountain, or Pacific?" Say nothing else.'
    }
  });
  return;
}

if (!customerLocalTime) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What time would you like me to call you?" Say nothing else.'
    }
  });
  return;
}

const applicationStartDate =
  cleanText(call.result?.application_start_date_answer, 500);

const parsedApplicationDate = applicationStartDate
  ? parseConfirmedLocalDate(applicationStartDate, timeZone)
  : null;

const customerLocalDate = parsedApplicationDate
  ? addDaysToLocalDateText(parsedApplicationDate, 1)
  : parseConfirmedLocalDate(
      `${pendingQuestionText || ""} ${combinedAnswer}`,
      timeZone
    );

if (!customerLocalDate) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What date would you like me to call you?" Say nothing else.'
    }
  });
  return;
}

const callbackAt = localDateTimeToUtc(
  customerLocalDate,
  customerLocalTime,
  timeZone
);

if (!callbackAt || callbackAt <= new Date()) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "That time has already passed. What future time would work better?" Say nothing else.'
    }
  });
  return;
}

const callbackReason =
  applicationStartDate ||
  call.result?.application_start_plan_explicitly_answered === true
    ? "Application checkpoint"
    : "Customer requested a better time";

await mergeCallResult(call.call_id, {
  callback_at: callbackAt.toISOString(),
  callback_local_date: customerLocalDate,
  callback_local_time: customerLocalTime,
  callback_timezone: timeZone,
  callback_reason: callbackReason,
  callback_confirmation_explicitly_answered: false,
  callback_confirmation_confirmed: false
});

call = (await getCallById(call.call_id)) || call;
refreshActiveRealtimeInstructions();

const spokenAppointment = formatCustomerCallbackTime(
  callbackAt,
  timeZone
);

requestAssistantResponse({
  queueIfBusy: true,
  response: {
    output_modalities: ["audio"],
    instructions: `Ask exactly: ${JSON.stringify(
      `I have us scheduled to speak on ${spokenAppointment}. Is that correct?`
    )} Say nothing else.`
  }
});

return;
}
 const previousCallbackAnswer =
  cleanText(call.result?.callback_datetime_answer, 500);

const combinedAnswer = [previousCallbackAnswer, answerText]
  .filter(Boolean)
  .join(" ");

const savedTimezone =
  cleanText(call.callback_timezone, 100) ||
  cleanText(call.result?.callback_timezone, 100);

const timeZone = resolveCustomerTimezone(
  combinedAnswer,
  savedTimezone
);

const customerLocalTime =
  parseConfirmedLocalTime(answerText) ||
  parseConfirmedLocalTime(previousCallbackAnswer);

await mergeCallResult(call.call_id, {
  callback_datetime_answer: combinedAnswer,
  ...(timeZone ? { callback_timezone: timeZone } : {}),
  callback_confirmation_explicitly_answered: false,
  callback_confirmation_confirmed: false
});

call = (await getCallById(call.call_id)) || call;
await endLocalWaitingState("callback_datetime_collected");

if (!timeZone) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What time zone are you in—Eastern, Central, Mountain, or Pacific?" Say nothing else.'
    }
  });
  return;
}

if (!customerLocalTime) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What time would you like me to call you?" Say nothing else.'
    }
  });
  return;
}

const applicationStartDate =
  cleanText(call.result?.application_start_date_answer, 500);

const parsedApplicationDate = applicationStartDate
  ? parseConfirmedLocalDate(applicationStartDate, timeZone)
  : null;

const customerLocalDate = parsedApplicationDate
  ? addDaysToLocalDateText(parsedApplicationDate, 1)
  : parseConfirmedLocalDate(
      `${pendingQuestionText || ""} ${combinedAnswer}`,
      timeZone
    );

if (!customerLocalDate) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "What date would you like me to call you?" Say nothing else.'
    }
  });
  return;
}

const callbackAt = localDateTimeToUtc(
  customerLocalDate,
  customerLocalTime,
  timeZone
);

if (!callbackAt || callbackAt <= new Date()) {
  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions:
        'Ask exactly: "That time has already passed. What future time would work better?" Say nothing else.'
    }
  });
  return;
}

const callbackReason =
  applicationStartDate ||
  call.result?.application_start_plan_explicitly_answered === true
    ? "Application checkpoint"
    : "Customer requested a better time";

await mergeCallResult(call.call_id, {
  callback_at: callbackAt.toISOString(),
  callback_local_date: customerLocalDate,
  callback_local_time: customerLocalTime,
  callback_timezone: timeZone,
  callback_reason: callbackReason,
  callback_confirmation_explicitly_answered: false,
  callback_confirmation_confirmed: false
});

call = (await getCallById(call.call_id)) || call;
refreshActiveRealtimeInstructions();

const spokenAppointment = formatCustomerCallbackTime(
  callbackAt,
  timeZone
);

requestAssistantResponse({
  queueIfBusy: true,
  response: {
    output_modalities: ["audio"],
    instructions: `Ask exactly: ${JSON.stringify(
      `I have us scheduled to speak on ${spokenAppointment}. Is that correct?`
    )} Say nothing else.`
  }
});

return;
}
  if (pendingQuestionType === "callback_confirmation") {
  const explicitAnswer = normalizeExplicitYesNo(transcript);

  if (explicitAnswer === null) {
    requestAssistantResponse({
      queueIfBusy: true,
      allowWhileAwaiting: true,
      preservePendingQuestion: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          'Ask exactly: "Was that a yes or a no?" Say nothing else.'
      }
    });

    return;
  }

  await mergeCallResult(call.call_id, {
    callback_confirmation_explicitly_answered: true,
    callback_confirmation_confirmed: explicitAnswer
  });

  await endLocalWaitingState(
    "explicit_callback_confirmation_answer"
  );

  call = (await getCallById(call.call_id)) || call;

  if (!explicitAnswer) {
    requestAssistantResponse({
      queueIfBusy: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          'Ask exactly: "No problem. What date and time would work better for you?" Say nothing else.'
      }
    });

    return;
  }

  const callbackAt =
    cleanText(call.result?.callback_at, 100);

  const customerLocalDate =
    cleanText(call.result?.callback_local_date, 100);

  const customerLocalTime =
    cleanText(call.result?.callback_local_time, 100);

  const timezone = resolveCustomerTimezone(
    call.result?.callback_timezone,
    call.callback_timezone
  );

  const reason =
    cleanText(call.result?.callback_reason, 1000) ||
    "Application checkpoint";

  const scheduleResult = await executeDougTool(
    call,
    "schedule_callback",
    {
      callback_at: callbackAt,
      customer_local_date: customerLocalDate,
      customer_local_time: customerLocalTime,
      timezone,
      reason,
      prospect_confirmed: true,
      discussion_summary:
        cleanText(call.summary, 4000) ||
        cleanText(call.result?.discussion_summary, 4000)
    },
    sessionCallPhase
  );

  if (!scheduleResult?.success) {
    console.error(JSON.stringify({
      event: "confirmed_callback_schedule_failed",
      call_id: call.call_id,
      error: scheduleResult?.error || "unknown"
    }));

    requestAssistantResponse({
      queueIfBusy: true,
      response: {
        output_modalities: ["audio"],
        instructions:
          "Say exactly: \"I'm sorry, I couldn't complete the scheduling. Let's verify the date and time one more time.\" Say nothing else."
      }
    });

    return;
  }

  const confirmedAppointment =
    formatCustomerCallbackTime(
      scheduleResult.callback_at,
      scheduleResult.timezone || timezone
    );

  requestAssistantResponse({
    queueIfBusy: true,
    response: {
      output_modalities: ["audio"],
      instructions: `Say exactly: ${JSON.stringify(
        `Excellent. I have us scheduled to speak on ${confirmedAppointment}.`
      )} Then use complete_call with outcome "follow_up_scheduled", next_action "Complete the application before Call Two", a concise summary, stop_sequence false, and pause_sequence false.`
    }
  });

  return;
}
    const professionalAnswerKey = ["has_realtor", "applied_with_lender"].includes(
      String(pendingQuestionType || "")
    )
      ? pendingQuestionType
      : null;
    if (professionalAnswerKey) {
      const explicitAnswer = normalizeExplicitYesNo(transcript);
      if (explicitAnswer !== null) {
        const storedAnswer = explicitAnswer ? "Yes" : "No";
        await mergeCallResult(call.call_id, {
          [professionalAnswerKey]: storedAnswer,
          ...(professionalAnswerKey === "applied_with_lender"
            ? { has_lender: storedAnswer }
            : {})
        });
        call = (await getCallById(call.call_id)) || call;
        await endLocalWaitingState("explicit_professional_yes_no_answer");
        requestAssistantResponse({ queueIfBusy: true });
        return;
      }
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

  async function physicallyEndActiveTwilioCall(reason) {
    if (
      !normalEndRequested ||
      finalHangupInProgress ||
      finalHangupCompleted ||
      finalHangupAttemptCount >= 3
    ) {
      return false;
    }

    finalHangupInProgress = true;

    try {
      const refreshedCall =
        (await getCallById(call.call_id)) || call;
      const twilioCallSid =
        activeTwilioCallSid ||
        String(
          refreshedCall?.twilio_call_sid ||
          call?.twilio_call_sid ||
          ""
        ).trim();

      if (!twilioCallSid) {
        throw new Error(
          "No live Twilio Call SID is available."
        );
      }

      let updatedCall = null;
      let lastUpdateError = null;
      while (finalHangupAttemptCount < 3) {
  finalHangupAttemptCount += 1;

  try {
    updatedCall = await twilioClient
      .calls(twilioCallSid)
      .update({
        status: "completed"
      });

    lastUpdateError = null;
    break;
  } catch (error) {
    lastUpdateError = error;

    if (finalHangupAttemptCount < 3) {
      await sleep(finalHangupAttemptCount === 1 ? 500 : 1000);
    }
  }
}
      if (lastUpdateError) throw lastUpdateError;

      finalHangupCompleted = true;
      if (finalHangupFallbackTimer) {
        clearTimeout(finalHangupFallbackTimer);
        finalHangupFallbackTimer = null;
      }
      if (finalAbsoluteHangupTimer) {
        clearTimeout(finalAbsoluteHangupTimer);
        finalAbsoluteHangupTimer = null;
      }
      await appendAction(call.call_id, {
        action: "twilio_physical_hangup",
        success: true,
        reason,
        twilio_call_sid: twilioCallSid,
        twilio_status: updatedCall?.status || "completed"
      });

      console.log(JSON.stringify({
        event: "twilio_physical_hangup",
        call_id: call.call_id,
        twilio_call_sid: twilioCallSid,
        twilio_status: updatedCall?.status || null,
        reason,
        success: true
      }));

      return true;
    } catch (error) {
      const safeError =
        cleanText(error.message, 1000) ||
        "Twilio physical hangup failed.";

      await appendAction(call.call_id, {
        action: "twilio_physical_hangup",
        success: false,
        reason,
        error: safeError
      });

      console.error(JSON.stringify({
        event: "twilio_physical_hangup",
        call_id: call.call_id,
        reason,
        success: false,
        error: safeError
      }));

      return false;
    } finally {
      finalHangupInProgress = false;
    }
  }

  async function handleToolCall(name, toolCallId, argumentText) {
    if (!call || !toolCallId || handledToolCalls.has(toolCallId)) return;
    if (currentCallIsTerminal()) return;
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
        execute: (activeCall, toolName, toolArgs) =>
          executeDougTool(
            activeCall,
            toolName,
            toolArgs,
            sessionCallPhase
          )
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
    const scheduleCallbackSucceeded =
      name === "schedule_callback" &&
      output?.success === true &&
      output?.intent === "schedule_callback" &&
      output?.error === null;
    const terminalActionSucceeded =
      completeCallSucceeded || scheduleCallbackSucceeded;

    if (terminalActionSucceeded) {
      beginNormalCallTermination(name);
      normalCompletionRecorded = true;
      await pool.query(
        `
          UPDATE ai_calls
          SET
            next_attempt_at = CASE
              WHEN callback_requested AND callback_at > NOW() THEN callback_at
              ELSE NULL
            END,
            current_state = CASE
              WHEN current_state IN ('reconnect_pending', 'reconnect_in_progress')
                THEN 'completed'
              ELSE current_state
            END,
            last_error = NULL,
            result = result
              - 'unexpected_disconnect_reconnect_scheduled'
              - 'unexpected_disconnect_at'
              - 'reconnect_at'
              - 'unexpected_disconnect_reconnect_attempted'
              - 'unexpected_disconnect_reconnect_completed',
            updated_at = NOW()
          WHERE call_id = $1
        `,
        [call.call_id]
      );
      await pool.query(
        `
          UPDATE call_attempts
          SET technical_status = 'canceled', completed_at = NOW(),
              cancellation_reason = 'normal_call_completion', updated_at = NOW()
          WHERE call_id = $1
            AND attempt_id IS DISTINCT FROM $2
            AND attempt_type IN ('cadence', 'disconnect_reconnect')
            AND completed_at IS NULL
            AND technical_status IN ('pending', 'scheduled', 'created')
        `,
        [call.call_id, call.last_attempt_id]
      );
      await mergeCallResult(call.call_id, {
        normal_completion_recorded: true,
        final_hangup_requested: true,
        completion_reason: "normal_completion",
        terminal_action: name,
        normal_completion_recorded_at: new Date().toISOString()
      });
      call = (await getCallById(call.call_id)) || call;
    }

    if (
      name === "save_call_progress" &&
      output?.success === true &&
      exactMeaningfulPurchaseArea(args?.answers?.purchase_area)
    ) {
      call = (await getCallById(call.call_id)) || call;
      refreshActiveRealtimeInstructions();
    }

    sendToOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(output)
      }
    });
    if (terminalActionSucceeded) {
      const lead = call.payload || {};
      const customerName =
        cleanText(
          lead.first_name || lead.customer_name || lead.name,
          160
        ) || "the customer";
      requestAssistantResponse({
        queueIfBusy: true,
        allowTerminalClosing: true,
        response: {
          output_modalities: ["audio"],
          instructions: `Say exactly: "If there's nothing else, thank you for your time, ${customerName}. Have a great day." Then stop speaking. Do not ask a question. Do not wait for another response. Do not call another tool. Do not add any other sentence.`
        }
      });
    } else {
      requestAssistantResponse({ queueIfBusy: true });
    }
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
        instructions: buildDouglasDaisyInstructions(call, sessionCallPhase),
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
          if (
            normalEndRequested &&
            finalClosingRequested &&
            !finalClosingResponseId
          ) {
            finalClosingResponseId = cleanText(
              event.response?.id || event.response_id,
              160
            ) || "";
          }
          activeResponsePreservesQuestion = pendingResponsePreservesQuestion;
          pendingResponsePreservesQuestion = false;
          activeResponseWaitingPromptKind = pendingResponseWaitingPromptKind;
          pendingResponseWaitingPromptKind = null;
          assistantTranscriptBuffer = "";
          assistantTranscriptSaved = false;
          questionCapturedForResponse = false;
          assistantAudioQueuedForResponse = false;
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
          assistantAudioQueuedForResponse = true;
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
          if (!assistantTranscriptBuffer && event.transcript) {
            assistantTranscriptBuffer = event.transcript;
          }
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
          const completedResponseId = cleanText(
            event.response?.id || event.response_id,
            160
          ) || "";
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
          if (
            normalEndRequested &&
            completedResponseId &&
            completedResponseId === finalClosingResponseId &&
            assistantAudioQueuedForResponse &&
            !finalPlaybackMarkName &&
            !finalHangupCompleted
          ) {
            sendFinalHangupMark();
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
          if (!normalEndRequested) scheduleSilenceReminder();
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

        const activeAttempt = call.last_attempt_id
          ? await getAttemptById(call.last_attempt_id)
          : null;
        lockSessionCallPhase(call, activeAttempt);
        console.log(JSON.stringify({
          event: "media_session_phase_locked",
          call_id: call.call_id,
          session_call_phase: sessionCallPhase
        }));

        activeTwilioCallSid =
          String(message?.start?.callSid || "").trim();
        activeTwilioStreamSid =
          String(
            message?.start?.streamSid ||
            message?.streamSid ||
            ""
          ).trim();
        streamSid = activeTwilioStreamSid;
        console.log(JSON.stringify({
          event: "twilio_live_call_captured",
          call_id: call?.call_id || null,
          twilio_call_sid: activeTwilioCallSid || null,
          twilio_stream_sid: activeTwilioStreamSid || null
        }));
        await updateCallStatus(
          call.call_id,
          "in-progress",
          activeTwilioCallSid
            ? { twilio_call_sid: activeTwilioCallSid }
            : {}
        );
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
        const returnedMarkName =
          String(message?.mark?.name || "").trim();
        if (returnedMarkName) pendingMarkNames.delete(returnedMarkName);
        if (
          returnedMarkName &&
          returnedMarkName === finalPlaybackMarkName
        ) {
          console.log(JSON.stringify({
            event: "final_hangup_mark_received",
            call_id: call.call_id,
            mark_name: returnedMarkName
          }));
          void physicallyEndActiveTwilioCall(
            "final_audio_playback_complete"
          );
        }
        if (!pendingMarkNames.size) {
          scheduleSilenceReminder();
        }
        return;
      }

      if (message.event === "media") {
        const payload = message.media?.payload;
        latestMediaTimestamp = Number(message.media?.timestamp || 0);
        if (!payload || currentCallIsTerminal()) return;

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
        if (
          call &&
          !normalEndRequested &&
          !finalClosingRequested &&
          !finalPlaybackMarkName &&
          !finalHangupInProgress &&
          !normalCompletionRecorded &&
          !finalHangupCompleted
        ) {
          void scheduleUnexpectedReconnect(call.call_id).catch((error) => {
            console.error("Failed to schedule disconnect reconnect:", error);
          });
        } else if (call) {
          console.log(JSON.stringify({
            event: "unexpected_reconnect_skipped",
            call_id: call.call_id,
            reason: "normal_terminal_call"
          }));
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
    if (
      call &&
      !normalEndRequested &&
      !finalClosingRequested &&
      !finalPlaybackMarkName &&
      !finalHangupInProgress &&
      !normalCompletionRecorded &&
      !finalHangupCompleted
    ) {
      void scheduleUnexpectedReconnect(call.call_id).catch((error) => {
        console.error("Failed to schedule disconnect reconnect:", error);
      });
    } else if (call) {
      console.log(JSON.stringify({
        event: "unexpected_reconnect_skipped",
        call_id: call.call_id,
        reason: "normal_terminal_call"
      }));
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
          AND ac.do_not_call = FALSE
          AND ac.wrong_number = FALSE
          AND ac.invalid_number = FALSE
          AND ac.sequence_status <> 'paused'
          AND ac.status NOT IN ('placing', 'queued', 'initiated', 'ringing', 'answered', 'in-progress', 'canceled', 'cancelled')
          AND (
            ac.twilio_call_sid IS NULL
            OR ac.status IN ('busy', 'failed', 'no-answer', 'completed')
          )
          AND (
            CASE
              WHEN ca.attempt_type IN ('customer_callback', 'application_checkpoint')
                THEN COALESCE(ac.callback_at, ac.next_attempt_at)
              ELSE ac.next_attempt_at
            END
          ) IS NOT NULL
          AND (
            CASE
              WHEN ca.attempt_type IN ('customer_callback', 'application_checkpoint')
                THEN COALESCE(ac.callback_at, ac.next_attempt_at)
              ELSE ac.next_attempt_at
            END
          ) <= NOW()
          AND (
            (
              ca.attempt_type IN ('customer_callback', 'application_checkpoint')
              AND ac.callback_requested = TRUE
              AND ac.callback_at = ca.scheduled_at
              AND ca.attempt_id IS DISTINCT FROM ac.last_attempt_id
            )
            OR (
              ac.status <> 'completed'
              AND ac.sequence_status <> 'completed'
              AND COALESCE(ac.result->>'normal_completion_recorded', 'false') <> 'true'
              AND COALESCE(ac.result->>'completion_reason', '') <> 'normal_completion'
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(ac.actions) AS action
                WHERE action->>'action' = 'complete_call'
                  AND COALESCE((action->>'success')::BOOLEAN, FALSE) = TRUE
              )
            )
          )
          AND (
            (
              COALESCE(ac.result->>'outbound_call_reason', ac.payload->>'outbound_call_reason', '') = 'initial_lead_call'
              AND ca.attempt_type = 'initial_lead_call'
              AND ac.next_attempt_at IS NOT NULL
              AND ac.next_attempt_at <= NOW()
              AND ac.attempts = 0
              AND ac.last_attempt_id IS NULL
              AND ac.result->>'initial_call_claimed_at' IS NULL
            )
            OR (
              ac.result->>'outbound_call_reason' = 'scheduled_second_call'
              AND ca.attempt_type IN ('customer_callback', 'application_checkpoint')
              AND ac.callback_requested = TRUE
              AND ac.callback_at IS NOT NULL
              AND ac.callback_at <= NOW()
              AND ac.callback_at = ca.scheduled_at
              AND ac.result->>'scheduled_second_call_appointment_id' IS NOT NULL
              AND ac.result->>'scheduled_second_call_source_call_id' IS NOT NULL
              AND ac.result->>'scheduled_second_call_dialed_at' IS NULL
            )
            OR (
              ac.result->>'outbound_call_reason' = 'unexpected_disconnect_reconnect'
              AND ca.attempt_type = 'disconnect_reconnect'
              AND ac.callback_at IS NOT NULL
              AND ac.callback_at <= NOW()
              AND ac.callback_at = ca.scheduled_at
              AND COALESCE(ac.result->>'unexpected_disconnect_reconnect_scheduled', 'false') = 'true'
              AND COALESCE(ac.result->>'unexpected_disconnect_reconnect_attempted', 'false') <> 'true'
              AND ac.result->>'reconnect_source_call_id' IS NOT NULL
              AND ac.result->>'reconnect_source_twilio_call_sid' IS NOT NULL
            )
          )
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

        await placeTwilioCall(call, {
          attemptId: attempt.attempt_id,
          source: outboundCallSource(attempt)
        });
        const dispatched = await getCallById(call.call_id);
        logSchedulingDecision(
          dispatched,
          attempt,
          "dispatch",
          "due_attempt_dispatched_immediately",
          currentTime
        );
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
              sequence_status = 'human_action',
              next_attempt_at = NULL,
              last_error = $2,
              result = result || $3::jsonb,
              updated_at = NOW()
            WHERE call_id = $1
          `,
          [
            row.call_id,
            cleanText(error.message, 4000),
            JSON.stringify({ automatic_redial_disabled: true })
          ]
        );

        await pool.query(
          `UPDATE call_attempts SET technical_status = 'failed',
           completed_at = NOW(),
           updated_at = NOW() WHERE attempt_id = $1 AND completed_at IS NULL`,
          [row.attempt_id]
        );

        queueMondaySync(row.call_id, "scheduler_failure_no_redial");
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
