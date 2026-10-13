// Qoder: turning a failure (Qoder's, or the plugin's own) back into the refusal OpenCode and magpie expect,
// and saying what an answer means for the account's sign-in.
import { STATUS_CODES } from "node:http"
import { errorResponse as refusal, kept } from "@astragate-community/plugin-kit"
import { SignInGone } from "./errors.mjs"

// failure is the status and message for a Qoder failure. Qoder's own code
// says what it is, read as Qoder's client reads it (QoderErrorCode in the
// app's qoder-agent-sdk worker): only 105 (loginExpired) is a lapsed
// sign-in there, so a 401/403 that carries another code isn't one here
// either (#98: a queued 10605 came as a 403 and read as "sign in again").
// A refused chat with no code keeps the built-in's 401, and a quota is a
// 429.
const QUEUED = "10605"
// the codes Qoder's client counts as a plan's usage or credits used up
const QUOTA_CODES = new Set(["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"])
// refusals of this request, not of the account: sensitive content, not
// supported, input too long, too many media, a custom model's service
const REQUEST_CODES = new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100403"])
const BUSY_WAIT = 30

export function failure(status, text) {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? "").trim()
  let code = ""
  let queue
  try {
    const j = JSON.parse(text)
    code = j?.code == null ? "" : String(j.code)
    if (j?.message) msg = String(j.message)
    // details is a JSON string, or the object itself (gjson reads either)
    const d = typeof j?.details === "string" ? JSON.parse(j.details) : j?.details
    if (d?.error?.message) msg += ": " + d.error.message
    // the queue's state: the message itself, as a JSON string, or a field
    queue = j?.queue && typeof j.queue === "object" ? j.queue : undefined
    if (!queue && typeof j?.message === "string" && j.message.trim().startsWith("{")) {
      const q = JSON.parse(j.message)
      if (q && typeof q === "object" && ("isQueued" in q || "serviceAvailable" in q || "retryAfterSeconds" in q)) queue = q
    }
  } catch {}
  msg ||= STATUS_CODES[status] ?? `HTTP ${status}`
  // Qoder's queue for the model: busy for now, with when to ask again. The
  // sign-in is fine (the same token reads the models and the usage), so it
  // is a 503 with Retry-After, which magpie asks again after, and never
  // touches the account's sign-in.
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds)
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : BUSY_WAIT
    const model = queue?.modelKey ? ` for ${queue.modelKey}` : ""
    const tier = queue?.queueType ? ` (this plan's queue: ${queue.queueType})` : ""
    const what = queue?.isQueued === true ? "queued the request" : "is busy"
    return { status: 503, message: `Qoder ${what}${model}${tier}; try again in ${wait}s`, retryAfter: wait, signIn: "" }
  }
  if (QUOTA_CODES.has(code)) return { status: 429, message: "usage limit reached: " + msg, signIn: "" }
  if (REQUEST_CODES.has(code)) return { status: 400, message: `Qoder refused the request (${code}): ${msg}`, signIn: "" }
  // a refused chat is the built-in's 401, which never marked the account
  // lapsed: only a refused refresh did (errorResponse says kept). Qoder's
  // own words go with it: a 401 right after signing in isn't a lapsed
  // sign-in, and its reason is what says what is (Yayoi_no_yume on X).
  if (status === 401 || status === 403) {
    const said = msg && msg !== STATUS_CODES[status] ? ` (Qoder said ${status}: ${msg.slice(0, 300)})` : ""
    return { status: 401, message: "the sign-in lapsed — sign in again" + said }
  }
  if (status === 429 || msg.toLowerCase().includes("quota")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

// errorResponse is a failure as OpenAI's API gives it. signIn is what it
// means for the account (magpie's X-Magpie-Sign-In): a 401 keeps it unless
// told expired, since the built-in marked only a refused refresh; any other
// status says nothing. retryAfter (seconds) is sent as Retry-After.
export function errorResponse({ status, message, signIn = status === 401 ? "kept" : "", retryAfter }) {
  const res = refusal({ status, message, type: "qoder_error", signIn: signIn || "" })
  if (retryAfter > 0) res.headers.set("Retry-After", String(retryAfter))
  return res
}

// signedInError is the refusal for a sign-in that couldn't be used: a lapsed one is a 401 (expired when Qoder
// refused the refresh token), anything else a 502.
export function signedInError(site, e) {
  return errorResponse({
    status: e instanceof SignInGone ? 401 : 502,
    message: String(e?.message ?? e).replace(new RegExp(`^${site.name}: `), ""),
    signIn: e?.expired ? "expired" : undefined,
  })
}

// signed is res saying what it means for the sign-in, as the built-in's
// answer did: a renewed job token cleared the mark whatever came of the
// request; without one, a success left the mark as it was.
export function signed(res, renewed) {
  if (renewed) {
    const headers = new Headers(res.headers)
    headers.set("X-Magpie-Sign-In", "renewed")
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  return res.ok ? kept(res) : res
}
