// WorkBuddy: the answer to a chat made to stream, folded back into the one body a client that didn't ask for one waits for.
import { errorResponse, KEPT } from "@astragate-community/plugin-kit"
import { namedBack } from "./tools.mjs"
import { explained } from "./refusals.mjs"

// fold puts what a stream's chunk says into the completion the whole stream
// makes: its deltas joined (a call's arguments as they arrive), its finish
// and usage the last to say them.
function fold(out, v) {
  if (typeof v?.id === "string" && out.id === undefined) out.id = v.id
  if (typeof v?.created === "number" && out.created === undefined) out.created = v.created
  if (typeof v?.model === "string" && out.model === undefined) out.model = v.model
  if (v?.usage && typeof v.usage === "object" && !Array.isArray(v.usage)) out.usage = v.usage
  for (const c of Array.isArray(v?.choices) ? v.choices : []) {
    const i = typeof c?.index === "number" ? c.index : 0
    const ch = (out.choices[i] ??= { index: i, message: { role: "assistant", content: "" }, finish_reason: null })
    const d = c?.delta && typeof c.delta === "object" ? c.delta : null
    if (d) {
      if (typeof d.content === "string") ch.message.content += d.content
      if (typeof d.reasoning_content === "string") ch.message.reasoning_content = (ch.message.reasoning_content ?? "") + d.reasoning_content
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const calls = (ch.message.tool_calls ??= [])
        const tc = (calls[t?.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
        if (t?.id) tc.id = t.id
        if (t?.function?.name) tc.function.name += t.function.name
        if (t?.function?.arguments) tc.function.arguments += t.function.arguments
      }
    }
    if (c?.finish_reason) ch.finish_reason = c.finish_reason
  }
}

// whole is the streamed answer a chat was made to give — WorkBuddy's chat
// endpoint answers streams only (see streamed) — folded back into the one
// chat completion body its client, which asked for none, waits for: the
// chunks joined, the model's calls named back to the tools the client
// knows (names), the account's sign-in marked kept. A stream carrying
// WorkBuddy's own error is explained as the refusal it is; an answer that
// isn't a stream is given back as it came.
export async function whole(res, names) {
  if (!/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) return res
  const dec = new TextDecoder()
  let rest = ""
  let out = { object: "chat.completion", choices: [] }
  let failed = null
  const one = (line) => {
    const m = /^data:\s?(.*)$/.exec(line)
    if (!m || m[1] === "[DONE]") return
    let v
    try {
      v = JSON.parse(m[1])
    } catch {
      return
    }
    if (v?.error !== undefined) failed ??= v
    else fold(out, v)
  }
  try {
    for await (const chunk of res.body ?? []) {
      rest += dec.decode(chunk, { stream: true })
      let i
      while ((i = rest.indexOf("\n")) >= 0) {
        one(rest.slice(0, i))
        rest = rest.slice(i + 1)
      }
    }
    one(rest + dec.decode())
  } catch (e) {
    failed ??= { error: { message: e?.message ?? String(e) } }
  }
  if (failed) return explained(new Response(JSON.stringify(failed), { status: 502, headers: { "content-type": "application/json" } }))
  out.choices = out.choices.filter(Boolean)
  if (!out.choices.length) return errorResponse({ status: 502, message: "WorkBuddy's stream ended without an answer" })
  namedBack(out, names)
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", ...KEPT } })
}
