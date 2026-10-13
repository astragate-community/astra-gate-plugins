// Where each API keeps its system prompt, and how ours joins it. Each function returns the body when it wrote
// something and undefined when it left the request as it was; `how` is { prompt, override, before }.

/** Whether the options' `agents` and `models` filters (empty or absent: everyone) let this request through. */
export function applies(options, body, ctx) {
  const { agents, models } = options
  if (Array.isArray(agents) && agents.length && !agents.includes(ctx.agent)) return false
  if (Array.isArray(models) && models.length) {
    const asked = String(body.model ?? ctx.model ?? "")
    if (!models.some((prefix) => typeof prefix === "string" && asked.startsWith(prefix))) return false
  }
  return true
}

// Our prompt next to the one there, in the shape the existing value has: a string is joined with a newline, a
// list of parts gets a part of ours (`part` builds it) — in place, so the caller assigns it back harmlessly.
// Undefined for any other shape: it isn't ours to rewrite.
function joined(existing, how, part) {
  if (typeof existing === "string") return how.before ? how.prompt + "\n" + existing : existing + "\n" + how.prompt
  if (Array.isArray(existing)) {
    if (how.before) existing.unshift(part(how.prompt))
    else existing.push(part(how.prompt))
    return existing
  }
}

const textBlock = (text) => ({ type: "text", text })

export function anthropic(body, how) {
  const system = body.system
  if (system === undefined || system === null || system === "" || (Array.isArray(system) && !system.length)) {
    body.system = how.prompt
    return body
  }
  if (!how.override) return
  const next = joined(system, how, textBlock)
  if (next === undefined) return
  body.system = next
  return body
}

export function chat(body, how) {
  if (!Array.isArray(body.messages)) return
  const first = body.messages[0]
  // "developer" is what newer OpenAI models call the system role
  if (!first || (first.role !== "system" && first.role !== "developer")) {
    body.messages.unshift({ role: "system", content: how.prompt })
    return body
  }
  if (!how.override) return
  const next = joined(first.content, how, textBlock)
  if (next === undefined) return
  first.content = next
  return body
}

export function responses(body, how) {
  const instructions = body.instructions
  if (typeof instructions !== "string" || !instructions) {
    body.instructions = how.prompt
    return body
  }
  if (!how.override) return
  body.instructions = how.before ? how.prompt + "\n" + instructions : instructions + "\n" + how.prompt
  return body
}

export function gemini(body, how) {
  // the REST docs say systemInstruction, some clients send the snake_case form; follow whichever is there
  const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction"
  const system = body[key]
  if (!system || !Array.isArray(system.parts) || !system.parts.length) {
    body[key] = { parts: [{ text: how.prompt }] }
    return body
  }
  if (!how.override) return
  if (how.before) system.parts.unshift({ text: how.prompt })
  else system.parts.push({ text: how.prompt })
  return body
}
