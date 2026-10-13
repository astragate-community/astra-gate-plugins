// WorkBuddy: calling its API and signing a request as its desktop app does.
import { UA_VERSION } from "./constants.mjs"
import { statusText } from "@astragate-community/plugin-kit"
import { api } from "./sites.mjs"

// ---- WorkBuddy's API ------------------------------------------------------

class WBError extends Error {
  constructor(message, code, status, said) {
    super(message)
    this.code = code
    this.status = status
    this.said = said // as magpie's built-in (wbCall) worded it
  }
}

// call makes a request of WorkBuddy's plugin API, which answers
// {code, msg, data}; a code but 0 is an error.
export async function call(site, method, path, headers = {}, body) {
  const res = await fetch(site.endpoint + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WorkBuddy/" + UA_VERSION,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  const code = Number.parseInt(env.code, 10) || 0
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText
    const said = code ? env.msg || `error ${code}` : env.msg || statusText(res.status)
    throw new WBError(`${site.name}: ${why} (HTTP ${res.status}${env.code ? ", code " + env.code : ""})`, env.code, res.status, said)
  }
  if (env.code) throw new WBError(`${site.name}: ${env.msg || "error"} (${env.code})`, env.code, res.status, env.msg || `error ${code}`)
  return env.data
}

export function domainOf(site, a) {
  return a.domain || new URL(api(site)).host
}

// sign sets on headers what WorkBuddy's desktop app sends with a chat: the
// account's own, the client's, and the attribution WorkBuddy's usage list
// shows as the client that asked (使用端). The chat's ids — the
// conversation's, the turn's, the message's — are attend's below.
//
// WorkBuddy's own client sends the whole of this on both builds
// (application-manifest.js: X-Agent-Purpose "conversation", X-IDE-Name/Type
// "WorkBuddy", X-IDE-Version, X-Product "SaaS"); a chat without them is
// counted under no client at all, which is the empty 使用端 a request shows
// when only some of the group is there. The gate below used to give the China
// build none of the client's headers, so every China-build request was
// attribution-less.
export function sign(site, a, headers) {
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("X-User-Id", a.uid ?? "")
  headers.set("X-Domain", domainOf(site, a))
  headers.set("X-Product", "SaaS")
  headers.set("X-IDE-Type", "WorkBuddy")
  headers.set("User-Agent", "WorkBuddy/" + UA_VERSION)
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("X-Agent-Intent", "craft")
  headers.set("X-Agent-Purpose", "conversation")
  headers.set("X-IDE-Name", "WorkBuddy")
  headers.set("X-IDE-Version", UA_VERSION)
  for (const [k, v] of Object.entries(enterpriseHeaders(a))) headers.set(k, v)
  if (!site.ai) return
  headers.set("X-Agent-Type", "main")
}

// enterpriseHeaders names the enterprise (team) an account signed in as, as
// WorkBuddy's own client does on every request it makes for that account
// (its auth interceptor: X-Enterprise-Id and X-Tenant-Id, both the
// account's enterpriseId). Without them WorkBuddy answers as the personal
// account: /v3/config lists the personal plan's models and not the
// enterprise's (#75). A personal account has none and sends none.
export function enterpriseHeaders(a) {
  const id = typeof a?.enterpriseId === "string" ? a.enterpriseId.trim() : ""
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {}
}

// postMeter asks the billing API (the meter has no /v2 prefix, on either build) and gives its answer whole:
// the HTTP status, WorkBuddy's code and message, and its data. Callers decide what a code means.
export async function postMeter(site, a, path, body = {}) {
  const res = await fetch(site.endpoint + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WorkBuddy/" + UA_VERSION,
      Authorization: "Bearer " + a.access,
      "X-User-Id": a.uid ?? "",
      "X-Domain": domainOf(site, a),
      "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy",
      ...enterpriseHeaders(a),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  let env = {}
  try {
    env = JSON.parse(await res.text()) ?? {}
  } catch {}
  return { status: res.status, code: Number.parseInt(env.code, 10) || 0, msg: env.msg || env.message || "", data: env.data ?? null }
}

// meter is postMeter for a call that must succeed: errors are said as magpie's built-in did — WorkBuddy's
// message, else its code, else the HTTP status.
export async function meter(site, a, path, body = {}) {
  const r = await postMeter(site, a, path, body)
  if (r.status < 200 || r.status >= 300) {
    if (r.code) throw new Error(r.msg || `error ${r.code}`)
    throw new Error(r.msg || statusText(r.status))
  }
  if (r.code) throw new Error(r.msg || `error ${r.code}`)
  return r.data
}
