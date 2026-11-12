// New API's 系统提示词 (a channel's system_prompt, with its "override" switch) as an Astra v2 gateway hook, a rewrite
// of the v1 magpie middleware, in each agent API's own place for it: Anthropic's system, Chat's first system or
// developer message, Responses' instructions, Gemini's systemInstruction.
//
// A request with no system prompt is given this one. One that has its own keeps it as it is, unless `override` is
// true: then this one is added before it ("prepend", New API's way) or after it ("append", the default, which keeps a
// prompt cache on the agent's own prompt). `agents` and `models`, when given, are the only clients (ids) and model
// name prefixes it applies to. The settings are what main.js's view keeps in storage under "settings"; the hook reads
// them from ctx.shared (manifest `reads`). The raw view is deliberate: the prompt goes where each API keeps it.

import { gateway } from "astra"
import { applies, anthropic, chat, responses, gemini } from "./apis.js"

export function onRequest(body, ctx) {
  const s = ctx.shared.settings
  if (!s || typeof s !== "object") return
  const prompt = typeof s.prompt === "string" ? s.prompt : ""
  if (!prompt) return
  if (!applies(s, body, ctx)) return
  const how = { prompt, override: !!s.override, before: s.position === "prepend" }
  switch (ctx.protocol) {
    case "anthropic":
      return anthropic(body, how)
    case "chat":
      return chat(body, how)
    case "responses":
      return responses(body, how)
    case "gemini":
      return gemini(body, how)
  }
}

export default gateway.defineHooks({ prompt: { onRequest } })
