function buildRealtimeSession({ model, voice, transcriptionModel, instructions, tools }) {
  const input = {
    format: { type: "audio/pcmu" }, noise_reduction: { type: "near_field" },
    turn_detection: { type: "server_vad", threshold: 0.62, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: false, interrupt_response: false, idle_timeout_ms: 12000 }
  };
  if (transcriptionModel) input.transcription = { model: transcriptionModel, language: "en" };
  return { type: "realtime", model, output_modalities: ["audio"], instructions, tools, tool_choice: "auto", audio: { input, output: { format: { type: "audio/pcmu" }, voice } } };
}
module.exports = { buildRealtimeSession };
