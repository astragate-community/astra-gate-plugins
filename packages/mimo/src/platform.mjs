// Xiaomi MiMo: the open platform's Token Plan — its pages, its plan and its tp- key.
import { ACCOUNT, PLATFORM, TP_LIFE } from "./constants.mjs"
import { accountJar, cookieHeader, follow } from "./cookies.mjs"
import { statusLine, vendorError } from "./errors.mjs"
import { tryJSON } from "./json.mjs"
import { fromAuth } from "./store.mjs"

// credits is a count of the Token Plan's credits, short: 6.81M, 4.1B
export function credits(n) {
  for (const [d, u] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n >= d) return `${Number((n / d).toPrecision(3))}${u}`
  }
  return String(n)
}

// The same Xiaomi account signs on at the platform as at the MiMo server: a
// page asked with no session answers 401 with a serviceLogin URL (sid
// api-platform), which the passToken follows back through the platform's
// /sts to the page.
//
// platformPage is one of the platform's /api/v1 pages, as {cookies, data}:
// cookies the session it was read with (given in, else signed on afresh),
// data the page's; null data is a page the account can't read.
export async function platformPage(creds, path, cookies) {
  const signal = AbortSignal.timeout(20_000)
  const url = PLATFORM + "/api/v1" + path
  const ask = async (c) => {
    const res = await fetch(url, { headers: c ? { Cookie: c } : {}, redirect: "manual", signal })
    return { res, text: await res.text() }
  }
  const data = (text) => {
    const v = tryJSON(text)
    return v?.code === 0 ? (v.data ?? null) : undefined
  }
  if (cookies) {
    const { res, text } = await ask(cookieHeader(cookies))
    const d = res.status === 200 ? data(text) : undefined
    if (d !== undefined) return { cookies, data: d }
  }
  const first = await ask("")
  const login = tryJSON(first.text)?.loginUrl
  if (first.res.status !== 401 || typeof login !== "string" || !login.startsWith(ACCOUNT + "/")) {
    throw new Error(`Xiaomi MiMo platform ${path}: ${vendorError(first.text, statusLine(first.res.status))}`)
  }
  const jar = accountJar(creds)
  const { res } = await follow(jar, login, { signal, home: PLATFORM, tooMany: "Xiaomi MiMo platform sign-in: too many redirects" })
  const text = await res.text()
  const d = res.status === 200 ? data(text) : undefined
  // back on Xiaomi's sign-in page: the passToken doesn't sign on here
  if (d === undefined) throw new Error(`Xiaomi MiMo platform ${path}: the Xiaomi account didn't sign on (${statusLine(res.status)})`)
  const got = {}
  for (const c of jar.for(PLATFORM + "/")) got[c.name] = c.value
  return { cookies: got, data: d }
}

export function createPlatform() {
  const platform = new Map() // userId -> the platform's session cookies
  const planKeys = new Map() // userId -> {key, base, at}

  // reader reads the platform's pages for an account, keeping the session
  // each answer was read with for the next
  const reader = (a, who) => {
    let c = platform.get(who)
    return async (path) => {
      const r = await platformPage(a.creds, path, c)
      c = r.cookies
      platform.set(who, c)
      return r.data
    }
  }

  // tokenPlan is the account's Token Plan at the open platform, as
  // {plan, until, renew, window}, or null: none, or the platform can't be
  // read (the app's card goes on without it). Its credits are spent by
  // its tp- key, not by this account's requests, so they are an aside.
  const tokenPlan = async (getAuth, app) => {
    const a = fromAuth(await getAuth())
    if (!a) return null
    const who = String(a.creds.userId)
    try {
      const read = reader(a, who)
      const p = await read("/tokenPlan/detail")
      const name = typeof p?.planName === "string" ? p.planName.trim() : ""
      if (!name || p.expired !== false) return null
      const out = { plan: `Token Plan ${name}`, renew: p.enableAutoRenew || p.hasAutoRenewSubscribed ? "auto" : "off" }
      // the platform's times are UTC ("有效期至 2026-11-06 23:59:59 (UTC)")
      const end = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(p.currentPeriodEnd ?? "") ? Date.parse(p.currentPeriodEnd.replace(" ", "T") + "Z") : NaN
      if (!isNaN(end)) out.until = new Date(end).toISOString()
      try {
        const u = await read("/tokenPlan/usage")
        const w = creditWindow(u, app)
        if (w) {
          out.window = w
          if (out.until) out.window.resetsAt = out.until
        }
      } catch {}
      return out
    } catch {
      platform.delete(who)
      return null
    }
  }

  // planKey is the account's Token Plan as {key, base, at}: its tp- key
  // and OpenAI base URL, or null when it has no live plan or no key (the
  // platform's page makes one; magpie doesn't make it for them)
  const planKey = async (a) => {
    const who = String(a.creds.userId)
    const had = planKeys.get(who)
    if (had && Date.now() - had.at < TP_LIFE) return had
    planKeys.delete(who)
    try {
      const read = reader(a, who)
      const p = await read("/tokenPlan/detail")
      if (!p?.planName || p.expired !== false) return null
      const k = await read("/tokenPlan/apiKey")
      const base = typeof k?.openaiBaseUrl === "string" && /^https:\/\/[^/]+\.xiaomimimo\.com\//.test(k.openaiBaseUrl) ? k.openaiBaseUrl.replace(/\/+$/, "") : ""
      if (!base) return null
      const key = await read("/tokenPlan/apiKey/raw")
      if (typeof key !== "string" || !key.startsWith("tp-")) return null
      const got = { key, base, at: Date.now() }
      planKeys.set(who, got)
      return got
    } catch {
      platform.delete(who)
      return null
    }
  }

  // forgetKey drops an account's tp- key, read again next time
  const forgetKey = (who) => planKeys.delete(who)

  return { tokenPlan, planKey, forgetKey }
}

// creditWindow is the Token Plan's credits spent, as a usage window, or null
// when the page doesn't say
export function creditWindow(page, app) {
  const items = [...(page?.monthUsage?.items ?? []), ...(page?.usage?.items ?? [])]
  const it = items.find((x) => x?.name === "month_total_token") ?? items.find((x) => x?.name === "plan_total_token")
  if (!(Number.isFinite(it?.used) && Number(it?.limit) > 0)) return null
  const w = {
    name: app ? "Token Plan · API key" : "Token Plan",
    used: Math.max(0, Math.min(100, (100 * it.used) / it.limit)),
    display: `${credits(it.used)} / ${credits(it.limit)} credits`,
  }
  // with an app plan, the account's requests go to the app: the
  // Token Plan's credits are its key's, an aside
  if (app) w.aside = true
  return w
}
