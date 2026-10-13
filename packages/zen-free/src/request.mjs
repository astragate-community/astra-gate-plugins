// Shaping a chat request for Zen: validating the endpoint and credential, keeping the agent's tools, and the
// headers (OpenCode's own client identity, one session id everywhere) the request goes out with.
import { createHash, randomUUID } from "node:crypto"
import { CORE_TOOLS, OPENCODE_VERSION } from "./constants.mjs"

export function httpURL(value) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment")
  }
  return url.href.replace(/\/+$/, "")
}

export function requirePublic(auth) {
  if (auth?.type !== "api" || auth.key !== "public") {
    throw new Error("OpenCode Zen Free uses the public credential. Enable its free access login method.")
  }
}

/**
 * Adds the core tools the agent did not declare, as stubs that say they are unavailable, and returns which
 * tool names the agent declared (what a reply may call) and which were injected.
 */
export function normalizeTools(body, protocol) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array")
  }
  body.tools ??= []
  const present = new Set(body.tools.map((tool) => (protocol === "chat" ? tool?.function?.name : tool?.name)))
  const declared = new Set([...present].filter((name) => typeof name === "string"))
  if (protocol === "chat" && Array.isArray(body.functions)) {
    for (const tool of body.functions) if (typeof tool?.name === "string") declared.add(tool.name)
  }
  const injected = new Set()
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue
    injected.add(name)
    const parameters = { type: "object", properties: {}, additionalProperties: false }
    const definition = { name, description: "Not available. Never call this tool." }
    body.tools.push(
      protocol === "chat"
        ? { type: "function", function: { ...definition, parameters } }
        : protocol === "anthropic"
          ? { ...definition, input_schema: parameters }
          : { type: "function", ...definition, parameters },
    )
  }
  return { declared, injected }
}

const SESSION_HEADERS = ["x-opencode-session", "x-session-affinity", "x-session-id", "conversation-id"]
const SESSION_FORMAT = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** The conversation's id in OpenCode's `ses_…` format, from a header, the body's metadata or its first user turn. */
export function sessionID(headers, body) {
  let signal
  for (const name of SESSION_HEADERS) {
    if (headers.get(name)) {
      signal = headers.get(name)
      break
    }
  }
  if (!signal && typeof body.metadata?.session_id === "string") signal = body.metadata.session_id
  if (!signal) {
    const messages = body.messages ?? body.input
    const first = Array.isArray(messages) ? messages.find((message) => message.role === "user")?.content : messages
    signal = first ? JSON.stringify(first) : randomUUID()
  }
  if (SESSION_FORMAT.test(signal)) return signal
  // Keep conversation affinity using OpenCode's canonical session format.
  const hash = createHash("sha256").update(`ses\0${signal}`).digest("hex")
  let value = BigInt(`0x${hash.slice(12, 32)}`)
  let suffix = ""
  for (let i = 0; i < 14; i++) {
    suffix = BASE62[Number(value % 62n)] + suffix
    value /= 62n
  }
  return `ses_${hash.slice(0, 12)}${suffix}`
}

const DROPPED_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "content-length", "content-encoding", "host", "cookie"]
const SESSION_ECHOES = ["x-session-id", "x-opencode-session", "x-session-affinity"]

/** The headers a request goes to Zen with: the caller's, minus its credentials, plus OpenCode's identity. */
export function upstreamHeaders(request, body, protocol, project) {
  const headers = new Headers(request.headers)
  for (const name of DROPPED_HEADERS) headers.delete(name)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  headers.set("user-agent", `opencode/${OPENCODE_VERSION}`)
  headers.set("x-opencode-client", "cli")
  headers.set("x-opencode-request", `req_${randomUUID().replaceAll("-", "")}`)
  if (!headers.has("x-opencode-project")) {
    headers.set("x-opencode-project", project?.vcs === "git" && project.id ? project.id : "global")
  }
  const session = sessionID(headers, body)
  for (const name of SESSION_ECHOES) headers.set(name, session)
  if (protocol === "anthropic") {
    headers.set("x-api-key", "public")
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  } else {
    headers.set("authorization", "Bearer public")
  }
  return headers
}
