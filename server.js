const express = require("express");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const { Pool } = require("pg");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

/*
 * HELUX AI WORKFORCE — DOUG 2.1
 * Recovery + operating-system build
 *
 * This file restores the working Twilio/OpenAI caller and safely integrates:
 * - Doug 2.1 conversation rules
 * - Realtime function tools
 * - six-attempt adaptive cadence
 * - call sequence and attempt tracking
 * - callback scheduling
 * - SMS application/DTI links
 * - specialist handoff and optional live transfer
 * - structured HELUX OS result callbacks
 *
 * The operating configuration is valid JavaScript inside this file. Raw JSON
 * must never replace server.js.
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

const OPENAI_VOICE =
  process.env.OPENAI_VOICE || "marin";

const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "";

const TWILIO_ACCOUNT_SID =
  process.env.TWILIO_ACCOUNT_SID;

const TWILIO_AUTH_TOKEN =
  process.env.TWILIO_AUTH_TOKEN;

const TWILIO_FROM_NUMBER =
  process.env.TWILIO_FROM_NUMBER;

const SPECIALIST_PHONE_NUMBER =
  process.env.SPECIALIST_PHONE_NUMBER || "";

const DPA_APPLICATION_URL =
  process.env.DPA_APPLICATION_URL ||
  "https://www.dpahelpcenter.com";

const DTI_CALCULATOR_URL =
  process.env.DTI_CALCULATOR_URL ||
  "https://www.dpahelpcenter.com/dti";

const CALL_SCHEDULER_ENABLED =
  String(
    process.env.CALL_SCHEDULER_ENABLED ||
      "false"
  ).toLowerCase() === "true";

const ENFORCE_CALL_CONSENT =
  String(
    process.env.ENFORCE_CALL_CONSENT ||
      "false"
  ).toLowerCase() === "true";

const DEFAULT_TIMEZONE =
  process.env.DEFAULT_TIMEZONE ||
  "America/New_York";

const SCHEDULER_INTERVAL_MS =
  Math.max(
    30000,
    Number(
      process.env.SCHEDULER_INTERVAL_MS ||
        60000
    )
  );

const REQUIRED_ENVIRONMENT = {
  DATABASE_URL,
  HELUX_API_KEY,
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER
};

const missingEnvironment =
  Object.entries(
    REQUIRED_ENVIRONMENT
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

if (missingEnvironment.length) {
  console.error(
    `Missing required environment variables: ${missingEnvironment.join(
      ", "
    )}`
  );

  process.exit(1);
}

const DOUG_CONFIG =
  Object.freeze({
    agentVersion:
      "doug-2.1.0",

    promptVersion:
      "dpa-readiness-v1",

    toolVersion:
      "tools-v1",

    knowledgeVersion:
      "dpa-general-v1",

    routingVersion:
      "dpa-routing-v1",

    cadenceVersion:
      "dpa-ready-6-attempt-adaptive-v2",

    maxAttempts:
      6,

    maxVoicemails:
      2,

    minimumGapMinutes:
      180,

    operatingWindow: {
      weekdayStart:
        "09:00",

      weekdayEnd:
        "19:30",

      saturdayStart:
        "10:00",

      saturdayEnd:
        "16:00",

      sundayEnabled:
        false
    },

    preferredWindows: {
      morning:
        "09:15",

      lateAfternoon:
        "16:30"
    },

    voiceRules: {
      maximumResponseSeconds:
        12,

      questionsPerTurn:
        1,

      interruptible:
        true
    }
  });

const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    max:
      10,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      10000
  });

const twilioClient =
  twilio(
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN
  );

const app =
  express();

app.set(
  "trust proxy",
  true
);

app.use(
  express.json({
    limit:
      "1mb"
  })
);

app.use(
  express.urlencoded({
    extended:
      false
  })
);

const server =
  http.createServer(
    app
  );

const mediaServer =
  new WebSocketServer({
    noServer:
      true
  });

let schedulerTimer =
  null;

let schedulerRunning =
  false;

class HttpError extends Error {
  constructor(
    statusCode,
    message
  ) {
    super(message);

    this.statusCode =
      statusCode;
  }
}

function cleanText(
  value,
  maximumLength = 255
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const text =
    String(value).trim();

  return text
    ? text.slice(
        0,
        maximumLength
      )
    : null;
}

function normalizeBoolean(
  value
) {
  if (
    value === true ||
    value === false
  ) {
    return value;
  }

  const normalized =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "true",
      "yes",
      "1",
      "confirmed",
      "granted"
    ].includes(
      normalized
    )
  ) {
    return true;
  }

  if (
    [
      "false",
      "no",
      "0",
      "denied",
      "revoked"
    ].includes(
      normalized
    )
  ) {
    return false;
  }

  return null;
}

function normalizePhone(
  value
) {
  const original =
    cleanText(
      value,
      50
    );

  if (!original) {
    return null;
  }

  const digits =
    original.replace(
      /\D/g,
      ""
    );

  if (
    digits.length === 10
  ) {
    return `+1${digits}`;
  }

  if (
    digits.length >= 11 &&
    digits.length <= 15
  ) {
    return `+${digits}`;
  }

  return original;
}

function authenticateHelux(
  req,
  res,
  next
) {
  const provided =
    req.headers[
      "x-helux-key"
    ];

  if (
    !provided ||
    Array.isArray(
      provided
    ) ||
    provided !==
      HELUX_API_KEY
  ) {
    return res
      .status(401)
      .json({
        success:
          false,

        error:
          "Unauthorized."
      });
  }

  next();
}

function createPublicId(
  prefix
) {
  return `${prefix}-${Date.now()
    .toString(36)
    .toUpperCase()}-${randomUUID()
    .split("-")[0]
    .toUpperCase()}`;
}

function createStreamToken() {
  return (
    randomUUID().replace(
      /-/g,
      ""
    ) +
    randomUUID().replace(
      /-/g,
      ""
    )
  );
}

function safetyIdentifier(
  call
) {
  return createHash(
    "sha256"
  )
    .update(
      String(
        call.case_id ||
          call.lead_id ||
          call.call_id
      )
    )
    .digest("hex");
}

function websocketBaseUrl() {
  return PUBLIC_BASE_URL
    .replace(
      /^http:/,
      "ws:"
    )
    .replace(
      /^https:/,
      "wss:"
    );
}

function callRequestKey(
  payload
) {
  const caseId =
    cleanText(
      payload.case_id,
      150
    );

  const leadId =
    cleanText(
      payload.lead_id,
      150
    );

  if (caseId) {
    return `case:${caseId}`;
  }

  if (leadId) {
    return `lead:${leadId}`;
  }

  throw new HttpError(
    422,
    "case_id or lead_id is required."
  );
}

function terminalCallStatus(
  status
) {
  return [
    "completed",
    "busy",
    "failed",
    "no-answer",
    "canceled"
  ].includes(
    String(
      status || ""
    ).toLowerCase()
  );
}

function stopOutcome(
  outcome
) {
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
  ].includes(
    String(
      outcome || ""
    ).toLowerCase()
  );
}

function confirmedConsent(
  payload
) {
  const explicit =
    normalizeBoolean(
      payload.consent_confirmed ??
        payload.ai_voice_consent
    );

  if (
    explicit !== null
  ) {
    return explicit;
  }

  const status =
    String(
      payload.consent_status ||
        ""
    ).toLowerCase();

  return [
    "confirmed",
    "granted",
    "approved",
    "yes"
  ].includes(status);
}

function buildAgentInstructions(
  call
) {
  const lead =
    call.payload || {};

  const result =
    call.result || {};

  const firstName =
    cleanText(
      lead.first_name,
      80
    ) || "there";

  const city =
    cleanText(
      lead.city,
      100
    ) || "their area";

  const state =
    cleanText(
      lead.state,
      50
    ) || "";

  const creditScore =
    lead.credit_score ??
    "not provided";

  const income =
    lead.household_income ??
    lead.income ??
    "not provided";

  const homePrice =
    lead.home_price ??
    "not provided";

  const estimatedDpa =
    lead.estimated_dpa ??
    "not provided";

  const employment =
    cleanText(
      lead.employment ||
        lead.employment_history,
      150
    ) || "not provided";

  const taxes =
    cleanText(
      lead.taxes_filed ||
        lead.tax_return_history,
      100
    ) || "not provided";

  const readinessScore =
    lead.readiness_score ??
    "not provided";

  const currentState =
    cleanText(
      call.current_state,
      80
    ) || "greeting";

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
