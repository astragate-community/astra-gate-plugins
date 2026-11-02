// Antigravity: Code Assist's methods (cloudcode-pa /v1internal) and Google's OAuth endpoints.
import { CLIENT_ID, CLIENT_SECRET, DAILY, ENDPOINTS, ONBOARD_POLLS, ONBOARD_WAIT, PROD, TOKEN_URL, USERINFO_URL } from "./constants.mjs"
import { agentVersion, userAgent } from "./client.mjs"
import { CodeAssistError, tryJSON } from "./errors.mjs"
import { sleep } from "@astragate-community/plugin-kit"

/** The headers every Code Assist call carries. */
export async function headersOf(token, extra = {}) {
  return { "Content-Type": "application/json", Authorization: "Bearer " + token, "User-Agent": userAgent(await agentVersion()), ...extra }
}

/** One call of Code Assist's at `base`, its answer as it came (the caller reads the status). */
export async function post(base, method, token, body, { signal, query = "", headers } = {}) {
  return fetch(`${base}/v1internal:${method}${query}`, {
    method: "POST",
    headers: await headersOf(token, headers),
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  })
}

// whether a failure of a host is a reason to ask the next one: it didn't answer, or answered it was busy
const tryNext = (status) => status === 429 || status === 408 || status === 404 || status >= 500

/**
 * A JSON method, asked of each of `bases` in turn while one can't answer; throws a CodeAssistError for a refusal.
 * Every method but a chat is small, so it has a timeout of its own.
 */
export async function call(method, token, body, { bases = ENDPOINTS, headers } = {}) {
  let last
  for (const [i, base] of bases.entries()) {
    let res
    try {
      res = await post(base, method, token, body, { signal: AbortSignal.timeout(30_000), headers })
    } catch (e) {
      last = new Error(`Antigravity ${method}: ${e?.message ?? e}`)
      continue
    }
    const text = await res.text()
    if (res.ok) return tryJSON(text) ?? {}
    last = new CodeAssistError(res.status, text, method)
    if (!tryNext(res.status) || i === bases.length - 1) throw last
  }
  throw last ?? new Error(`Antigravity ${method}: no host to ask`)
}

/** loadCodeAssist: the account's tier, plan and (when it has been set up) project. Asked of prod first, as the app does. */
export const loadCodeAssist = (token) => call("loadCodeAssist", token, { metadata: { ideType: "ANTIGRAVITY" } }, { bases: [PROD, DAILY] })

// Code Assist's project comes as an id or as {id, name}
export const projectOf = (p) => (typeof p === "string" ? p : typeof p?.id === "string" ? p.id : "").trim()

/** The tier a new account is set up on: the one loadCodeAssist marks as default; a free account when it names none. */
export function defaultTier(load) {
  const tiers = Array.isArray(load?.allowedTiers) ? load.allowedTiers : []
  const t = tiers.find((x) => x?.isDefault) ?? tiers[0]
  return t?.id && t.id !== "legacy-tier" ? String(t.id) : "free-tier"
}

/** onboardUser: sets the account up for Code Assist, asking again until it says it is done; gives the project it was given. */
export async function onboard(token, tierId, version) {
  const body = { tier_id: tierId, metadata: { ide_type: "ANTIGRAVITY", ide_version: version, ide_name: "antigravity" } }
  for (let i = 0; i < ONBOARD_POLLS; i++) {
    const r = await call("onboardUser", token, body)
    if (r.done) return projectOf(r.response?.cloudaicompanionProject)
    await sleep(ONBOARD_WAIT)
  }
  throw new Error("Antigravity: setting the account up is taking long; try again in a minute")
}

/**
 * The account's project and plan as Antigravity finds them: loadCodeAssist names one for an account already set up;
 * an account that is not is set up on its default tier. `kept` is a project the sign-in already holds, which stays.
 * Gives { project, plan, tier, paid, credits }; a project may be "" when Google has none for the account.
 */
export async function setup(token, kept = "") {
  let load
  try {
    load = await loadCodeAssist(token)
  } catch (e) {
    if (!kept) throw e
    return { project: kept, plan: "", tier: "", paid: "", credits: [] }
  }
  const tier = String(load.currentTier?.id ?? load.currentTier ?? "")
  const paid = String(load.paidTier?.id ?? load.paidTier ?? "")
  const plan = String(load.paidTier?.name || load.currentTier?.name || "")
  const credits = Array.isArray(load.paidTier?.availableCredits) ? load.paidTier.availableCredits : []
  let project = kept || projectOf(load.cloudaicompanionProject)
  if (!project) project = await onboard(token, defaultTier(load), await agentVersion())
  if (!project) {
    const why = (Array.isArray(load.ineligibleTiers) ? load.ineligibleTiers : []).map((t) => t?.reasonMessage).find(Boolean)
    throw new Error(
      why
        ? `Antigravity won't serve this Google account: ${why}`
        : "Antigravity hasn't set this Google account up (it gave no project); sign in to the Antigravity app with it once, then try again",
    )
  }
  return { project, plan, tier, paid, credits }
}

/**
 * fetchAvailableModels: the models the account has, with the allowance of each. The account's paid tier is named as
 * Antigravity does (Google takes one only from an account that has it); a tier Google won't take is left out.
 */
export async function availableModels(token, project, tiers = []) {
  const asks = [...tiers.filter((t) => t && t !== "free-tier" && t !== "legacy-tier"), ""]
  let last
  for (const t of asks) {
    try {
      return await call("fetchAvailableModels", token, t ? { project, entitlement: { userTier: t } } : { project }, { bases: ENDPOINTS })
    } catch (e) {
      last = e
      if (e?.status === 401 || e?.status === 403) throw e
    }
  }
  throw last
}

// Google's token endpoint, in form encoding
async function tokenCall(form) {
  let res
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...form }).toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error("Google's sign-in: " + (e?.message ?? e))
  }
  const text = await res.text()
  const body = tryJSON(text) ?? {}
  if (!res.ok) {
    const err = Object.assign(new Error(`Google's sign-in refused (${res.status}): ${body.error_description || body.error || res.statusText}`), { status: res.status, code: body.error })
    throw err
  }
  return body
}

/** The tokens Google gave for the code a browser sign-in came back with. */
export const exchangeCode = (code, verifier, redirect) =>
  tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect })

/** A new access token for a refresh token (Google's refresh tokens don't turn over: none comes back). */
export const refreshToken = (refresh) => tokenCall({ grant_type: "refresh_token", refresh_token: refresh })

/** Whose Google account an access token is: its email. */
export async function whoIs(access) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: "Bearer " + access }, signal: AbortSignal.timeout(15_000) })
  const body = tryJSON(await res.text()) ?? {}
  if (!res.ok || !body.email) throw new Error("Google didn't say whose account this is")
  return String(body.email)
}
