// Kiro: calling its management API, and saying who is calling.
import { BUILDER_ID_PROFILE, management } from "./constants.mjs"
import { KiroError, gone, statusLine } from "./errors.mjs"

// authHeaders say who is calling: the token, and what kind it is.
export function authHeaders(a) {
  const h = { Authorization: `Bearer ${a.token}` }
  if (a.tokenType) h.tokentype = a.tokenType
  return h
}
export const tokenType = (c) => (c.method === "apikey" ? "API_KEY" : c.method === "external-idp" ? "EXTERNAL_IDP" : "")
/** A sign-in as the caller the headers name. */
export const callerOf = (c) => ({ token: c.access, tokenType: tokenType(c) })

// regionOf is where the account's API is: the region its profile is in, else
// the nearer of Kiro's two to where it signed in.
export function regionOf(profile, signedIn) {
  const parts = String(profile ?? "").split(":")
  if (parts.length > 4 && parts[3]) return parts[3]
  return String(signedIn ?? "").startsWith("eu-") ? "eu-central-1" : "us-east-1"
}

// managementCall calls Kiro's management API: GET with a query, or POST
// with a JSON body.
export async function managementCall(region, a, method, query, body) {
  let url = `${management(region)}/${method}`
  if (!body && query) url += "?" + new URLSearchParams(query)
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...authHeaders(a), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new KiroError(res.status, text)
  return JSON.parse(text)
}

// apiKeyProfile asks Kiro which profile an API key is for.
async function apiKeyProfile(c) {
  const res = await fetch(management("us-east-1") + "/", {
    method: "POST",
    headers: { ...authHeaders(callerOf(c)), "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetProfile" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const msg = `Kiro didn't take the API key: ${statusLine(res.status)}`
    throw res.status === 401 || res.status === 403 ? gone(msg) : new Error(msg)
  }
  const arn = (await res.json().catch(() => null))?.profile?.arn
  if (!arn) throw new Error("Kiro didn't say which profile the API key is for")
  return arn
}

// profileOf finds the profile a sign-in that doesn't name one uses: an API
// key's own, Builder ID's, or the first Kiro lists in either of its regions.
export async function profileOf(c) {
  if (c.method === "apikey") return apiKeyProfile(c)
  if (c.builderID) return BUILDER_ID_PROFILE
  let last
  for (const region of ["us-east-1", "eu-central-1"]) {
    try {
      const out = await managementCall(region, callerOf(c), "List-Available-Profiles", null, {})
      const arn = (out?.profiles ?? []).find((p) => p?.arn)?.arn
      if (arn) return arn
    } catch (e) {
      // a Builder ID sign-in the token didn't say was one
      if (c.method === "idc" && e?.status === 403 && e.body.includes("Builder ID")) return BUILDER_ID_PROFILE
      last = e
    }
  }
  throw last ?? new Error("Kiro has no profile for this sign-in")
}

// usageLimits is Get-Usage-Limits: the plan, the account's email, credits.
export function usageLimits(a, email) {
  return managementCall(a.region, a, "Get-Usage-Limits",
    { origin: "KIRO_CLI", profileArn: a.profile, resourceType: "CREDIT", isEmailRequired: String(email) })
}
