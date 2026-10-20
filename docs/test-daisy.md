# Test Daisy

The manager's **Test Daisy** button starts an owner-only, five-minute browser rehearsal. Choose a client context and starting saved outbound playbook, then speak as that client. Each start fetches the current caller settings, composed multi-area scripts and preparation context. Existing phone dispatch approval is not invoked because no call is placed.

The `/api/v1/manager/test-media` socket adapts the browser's 8 kHz PCMU audio to the **same `manager-calls.js` media connection handler** used by Twilio. `callInstructions`, `nextGuidedTurn`, the model, voice, VAD, response scheduling, tool schemas and preparation-coverage checks are shared. This tests conversation behavior; it does not measure the telephone carrier's network or audio quality.

Only the rehearsal's service adapter changes: get/update/append/report/reconcile write test-session state; the call and recording provider is an in-memory substitute. No real Twilio client, CRM callback, lead update, email, callback scheduling or readiness update is exposed to that session. Requests made during conversation remain simulated outcomes. Production phone sessions still use their original services.

The Edge Function validates the existing active owner session. The caller API retains its existing server-key authentication. Browser authorization uses a single-use, 60-second ticket sent in the first WebSocket message, never a URL parameter. The socket requires the production CRM origin. One active rehearsal per owner, maximum five minutes. Secrets stay server-side.

The caller database's private `daisy_test_sessions` stores owner-scoped transcripts, markers, outcome/quality metadata and stereo WAV audio. RLS is enabled, no client policy exists, and PUBLIC access is revoked. Existing server database credentials write the table. Sessions expose only authenticated owner-scoped retrieval through the Edge Function. Recording starts when the owner starts a rehearsal, as stated in the UI; this does not change customer recording controls.

Metadata includes voice, settings version, source script numbers/versions, engine revision and SHA-256 of the actual assembled instructions. Start a fresh session after editing saved scripts/settings to use the new versions. Current calls and existing sessions remain unchanged. No runtime prompt editor or automatic code changes are introduced.

Use **Mark this moment** with a short note, then **Stop & save**. Review/download audio and the transcript/markers from Saved test sessions. The browser must provide microphone access; otherwise use the same manager URL in a browser with a working microphone. The room cannot give ChatGPT continuous live listening; saved evidence supports the adjust/retest loop.

Mark this moment pauses browser audio playback and microphone transmission while retaining the same Realtime session and opening stage. Write the adjustment and Continue conversation saves that marker before resuming. Notes are never sent to the model as customer speech. Pending tool continuations are held during the pause; the five-minute speaking allowance excludes note-taking pauses, with a 20-minute wall-clock room limit. Recordings omit paused intervals and marker times use that same active timeline.
