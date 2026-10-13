// The provider's fetch: sends each request on the plan it belongs to — the coding plan with the account's key,
// or the Start Plan / gift as ZCode's own request — and reads the gift's refusals.
import { kept } from "@astragate-community/plugin-kit"
import { BIGMODEL_BASE, EXPIRED, PROVIDER, START_BASE, ZAI_BASE } from "./constants.mjs"
import { blocked, giftModel, giftUsable, spentUp, startPlan } from "./gift.mjs"
import { plansOf } from "./routing.mjs"
import { jwtExpired, keyOf, stateOf } from "./session.mjs"
import { dress, modelOf, startHeaders, workPlace } from "./start.mjs"

// rebase moves a request's URL from whichever plan's base it carries to base.
export function rebase(url, base) {
  for (const b of [START_BASE, ZAI_BASE, BIGMODEL_BASE]) if (url.startsWith(b)) return base + url.slice(b.length)
  return url
}

const bodyText = async (body) => (typeof body === "string" ? body : await new Response(body).text())

// trialRequest: a "-Trial" model is the gift's entry. Its raw name and the body naming it, or the answer
// refusing it: the gift is spent, or has no such model.
async function trialRequest(s, gift, body, m) {
  gift ??= await startPlan(s.jwt, s.device).catch(() => null)
  const raw = giftModel(gift, m)
  if (!(raw && giftUsable(s, gift, raw))) {
    const error = { type: raw ? "rate_limit_error" : "invalid_request_error", message: raw ? `ZCode's limited quota for ${raw} is exhausted or temporarily unavailable` : `ZCode has no active limited quota for ${m}` }
    return { refusal: kept(new Response(JSON.stringify({ type: "error", error }), { status: raw ? 429 : 400, headers: { "content-type": "application/json" } })) }
  }
  return { body: JSON.stringify({ ...JSON.parse(body), model: raw }) }
}

// a trial entry's gift answer that can't serve the request is
// the agent's answer, not the coding plan's: the user picked the
// gift, so a spent bucket says 429 (its quota error inside a 200
// among them) and anything else goes on as it came. A quota
// answer keeps that model off the gift for a minute, so a rate
// limit is not knocked twice. A stream's body is never read here.
async function giftAnswer(res, s, body) {
  const json = (res.headers.get("content-type") ?? "").includes("application/json")
  if (res.status >= 400 || json) {
    const text = await res.text()
    const spent = spentUp(text, res.status)
    if (!spent && res.status < 400) return kept(res, text)
    if (spent) {
      for (const [k, until] of blocked) if (Date.now() >= until) blocked.delete(k)
      blocked.set(s.key + "\0" + s.jwt + "\0" + modelOf(body).toLowerCase(), Date.now() + 60_000)
    }
    return spent && res.status < 400 ? kept(new Response(text, { status: 429, headers: res.headers })) : kept(res, text)
  }
  return null
}

/** The `fetch` the auth loader hands OpenCode / magpie for this provider. */
export function planFetch(getAuth, client, id = PROVIDER) {
  return async (input, init) => {
    const auth = await getAuth()
    const s = stateOf(auth)
    if (!s) throw new Error("not signed in to ZCode")
    let url = input instanceof Request ? input.url : String(input)
    const opts = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init } : { ...init }
    const { start: alone, gift: known } = await plansOf(s)
    const key = await keyOf(s, auth, client, id)
    // a dual account's body is read ahead of sending, so a gift that
    // says it is spent can spend nothing and replay what was asked for
    let start = alone
    let orig, forcedGift = false
    if (opts.body != null) {
      orig = opts.body = await bodyText(opts.body)
      delete opts.duplex
      const m = modelOf(orig)
      if (m.toLowerCase().endsWith("-trial")) {
        const t = await trialRequest(s, known, orig, m)
        if (t.refusal) return t.refusal
        orig = opts.body = t.body
        forcedGift = true
      }
      start = alone || forcedGift
    }
    const h = new Headers(opts.headers)
    const place = workPlace(h)
    if (start) {
      if (jwtExpired(s.jwt)) throw new Error(EXPIRED)
      if (!s.jwt) throw new Error("ZCode's sign-in has no key; sign in again")
      url = rebase(url, START_BASE)
      // the Start Plan is served only to what looks like ZCode's own request
      startHeaders(h, s.jwt)
      if (opts.body != null) {
        opts.body = dress(orig, s.site, s.device, place)
        delete opts.duplex
        h.delete("content-length")
      }
    } else {
      if (!key) throw new Error("ZCode's sign-in has no key; sign in again")
      url = rebase(url, s.base)
      h.delete("authorization")
      h.set("x-api-key", key)
      h.set("Authorization", "Bearer " + key)
    }
    const res = await fetch(url, { ...opts, headers: h })
    if (start && forcedGift) {
      const answer = await giftAnswer(res, s, orig)
      if (answer) return answer
    }
    // the plan's answer goes on as it came, the account kept: the
    // built-in never marked a ZCode account lapsed nor cleared one
    return kept(res)
  }
}
