// Helpers for the tests: a fetch that answers from a script and remembers what it was asked, SSE bodies, a JWT.
import { generateKeyPairSync } from "node:crypto"

export const NOW = Date.now()

// one real device key, made once: a renewal signs its proof with it
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
export const DEVICE_KEYS = { devicePublicKey: key.publicKey.export({ type: "spki", format: "pem" }), devicePrivateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }) }

// a JWT whose exp is `seconds` from now (the signature is not checked anywhere)
export const jwt = (seconds = 3600) => "h." + Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + seconds })).toString("base64url") + ".s"

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

export const ev = (event, data) => `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`

export const sseBody = (...chunks) =>
  new Response(new ReadableStream({ start(ctl) { for (const c of chunks) ctl.enqueue(new TextEncoder().encode(c)); ctl.close() } }), { status: 200, headers: { "content-type": "text/event-stream" } })

/** Replaces fetch; `script(url, init, calls)` answers. Returns the calls made, [{ url, init, body }]. */
export function fake(script) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: typeof init.body === "string" ? init.body : null }
    calls.push(call)
    return script(call.url, init, calls)
  }
  return calls
}

const realFetch = globalThis.fetch
export const restoreFetch = () => {
  globalThis.fetch = realFetch
}

export const collect = async (it) => {
  const out = []
  for await (const x of it) out.push(x)
  return out
}

export const readAll = async (res) => ({ status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() })

// a stored sign-in
export const auth = (o = {}) => ({
  type: "oauth", access: jwt(), refresh: "R1", expires: NOW + 3600_000, accountId: "alice", uid: "u1", clientId: "ono9krqynydwx5",
  deviceId: "1234567890123456789", machineId: "abcd", ...DEVICE_KEYS, ...o,
})

// the OpenAI chat request the agent sends
export const chatRequest = (o = {}) => ({ model: "glm-5", messages: [{ role: "user", content: "hello" }], ...o })
