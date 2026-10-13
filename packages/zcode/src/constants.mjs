// ZCode's GLM Coding Plan: versions, endpoints and the built-in model list.
export const PROVIDER = "zcode"
export const ZCODE = "https://zcode.z.ai"
export const ZAI_API = "https://api.z.ai"
export const BIGMODEL_API = "https://bigmodel.cn" // BigModel's business API, where ZCode asks it
export const ZAI_BASE = "https://api.z.ai/api/anthropic"
export const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic"
export const START_BASE = ZCODE + "/api/v1/zcode-plan/anthropic"
export const APP_VERSION = "3.14.3" // the ZCode whose sign-in this makes
export const UA = "ZCode/" + APP_VERSION

// ZCode's models before its config is read; the Start Plan has all but GLM-5.3.
export const MODELS = [
  { id: "GLM-5.3", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.3-Flash", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.2", context: 1_000_000, output: 128_000, efforts: ["none", "high", "max"] },
  { id: "GLM-5-Turbo", context: 200_000, output: 64_000, efforts: ["none", "high"] },
]
export const START_MODELS = MODELS.filter((m) => m.id !== "GLM-5.3")

// EXPIRED is the built-in's words (errZCodeExpired) for a Start Plan
// sign-in past its end.
export const EXPIRED = "ZCode's sign-in has expired; sign in to ZCode again (or add the account again in magpie)"
