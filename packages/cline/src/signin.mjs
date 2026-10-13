// The browser sign-in: Cline's WorkOS device-code flow, traded at Cline's register endpoint for the account's own pair.
import { API, DEVICE_CAP, DEVICE_GRANT, WORKOS_CLIENT, WORKOS_DEVICE, WORKOS_TOKEN } from "./constants.mjs"
import { clineApi } from "./api.mjs"
import { parseAuth } from "./session.mjs"
import { firstOf, messageOf } from "./util.mjs"
import { sleep } from "@astragate-community/plugin-kit"

// workos is one form post to WorkOS
const workos = (fetchImpl, url, params) =>
  fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  })

// deviceAuthorize starts the flow: a code to approve in the browser
export async function deviceAuthorize() {
  let res
  try {
    res = await workos(fetch, WORKOS_DEVICE, { client_id: WORKOS_CLIENT })
  } catch (e) {
    throw new Error(`Cline sign-in: ${e?.message ?? e}`)
  }
  if (!res.ok) throw new Error(`Cline sign-in: the device code request failed (HTTP ${res.status})`)
  const d = await res.json().catch(() => null)
  if (!d?.device_code || !d?.verification_uri) throw new Error("Cline sign-in: the device code answer was incomplete")
  return d
}

// pollDevice waits the device code out, as Cline's pollWorkOSTokens does: the
// interval only grows (slow_down raises it for every later poll, RFC 8628), it
// starts at a second, and a 5xx, a non-JSON reply or a network error is a poll
// to try again, not the sign-in failing.
export async function pollDevice(d, { fetchImpl = fetch, sleep: sleeper = sleep, now = Date.now } = {}) {
  const deadline = now() + Math.min(Number(d?.expires_in) > 0 ? Number(d.expires_in) : 300, DEVICE_CAP) * 1000
  let interval = Math.max(1, Number(d?.interval) > 0 ? Math.floor(Number(d.interval)) : 5)
  while (now() < deadline) {
    await sleeper(interval * 1000)
    let res = null
    let j = null
    try {
      res = await workos(fetchImpl, WORKOS_TOKEN, { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: WORKOS_CLIENT })
      j = await res.json().catch(() => null)
    } catch {}
    // WorkOS having a moment, or the network: not the sign-in
    if (!res || res.status >= 500) continue
    // a reply that isn't JSON and isn't a 5xx is the poll turned away: an
    // HTML 400 would otherwise keep polling to the deadline (ten minutes)
    // and fail there anyway
    if (j === null) {
      if (res.status >= 400) throw new Error(`Cline sign-in: the token poll was refused (HTTP ${res.status})`)
      continue
    }
    if (j.error === "authorization_pending") continue
    if (j.error === "slow_down") {
      interval += 1
      continue
    }
    if (j.error) throw new Error(`Cline sign-in: ${j.error}${j.error_description ? ` (${j.error_description})` : ""}`)
    if (typeof j.access_token !== "string" || !j.access_token) throw new Error("Cline sign-in: the token answer had no access token")
    return j
  }
  throw new Error("the sign-in wasn't finished in time")
}

// deviceSignIn is the browser method: the device code page opened, WorkOS
// polled until the code is approved, and the WorkOS tokens traded at Cline's
// register endpoint for the account's own pair
export async function deviceSignIn() {
  const d = await deviceAuthorize()
  return {
    url: firstOf(d.verification_uri_complete, d.verification_uri, "https://app.cline.bot"),
    instructions: `Approve the sign-in in the browser${d.user_code ? ` — the code is ${d.user_code}` : ""}.`,
    method: "auto",
    async callback() {
      let j
      try {
        j = await pollDevice(d)
      } catch (e) {
        return { type: "failed", error: messageOf(e) }
      }
      try {
        const data = await clineApi(`${API}/auth/register`, { method: "POST", body: { accessToken: j.access_token, refreshToken: j.refresh_token ?? "" }, signal: AbortSignal.timeout(30_000) })
        const p = parseAuth(data, j.refresh_token ?? "")
        if (p.error) throw new Error(`Cline sign-in: ${p.error}`)
        return { type: "success", ...p }
      } catch (e) {
        return { type: "failed", error: messageOf(e) }
      }
    },
  }
}
