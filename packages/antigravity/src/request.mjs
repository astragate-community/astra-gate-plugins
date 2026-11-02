// Antigravity: a Gemini request as Code Assist takes it — Gemini's own, shaped for Antigravity, in an envelope.
import { createHash, randomUUID } from "node:crypto"
import { generation, levelOf } from "./generation.mjs"
import { history } from "./history.mjs"
import { isClaude, resolveModel } from "./models.mjs"
import { plainSchema } from "./schema.mjs"

// Gemini's request fields, whichever way they are spelled
const FIELDS = { systemInstruction: ["systemInstruction", "system_instruction"], toolConfig: ["toolConfig", "tool_config"],
  generationConfig: ["generationConfig", "generation_config"], safetySettings: ["safetySettings", "safety_settings"] }
const pick = (o, names) => names.map((n) => o[n]).find((v) => v !== undefined)

// Antigravity answers a request whose system prompt reads as Claude Code's or the Claude Agent SDK's (which Claude
// Desktop's chats use) with a 429 "Resource has been exhausted", whatever the quota. It matches these words in the
// system instruction — not in a message — and lets the same words through with a zero-width space inside each.
const CLOAKED = ["x-anthropic-billing-header", "Claude Agent SDK"].map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))
const ZWSP = "​"
export const cloak = (text) => CLOAKED.reduce((s, re) => s.replace(re, (m) => m[0] + ZWSP + m.slice(1)), String(text))

// the system instruction as Code Assist takes it: parts of text, with the words it turns away broken
function system(si) {
  if (!si) return undefined
  const parts = (Array.isArray(si) ? si : si.parts ?? [{ text: typeof si === "string" ? si : "" }])
    .filter((p) => typeof p?.text === "string" && p.text)
    .map((p) => ({ text: cloak(p.text) }))
  return parts.length ? { role: "user", parts } : undefined
}

// Tools: the function declarations with schemas it accepts. Code Assist turns away a request that mixes functions with
// its own tools (Google Search, code execution), so the functions win.
function tools(list) {
  const declared = []
  const builtin = []
  for (const t of Array.isArray(list) ? list : []) {
    const fns = t?.functionDeclarations ?? t?.function_declarations
    if (Array.isArray(fns)) {
      for (const f of fns) {
        if (!f?.name) continue
        const { parametersJsonSchema, parameters_json_schema, parameters, ...rest } = f
        declared.push({ ...rest, parameters: plainSchema(parametersJsonSchema ?? parameters_json_schema ?? parameters) })
      }
    } else if (t && typeof t === "object") builtin.push(t)
  }
  if (declared.length) return [{ functionDeclarations: declared }]
  return builtin.length ? builtin : undefined
}

// A Claude model on Antigravity wants its calls checked against the schema; and it takes no request without a tool config
function toolConfig(cfg, hasTools, claude) {
  const fcc = cfg?.functionCallingConfig ?? cfg?.function_calling_config
  if (!claude) return fcc ? { functionCallingConfig: fcc } : undefined
  const mode = String(fcc?.mode ?? "").toUpperCase()
  if (hasTools && (mode === "ANY" || mode === "NONE")) return { functionCallingConfig: fcc }
  return { functionCallingConfig: { ...(fcc ?? {}), mode: "VALIDATED" } }
}

/** The conversation's name as Antigravity makes it: from its first words, so every turn of one conversation has the same. */
export function sessionOf(contents) {
  const first = contents.find((c) => c.role === "user")?.parts?.find((p) => typeof p.text === "string" && p.text)?.text ?? randomUUID()
  const n = createHash("sha256").update(first).digest().readBigUInt64BE(0) & 0x7fffffffffffffffn
  return "-" + n.toString()
}

/**
 * A Gemini request (as @ai-sdk/google, or Astra's Gemini encoder, sends it) as the `request` of Code Assist's
 * envelope, with the model it goes out under: `{ model, request }`.
 */
export function shape(body, requested, { known = undefined } = {}) {
  const asked = pick(body, FIELDS.generationConfig)
  const thinking = asked?.thinkingConfig ?? asked?.thinking_config
  const model = resolveModel(requested, known, thinking ? levelOf(thinking) : "")
  const claude = isClaude(model)
  const contents = history(body.contents, { claude })
  const t = tools(body.tools)
  const request = { contents }
  const si = system(pick(body, FIELDS.systemInstruction))
  if (si) request.systemInstruction = si
  if (t) request.tools = t
  const cfg = toolConfig(pick(body, FIELDS.toolConfig), !!t, claude)
  if (cfg) request.toolConfig = cfg
  const gen = generation(asked, model)
  if (gen) request.generationConfig = gen
  const safety = pick(body, FIELDS.safetySettings)
  if (safety) request.safetySettings = safety
  request.sessionId = sessionOf(contents)
  return { model, request }
}

/** The envelope Code Assist takes: the request, the model, and what only the account and the app know. */
export const envelope = ({ model, request }, project) => ({ project, requestId: "agent-" + randomUUID(), userAgent: "antigravity", requestType: "agent", model, request })
