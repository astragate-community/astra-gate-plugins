// New API's 系统提示词 (a channel's system_prompt, with its "override" switch) as magpie gateway middleware,
// based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md), in each agent API's own place for it:
// Anthropic's system, Chat's first system or developer message, Responses' instructions, Gemini's
// systemInstruction.
//
//   {"system_prompt": "Answer in English.", "override": false,
//    "position": "append", "agents": [], "models": []}
//
// A request with no system prompt is given this one. One that has its own keeps it as it is, unless override is
// true: then this one is added before it ("prepend", New API's way) or after it ("append", the default, which
// keeps a prompt cache on the agent's own prompt). agents and models, when given, are the only agents and model
// name prefixes it applies to.
//
// Astra runs the built file as an ES module in Jint: only onRequest is exported, and nothing imports a package
// or a node: module.
import { applies, anthropic, chat, responses, gemini } from "./apis.mjs"

export function onRequest(body, ctx) {
  const o = ctx.options || {}
  const prompt = typeof o.system_prompt === "string" ? o.system_prompt : ""
  if (!prompt) return
  if (!applies(o, body, ctx)) return
  const how = { prompt, override: !!o.override, before: o.position === "prepend" }
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
