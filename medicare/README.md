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
- Transfer: no closer destination is configured; intake offers a callback.

Set `MEDICARE_VOICE_ENABLED=false` and deploy to disable the module without
changing DPA behavior. Before disabling or removing it, repoint this Medicare
number's Twilio voice webhook to a replacement handler. Medicare voice/model
overrides are `MEDICARE_OPENAI_VOICE` and `MEDICARE_OPENAI_MODEL`.

To remove: repoint the Medicare number, remove this directory and the three
`medicareVoice` integration points in `server.js`. Other call handlers remain
independent. Hosting is shared; independent service deployment is a separate
infrastructure change, not claimed by this implementation.

Validation: `node --test medicare/intake.test.js` plus `npm test`.
