// How much of the subscription's allowance is gone, as magpie's built-in
// Grok account shows it (internal/provider/grok_usage.go) and the CLI's own
// /usage reads it: the credits of the current period, weekly for
// SuperGrok, and what on-demand spending has used of its cap.
import { statusText } from "@astragate-community/plugin-kit"
import { BASE } from "./constants.mjs"
import { rateWindow } from "./ratelimit.mjs"
import { homeOf, remember, token } from "./session.mjs"

const PERIODS = { DAILY: ["1 day", 24 * 3600], WEEKLY: ["7 days", 7 * 24 * 3600], MONTHLY: ["Month", 30 * 24 * 3600] }
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// netError is a request that got no answer, as Go's http client words it
// (`Get "<url>": …`), with the words magpie's keepLast looks for to keep
// the card it had: no such host, connection refused, timeout, EOF.
export function netError(url, e) {
  const m = String(e?.message ?? e)
  const code = String(e?.code ?? e?.cause?.code ?? "")
  let why = m
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out/i.test(m)) why = "timeout"
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo|ENOTFOUND|resolve|DNS/i.test(m)) why = "dial tcp: lookup: no such host"
  else if (code === "ECONNREFUSED" || /ECONNREFUSED|Unable to connect|refused/i.test(m)) why = "dial tcp: connection refused"
  else if (/ECONNRESET|socket|closed|fetch failed/i.test(m + code)) why = "EOF"
  return `Get "${url}": ${why}`
}

// jsonError is JSON that won't read, as Go's encoding/json says it.
export function jsonError(text) {
  const c = text.trimStart()[0]
  return c === undefined ? "unexpected end of JSON input" : `invalid character '${c}' looking for beginning of value`
}

// windowsOf is the allowance cards a billing answer (format=credits) holds.
export function cardsOf(data) {
  const cfg = data?.config ?? {}
  const num = (v) => (typeof v === "number" ? v : 0)
  let [name, span] = ["Allowance", 0]
  let end = cfg.billingPeriodEnd
  if (cfg.currentPeriod) {
    ;[name, span] = PERIODS[String(cfg.currentPeriod.type ?? "").replace(/^USAGE_PERIOD_TYPE_/, "")] ?? ["Allowance", 0]
    end = cfg.currentPeriod.end
  }
  const at = typeof end === "string" && RFC3339.test(end) && !Number.isNaN(Date.parse(end)) ? { resetsAt: end } : {}
  const out = [{ name, used: num(cfg.creditUsagePercent), ...(span ? { span } : {}), ...at }]
  const cap = num(cfg.onDemandCap?.val)
  if (cap > 0) out.push({ name: "On-demand", used: (100 * num(cfg.onDemandUsed?.val)) / cap, ...at, aside: true })
  return out
}

export async function usage(key) {
  const url = `${BASE}/billing?format=credits`
  let res, text
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) text = await res.text()
  } catch (e) {
    return { error: netError(url, e), windows: [] }
  }
  if (!res.ok) return { error: statusText(res.status), windows: [] }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { error: jsonError(text), windows: [] }
  }
  return { windows: cardsOf(data) }
}

// accountUsage is auth.usage: how much of the subscription's allowance is gone; each
// read keeps the sign-in (signIn), as the built-in's marked no
// account lapsed nor cleared one
export async function accountUsage(client, getAuth) {
  const auth = await getAuth()
  let c
  try {
    c = await token(homeOf(auth), false)
  } catch (e) {
    return { error: e.message, windows: [], signIn: "kept" }
  }
  await remember(client, auth, c)
  const u = await usage(c.key)
  if (!u.error) u.windows = [...rateWindow(auth.refresh), ...u.windows]
  return { ...u, signIn: "kept" }
}
