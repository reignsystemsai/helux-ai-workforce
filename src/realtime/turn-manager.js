function semanticTurnDelay(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(?:income|debt|payment|date|time|let me think|not sure|frustrat|confus|afraid)\b/.test(text)) return 750;
  return 350;
}
function extractPrimaryQuestion(value) { const match = String(value || "").match(/[^?]{1,400}\?/); return match ? match[0].trim() : null; }
module.exports = { semanticTurnDelay, extractPrimaryQuestion };
