# Daisy 3.0 migration notes

## Architecture assessment

Before this update, the production caller was implemented in a single `server.js` file of roughly 6,700 lines. It already contained mature Express routes, database migration and persistence, Twilio voice/SMS, OpenAI Realtime media handling, DTI calculations, transfers and handoffs, HELUX result reporting, disconnect recovery, and resilient Monday.com synchronization. The primary architectural risk was coupling: the effective spoken prompt, tool contracts, workflow decisions, provider execution, and realtime turn logic were colocated.

Daisy 3.0 keeps `server.js` as the production composition root and incrementally extracts stable boundaries:

- `src/conversation`: spoken script, response rules, objection guidance, state model, and effective system-prompt composition.
- `src/intents`: public intent contracts, validation, routing, and provider-result sanitization.
- `src/actions`: background action adapters and predictable result envelopes.
- `src/realtime`: Realtime session configuration, semantic turn timing, interruption classification, latency defaults, and reconnect snapshots.
- `src/compliance`: deterministic interest-rate and sensitive-information enforcement plus prompt guardrails.
- `src/workflows`: first-call, nurture, and disconnect-recovery definitions.

The legacy prompt and tool declarations remain temporarily in `server.js` as inert compatibility/reference code. The live Realtime session uses the Daisy 3.0 modules. Removing the inert definitions can be a later low-risk cleanup after production observation.

## Behavior changes

- The active journey is now explicitly Trust -> Need -> Hope -> Discovery -> Urgency -> Action.
- The first-call script includes identity, introduction, trust confirmation, time check, roadmap, DPA education, knowledge discovery, timeline, Realtor, lender, purchase area, and closing.
- Conversation state now records the current stage/objective, last confirmed fact, pending question, next best action, and confirmed answers.
- Valid known-state transitions are enforced before `save_call_progress` reaches infrastructure.
- Operational tools are exposed as intents and always return `{ success, intent, customer_safe_message, data, error }`.
- Raw provider messages, stack traces, secrets, message IDs, and Monday errors are not returned to Daisy.
- Daisy may claim a customer-visible action only after a successful result supplies a safe confirmation.
- Interest-rate questions receive a deterministic licensed-lender response and objective redirect. Output interception cancels prohibited rate claims and sensitive-data requests.
- Listening acknowledgements do not barge in. Explicit interruptions and meaningful statements do. Financial/date/emotional turns receive a slightly longer semantic-completion delay.
- Timeline normalization supports 30-60 days, 60-90 days, within six months, and more than six months.
- Customers more than six months away are routed to non-pressured nurture behavior.

## Preserved functionality

- Existing non-retired environment-variable names and defaults.
- Existing Twilio webhook, media WebSocket, Monday webhook, HELUX result, and non-retired HTTP routes.
- Existing PostgreSQL schema and incremental migration behavior; no destructive migration is introduced.
- Existing SMS resource library and delivery tracking.
- Existing DTI calculation, specialist handoff, live transfer, contact restriction, and result completion.
- Existing transcript/action logging and unexpected-disconnect recovery.
- Existing Monday.com outbound and inbound synchronization. Monday failures remain isolated from active calls.

## Safe phased rollout

1. Run `npm test` and `npm run check` in CI.
2. Deploy to a staging service using a non-production Twilio number and staging database.
3. Exercise identity/wrong-number/opt-out, SMS success/failure, rate question, disconnect/reconnect, transfer, and Monday outage scenarios.
4. Review transcripts for question count, repetition, action-confirmation timing, and customer privacy.
5. Deploy to production with the existing environment unchanged.
6. Monitor tool failure codes, compliance intercept actions, DTI delivery, application starts, latency, and disconnect recovery.
7. After a stable observation window, remove the inert Daisy 2.5 prompt/tool declarations from `server.js` in a separate cleanup change.

## Database and environment migration

No database migration or environment-variable rename is required. Conversation state metadata is stored inside the existing JSONB `result` document, while existing `current_state`, `next_state`, pending-question, summary, and next-action columns remain in use.

`.env.example` documents every currently referenced setting. Required production secrets remain `DATABASE_URL`, `HELUX_API_KEY`, `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.

## Verification scope

Automated tests cover normal continuation, wrong number, meaningful interruption, listening acknowledgement, interest-rate questions, DTI requests, SMS success/failure, both timeline extremes, Realtor/lender facts, changed income, disconnect snapshots, reconnect resume, opt-out, tool timeout, and Monday failure isolation. Characterization tests also protect the existing route/tool surface.
