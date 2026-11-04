# Estimate Medicare voice module

This directory owns the Medicare intake prompts, scripts, phone callbacks, CRM
bridge and tests. DPA/Prep Hub call handlers and scripts are not imported or
modified by this module.

- Phone: +1 877 317 9445, validated before activating its Twilio webhook.
- HTTP/WebSocket routes: `/api/v1/medicare/*` only.
- CRM: dedicated Medicare Supabase project `zwmxmoxhbrpwlnffsrku`.
- Authentication: existing Estimate Medicare owner-session verifier.
- Infrastructure: shares the existing Render process, Twilio account, OpenAI
  credentials and server Postgres pool. Only the Medicare bridge signing key
  uses the server pool; client records are sent to the dedicated Medicare CRM.
- Transfer: destination is stored privately in the Medicare database settings, loaded through the signed bridge, and never accepted from caller/model input.
- Opening: Daisy speaks directly; no preliminary synthetic voice or recording prompt.
- Prepared transcript upgrade: audio recording stays off; a separate transcript flag saves timestamped speaker turns without changing Daisy’s approved opening. Apply transcript.sql before deploying this upgrade. Caller opt-out stops future transcript capture.

Set `MEDICARE_VOICE_ENABLED=false` and deploy to disable the module without
changing DPA behavior. Before disabling or removing it, repoint this Medicare
number's Twilio voice webhook to a replacement handler. Medicare voice/model
overrides are `MEDICARE_OPENAI_VOICE` and `MEDICARE_OPENAI_MODEL`.

To remove: repoint the Medicare number, remove this directory and the three
`medicareVoice` integration points in `server.js`. Other call handlers remain
independent. Hosting is shared; independent service deployment is a separate
infrastructure change, not claimed by this implementation.

Validation: `node --test medicare/intake.test.js` plus `npm test`.

The server controls the next intake step after each captured answer and automatically queues the specialist transfer after phone confirmation. CRM writes run in a serial background queue; transfer and hangup flush pending writes. Saved library scripts cannot change the order or turn the handoff into an optional offer. Per-call `flow_revision`, `next_step`, and `handoff_status` provide diagnostics without enabling recording.

US phone readback spells digits as plus one, area-code digits, exchange digits, and the final four digits. Speech endpointing waits 450 ms of silence. Inbound live instructions contain only safety rules and the current server-controlled question.

Transcript upgrade requires `transcript.sql` to add the independent flag and append/deduplicate transcript events in the private Medicare database. Text speech recognition can contain transcription errors. This captures the Daisy intake segment, not the agent conversation after transfer.
