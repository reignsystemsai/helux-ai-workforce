# PrepHub guided conversation handling

The saved script remains the authority for the opening, resource explanations, milestones and closing sequence. Runtime revision v27 adds a shared secondary interpreter for Credit and Taxes; it does not create a new script or rewrite the saved tax blocks.

## Turn handling

1. Respect explicit stop/end requests immediately. Keep identity, recording controls and recipient scope outside the secondary interpreter.
2. Preview the existing script transition using a copy of runtime state. Straightforward accepted replies, valid tax-year evidence, required page reads and ordinary callback details keep the native path.
3. Interpret mixed, negative, unclear or unexpected preparation replies through a bounded Responses request with strict structured output. Consider the current question, recent turns, the saved checkpoint, approved script/catalog and this recipient's reported/saved page facts. Interpret meaning and negation before keyword matches. Record offer decisions and follow-up ownership separately from the primary response action.
4. The server applies an allowed conversational move: preserve the native turn, normalize an unambiguous answer, answer and return to the unfinished question, clarify, decline an optional offer, defer a task, hand off to the callback scheduler, read actual page status, or close. The interpreter has no database, enrollment, payment or outreach tools.
5. Preserve the original checkpoint across clarification and interruptions. An explicit answer plus a question can advance once after answering; acknowledgment of an explanation alone must not complete an unrelated task. Declining a paid plan leaves the free preparation tools available. Existing tax help declines only the professional referral.
6. Distinguish the client offering to call from requesting a Daisy callback. Respect the recorded preference unless the client changes it. Dates, time zones, booking confirmation and save results stay with the existing scheduler and authenticated tools. Questions during confirmation do not silently book an appointment.
7. If interpretation fails, keep the checkpoint and ask a relevant clarification. Do not replay the price list or assume yes. After another failure offer to pause instead of repeating indefinitely. Discard late results after a newer client turn, stage change, disconnect or goodbye.

## Script and evidence boundaries

- Credit sweep and tradeline assessment are separate topics. Use only the approved catalog and website guide; do not invent services or guaranteed outcomes.
- Tax filing selections are client-reported, not IRS verification. Preserve the existing recent-two-year logic, selection/save walkthrough, resource block and follow-up.
- A page read is read-only and scoped to the call recipient. Fresh status is required before claiming to see current saved work. Conversation output cannot claim to have sent, saved, booked, enrolled, charged or referred anything.
- The unfinished conversational checkpoint, declined plan and follow-up ownership survive reconnect. Existing one-reconnect policy and polite provider hang-up remain in effect.
- `result.conversation_handling` records the last interpretation action, original client quotation, script stage, resulting stage and latency or fallback status for review. Connection diagnostics remain separate from conversational evidence.

## Verification

Node tests exercise the real guided-call event path with mocked model/provider transports, including the last-call refusal, natural tax explanations, mixed answers, interruptions, callback ownership, failed interpretation, stale results and reconnect. They do not place customer calls or prove speech/model quality under real telephone conditions. A fresh owner test call validates the deployed behavior.
