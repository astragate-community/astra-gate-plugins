// Factory: the models droid offers, with the wire each is sent on and the vendor it names in x-api-provider.
const E5 = ["low", "medium", "high", "xhigh", "max"]
const E6 = ["none", "low", "medium", "high", "xhigh", "max"]
const E4 = ["low", "medium", "high", "xhigh"]

// The models droid's /model picker offers, less Gemini's (sent on a route of
// Factory's own) and auto (droid picks it client side): id, name, the wire
// droid sends it on, the vendor it names in x-api-provider, context, output,
// reasoning efforts, images. Haiku 5.5 and Mistral Large 4 are droid
// 0.240.0's (models.test.mjs reads its registry); GPT-6 Astra Ultra Fast,
// new there too, stays out: droid offers it only after the user accepts
// Factory's high-cost terms for it (explicitOptInRequirement).
export const MODELS = [
  ["claude-fable-5.1", "Fable 5.1", "anthropic", "anthropic", 867000, 128000, E5, true],
  ["claude-fable-5", "Fable 5", "anthropic", "anthropic", 867000, 128000, E5, true],
  ["claude-opus-5-5", "Opus 5.5", "anthropic", "anthropic", 872000, 128000, E5, true],
  ["claude-opus-5", "Opus 5", "anthropic", "anthropic", 867000, 128000, E5, true],
  ["claude-opus-4-8", "Opus 4.8", "anthropic", "anthropic", 867000, 128000, E5, true],
  ["claude-sonnet-5-5", "Sonnet 5.5", "anthropic", "anthropic", 872000, 128000, E5, true],
  ["claude-sonnet-5", "Sonnet 5", "anthropic", "anthropic", 872000, 128000, E5, true],
  ["claude-sonnet-4-6", "Sonnet 4.6", "anthropic", "anthropic", 931000, 64000, ["low", "medium", "high", "max"], true],
  ["claude-haiku-5-5", "Haiku 5.5", "anthropic", "anthropic", 872000, 128000, E5, true],
  ["claude-haiku-4-5-20251001", "Haiku 4.5", "anthropic", "anthropic", 0, 0, ["low", "medium", "high"], true],
  ["gpt-6.1-sol", "GPT-6.1 Sol", "responses", "openai", 1050000, 128000, E5, true],
  ["gpt-6-sol", "GPT-6 Sol", "responses", "openai", 1050000, 128000, E6, true],
  ["gpt-6-astra", "GPT-6 Astra", "responses", "openai", 1050000, 128000, E5, true],
  ["gpt-6-luna", "GPT-6 Luna", "responses", "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-sol", "GPT-5.6 Sol", "responses", "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-terra", "GPT-5.6 Terra", "responses", "openai", 1050000, 128000, E6, true],
  ["gpt-5.6-luna", "GPT-5.6 Luna", "responses", "openai", 1050000, 128000, E6, true],
  ["gpt-5.5", "GPT-5.5", "responses", "openai", 1050000, 128000, E4, true],
  ["gpt-5.4", "GPT-5.4", "responses", "openai", 1050000, 128000, E4, true],
  ["gpt-5.3-codex", "GPT-5.3-Codex", "responses", "openai", 400000, 128000, E4, true],
  ["grok-4.7", "Grok 4.7", "responses", "xai", 500000, 63356, E4, true],
  ["grok-4.6", "Grok 4.6", "responses", "xai", 200000, 63356, E4, true],
  // reasoning is mandatory on GLM-5.3 and GLM-5.3-Flash (Fireworks turns
  // none away): low is their least. GLM-5.2, Kimi K3 and DeepSeek V4.1
  // Flash stop thinking at none, droid's "off" (yetone/magpie#899).
  ["glm-5.3", "GLM-5.3", "chat", "fireworks", 1040000, 131072, ["low", "high", "max"], false],
  ["glm-5.3-flash", "GLM-5.3-Flash", "chat", "fireworks", 1048576, 131072, ["low", "high", "max"], true],
  ["glm-5.2", "GLM-5.2", "chat", "baseten", 1040000, 131072, ["none", "high", "max"], false],
  ["kimi-k3", "Kimi K3", "chat", "fireworks", 262144, 65536, ["none", "low", "high", "max"], true],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "chat", "fireworks", 1040000, 131072, ["none", "low", "high", "max"], true],
  ["qwen3.8-max", "Qwen3.8 Max", "chat", "fireworks", 262144, 131072, ["low", "medium", "xhigh"], false],
  ["minimax-m3", "MiniMax M3", "chat", "fireworks", 512000, 64000, ["high"], true],
  ["minimax-m2.7", "MiniMax M2.7", "anthropic", "fireworks", 196600, 64000, ["high"], false],
  ["mistral-large-4", "Mistral Large 4", "chat", "mistral", 524288, 64000, ["high"], true],
  ["mistral-medium-3.5", "Mistral Medium 3.5", "chat", "mistral", 256000, 64000, ["high"], true],
  ["nemotron-3-ultra", "Nemotron 3 Ultra", "chat", "baseten", 202000, 65536, ["high"], false],
].map(([id, name, protocol, upstream, context, output, efforts, images]) => ({ id, name, protocol, upstream, context, output, efforts, images }))

export const byId = new Map(MODELS.map((m) => [m.id, m]));

// CORE are the models Droid Core's windows count: those of a vendor other
// than Anthropic, OpenAI and xAI. Standard's count every other model.
export const CORE = MODELS.filter((m) => !["anthropic", "openai", "xai"].includes(m.upstream)).map((m) => m.id);

/** The manifest's model record for a model (zero context/output means droid did not say: left out). */
export function manifestModel(m) {
  const out = { id: m.id, name: m.name, protocol: m.protocol };
  if (m.context) out.context = m.context;
  if (m.output) out.output = m.output;
  if (m.images) out.vision = true;
  if (m.efforts.length) out.reasoning = true;
  return out;
}
