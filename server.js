const express = require("express");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const { Pool } = require("pg");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const HELUX_API_KEY = process.env.HELUX_API_KEY;

const HELUX_BASE_URL = String(
  process.env.HELUX_BASE_URL || "https://helux-os.onrender.com"
).replace(/\/+$/, "");

const HELUX_RESULTS_PATH =
  process.env.HELUX_RESULTS_PATH || "/api/v1/calls/results";

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
    "https://helux-ai-workforce.onrender.com"
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

const REQUIRED_ENVIRONMENT = {
  DATABASE_URL,
  HELUX_API_KEY,
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER
};

const missingEnvironment =
  Object.entries(REQUIRED_ENVIRONMENT)
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

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const twilioClient = twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN
);

const app = express();

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(
  express.urlencoded({
    extended: false
  })
);

const server = http.createServer(app);

const mediaServer = new WebSocketServer({
  noServer: true
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
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

  const text = String(value).trim();

  return text
    ? text.slice(0, maximumLength)
    : null;
}

function normalizePhone(value) {
  const original = cleanText(
    value,
    50
  );

  if (!original) {
    return null;
  }

  const digits = original.replace(
    /\D/g,
    ""
  );

  if (digits.length === 10) {
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
    req.headers["x-helux-key"];

  if (
    !provided ||
    Array.isArray(provided) ||
    provided !== HELUX_API_KEY
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  next();
}

function createPublicId(prefix) {
  return `${prefix}-${Date.now()
    .toString(36)
    .toUpperCase()}-${randomUUID()
    .split("-")[0]
    .toUpperCase()}`;
}

function createStreamToken() {
  return (
    randomUUID().replace(/-/g, "") +
    randomUUID().replace(/-/g, "")
  );
}

function safetyIdentifier(call) {
  return createHash("sha256")
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
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
}

function callRequestKey(payload) {
  const caseId = cleanText(
    payload.case_id,
    150
  );

  const leadId = cleanText(
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

function terminalCallStatus(status) {
  return [
    "completed",
    "busy",
    "failed",
    "no-answer",
    "canceled"
  ].includes(
    String(status || "").toLowerCase()
  );
}

function buildAgentInstructions(call) {
  const lead = call.payload || {};

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
      lead.employment,
      150
    ) || "not provided";

  const taxes =
    cleanText(
      lead.taxes_filed,
      100
    ) || "filed_2_years";

  return `
You are Doug, the AI workforce assistant for DPA Help Center.
You are making an outbound call to ${firstName}, who completed a homebuyer readiness form.

IDENTITY AND DISCLOSURE
- Clearly identify yourself as Doug, an AI assistant for DPA Help Center.
- Never claim to be human.
- Speak warmly, naturally, confidently, and briefly.
- Keep most responses to one or two short sentences.

LEAD CONTEXT
- First name: ${firstName}
- Location: ${city}${state ? `, ${state}` : ""}
- Credit score: ${creditScore}
- Household income: ${income}
- Employment history: ${employment}
- Taxes filed: ${taxes}
- Target home price: ${homePrice}
- Estimated assistance shown: ${estimatedDpa}

PRIMARY GOAL
1. Confirm you reached ${firstName}.
2. Ask whether now is a good time for a quick call about their homebuyer readiness results.
3. Explain that their submitted information indicates they may be ready for the next DPA step.
4. Confirm their buying timeline, intended city or area, and whether they want to speak with a home-loan specialist.
5. Capture objections naturally and answer only what you know.
6. End with a clear next action.

COMPLIANCE
- Never guarantee approval, eligibility, a loan, an interest rate, or a specific assistance amount.
- Say that final eligibility depends on program, lender, income, property, credit, and documentation review.
- Do not request a Social Security number, full date of birth, bank login, card number, password, or one-time code.
- Do not give legal, tax, or financial advice.
- If the person says stop calling, do not call, remove me, or similar, apologize, confirm the request, and end promptly.
- If it is the wrong person, apologize and end promptly.

OPENING
Begin with: "Hi ${firstName}, this is Doug, an AI assistant with DPA Help Center. You recently completed our homebuyer readiness form. Did I catch you at an okay time for a quick call?"
`.trim();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_calls (
      id BIGSERIAL PRIMARY KEY,

      call_id VARCHAR(100)
        UNIQUE
        NOT NULL,

      request_key VARCHAR(320)
        UNIQUE
        NOT NULL,

      case_id VARCHAR(150),
      lead_id VARCHAR(150),

      phone VARCHAR(50)
        NOT NULL,

      status VARCHAR(50)
        NOT NULL
        DEFAULT 'created',

      stream_token VARCHAR(160)
        NOT NULL,

      twilio_call_sid VARCHAR(80),

      attempts INTEGER
        NOT NULL
        DEFAULT 0,

      payload JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      transcript JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      result JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      last_error TEXT,

      started_at TIMESTAMPTZ,
      answered_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS
      idx_ai_calls_case_id
      ON ai_calls(case_id);

    CREATE INDEX IF NOT EXISTS
      idx_ai_calls_lead_id
      ON ai_calls(lead_id);

    CREATE INDEX IF NOT EXISTS
      idx_ai_calls_status
      ON ai_calls(status);

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_ai_calls_twilio_sid
      ON ai_calls(twilio_call_sid)
      WHERE twilio_call_sid IS NOT NULL;
  `);

  console.log(
    "HELUX AI Workforce database initialized."
  );
}

async function getCallById(callId) {
  const result = await pool.query(
    `
      SELECT *
      FROM ai_calls
      WHERE call_id = $1
      LIMIT 1
    `,
    [callId]
  );

  return result.rows[0] || null;
}

async function getCallByRequestKey(
  requestKey
) {
  const result = await pool.query(
    `
      SELECT *
      FROM ai_calls
      WHERE request_key = $1
      LIMIT 1
    `,
    [requestKey]
  );

  return result.rows[0] || null;
}

async function validateCallToken(
  callId,
  token
) {
  const result = await pool.query(
    `
      SELECT *
      FROM ai_calls
      WHERE
        call_id = $1
        AND
        stream_token = $2
      LIMIT 1
    `,
    [callId, token]
  );

  return result.rows[0] || null;
}

async function appendTranscript(
  callId,
  speaker,
  text
) {
  const cleaned = cleanText(
    text,
    8000
  );

  if (!cleaned) {
    return;
  }

  const entry = {
    speaker,
    text: cleaned,
    at: new Date().toISOString()
  };

  await pool.query(
    `
      UPDATE ai_calls
      SET
        transcript =
          transcript || $2::jsonb,

        updated_at =
          NOW()

      WHERE
        call_id = $1
    `,
    [
      callId,
      JSON.stringify([entry])
    ]
  );
}

async function updateCallStatus(
  callId,
  status,
  extra = {}
) {
  const statusValue =
    cleanText(status, 50) ||
    "unknown";

  const lastError =
    cleanText(
      extra.last_error,
      4000
    );

  const twilioCallSid =
    cleanText(
      extra.twilio_call_sid,
      80
    );

  await pool.query(
    `
      UPDATE ai_calls

      SET
        status =
          $2::VARCHAR(50),

        twilio_call_sid =
          COALESCE(
            $3::VARCHAR(80),
            twilio_call_sid
          ),

        last_error =
          COALESCE(
            $4::TEXT,
            last_error
          ),

        started_at =
          CASE
            WHEN $2::VARCHAR(50) IN (
              'queued',
              'initiated',
              'ringing',
              'answered',
              'in-progress'
            )
            THEN COALESCE(
              started_at,
              NOW()
            )

            ELSE started_at
          END,

        answered_at =
          CASE
            WHEN $2::VARCHAR(50) IN (
              'answered',
              'in-progress'
            )
            THEN COALESCE(
              answered_at,
              NOW()
            )

            ELSE answered_at
          END,

        completed_at =
          CASE
            WHEN $2::VARCHAR(50) IN (
              'completed',
              'busy',
              'failed',
              'no-answer',
              'canceled'
            )
            THEN COALESCE(
              completed_at,
              NOW()
            )

            ELSE completed_at
          END,

        updated_at =
          NOW()

      WHERE
        call_id =
          $1::VARCHAR(100)
    `,
    [
      callId,
      statusValue,
      twilioCallSid,
      lastError
    ]
  );
}

async function notifyHelux(call) {
  try {
    const response = await fetch(
      `${HELUX_BASE_URL}${HELUX_RESULTS_PATH}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-helux-key":
            HELUX_API_KEY
        },

        body: JSON.stringify({
          case_id:
            call.case_id,

          lead_id:
            call.lead_id,

          call_id:
            call.call_id,

          twilio_call_sid:
            call.twilio_call_sid,

          status:
            call.status,

          transcript:
            call.transcript || [],

          result:
            call.result || {}
        })
      }
    );

    if (!response.ok) {
      const body =
        await response.text();

      console.error(
        `HELUX result callback failed with ${response.status}: ${body.slice(
          0,
          500
        )}`
      );
    }
  } catch (error) {
    console.error(
      "HELUX result callback failed:",
      error.message
    );
  }
}

async function placeTwilioCall(call) {
  const voiceUrl = new URL(
    `${PUBLIC_BASE_URL}/api/v1/twilio/voice`
  );

  voiceUrl.searchParams.set(
    "call_id",
    call.call_id
  );

  voiceUrl.searchParams.set(
    "token",
    call.stream_token
  );

  const statusUrl = new URL(
    `${PUBLIC_BASE_URL}/api/v1/twilio/status`
  );

  statusUrl.searchParams.set(
    "call_id",
    call.call_id
  );

  statusUrl.searchParams.set(
    "token",
    call.stream_token
  );

  await pool.query(
    `
      UPDATE ai_calls
      SET
        status =
          'placing',

        attempts =
          attempts + 1,

        last_error =
          NULL,

        updated_at =
          NOW()

      WHERE
        call_id = $1
    `,
    [call.call_id]
  );

  try {
    const twilioCall =
      await twilioClient.calls.create({
        to:
          call.phone,

        from:
          TWILIO_FROM_NUMBER,

        url:
          voiceUrl.toString(),

        method:
          "POST",

        statusCallback:
          statusUrl.toString(),

        statusCallbackMethod:
          "POST",

        statusCallbackEvent: [
          "initiated",
          "ringing",
          "answered",
          "completed"
        ]
      });

    await updateCallStatus(
      call.call_id,
      twilioCall.status || "queued",
      {
        twilio_call_sid:
          twilioCall.sid
      }
    );

    return twilioCall;
  } catch (error) {
    await updateCallStatus(
      call.call_id,
      "failed",
      {
        last_error:
          error.message
      }
    );

    throw error;
  }
}

app.get("/", (req, res) => {
  res.json({
    message:
      "HELUX AI Workforce is online.",

    version:
      "1.0.0",

    worker:
      "DPA outbound caller",

    realtime_model:
      OPENAI_REALTIME_MODEL,

    voice:
      OPENAI_VOICE
  });
});

app.get(
  "/health",
  async (req, res) => {
    try {
      const database =
        await pool.query(
          "SELECT NOW() AS database_time"
        );

      res.json({
        status:
          "healthy",

        service:
          "helux-ai-workforce",

        database:
          "connected",

        database_time:
          database.rows[0]
            .database_time,

        openai:
          Boolean(
            OPENAI_API_KEY
          ),

        twilio:
          Boolean(
            TWILIO_ACCOUNT_SID &&
              TWILIO_AUTH_TOKEN &&
              TWILIO_FROM_NUMBER
          )
      });
    } catch (error) {
      res.status(503).json({
        status:
          "unhealthy",

        service:
          "helux-ai-workforce",

        database:
          "disconnected",

        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/v1/calls",
  authenticateHelux,
  async (req, res, next) => {
    try {
      const payload =
        req.body || {};

      const requestKey =
        callRequestKey(
          payload
        );

      const phone =
        normalizePhone(
          payload.phone
        );

      if (!phone) {
        throw new HttpError(
          422,
          "A valid phone number is required."
        );
      }

      const existing =
        await getCallByRequestKey(
          requestKey
        );

      if (existing) {
        return res
          .status(200)
          .json({
            success:
              true,

            duplicate:
              true,

            call_id:
              existing.call_id,

            status:
              existing.status,

            twilio_call_sid:
              existing.twilio_call_sid
          });
      }

      const callId =
        createPublicId(
          "CALL"
        );

      const streamToken =
        createStreamToken();

      const insertResult =
        await pool.query(
          `
            INSERT INTO ai_calls (
              call_id,
              request_key,
              case_id,
              lead_id,
              phone,
              status,
              stream_token,
              payload
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              'created',
              $6,
              $7::jsonb
            )
            RETURNING *
          `,
          [
            callId,
            requestKey,

            cleanText(
              payload.case_id,
              150
            ),

            cleanText(
              payload.lead_id,
              150
            ),

            phone,
            streamToken,

            JSON.stringify(
              payload
            )
          ]
        );

      const call =
        insertResult.rows[0];

      const twilioCall =
        await placeTwilioCall(
          call
        );

      res.status(201).json({
        success:
          true,

        duplicate:
          false,

        call_id:
          call.call_id,

        status:
          twilioCall.status ||
          "queued",

        twilio_call_sid:
          twilioCall.sid
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
      const call =
        await getCallById(
          req.params.callId
        );

      if (!call) {
        throw new HttpError(
          404,
          "Call not found."
        );
      }

      if (
        !terminalCallStatus(
          call.status
        )
      ) {
        throw new HttpError(
          409,
          `Call cannot be retried while status is ${call.status}.`
        );
      }

      const newStreamToken =
        createStreamToken();

      await pool.query(
        `
          UPDATE ai_calls

          SET
            stream_token =
              $2,

            status =
              'created',

            twilio_call_sid =
              NULL,

            last_error =
              NULL,

            completed_at =
              NULL,

            updated_at =
              NOW()

          WHERE
            call_id = $1
        `,
        [
          call.call_id,
          newStreamToken
        ]
      );

      const refreshed =
        await getCallById(
          call.call_id
        );

      const twilioCall =
        await placeTwilioCall(
          refreshed
        );

      res.json({
        success:
          true,

        call_id:
          call.call_id,

        status:
          twilioCall.status ||
          "queued",

        twilio_call_sid:
          twilioCall.sid,

        attempts:
          Number(
            call.attempts || 0
          ) + 1
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
      const call =
        await getCallById(
          req.params.callId
        );

      if (!call) {
        throw new HttpError(
          404,
          "Call not found."
        );
      }

      res.json({
        success:
          true,

        call: {
          call_id:
            call.call_id,

          case_id:
            call.case_id,

          lead_id:
            call.lead_id,

          phone:
            call.phone,

          status:
            call.status,

          twilio_call_sid:
            call.twilio_call_sid,

          attempts:
            call.attempts,

          transcript:
            call.transcript,

          result:
            call.result,

          last_error:
            call.last_error,

          created_at:
            call.created_at,

          started_at:
            call.started_at,

          answered_at:
            call.answered_at,

          completed_at:
            call.completed_at
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/v1/twilio/voice",
  async (req, res, next) => {
    try {
      const callId = cleanText(
        req.query.call_id,
        100
      );

      const token = cleanText(
        req.query.token,
        160
      );

      const call =
        await validateCallToken(
          callId,
          token
        );

      if (!call) {
        throw new HttpError(
          401,
          "Invalid call token."
        );
      }

      const response =
        new twilio.twiml
          .VoiceResponse();

      const connect =
        response.connect();

      const stream =
        connect.stream({
          url:
            `${websocketBaseUrl()}/api/v1/twilio/media`
        });

      stream.parameter({
        name:
          "call_id",

        value:
          call.call_id
      });

      stream.parameter({
        name:
          "stream_token",

        value:
          call.stream_token
      });

      res
        .type("text/xml")
        .send(
          response.toString()
        );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/v1/twilio/status",
  async (req, res, next) => {
    try {
      const callId = cleanText(
        req.query.call_id,
        100
      );

      const token = cleanText(
        req.query.token,
        160
      );

      const call =
        await validateCallToken(
          callId,
          token
        );

      if (!call) {
        throw new HttpError(
          401,
          "Invalid call token."
        );
      }

      const status =
        cleanText(
          req.body.CallStatus,
          50
        ) || "unknown";

      const twilioCallSid =
        cleanText(
          req.body.CallSid,
          80
        );

      await updateCallStatus(
        call.call_id,
        status,
        {
          twilio_call_sid:
            twilioCallSid
        }
      );

      if (
        terminalCallStatus(
          status
        )
      ) {
        const finalCall =
          await getCallById(
            call.call_id
          );

        void notifyHelux(
          finalCall
        );
      }

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
);

mediaServer.on(
  "connection",
  (twilioSocket) => {
    let openaiSocket =
      null;

    let call =
      null;

    let streamSid =
      null;

    let latestMediaTimestamp =
      0;

    let responseStartTimestamp =
      null;

    let lastAssistantItemId =
      null;

    let markCounter =
      0;

    let initialGreetingStarted =
      false;

    let pendingAudio =
      [];

    let closed =
      false;

    function sendToOpenAI(
      event
    ) {
      if (
        openaiSocket &&
        openaiSocket.readyState ===
          WebSocket.OPEN
      ) {
        openaiSocket.send(
          JSON.stringify(
            event
          )
        );

        return true;
      }

      return false;
    }

    function sendToTwilio(
      message
    ) {
      if (
        twilioSocket.readyState ===
        WebSocket.OPEN
      ) {
        twilioSocket.send(
          JSON.stringify(
            message
          )
        );

        return true;
      }

      return false;
    }

    function sendMark() {
      if (!streamSid) {
        return;
      }

      markCounter += 1;

      sendToTwilio({
        event:
          "mark",

        streamSid,

        mark: {
          name:
            `openai-${markCounter}`
        }
      });
    }

    async function handleInterruption() {
      if (
        !streamSid ||
        !lastAssistantItemId ||
        responseStartTimestamp ===
          null
      ) {
        return;
      }

      const elapsed = Math.max(
        0,

        latestMediaTimestamp -
          responseStartTimestamp
      );

      sendToTwilio({
        event:
          "clear",

        streamSid
      });

      sendToOpenAI({
        type:
          "conversation.item.truncate",

        item_id:
          lastAssistantItemId,

        content_index:
          0,

        audio_end_ms:
          elapsed
      });

      responseStartTimestamp =
        null;

      lastAssistantItemId =
        null;
    }

    function connectToOpenAI() {
      const url =
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
          OPENAI_REALTIME_MODEL
        )}`;

      openaiSocket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                `Bearer ${OPENAI_API_KEY}`,

              "OpenAI-Safety-Identifier":
                safetyIdentifier(
                  call
                )
            }
          }
        );

      openaiSocket.on(
        "open",
        () => {
          const inputAudio = {
            format: {
              type:
                "audio/pcmu"
            },

            turn_detection: {
              type:
                "server_vad",

              threshold:
                0.5,

              prefix_padding_ms:
                300,

              silence_duration_ms:
                500,

              create_response:
                true,

              interrupt_response:
                true,

              idle_timeout_ms:
                12000
            }
          };

          if (
            OPENAI_TRANSCRIPTION_MODEL
          ) {
            inputAudio.transcription = {
              model:
                OPENAI_TRANSCRIPTION_MODEL,

              language:
                "en"
            };
          }

          sendToOpenAI({
            type:
              "session.update",

            session: {
              type:
                "realtime",

              model:
                OPENAI_REALTIME_MODEL,

              output_modalities: [
                "audio"
              ],

              instructions:
                buildAgentInstructions(
                  call
                ),

              audio: {
                input:
                  inputAudio,

                output: {
                  format: {
                    type:
                      "audio/pcmu"
                  },

                  voice:
                    OPENAI_VOICE
                }
              }
            }
          });

          for (
            const audio of
            pendingAudio
          ) {
            sendToOpenAI({
              type:
                "input_audio_buffer.append",

              audio
            });
          }

          pendingAudio = [];
        }
      );

      openaiSocket.on(
        "message",
        async (
          rawMessage
        ) => {
          let event;

          try {
            event =
              JSON.parse(
                rawMessage.toString()
              );
          } catch {
            return;
          }

          if (
            event.type ===
              "session.updated" &&
            !initialGreetingStarted
          ) {
            initialGreetingStarted =
              true;

            sendToOpenAI({
              type:
                "response.create",

              response: {
                output_modalities: [
                  "audio"
                ],

                instructions:
                  "Start the call now using the required opening. Do not wait for the other person to speak first."
              }
            });

            return;
          }

          if (
            event.type ===
              "response.output_item.added" ||
            event.type ===
              "response.output_item.created"
          ) {
            if (
              event.item &&
              event.item.id
            ) {
              lastAssistantItemId =
                event.item.id;
            }

            return;
          }

          if (
            event.type ===
              "response.output_audio.delta" ||
            event.type ===
              "response.audio.delta"
          ) {
            if (
              !event.delta ||
              !streamSid
            ) {
              return;
            }

            if (
              responseStartTimestamp ===
              null
            ) {
              responseStartTimestamp =
                latestMediaTimestamp;
            }

            sendToTwilio({
              event:
                "media",

              streamSid,

              media: {
                payload:
                  event.delta
              }
            });

            sendMark();

            return;
          }

          if (
            event.type ===
            "input_audio_buffer.speech_started"
          ) {
            await handleInterruption();
            return;
          }

          if (
            event.type ===
            "response.output_audio_transcript.done"
          ) {
            await appendTranscript(
              call.call_id,
              "assistant",
              event.transcript
            );

            return;
          }

          if (
            event.type ===
            "conversation.item.input_audio_transcription.completed"
          ) {
            await appendTranscript(
              call.call_id,
              "lead",
              event.transcript
            );

            return;
          }

          if (
            event.type ===
            "error"
          ) {
            const message =
              event.error?.message ||
              event.message ||
              "OpenAI Realtime error";

            console.error(
              `OpenAI Realtime error for ${call.call_id}:`,
              message
            );

            await updateCallStatus(
              call.call_id,
              "in-progress",
              {
                last_error:
                  message
              }
            );
          }
        }
      );

      openaiSocket.on(
        "error",
        async (error) => {
          console.error(
            `OpenAI socket error for ${call.call_id}:`,
            error.message
          );

          await updateCallStatus(
            call.call_id,
            "in-progress",
            {
              last_error:
                error.message
            }
          );
        }
      );

      openaiSocket.on(
        "close",
        () => {
          if (
            !closed &&
            twilioSocket.readyState ===
              WebSocket.OPEN
          ) {
            twilioSocket.close();
          }
        }
      );
    }

    twilioSocket.on(
      "message",
      async (
        rawMessage
      ) => {
        let message;

        try {
          message =
            JSON.parse(
              rawMessage.toString()
            );
        } catch {
          return;
        }

        if (
          message.event ===
          "start"
        ) {
          const parameters =
            message.start
              ?.customParameters ||
            {};

          const callId =
            cleanText(
              parameters.call_id,
              100
            );

          const token =
            cleanText(
              parameters.stream_token,
              160
            );

          call =
            await validateCallToken(
              callId,
              token
            );

          if (!call) {
            twilioSocket.close(
              1008,
              "Invalid stream token"
            );

            return;
          }

          streamSid =
            message.start
              ?.streamSid ||
            message.streamSid;

          await updateCallStatus(
            call.call_id,
            "in-progress",
            {
              twilio_call_sid:
                message.start
                  ?.callSid
            }
          );

          connectToOpenAI();

          return;
        }

        if (
          message.event ===
          "media"
        ) {
          const payload =
            message.media
              ?.payload;

          latestMediaTimestamp =
            Number(
              message.media
                ?.timestamp ||
                0
            );

          if (!payload) {
            return;
          }

          if (
            !sendToOpenAI({
              type:
                "input_audio_buffer.append",

              audio:
                payload
            })
          ) {
            if (
              pendingAudio.length <
              200
            ) {
              pendingAudio.push(
                payload
              );
            }
          }

          return;
        }

        if (
          message.event ===
          "stop"
        ) {
          closed = true;

          if (
            openaiSocket &&
            openaiSocket.readyState ===
              WebSocket.OPEN
          ) {
            openaiSocket.close();
          }
        }
      }
    );

    twilioSocket.on(
      "close",
      () => {
        closed = true;

        if (
          openaiSocket &&
          openaiSocket.readyState ===
            WebSocket.OPEN
        ) {
          openaiSocket.close();
        }
      }
    );

    twilioSocket.on(
      "error",
      (error) => {
        console.error(
          "Twilio media socket error:",
          error.message
        );
      }
    );
  }
);

server.on(
  "upgrade",
  (
    request,
    socket,
    head
  ) => {
    const requestUrl =
      new URL(
        request.url,
        `http://${request.headers.host}`
      );

    if (
      requestUrl.pathname !==
      "/api/v1/twilio/media"
    ) {
      socket.destroy();
      return;
    }

    mediaServer.handleUpgrade(
      request,
      socket,
      head,
      (websocket) => {
        mediaServer.emit(
          "connection",
          websocket,
          request
        );
      }
    );
  }
);

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : 500;

    if (
      statusCode >= 500
    ) {
      console.error(
        "HELUX AI Workforce request failed:",
        error
      );
    }

    res
      .status(statusCode)
      .json({
        success:
          false,

        error:
          statusCode >= 500
            ? "Internal server error."
            : error.message
      });
  }
);

async function start() {
  try {
    await initializeDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `HELUX AI Workforce running on port ${PORT}`
        );

        console.log(
          `Realtime model: ${OPENAI_REALTIME_MODEL}`
        );

        console.log(
          `Voice: ${OPENAI_VOICE}`
        );
      }
    );
  } catch (error) {
    console.error(
      "HELUX AI Workforce failed to start:",
      error
    );

    process.exit(1);
  }
}

async function shutdown() {
  console.log(
    "HELUX AI Workforce shutting down."
  );

  server.close(
    async () => {
      await pool.end();
      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);

start();
