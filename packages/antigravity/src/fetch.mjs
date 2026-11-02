// Antigravity: the fetch OpenCode / magpie are given — each Gemini request answered through Code Assist.
import { sleep } from "@astragate-community/plugin-kit"
import { post } from "./api.mjs"
import { ENDPOINTS, RETRY_WAIT_MAX } from "./constants.mjs"
import { describe } from "./errors.mjs"
import { knownFor } from "./models.mjs"
import { envelope, shape } from "./request.mjs"
import { collect, failed, refusal, streamOf } from "./response.mjs"

// the host that answered last goes first next time
let preferred = ENDPOINTS[0]
const hosts = () => [preferred, ...ENDPOINTS.filter((h) => h !== preferred)]

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

async function bodyOf(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
}

// what a failure to have a sign-in to use is answered as: a sign-in Google turned down marks the account, anything else doesn't
const signInError = (e) => refusal(e?.gone ? 401 : 502, String(e?.message ?? e), { signIn: e?.signIn ?? "kept" })

// a rough count of the text of a request, for the client that asks (Code Assist has no method for it)
function countTokens(body) {
  let chars = 0
  const walk = (v) => {
    if (typeof v === "string") chars += v.length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "role") walk(x)
  }
  walk(body.contents)
  walk(body.systemInstruction ?? body.system_instruction)
  walk(body.tools)
  return new Response(JSON.stringify({ totalTokens: Math.ceil(chars / 4) }), { status: 200, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } })
}

/**
 * chatFetch answers a request to the Gemini provider's fetch: a model's generateContent or streamGenerateContent.
 * Code Assist answers a stream only, so a reply that isn't streamed is the stream collected.
 */
export async function chatFetch(creds, getAuth, auth, input, init = {}) {
  const path = new URL(urlOf(input)).pathname
  const m = /\/models\/([^/:]+):(\w+)$/.exec(path)
  if (!m) return refusal(404, `this plugin only answers Gemini's generateContent and streamGenerateContent, not ${path}`)
  const model = decodeURIComponent(m[1])
  const stream = m[2] === "streamGenerateContent"
  if (!stream && m[2] !== "generateContent" && m[2] !== "countTokens") return refusal(404, `Antigravity doesn't answer ${m[2]}`)
  let body
  try {
    body = await bodyOf(input, init)
  } catch {
    return refusal(400, "a request that isn't JSON")
  }
  if (m[2] === "countTokens") return countTokens(body.generateContentRequest ?? body)

  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  let cur
  try {
    cur = await creds((await getAuth()) ?? auth)
  } catch (e) {
    return signInError(e)
  }
  const payload = JSON.stringify(envelope(shape(body, model, { known: knownFor(cur.project) }), cur.project))

  let last = refusal(502, "Antigravity has no host to ask")
  let refreshed = false
  let waited = false
  const order = hosts()
  for (let i = 0; i < order.length; i++) {
    const base = order[i]
    let res
    try {
      res = await post(base, "streamGenerateContent", cur.token, payload, { signal, query: "?alt=sse" })
    } catch (e) {
      if (signal?.aborted) throw e
      last = refusal(502, `Antigravity: ${e?.message ?? e}`)
      continue
    }
    if (res.ok) {
      preferred = base
      return stream ? streamOf(res) : collect(res)
    }
    const text = await res.text()
    const d = describe(res.status, text)
    if (d.kind === "auth" && !refreshed) {
      // the token was turned down: refreshed (unless someone already has), and asked again of the same host
      refreshed = true
      try {
        cur = await creds((await getAuth()) ?? auth, cur.token)
      } catch (e) {
        return signInError(e)
      }
      i--
      continue
    }
    if ((d.kind === "limit" || d.kind === "capacity") && d.waitMs > 0 && d.waitMs <= RETRY_WAIT_MAX && !waited) {
      // a short limit is waited out once; a long one is the caller's to route around (another account, another model)
      waited = true
      await sleep(Math.max(d.waitMs, 1000))
      i--
      continue
    }
    last = failed(res.status, text)
    // another host may be able to answer where this one couldn't
    if (d.kind === "busy" || res.status === 404 || res.status === 408 || res.status >= 500) continue
    return last
  }
  return last
}
