// Qoder: shaping a chat completion request as Qoder's agent_chat_generation takes it.
import { textOf } from "@astragate-community/plugin-kit"
import { COSY_VERSION, QODER_SYS } from "./constants.mjs"
import { callId, hexID } from "./util.mjs"

const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

export function fitEffort(want, levels) {
  if (want === "ultra" && !levels.includes(want)) want = "max"
  if (!levels.length || levels.includes(want)) return want
  const at = EFFORT_RANK.indexOf(want)
  if (at < 0) return want
  let best = want
  let dist = EFFORT_RANK.length
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// effortFor is whether to think and at which of the model's efforts ("" for
// none): asked for none, a model that always thinks thinks at its lowest;
// asked for nothing, or a level Qoder doesn't name, at its own default.
export function effortFor(asked, m) {
  let want = String(asked ?? "").toLowerCase()
  if (!EFFORT_RANK.includes(want)) want = ""
  if (!m.thinks || (want === "none" && !m.alwaysThinks)) return [false, ""]
  if (!m.efforts.length) return [true, ""]
  if (want === "") return [true, m.defaultEffort]
  if (want === "none") return [true, m.efforts[0]]
  return [true, fitEffort(want, m.efforts)]
}

function imageBlock(p) {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
  return url ? { type: "image_url", image_url: { url } } : null
}

function blocksOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const out = []
  for (const p of content ?? []) {
    if (p?.type === "text" && p.text != null) out.push({ type: "text", text: p.text })
    else if (p?.type === "image_url") {
      const b = imageBlock(p)
      if (b) out.push(b)
    }
  }
  return out
}

// qoderMessages is the chat's turns as Qoder takes them: text and image
// blocks, an assistant's tool calls as tool_calls, results as tool turns by
// tool_call_id. A tool turn holds text only, so the images a tool returned
// follow in a user turn — the start of the user's own when one comes next.
export function qoderMessages(msgs) {
  const out = []
  const names = {}
  let seen = []
  const showSeen = () => {
    if (seen.length) out.push({ role: "user", content: seen })
    seen = []
  }
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role !== "user" && m.role !== "tool") showSeen()
    if (m.role === "tool") {
      let txt = textOf(m.content)
      const ims = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map(imageBlock).filter(Boolean) : []
      if (ims.length) {
        let of = "tool call " + m.tool_call_id
        const name = names[m.tool_call_id] || m.name
        if (name) of = `${name} (${of})`
        seen.push({ type: "text", text: `[From the result of ${of}:]` }, ...ims)
        const note = ims.length === 1 ? "[The tool returned an image; it follows in the next message.]" : `[The tool returned ${ims.length} images; they follow in the next message.]`
        txt = txt.trim() ? txt + "\n\n" + note : txt + note
      }
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: txt })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const id = c.id || callId()
        names[id] = c.function?.name
        const args = c.function?.arguments
        return { id, type: "function", function: { name: c.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }
      })
      out.push({ role: "assistant", content: textOf(m.content), tool_calls: calls })
      continue
    }
    let blocks = blocksOf(m.content)
    if (m.role === "assistant") blocks = blocks.filter((b) => b.type === "text")
    if (!blocks.length) continue
    if (m.role === "user" && seen.length) [blocks, seen] = [[...seen, ...blocks], []]
    out.push({ role: m.role, content: blocks })
  }
  showSeen()
  return out
}

// windowFor is the context window a request is sent (context_length) on a
// model that offers several: the one Qoder's client picks by default
// (max_input_tokens without one) while the request fits it, else the
// smallest that holds it, else the largest. A larger window may cost more
// (Qoder: changing the Context "may change the rate"), so it is asked for
// only when the conversation needs it. The request's size is counted
// generously, a token for every 3 bytes of its UTF-8 JSON, so a window is
// raised a little early rather than late, and the reply's max_tokens is
// counted in it: a window holds the prompt and the reply, so a
// conversation of 180K asking 32K for the reply is sent 400K, not the 200K
// it would overflow while magpie says the model takes 1M (yetone/magpie#700).
export function windowFor(chat, m, reply = 0) {
  const base = m.defaultWindow || (m.config?.max_input_tokens > 0 ? m.config.max_input_tokens : 0) || m.context
  if (!m.windows?.length) return m.context
  const need = Math.ceil(Buffer.byteLength(JSON.stringify({ m: chat.messages ?? [], t: chat.tools ?? [] })) / 3) + Math.max(0, reply)
  if (base > 0 && need <= base) return base
  return m.windows.find((w) => w >= need) ?? m.windows[m.windows.length - 1]
}

// qoderBody is the plaintext agent_chat_generation takes for a chat
// completion request, for model m.
export function qoderBody(chat, m) {
  const system = (chat.messages ?? []).filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content)).filter(Boolean).join("\n\n")
  const tools = chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function" && t.function?.name) : []
  let sysText = system ? QODER_SYS + "\n\n" + system : QODER_SYS
  if (chat.tool_choice === "required" && tools.length) sysText += "\nYou must call an available function in this response."
  const sys = { type: "text", text: sysText }
  const [thinking, effort] = effortFor(chat.reasoning_effort, m)
  const params = { enable_thinking: thinking, max_tokens: chat.max_completion_tokens || chat.max_tokens || 32000 }
  if (effort) params.reasoning_effort = effort
  const window = windowFor(chat, m, params.max_tokens)
  if (window > 0) params.context_length = window
  const body = {
    parameters: params,
    business: { product: "app", version: COSY_VERSION, type: "agent", id: hexID(), name: "magpie session", begin_at: Date.now(), stage: "start" },
    agent_id: "agent_common",
    task_id: "common",
    session_type: "app",
    model_config: m.config,
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...qoderMessages(chat.messages ?? [])],
  }
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } },
    }))
  return body
}
