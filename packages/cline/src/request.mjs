// Shaping a chat request for Cline's gateway: the task id, the pinned upstream, the body and the headers.
import { createHash } from "node:crypto"
import { SESSION } from "./constants.mjs"
import { clientHeaders } from "./api.mjs"

// magpie's synthetic session from the first user message doesn't identify a
// task: unrelated conversations can start with that same message.
export function sessionOf(input) {
  const s = String(input?.sessionID ?? "").trim()
  if (!s || /^magpie-[0-9a-f]{24}$/.test(s)) return ""
  return s.slice(0, 128)
}

/** The task id Cline's gateway groups a chat under: a version-4-shaped UUID derived from the session. */
export function taskIdOf(session) {
  const bytes = createHash("sha256").update("cline task\0").update(session).digest().subarray(0, 16)
  const b = Buffer.from(bytes)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// isOn is whether an option is set: true, or "true" in a config written by hand
export const isOn = (v) => v === true || v === "true"

// pinned is the upstream a DeepSeek model of Cline's is pinned to when the
// pinUpstream option is on (magpie's built-in ClinePass has the same tick):
// Cline's gateway otherwise picks among the providers serving the model, and
// some answer DeepSeek's models worse than DeepSeek's own API. A cline-free/
// model is left to Cline, as is every model that isn't DeepSeek's.
export function pinned(on, model) {
  if (!on || typeof model !== "string" || model.startsWith("cline-free/")) return ""
  return model.slice(model.lastIndexOf("/") + 1).toLowerCase().startsWith("deepseek") ? "deepseek" : ""
}

// pinBody is the request's body with providerOptions.gateway.only set to the
// pinned upstream, written in at the end so the rest of the body — the
// prefix a cache matches — is the client's byte for byte. A body that has
// providerOptions of its own is the client's to keep.
export function pinBody(body, chat, on) {
  const up = pinned(on, chat?.model)
  if (!up || chat.providerOptions !== undefined) return body
  const end = body.lastIndexOf("}")
  if (end < 0) return body
  const head = body.slice(0, end)
  const sep = /[{,]\s*$/.test(head) ? "" : ","
  return head + sep + `"providerOptions":${JSON.stringify({ gateway: { only: [up] } })}` + body.slice(end)
}

/** The body of a fetch call as text, however the caller gave it (init, a Request, bytes, a stream). */
export async function bodyText(input, init) {
  const b = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (b === undefined || b === null) return ""
  if (typeof b === "string") return b
  if (b instanceof URLSearchParams) return b.toString()
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b)
  try {
    return await new Response(b).text()
  } catch {
    return ""
  }
}

/** The URL a fetch call is for. */
export const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

/** The chat completion body to send: what the client sent, the pinned upstream written in. Throws on anything that isn't a chat object. */
export async function chatBody(input, init, pin) {
  const body = await bodyText(input, init)
  const chat = JSON.parse(body)
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) throw new Error("not a chat completion")
  return pinBody(body, chat, pin)
}

/** The headers to send: the client's own, the private session header taken off, the account's token and Cline's identity set. */
export function chatHeaders(input, init, bearer) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const session = headers.get(SESSION)
  headers.delete(SESSION)
  headers.delete("X-Task-ID")
  headers.set("Authorization", `Bearer ${bearer}`)
  for (const [k, v] of Object.entries(clientHeaders(session ? taskIdOf(session) : undefined))) headers.set(k, v)
  headers.delete("content-length")
  headers.delete("host")
  return headers
}
