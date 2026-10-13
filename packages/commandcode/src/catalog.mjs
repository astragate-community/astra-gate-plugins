// The built-in model lists, which plan is let which models (the CLI's own table), and what the plugin keeps of them

// The plan's models when its list can't be asked: Claude on Messages, the
// rest on chat completions. Pictures as models.dev has them (DeepSeek V4
// and GLM-5.3 read text alone, so say nothing).
export const MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context: 1_000_000, images: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000, images: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", context: 1_050_000, images: true },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context: 1_000_000 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context: 1_000_000 },
  { id: "moonshotai/Kimi-K3", name: "Kimi K3", context: 1_000_000, images: true },
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", context: 1_000_000 },
  { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", context: 1_000_000, images: true },
]

// The models the Go plan is let use, as the CLI's own table has it
// (1.73.0): every model its picker shows (less the hidden) but the
// "premium" ones and those it blocks for Go (GO_REFUSED). They stand in
// until Command Code's list is fetched (goModels), or when it can't be,
// and give that list the reasoning levels and pictures it doesn't say —
// magpie's cmdGoModels.
const EFF5 = ["low", "medium", "high", "xhigh", "max"]

export const GO_MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", context: 1_050_000, images: true, efforts: EFF5 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context: 1_050_000, images: true, efforts: EFF5 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context: 1_000_000, efforts: ["high", "max"] },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context: 1_000_000, efforts: ["high", "max"] },
  { id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (exp)", context: 1_000_000, images: true, efforts: ["high", "max"] },
  { id: "deepseek/deepseek-v4-flash-fast", name: "DeepSeek V4 Flash Fast", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 1_000_000, images: true, efforts: ["low", "high", "max"] },
  { id: "deepseek/deepseek-v4.1-flash-fast", name: "DeepSeek V4.1 Flash Fast", context: 1_000_000, images: true, efforts: ["low", "high", "max"] },
  { id: "moonshotai/Kimi-K3", name: "Kimi K3", context: 1_000_000, images: true, efforts: ["low", "high", "max"] },
  { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", context: 256_000, images: true },
  { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code HighSpeed", context: 262_000, images: true },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", context: 256_000, images: true },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context: 256_000, images: true },
  { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", context: 1_048_576, images: true, efforts: ["low", "high", "max"] },
  { id: "z-ai/glm-5.3-flashx", name: "GLM-5.3 FlashX", context: 1_000_000, images: true, efforts: ["low", "high", "max"] },
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "zai-org/GLM-5.2", name: "GLM-5.2", context: 1_000_000, efforts: ["high", "max"] },
  { id: "zai-org/GLM-5.2-Fast", name: "GLM-5.2 Fast", context: 1_000_000 },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1", context: 200_000 },
  { id: "zai-org/GLM-5", name: "GLM-5", context: 200_000 },
  { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", context: 1_000_000, images: true, efforts: ["low", "medium", "high"] },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", context: 200_000 },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", context: 200_000 },
  { id: "xiaomi/mimo-v2.6-pro", name: "MiMo V2.6 Pro", context: 1_048_576, images: true },
  { id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash", context: 1_048_576, images: true },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", context: 1_000_000 },
  { id: "xiaomi/mimo-v2.5", name: "MiMo V2.5", context: 1_000_000, images: true },
  { id: "Qwen/Qwen3.8-Omni-Flash", name: "Qwen 3.8 Omni Flash", context: 1_000_000, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "Qwen/Qwen3.8-Max-0902", name: "Qwen 3.8 Max 0902", context: 1_000_000, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "Qwen/Qwen3.8-Max", name: "Qwen 3.8 Max", context: 1_000_000, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", context: 262_144, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "Qwen/Qwen3.8-Flash", name: "Qwen 3.8 Flash", context: 1_000_000, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context: 1_000_000 },
  { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus", context: 1_000_000, images: true },
  { id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", context: 1_000_000, images: true },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview", context: 200_000 },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus", context: 200_000, images: true },
  { id: "meituan/LongCat-2.0", name: "LongCat 2.0", context: 1_048_576 },
  { id: "stepfun/Step-5-Preview", name: "Step 5 Preview", context: 1_000_000, images: true, efforts: ["low", "medium", "high"] },
  { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash", context: 256_000, images: true },
  { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash", context: 262_144 },
  { id: "tencent/hy3-paid", name: "Tencent Hy3", context: 262_144 },
  { id: "tencent/hy4-preview", name: "Tencent Hy4 Preview", context: 1_048_576, efforts: ["low", "medium", "high"] },
  { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", context: 1_000_000, images: true, efforts: ["low", "medium", "high"] },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", context: 1_000_000, images: true, efforts: ["low", "medium", "high"] },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", context: 1_000_000 },
  { id: "thinkingmachines/inkling", name: "Inkling", context: 256_000, images: true },
  { id: "thinkingmachines/inkling-small", name: "Inkling Small", context: 1_000_000, images: true },
  { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha", context: 1_000_000, images: true, efforts: ["low", "medium", "high"] },
  { id: "stealth/pixel-canary", name: "Pixel Canary", context: 262_144, images: true, efforts: ["low", "medium", "xhigh"] },
  { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", context: 256_000 },
  { id: "inclusionai/ling-3.0-flash-free", name: "Ling 3.0 Flash", context: 256_000 },
  { id: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante", context: 262_144 },
  { id: "inclusionai/ling-3.1-flash:free", name: "Ling 3.1 Flash", context: 262_144, efforts: ["low", "medium", "high"] },
  { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", context: 1_048_576, images: true, efforts: ["low", "medium", "high", "xhigh"] },
  { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", context: 1_048_576, images: true, efforts: ["low", "medium", "high", "xhigh"] },
  { id: "xai/grok-4.5", name: "Grok 4.5", context: 500_000, images: true, efforts: ["low", "medium", "high"] },
]

// The models each plan is let use, as the CLI's own table has it
// (command-code 1.79.2: evaluateModelAccess over its model categories and
// its plans' allowedCategories and blockedModels). Command Code's list is
// the same 87 models for every plan, asked with a key or without, and the
// Provider API turns a model the plan hasn't away only when it is asked
// (403 "MODEL_NOT_IN_PLAN: Claude Opus 5.5 available in Provider and above
// plans or extra on demand usage"). So a plan's list is Command Code's less
// what its plan refuses: a premium model when the plan has the open models
// alone (Go, GOAT), and the models it blocks. A model the table doesn't
// name the CLI lets any plan pick; one the plan hasn't after all is refused
// with MODEL_NOT_IN_PLAN, which the agent is told. Blocks are by the
// model's id: the CLI's own block of "vercel-ai-gateway:xiaomi/mimo-v2.6-
// pro-ultraspeed" misses its "cai" model, and Go is still kept off it.
const PREMIUM = new Set([
  "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5-1", "claude-fable-5",
  "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
  "claude-haiku-4-5-20251001", "gpt-5.6-terra", "gpt-6-astra", "gpt-6.1-sol",
  "gpt-6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.4-mini",
  "google/gemini-3.5-flash", "google/gemini-3.1-flash-lite", "sakana/fugu-ultra",
  "meta/muse-spark-1.1",
])
const GO_BLOCKED = new Set([
  "meta/muse-spark-1.2", "meta/muse-spark-1.3", "xai/grok-4.6", "xai/grok-4.7",
  "xiaomi/mimo-v2.6-pro-ultraspeed", "google/gemini-3.7-flash", "google/gemini-3.8-flash",
  "gpt-5.6-sol", "claude-sonnet-5-5", "claude-haiku-5-5",
])
const PRO_BLOCKED = new Set([
  "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101",
  "gpt-6-astra", "gpt-6.1-sol", "sakana/fugu-ultra",
])
// by the plan's name (PLAN_NAMES): the old Pro and the new are let the same
const PLAN_MODELS = {
  Go: { premium: false, blocked: GO_BLOCKED },
  GOAT: { premium: false },
  Pro: { premium: true, blocked: PRO_BLOCKED },
  Provider: { premium: true, blocked: new Set(["gpt-6.1-sol"]) },
  Max: { premium: true },
  Ultra: { premium: true },
  "Teams Pro": { premium: true },
}

// refuses is whether the plan named refuses the model: never for a plan
// the table doesn't know, "No plan" and an unread one among them.
export function refuses(plan, id) {
  const p = PLAN_MODELS[plan]
  if (!p) return false
  return (!p.premium && PREMIUM.has(id)) || !!p.blocked?.has(id)
}

// The models of Command Code's list the Go plan is refused — magpie's
// cmdGoRefused.
export const GO_REFUSED = new Set([...PREMIUM, ...GO_BLOCKED])
export const GO_EFFORTS = Object.fromEntries(GO_MODELS.map((m) => [m.id, m.efforts ?? []]))
