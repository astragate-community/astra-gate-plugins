// WorkBuddy: the two builds (China and international) and the models each lists.
 // how long a refresh's result answers for the old refresh token

// [id, name, context, efforts]
const CN_MODELS = [
  ["auto", "Auto", 168000],
  ["hy4-preview-f", "Hy4 preview", 1000000, ["high"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["hy3-x", "Hy3-X", 192000, ["low", "high"]],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["glm-5.1", "GLM-5.1", 200000],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000],
  ["minimax-m3", "MiniMax-M3", 512000],
  ["kimi-k3-1", "Kimi-K3", 1000000, ["low", "high", "xhigh"]],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1000000, ["none", "high", "xhigh"]],
]

const AI_MODELS = [
  ["default-model", "Default", 176000],
  ["fast-model", "Fast", 200000],
  ["balanced-model", "Balanced", 256000],
  ["primary-model", "Primary", 272000],
  ["deep-model", "Deep", 176000],
  ["gpt-5.5", "GPT-5.5", 1000000],
  ["gpt-5.4", "GPT-5.4", 272000],
  ["gpt-5.3-codex", "GPT-5.3-Codex", 272000],
  ["gemini-3.1-pro", "Gemini-3.1-Pro", 400000],
  ["gemini-3.5-flash", "Gemini-3.5-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["kimi-k3", "Kimi-K3", 1000000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["minimax-m3", "MiniMax-M3", 512000],
]

export const SITES = {
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    endpoint: "https://copilot.tencent.com",
    authID: "workbuddy-desktop",
    platform: "workbuddy",
    ai: false,
    models: CN_MODELS,
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    endpoint: "https://www.workbuddy.ai",
    authID: "workbuddy-desktop-ai",
    platform: "workbuddy-ai",
    ai: true,
    models: AI_MODELS,
    // models whose images WorkBuddy AI drops though its config says they
    // take them (see textOnly)
    noImages: /^glm-/,
  },
}

// textOnly says whether site drops the images sent to model, whatever its
// config says. On 2026-10-13, with a real WorkBuddy AI account (Yirasumi on
// Discord), www.workbuddy.ai's /v3/config marked every model
// supportsImages: true, but a chat to glm-5.3-flash, glm-5.3 or glm-5.2
// came back saying "[System reminder: the current model does not support
// images. Content filtered. ...]": the server had taken the image out.
// Its other models (deepseek-v4.1-flash, kimi, gemini, grok, gpt) read
// them, and WorkBuddy (China)'s glm-5.3-flash does too, so this is WorkBuddy
// AI's GLM models alone. Said text-only, magpie's image-describing model
// reads the image for them; a user who said the model takes images keeps
// their own answer (magpie's settings, over what this list says).
export function textOnly(site, model) {
  return !!site.noImages?.test(model)
}
export const api = (site) => site.endpoint + "/v2"