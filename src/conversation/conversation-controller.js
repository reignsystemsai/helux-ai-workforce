const { buildSystemPrompt } = require("./system-prompt");
const { canTransition } = require("./conversation-state");

function buildAgentInstructions(call) { return buildSystemPrompt(call); }
function validateConversationTransition(currentState, nextState) {
  return canTransition(currentState, nextState, { allowLegacy: true });
}

module.exports = { buildAgentInstructions, validateConversationTransition };
