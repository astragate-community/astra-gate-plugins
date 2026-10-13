// Factory: calling WorkOS and Factory's API with the headers droid sends.
import { API, API_EU, CLIENT_ID, VERSION, WORKOS } from "./constants.mjs"
import { FactoryStatus, signInFailure, statusLine, vendorError } from "./errors.mjs"

// workos posts a form to WorkOS: the answer and its status.
export async function workos(path, form, signal) {
  const res = await fetch(WORKOS + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  return { text: await res.text(), status: res.status }
}

// authenticate asks WorkOS for tokens. A 400 carrying an OAuth error is an
// answer, not a failure: the device flow's polls are told to wait so.
export async function authenticate(form, signal) {
  const { text, status } = await workos("/authenticate", form, signal)
  let t = {}
  try {
    t = JSON.parse(text) ?? {}
  } catch {}
  t.status = status
  if (status !== 200 && !t.error) throw signInFailure(status, text)
  return t
}

// renew trades a refresh token for a new pair, in the WorkOS org when one is
// named (droid's way of putting a token that names no org in one); droid's
// routine refresh names none, and WorkOS keeps the org.
export async function renew(refresh, org) {
  const form = { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }
  if (org) form.organization_id = org
  const t = await authenticate(form, AbortSignal.timeout(20_000))
  if (t.error) throw new FactoryStatus(t.status, "Factory: " + `${t.error} ${t.error_description ?? ""}`.trim())
  if (!t.access_token) throw new Error("Factory: the refresh gave no access token")
  return t
}

// base is the Factory API the account's org is served from.
export const base = (c) => (c.region === "eu" ? API_EU : API)

// llmBase is where the account's model requests go: the org's own host when
// whoami named one, else its region's API.
export function llmBase(c) {
  if (c.premBaseHost) {
    const p = c.premBaseHost.replace(/\/+$/, "")
    return p.includes("://") ? p : "https://" + p
  }
  return base(c)
}

// factoryHeaders are what droid sends on every call to Factory's API.
export function factoryHeaders(h, c) {
  h.set("Authorization", "Bearer " + c.access)
  h.set("X-Factory-Client", "cli")
  h.set("X-Client-Version", VERSION)
  h.set("User-Agent", "factory-cli/" + VERSION)
  if (c.activeOrganizationId) h.set("X-Factory-Org-Id", c.activeOrganizationId)
  else h.delete("X-Factory-Org-Id")
}

// the text of an answer of Factory's; anything but a 200 is a FactoryStatus carrying the body
async function okText(res) {
  const text = await res.text()
  if (res.status !== 200) throw new FactoryStatus(res.status, "Factory: " + vendorError(text, statusLine(res.status)), text)
  return text
}

// factoryGet reads a JSON answer of Factory's API, asked with the headers droid sends on every call.
export async function factoryGet(c, path, timeout = 30_000) {
  const h = new Headers({ Accept: "application/json" })
  factoryHeaders(h, c)
  const res = await fetch(base(c) + path, { headers: h, signal: AbortSignal.timeout(timeout) })
  return JSON.parse(await okText(res))
}

// firstOrg is the first WorkOS org /api/cli/org says the account is in, ""
// for none. droid asks it with the bearer token alone.
export async function firstOrg(c) {
  const r = await factoryGet({ ...c, activeOrganizationId: "" }, "/api/cli/org")
  return r?.workosOrgIds?.[0] ?? ""
}

// whoami asks Factory whose the token is with the headers droid's whoami
// sends: the token, X-Factory-Whoami-Extended, and the active org when there
// is one — nothing else.
export async function whoami(c, signal) {
  const h = { Authorization: "Bearer " + c.access, "X-Factory-Whoami-Extended": "true" }
  if (c.activeOrganizationId) h["X-Factory-Org-Id"] = c.activeOrganizationId
  const res = await fetch(base(c) + "/api/cli/whoami", { headers: h, signal: signal ?? AbortSignal.timeout(10_000) })
  return JSON.parse(await okText(res)) ?? {}
}