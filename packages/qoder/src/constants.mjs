// Qoder: versions, timings, endpoints and the built-in model lists.

export const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1"
export const COSY_VERSION = "1.1.49"
export const SIGN_IN_TIMEOUT = 15 * 60 * 1000
export const REFRESH_LEAD = 5 * 60 * 1000 // a chat token this close to its end is refreshed before a request
export const RENEW_LEAD = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
export const KEEP_SPENT_MS = 60 * 60 * 1000 // how long what a spent refresh token gave is remembered
export const DAY = 24 * 60 * 60 * 1000
export const CHAT = "@ai-sdk/openai-compatible"
export const CAMPAIGN_MACHINE_TTL = 60 * 60 * 1000 // Qoder's desktop client renews its native identity hourly

// Qoder's embedded 1024-bit RSA key (from the client's cosy source): it wraps
// the per-request AES key of the COSY Authorization header.
export const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

export const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."

const EFF5 = ["low", "medium", "high", "xhigh", "max"]

// Qoder's list when the account's can't be asked (as it was on 2026-09-30,
// with the app's Fast from 2026-10-12).
export const MODELS = [
  { id: "ultimate", name: "Ultimate", context: 1_000_000, efforts: EFF5 },
  { id: "fast", name: "Fast", context: 1_000_000 },
  { id: "performance", name: "Performance", context: 1_000_000, efforts: EFF5 },
  { id: "efficient", name: "Efficient", context: 200_000 },
  { id: "smodel", name: "Sonus", context: 180_000, efforts: EFF5 },
  { id: "cmodel", name: "Cantus", context: 180_000, efforts: EFF5 },
  { id: "qmodel_38max", name: "Qwen3.8-Max", context: 180_000, efforts: ["low", "medium", "xhigh"] },
  { id: "qfmodel", name: "Qwen3.8-Flash", context: 180_000, efforts: ["low", "medium", "xhigh"] },
  { id: "qmodel_latest", name: "Qwen3.7-Max", context: 1_000_000 },
  { id: "qmodel", name: "Qwen3.7-Plus", context: 1_000_000 },
  { id: "kmodel_latest", name: "Kimi-K3", context: 180_000, efforts: ["low", "high", "max"] },
  { id: "kmodel", name: "Kimi-K2.8-Preview", efforts: ["low", "high", "max"] },
  { id: "gmodel", name: "GLM-5.3", context: 180_000, efforts: ["low", "high", "max"] },
  { id: "gfmodel", name: "GLM-5.3-Flash", context: 1_000_000, efforts: ["high", "max"] },
  { id: "dmodel", name: "DeepSeek-V4-Pro", context: 1_000_000, efforts: ["high", "max"] },
  { id: "dfmodel", name: "DeepSeek-Flash", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "mmodel", name: "MiniMax-M3", context: 180_000 },
].map((m) => ({ images: true, ...m }))

// Qoder CN's list when the account's can't be asked: the tiers Qoder CN's
// CLI names (auto routes inside Qoder and isn't one model). The account's
// own list, read once signed in, takes over from it.
export const CN_MODELS = [
  ...MODELS.filter((m) => ["ultimate", "performance", "efficient"].includes(m.id)),
  { id: "lite", name: "Lite" },
]
