// Signing in: ZCode's browser flow for Z.ai or BigModel, and "as ZCode" (the ZCode app's own sign-in).
import { sleep } from "@astragate-community/plugin-kit"
import { APP_VERSION, ZAI_API, ZCODE } from "./constants.mjs"
import { anyDevice, call } from "./api.mjs"
import { startPlan } from "./gift.mjs"
import { keysURL, projectKey, teamHeaders } from "./keys.mjs"
import { ownSignIn } from "./local.mjs"
import { planOf } from "./routing.mjs"
import { jwtExpiry } from "./session.mjs"
import { SITES } from "./sites.mjs"
import { first, isTeam, uuid, who } from "./util.mjs"

// bizAuth is the Authorization a sign-in gives the business API: Z.ai's
// token exchanged for a business one, as a Bearer; BigModel's goes bare.
async function bizAuth(site, token) {
  if (site === "bigmodel") return token
  let biz
  try {
    biz = await call("POST", ZAI_API + "/api/auth/z/login", { body: { token } })
  } catch (e) {
    throw new Error(`Z.ai sign-in: ${e.message}`)
  }
  if (!biz?.access_token) throw new Error("Z.ai sign-in: no token")
  return "Bearer " + biz.access_token
}

// mintKey is the account's own coding plan key, in its default project
// ("默认机构" / "默认项目", else the first), and the plan it has.
async function mintKey(site, root, auth, info) {
  let org = ""
  let proj = ""
  for (const o of info?.organizations ?? []) {
    const ps = (o.projects ?? []).filter((p) => p.projectId && String(p.projectType) !== "2")
    if (!o.organizationId || !ps.length) continue
    const def = (ps.find((p) => String(p.projectName ?? "").includes("默认项目")) ?? ps[0]).projectId
    const named = String(o.organizationName ?? "").includes("默认机构")
    if (!org || named) {
      org = o.organizationId
      proj = def
      if (named) break
    }
  }
  if (!org) throw new Error(`this ${SITES[site].name} account has no project for an API key`)
  const key = await projectKey(site, keysURL(root, org, proj), auth, undefined, { name: "zcode-api-key" })
  const s = { key, base: SITES[site].base }
  try {
    return { s, plan: await planOf(s) }
  } catch (e) {
    throw new Error(`GLM Coding Plan: ${e.message}`)
  }
}

// teamSignIn is the account's seat on a team's plan: the first team project
// whose plan is in force and gives it a seat, and that project's key.
async function teamSignIn(site, root, auth, info) {
  const base = SITES[site].base
  const ps = []
  for (const o of info?.organizations ?? [])
    for (const p of o.projects ?? []) if (o.organizationId && p.projectId && String(p.projectType) === "2") ps.push({ org: o.organizationId, project: p.projectId })
  if (!ps.length) return { err: "no team plan", none: true }
  let why = ""
  let last = ""
  for (const p of ps) {
    let d
    try {
      d = (await call("GET", root + "/api/biz/team/subscribe/product/querySubscribeDetail", { auth, headers: teamHeaders(base, p.org, p.project) })) ?? {}
    } catch (e) {
      last = e.message
      continue
    }
    const status = String(d.status ?? "").toUpperCase()
    const grant = String(d.memberGrantStatus ?? "").toUpperCase()
    if (!(d.hasSubscription !== false && status === "EFFECTIVE" && grant === "VALID")) {
      if (!why && status === "EFFECTIVE" && grant === "UNASSIGNED")
        why = `this ${SITES[site].name} account is in a team with a GLM Coding Plan but has no seat on it yet — ask the team's admin to give it one, then sign in again`
      if (!why && status === "EXPIRED") why = `the ${SITES[site].name} team's GLM Coding Plan this account is in has expired`
      continue
    }
    let key
    try {
      key = await projectKey(site, keysURL(root, p.org, p.project), auth, teamHeaders(base, p.org, p.project), { name: "zcode-team-api-key", keyType: 2 })
    } catch (e) {
      return { err: `the team's GLM Coding Plan: ${e.message}`, why: `the team's GLM Coding Plan: ${e.message}` }
    }
    return { s: { key, base, token: auth, org: p.org, project: p.project }, plan: first(d.productName, "GLM Coding Team") }
  }
  if (why) return { err: why, why }
  const err = `the team's GLM Coding Plan: ${last || "no seat on it"}`
  return { err, why: err }
}

// signedIn is what a sign-in gives: the account's coding plan key and plan;
// or, with none of its own, a seat on a team's plan; or else ZCode's token
// for its Start Plan while the account has one.
export async function signedIn(site, token, jwt, device) {
  const name = SITES[site].name
  const root = SITES[site].api
  let s = null
  let err = null
  let team = ""
  try {
    const auth = await bizAuth(site, token)
    let info
    try {
      info = await call("GET", root + "/api/biz/customer/getCustomerInfo", { auth })
    } catch (e) {
      throw new Error(`${name} account: ${e.message}`)
    }
    const own = await mintKey(site, root, auth, info).catch((e) => ({ e }))
    if (own.e) err = own.e
    else if (own.plan) return { ...own.s, jwt, plan: own.plan }
    else s = own.s
    const t = await teamSignIn(site, root, auth, info)
    if (t.s) return { ...t.s, jwt, plan: t.plan }
    team = t.why ?? ""
  } catch (e) {
    err = e
  }
  let berr = null
  if (jwt) {
    try {
      const sp = await startPlan(jwt, device)
      if (sp) return { ...(err || !s?.key ? { base: SITES[site].base } : s), jwt, plan: sp.name }
    } catch (e) {
      berr = e
    }
  }
  if (team && berr) throw new Error(`${team}; ZCode's Start Plan: ${berr.message}`)
  if (team) throw new Error(team)
  if (err && berr) throw new Error(`${err.message}; ZCode's Start Plan: ${berr.message}`)
  if (err) throw err
  if (berr) throw new Error(`this ${name} account has no GLM Coding Plan, of its own or a team's, and ZCode's Start Plan could not be read: ${berr.message}`)
  throw new Error(
    `this ${name} account has no GLM Coding Plan, of its own or a team's, and ZCode's Start Plan has ended or was never started — subscribe at ${SITES[site].subscribe}, then sign in again`,
  )
}

// where Z.ai or BigModel sends the browser back, as ZCode sets it (BigModel's page names it redirect)
export function authorizeUrl(raw, site) {
  const u = new URL(raw)
  const back = `${ZCODE}/app/oauth/login?` + new URLSearchParams({ redirect: "zcode://oauth/callback", app_version: APP_VERSION })
  u.searchParams.set(site === "bigmodel" ? "redirect" : "redirect_uri", back)
  return u.toString()
}

// pollToken is the site's token in a poll's answer.
export const pollToken = (got, site) => (site === "bigmodel" ? first(got.bigmodel?.access_token, got.bigmodel?.accessToken) : first(got.zai?.access_token))

// authorize opens ZCode's sign-in flow on site; its callback polls it.
export async function authorize(site, log) {
  const poll = "Bearer " + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
  const device = uuid()
  let flow
  try {
    flow = await call("POST", ZCODE + "/api/v1/oauth/cli/init", { auth: poll, body: { provider: site }, device })
  } catch (e) {
    throw new Error(`ZCode sign-in: ${e.message}`)
  }
  let u
  try {
    u = new URL(flow?.authorize_url)
  } catch {}
  if (!flow?.flow_id || u?.protocol !== "https:") throw new Error("ZCode gave no sign-in page")
  const interval = Math.max(Number(flow.poll_interval_sec) || 0, 1) * 1000
  const deadline = Number(flow.expires_at) > 0 ? Number(flow.expires_at) * 1000 : Date.now() + 5 * 60_000
  return {
    url: authorizeUrl(flow.authorize_url, site),
    instructions: `Sign in to ${SITES[site].name} in the browser; this finishes on its own.`,
    method: "auto",
    async callback() {
      const fail = (msg) => (log(msg), { type: "failed", error: msg })
      for (;;) {
        await sleep(interval)
        if (Date.now() > deadline) return fail("the sign-in expired; start again")
        let got
        try {
          got = (await call("GET", `${ZCODE}/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flow_id)}`, { auth: poll, device })) ?? {}
        } catch (e) {
          if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return fail("ZCode sign-in: " + e.message)
          continue // a hiccup: ask again
        }
        const token = pollToken(got, site)
        if (got.status === "pending" || !got.status) continue
        if (got.status === "failed") return fail(`the sign-in was declined on ${SITES[site].name}`)
        if (got.status !== "ready" || !token) return fail("ZCode sign-in: unexpected answer " + got.status)
        let s
        try {
          s = await signedIn(site, token, first(got.token), device)
        } catch (e) {
          return fail(e.message)
        }
        const state = { site, device, ...s }
        return {
          type: "success",
          refresh: JSON.stringify(state),
          access: s.key || s.jwt || "",
          // the key doesn't run out; ZCode's token, when it is all there is, does
          expires: s.key || isTeam(s) ? 0 : jwtExpiry(s.jwt),
          accountId: who(got.user),
        }
      }
    },
  }
}

// asZCode is the sign-in "as ZCode": what it reads is ZCode's own.
export function asZCode() {
  return {
    url: "",
    instructions: "Uses the account the ZCode app is signed in to, and follows it while ZCode stays signed in to that account.",
    method: "auto",
    async callback() {
      const own = ownSignIn()
      if (!own) return { type: "failed", error: "ZCode isn't signed in on this computer; sign in to ZCode, or sign in to Z.ai or BigModel here" }
      const { user, ...s } = own
      const state = { source: "zcode", device: anyDevice, ...s }
      return { type: "success", refresh: JSON.stringify(state), access: s.key || s.jwt || "", expires: 0, accountId: user }
    },
  }
}
