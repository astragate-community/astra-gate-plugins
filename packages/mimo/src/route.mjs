// Xiaomi MiMo: sending a model request — to the app's /route, or, for an account the app refused, to its Token Plan.
import { APP_VERSION, SOURCE, TP_LIFE, TP_MODELS, UA } from "./constants.mjs"
import { cookieHeader } from "./cookies.mjs"
import { expiredMessage } from "./errors.mjs"
import { tryJSON } from "./json.mjs"
import { bodyText, planPath, renamedModel, said, withAutoModel } from "./request.mjs"
import { fromAuth } from "./store.mjs"
import { Lapsed } from "./sso.mjs"

export function createRoute({ fresh, platform }) {
  // onPlan is the accounts the app refused (membership_required), and when
  const onPlan = new Map()

  // the fetch OpenCode's provider sends the model's requests through
  return async function route(getAuth, a, input, init = {}) {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const body = withAutoModel(bodyText(init.body ?? (req ? await req.text() : undefined)))
    let s
    try {
      s = await fresh(getAuth, false)
    } catch (e) {
      // the passToken no longer signs the account on: the built-in
      // failed the request (magpie's 502) in mimoLapse's words and
      // marked the account lapsed
      if (!(e instanceof Lapsed)) throw e
      const who = fromAuth(await getAuth())?.creds.userId ?? a.creds.userId
      const message = expiredMessage(who)
      return said(new Response(JSON.stringify({ error: { message, type: "api_error", code: null } }), { status: 502, headers: { "content-type": "application/json" } }), "expired")
    }
    const who = String(s.creds.userId)
    const method = init.method ?? req?.method ?? "POST"
    const mark = s.renewed ? "renewed" : "kept"
    // the account's Token Plan, at its own endpoint with its key:
    // what the app's /route was asked for, as the plan names it
    const toPlan = async () => {
      const tp = await platform.planKey(s)
      if (!tp) return null
      const h = new Headers(init.headers ?? req?.headers)
      for (const k of ["cookie", "x-mimo-source", "x-client-version", "user-agent"]) h.delete(k)
      h.set("Authorization", "Bearer " + tp.key)
      const res = await fetch(tp.base + planPath(url), { ...init, method, headers: h, body: renamedModel(body, TP_MODELS) })
      // the key was reset at the platform: read it again next time
      if (res.status === 401) platform.forgetKey(who)
      return said(res, mark)
    }
    const since = onPlan.get(who)
    if (since && Date.now() - since < TP_LIFE) {
      const res = await toPlan()
      if (res) return res
      onPlan.delete(who)
    }
    const headers = new Headers(init.headers ?? req?.headers)
    headers.delete("authorization")
    headers.set("Cookie", cookieHeader(s.cookies))
    headers.set("X-Mimo-Source", SOURCE)
    headers.set("User-Agent", UA)
    headers.set("X-Client-Version", APP_VERSION)
    // the server's answer goes through as it is, a 401 too, as the
    // built-in's did: it took the lapse off only when it signed on
    // again, whatever the server then answered
    const res = await fetch(url, { ...init, method, headers, body })
    if (res.status === 403) {
      const text = await res.text()
      if (tryJSON(text)?.error?.code === "membership_required") {
        const tp = await toPlan()
        if (tp) {
          onPlan.set(who, Date.now())
          return tp
        }
      }
      return said(res, mark, text)
    }
    return said(res, mark)
  }
}
