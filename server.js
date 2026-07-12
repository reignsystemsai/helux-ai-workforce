const express = require("express");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const { Pool } = require("pg");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

/*
 * HELUX AI WORKFORCE — DOUG 2.1.2
 * Working Twilio/OpenAI caller + isolated monday.com command-center adapter.
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
  agentVersion: "doug-2.1.2",
  promptVersion: "dpa-readiness-v1",
  toolVersion: "tools-v1",
  knowledgeVersion: "dpa-general-v1",
  routingVersion: "dpa-routing-v1",
  cadenceVersion: "dpa-ready-6-attempt-adaptive-v2",
  mondayAdapterVersion: "monday-call-control-v1",
  maxAttempts: 6,
  maxVoicemails: 2,
  minimumGapMinutes: 180,
  operatingWindow: {
    weekdayStart: "09:00",
    weekdayEnd: "19:30",
    saturdayStart: "10:00",
    saturdayEnd: "16:00",
    sundayEnabled: false
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

function normalizeTimezone(value) {
  const candidate = cleanText(value, 100) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
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
    "specialist_callback",
    "application_link_sent",
    "dti_calculator_sent",
    "needs_review",
    "nurture",
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

function buildAgentInstructions(call) {
  const lead = call.payload || {};
  const result = call.result || {};
  const firstName = cleanText(lead.first_name, 80) || "there";
  const city = cleanText(lead.city, 100) || "their area";
  const state = cleanText(lead.state, 50) || "";
  const creditScore = lead.credit_score ?? "not provided";
  const income = lead.household_income ?? lead.income ?? "not provided";
  const homePrice = lead.home_price ?? "not provided";
  const estimatedDpa = lead.estimated_dpa ?? "not provided";
  const employment =
    cleanText(lead.employment || lead.employment_history, 150) ||
    "not provided";
  const taxes =
    cleanText(lead.taxes_filed || lead.tax_return_history, 100) ||
    "not provided";
  const readinessScore = lead.readiness_score ?? "not provided";
  const currentState = cleanText(call.current_state, 80) || "greeting";

  return `
You are Doug, the AI workforce readiness specialist for DPA Help Center.
You are calling ${firstName}, who completed a homebuyer readiness process.

IDENTITY
- Your name is Doug.
- Clearly disclose that you are an AI assistant for DPA Help Center.
- You are not a lender and you do not approve loans.
- Never claim to be human.

VOICE STANDARD
- Sound warm, premium, calm, confident, and conversational.
- Never sound like a telemarketer.
- Keep most turns under two short sentences and approximately ${DOUG_CONFIG.voiceRules.maximumResponseSeconds} seconds.
- Ask exactly one question at a time and pause for the answer.
- Stop immediately when interrupted.
- Natural acknowledgements include: "Okay," "I see," "Understood," "That makes sense," "Got it," and "Perfect."
- Avoid long speeches, repetition, sales hype, and robotic transitions.

PRIVACY
- Before identity is confirmed, do not disclose credit, income, readiness score, home price, assistance estimate, or other financial information.
- If this is the wrong person or wrong number, apologize, use mark_contact_restriction, and end.

KNOWN LEAD CONTEXT
- First name: ${firstName}
- Location: ${city}${state ? `, ${state}` : ""}
- Credit score submitted: ${creditScore}
- Household income submitted: ${income}
- Employment submitted: ${employment}
- Tax history submitted: ${taxes}
- Target home price: ${homePrice}
- Readiness score: ${readinessScore}
- Estimated assistance shown: ${estimatedDpa}
- Current conversation state: ${currentState}
- Previously saved call information: ${JSON.stringify(result)}

LEAD INTELLIGENCE RULE
- Never ask for information already known unless you are confirming that it is still accurate, it is missing, or the customer says it changed.
- Confirm known information instead of restarting the website intake.

STATE MACHINE
1. Greeting: ask for ${firstName} without revealing private information.
2. Identity verification: confirm the person, disclose that you are an AI assistant, and ask whether now is a good time.
3. Readiness confirmation: confirm that the submitted credit, income, employment, and tax information remains current.
4. Application status: determine whether they only completed the readiness form, received an application link, started an application, submitted one, or are already preapproved.
5. Qualification: confirm buying timeline, target area, Realtor status, and lender status.
6. DTI snapshot when needed: collect gross monthly household income and recurring monthly credit obligations, then call calculate_preliminary_dti.
7. Program guidance: explain broadly that state, county, city, and lender-based options may exist and a specialist must verify the best fit.
8. Routing: select the correct action—application link, DTI calculator, specialist handoff, live transfer, callback, review, or nurture.
9. Closing: confirm exactly what happened and what happens next.
10. Follow-up scheduling: collect date, time, timezone, and reason; repeat the appointment before calling schedule_callback.

EMOTIONAL INTELLIGENCE
- Detect frustration, confusion, skepticism, urgency, excitement, hesitation, fear, or disappointment.
- Acknowledge the emotion first, then provide one simple next step.

DTI RULE
- Include credit-card minimums, vehicle payments, student loans, personal loans, child support, alimony, and other recurring credit obligations.
- Do not include groceries, utilities, phone service, or normal living expenses.
- Always call the result a preliminary estimate, not an underwriting result.

PROGRAM GUIDANCE
- Give broad information that can fit a qualified homebuyer.
- Never guess or select a final program.
- Say: "A specialist will verify current program availability and eligibility" when exact details are uncertain.

COMPLIANCE
- Never guarantee approval, eligibility, a loan, an interest rate, a closing date, or a specific assistance amount.
- Final eligibility depends on the program, lender, income, property, credit, and documentation review.
- Never request a Social Security number, full date of birth, bank login, card number, password, or one-time code.
- Do not give legal, tax, or financial advice.
- If the person says stop calling, remove me, do not call, or similar, apologize, call mark_contact_restriction with do_not_call, and end promptly.

TOOLS
- Use save_call_progress as meaningful information is confirmed.
- Use calculate_preliminary_dti for DTI math.
- Use send_resource_link only after the customer agrees to receive the link.
- Use schedule_callback only after repeating and confirming the callback time.
- Use create_specialist_handoff when a human should follow up.
- Use transfer_to_specialist only after the customer explicitly agrees to a live transfer.
- Use mark_contact_restriction immediately for wrong number, invalid number, opt-out, or not interested.
- Use complete_call before ending every connected conversation.
- Never say an action succeeded until the tool returns success.

OPENING
First ask: "Hi, may I speak with ${firstName}?"
After identity is confirmed, say: "Hi ${firstName}, this is Doug, an AI assistant with DPA Help Center. You recently completed our homebuyer readiness process. Did I catch you at an okay time for a quick call?"
`.trim();
}

const DOUG_TOOLS = [
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
      "Send the approved DPA application link or DTI calculator link by SMS after customer confirmation.",
    parameters: {
      type: "object",
      properties: {
        resource_type: {
          type: "string",
          enum: ["application", "dti_calculator"]
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
        preferred_contact_method: {
          type: "string",
          enum: ["phone", "sms", "email"]
        },
        prospect_confirmed: { type: "boolean" }
      },
      required: [
        "callback_at",
        "timezone",
        "reason",
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
            "technical_failure"
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
    ["callback_requested", "BOOLEAN NOT NULL DEFAULT FALSE"]
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
    ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
    ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"]
  ];

  for (const [columnName, definition] of attemptColumns) {
    await runMigrationStep(
      `call_attempts.${columnName}`,
      `ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`
    );
  }

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
    ]
  ];

  for (const [name, sql] of indexSteps) {
    await runMigrationStep(name, sql, { optional: true });
  }

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
  const labels = Array.isArray(settings.labels) ? settings.labels : [];
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
    application_link_sent: "Application Sent",
    dti_calculator_sent: "DTI Sent",
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
  if (call.do_not_call || call.wrong_number || call.invalid_number) {
    return "Closed or Suppressed";
  }

  const status = String(call.sequence_status || "").toLowerCase();
  if (status === "ready") return "Ready to Call";
  if (["scheduled", "calling", "waiting_retry", "paused"].includes(status)) {
    return "Active Sequences";
  }
  if (status === "callback_scheduled") return "Callbacks";
  if (["human_action", "exhausted"].includes(status)) {
    return "Human Action Needed";
  }
  if (status === "completed") return "Completed";
  if (status === "suppressed") return "Closed or Suppressed";
  return "Active Sequences";
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

  assignMondayValue(values, board, ["Lead ID"], call.lead_id);
  assignMondayValue(values, board, ["Case ID"], call.case_id);
  assignMondayValue(values, board, ["Phone"], call.phone);
  assignMondayValue(values, board, ["Time Zone", "Timezone"], call.timezone);
  assignMondayValue(values, board, ["AI Agent", "Agent"], "Doug");
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
  return localDayOfWeek(parts) !== 0;
}

function operatingWindowForParts(parts) {
  const day = localDayOfWeek(parts);
  if (day === 0) return null;
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
  const timeZone = call.timezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const attempt = Number(call.attempts || 0);
  const localNow = zonedParts(now, timeZone);

  if (attempt <= 1) {
    if (localNow.hour < 13) {
      const sameDayAfternoon = zonedDateTimeToUtc(
        candidateLocalDate(
          localNow,
          0,
          DOUG_CONFIG.preferredWindows.lateAfternoon
        ),
        timeZone
      );

      if (
        sameDayAfternoon.getTime() - now.getTime() >=
          DOUG_CONFIG.minimumGapMinutes * 60000 &&
        insideOperatingWindow(sameDayAfternoon, timeZone)
      ) {
        return sameDayAfternoon;
      }
    }

    return nextValidWindow(
      timeZone,
      now,
      DOUG_CONFIG.preferredWindows.morning,
      DOUG_CONFIG.minimumGapMinutes
    );
  }

  if (attempt === 2) {
    const lastWasAfternoon = localNow.hour >= 14;
    return nextValidWindow(
      timeZone,
      new Date(now.getTime() + 12 * 60 * 60 * 1000),
      lastWasAfternoon
        ? DOUG_CONFIG.preferredWindows.morning
        : DOUG_CONFIG.preferredWindows.lateAfternoon,
      0
    );
  }

  if (attempt === 3) {
    return nextValidWindow(
      timeZone,
      new Date(now.getTime() + 36 * 60 * 60 * 1000),
      DOUG_CONFIG.preferredWindows.lateAfternoon,
      0
    );
  }

  if (attempt === 4) {
    return nextValidWindow(
      timeZone,
      new Date(now.getTime() + 60 * 60 * 60 * 1000),
      DOUG_CONFIG.preferredWindows.morning,
      0
    );
  }

  return nextValidWindow(
    timeZone,
    new Date(now.getTime() + 72 * 60 * 60 * 1000),
    DOUG_CONFIG.preferredWindows.lateAfternoon,
    0
  );
}

async function finalizeCadenceAfterTerminal(callId, technicalStatus) {
  const call = await getCallById(callId);
  if (!call) return;

  const transcriptCount = Array.isArray(call.transcript)
    ? call.transcript.length
    : 0;
  const outcome = String(call.outcome || "").toLowerCase();

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
  const refreshedCall = await getCallById(call.call_id);
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
    Number(refreshedCall.attempts || 0) >=
    Number(refreshedCall.max_attempts || DOUG_CONFIG.maxAttempts)
  ) {
    throw new HttpError(409, "Maximum call attempts have been reached.");
  }

  const voiceUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/voice`);
  voiceUrl.searchParams.set("call_id", refreshedCall.call_id);
  voiceUrl.searchParams.set("token", refreshedCall.stream_token);

  const statusUrl = new URL(`${PUBLIC_BASE_URL}/api/v1/twilio/status`);
  statusUrl.searchParams.set("call_id", refreshedCall.call_id);
  statusUrl.searchParams.set("token", refreshedCall.stream_token);

  const attemptNumber = Number(refreshedCall.attempts || 0) + 1;
  const attemptId = createPublicId("ATTEMPT");

  await pool.query(
    `
      INSERT INTO call_attempts (
        attempt_id, call_id, attempt_number, call_leg,
        scheduled_at, dialed_at, technical_status
      )
      VALUES ($1, $2, $3, 1, COALESCE($4, NOW()), NOW(), 'placing')
    `,
    [
      attemptId,
      refreshedCall.call_id,
      attemptNumber,
      refreshedCall.next_attempt_at
    ]
  );

  await pool.query(
    `
      UPDATE ai_calls
      SET
        status = 'placing',
        sequence_status = 'calling',
        attempts = attempts + 1,
        last_attempt_id = $2,
        last_attempt_at = NOW(),
        next_attempt_at = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = NOW()
      WHERE call_id = $1
    `,
    [refreshedCall.call_id, attemptId]
  );

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

async function executeDougTool(call, name, args) {
  const safeArgs = args && typeof args === "object" ? args : {};

  if (name === "save_call_progress") {
    const currentState = cleanText(safeArgs.current_state, 80) || "unknown";
    const nextState = cleanText(safeArgs.next_state, 80);
    const sentiment = cleanText(safeArgs.sentiment, 50);
    const answers = safeArgs.answers || {};

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
          progress_notes: cleanText(safeArgs.notes, 2000)
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

  if (name === "send_resource_link") {
    if (safeArgs.consent_confirmed !== true) {
      return {
        success: false,
        error: "Customer confirmation is required before sending SMS."
      };
    }

    const resourceType = cleanText(safeArgs.resource_type, 50);
    if (!["application", "dti_calculator"].includes(resourceType)) {
      return { success: false, error: "Unsupported resource type." };
    }

    const resourceUrl =
      resourceType === "dti_calculator"
        ? DTI_CALCULATOR_URL
        : DPA_APPLICATION_URL;
    const description =
      resourceType === "dti_calculator"
        ? "DPA Help Center DTI calculator"
        : "DPA Help Center application";

    try {
      const message = await twilioClient.messages.create({
        to: call.phone,
        from: TWILIO_FROM_NUMBER,
        body: `Here is the ${description} Doug mentioned: ${resourceUrl}`
      });

      const patch =
        resourceType === "dti_calculator"
          ? { dti_calculator_sent: true }
          : { application_link_sent: true };

      await mergeCallResult(call.call_id, patch);
      await appendAction(call.call_id, {
        action: name,
        success: true,
        resource_type: resourceType,
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
        destination: call.phone.replace(/.(?=.{4})/g, "*"),
        message_sid: message.sid
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

    await pool.query(
      `
        UPDATE ai_calls
        SET
          callback_at = $2,
          callback_timezone = $3,
          callback_requested = TRUE,
          next_attempt_at = $2,
          sequence_status = 'callback_scheduled',
          next_action = $4,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [call.call_id, callbackAt, timezone, reason]
    );

    await mergeCallResult(call.call_id, {
      callback_at: callbackAt.toISOString(),
      callback_timezone: timezone,
      callback_reason: reason,
      preferred_contact_method:
        cleanText(safeArgs.preferred_contact_method, 30) || "phone"
    });

    await appendAction(call.call_id, {
      action: name,
      success: true,
      callback_at: callbackAt.toISOString(),
      timezone,
      reason
    });

    queueMondaySync(call.call_id, "callback_scheduled");

    return {
      success: true,
      callback_at: callbackAt.toISOString(),
      timezone,
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
            sequence_status = 'completed',
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
            ELSE 'completed'
          END,
          next_attempt_at = NULL,
          next_action = $6,
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

    let nextAttemptAt = null;
    let sequenceStatus = stopSequence ? "completed" : "waiting_retry";
    if (pauseSequence) sequenceStatus = "paused";

    if (requestedNext) {
      const parsed = new Date(requestedNext);
      if (!Number.isNaN(parsed.getTime()) && parsed > new Date()) {
        nextAttemptAt = parsed;
        sequenceStatus = "scheduled";
      }
    }

    await pool.query(
      `
        UPDATE ai_calls
        SET
          outcome = $2,
          next_action = $3,
          summary = $4,
          sequence_status = $5,
          next_attempt_at = $6,
          updated_at = NOW()
        WHERE call_id = $1
      `,
      [
        call.call_id,
        outcome,
        nextAction,
        summary,
        sequenceStatus,
        nextAttemptAt
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
      stop_sequence: stopSequence,
      pause_sequence: pauseSequence,
      requested_next_call_at: nextAttemptAt
        ? nextAttemptAt.toISOString()
        : null
    });

    await appendAction(call.call_id, {
      action: name,
      success: true,
      outcome,
      stop_sequence: stopSequence,
      pause_sequence: pauseSequence,
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null
    });

    queueMondaySync(call.call_id, `complete_call_${outcome}`);

    return {
      success: true,
      outcome,
      sequence_status: sequenceStatus,
      next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null
    };
  }

  return { success: false, error: `Unknown tool: ${name}` };
}

app.get("/", (req, res) => {
  res.json({
    message: "HELUX AI Workforce is online.",
    version: DOUG_CONFIG.agentVersion,
    worker: "DPA outbound caller",
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
        metadata_cached: Boolean(mondayMetadataCache)
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
      queueMondaySync(call.call_id, "sequence_created");

      const now = new Date();
      const shouldDialNow = forceCallNow || insideOperatingWindow(now, timezone);

      if (!shouldDialNow) {
        const nextAttemptAt = nextValidWindow(
          timezone,
          now,
          DOUG_CONFIG.preferredWindows.morning,
          0
        );

        await pool.query(
          `
            UPDATE ai_calls
            SET
              sequence_status = 'scheduled',
              next_attempt_at = $2,
              updated_at = NOW()
            WHERE call_id = $1
          `,
          [call.call_id, nextAttemptAt]
        );

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

      const twilioCall = await placeTwilioCall(call, { force: forceCallNow });

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
  const handledToolCalls = new Set();

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
    sendToTwilio({
      event: "mark",
      streamSid,
      mark: { name: `openai-${markCounter}` }
    });
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
    sendToOpenAI({
      type: "conversation.item.truncate",
      item_id: lastAssistantItemId,
      content_index: 0,
      audio_end_ms: elapsed
    });

    responseStartTimestamp = null;
    lastAssistantItemId = null;
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
      output = await executeDougTool(refreshed || call, name, args);
    } catch (error) {
      console.error(`Doug tool ${name} failed for ${call.call_id}:`, error);
      output = {
        success: false,
        error: "The action could not be completed. Use a safe fallback."
      };
    }

    sendToOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(output)
      }
    });
    sendToOpenAI({ type: "response.create" });
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
      const inputAudio = {
        format: { type: "audio/pcmu" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true,
          idle_timeout_ms: 12000
        }
      };

      if (OPENAI_TRANSCRIPTION_MODEL) {
        inputAudio.transcription = {
          model: OPENAI_TRANSCRIPTION_MODEL,
          language: "en"
        };
      }

      sendToOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          instructions: buildAgentInstructions(call),
          tools: DOUG_TOOLS,
          tool_choice: "auto",
          audio: {
            input: inputAudio,
            output: {
              format: { type: "audio/pcmu" },
              voice: OPENAI_VOICE
            }
          }
        }
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

        if (event.type === "session.updated" && !initialGreetingStarted) {
          initialGreetingStarted = true;
          sendToOpenAI({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              instructions:
                "Start now with the identity-safe opening. Ask only whether the named person is available. Do not reveal financial information before identity confirmation."
            }
          });
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
          await handleInterruption();
          return;
        }

        if (event.type === "response.output_audio_transcript.done") {
          await appendTranscript(call.call_id, "assistant", event.transcript);
          return;
        }

        if (
          event.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          await appendTranscript(call.call_id, "lead", event.transcript);
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

        if (
          event.type === "response.done" &&
          event.response &&
          Array.isArray(event.response.output)
        ) {
          for (const item of event.response.output) {
            if (item && item.type === "function_call") {
              await handleToolCall(
                item.name,
                item.call_id,
                item.arguments || "{}"
              );
            }
          }
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
        connectToOpenAI();
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

async function runScheduler() {
  if (!CALL_SCHEDULER_ENABLED || schedulerRunning) return;
  schedulerRunning = true;

  try {
    const due = await pool.query(
      `
        SELECT call_id
        FROM ai_calls
        WHERE
          sequence_status IN (
            'scheduled',
            'waiting_retry',
            'callback_scheduled'
          )
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= NOW()
          AND attempts < max_attempts
          AND do_not_call = FALSE
          AND wrong_number = FALSE
          AND invalid_number = FALSE
        ORDER BY next_attempt_at ASC
        LIMIT 10
      `
    );

    for (const row of due.rows) {
      const claim = await pool.query(
        `
          UPDATE ai_calls
          SET sequence_status = 'calling', updated_at = NOW()
          WHERE
            call_id = $1
            AND sequence_status IN (
              'scheduled',
              'waiting_retry',
              'callback_scheduled'
            )
            AND next_attempt_at <= NOW()
          RETURNING *
        `,
        [row.call_id]
      );

      if (!claim.rows[0]) continue;

      try {
        const call = claim.rows[0];
        queueMondaySync(call.call_id, "scheduler_claimed");

        if (!insideOperatingWindow(new Date(), call.timezone || DEFAULT_TIMEZONE)) {
          const nextAttemptAt = nextValidWindow(
            call.timezone || DEFAULT_TIMEZONE,
            new Date(),
            DOUG_CONFIG.preferredWindows.morning,
            0
          );

          await pool.query(
            `
              UPDATE ai_calls
              SET
                sequence_status = 'scheduled',
                next_attempt_at = $2,
                updated_at = NOW()
              WHERE call_id = $1
            `,
            [call.call_id, nextAttemptAt]
          );

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
        await placeTwilioCall(refreshed);
      } catch (error) {
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
        .then((metadata) => {
          console.log(
            `monday.com connected: ${metadata.main.name} (${metadata.main.id})`
          );
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
