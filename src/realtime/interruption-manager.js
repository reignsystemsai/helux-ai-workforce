const LISTENING = new Set(["mm hmm", "mmm hmm", "mhm", "uh huh", "right", "okay", "ok", "yeah", "i see", "got it"]);
function normalize(value) { return String(value || "").toLowerCase().replace(/-/g, " ").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim(); }
function isListeningAcknowledgement(value) { return LISTENING.has(normalize(value)); }
function isExplicitInterruption(value) { return /^(?:wait|hold on|stop|excuse me)\b/.test(normalize(value)); }
function shouldInterrupt({ transcript, speechDurationMs = 0 }) {
  if (isListeningAcknowledgement(transcript)) return false;
  return isExplicitInterruption(transcript) || /\?/.test(String(transcript || "")) || normalize(transcript).split(" ").length >= 3 || speechDurationMs >= 700;
}
module.exports = { isListeningAcknowledgement, isExplicitInterruption, shouldInterrupt };
