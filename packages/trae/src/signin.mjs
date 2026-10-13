// Trae: the browser sign-in — the IDE's own: the realm's authorization page, back to a callback on 127.0.0.1.
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { resultPage } from "@astragate-community/plugin-kit"
import { SIGN_IN_TIMEOUT } from "./constants.mjs"
import { boundExchange, exchange } from "./api.mjs"
import { newDevice } from "./device.mjs"
import { toAuth } from "./session.mjs"
import { accountOf, authHostOf } from "./sites.mjs"
import { parseJSON, whenOf } from "./values.mjs"

// signedIn reads trae.cn's callback: userJwt (the token pair) and userInfo
// (the account), or, from its older page, a refresh token alone, which is
// exchanged for the pair
export async function signedIn(q, device, site) {
  const jwt = parseJSON(q.get("userJwt"))
  const info = parseJSON(q.get("userInfo"))
  const host = q.get("host") || info.Host || ""
  let s = {
    token: jwt.Token ?? jwt.token ?? "",
    refresh: jwt.RefreshToken ?? jwt.refreshToken ?? q.get("refreshToken") ?? "",
    expires: whenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    clientId: jwt.ClientID ?? jwt.clientId ?? q.get("clientId") ?? site.clientId,
    uid: String(info.UserID ?? info.userId ?? q.get("userId") ?? ""),
    name: String(info.ScreenName ?? info.screenName ?? ""),
    api: host,
    region: site.regionOf(info),
    host,
    // a token host the callback named, if it named one
    authHost: authHostOf(q.get("authHost") || q.get("auth_host") || info.AuthHost || info.authHost, site),
    account: accountOf(info),
  }
  const authHost = s.authHost || site.hosts.auth
  if (!s.token && s.refresh) {
    const x = await exchange(s.refresh, s.clientId, site, authHost)
    s = { ...s, ...x, uid: x.uid || s.uid, name: x.name || s.name, api: x.api || s.api, region: x.region || s.region, host: s.host || x.api, account: { ...x.account, ...s.account } }
  }
  if (!s.token) throw new Error(`${site.webHost} sent back no token`)
  if (!s.refresh) throw new Error(`${site.webHost} sent back no refresh token`)
  s = { ...s, ...device }
  // the token the page gives is bound to no device: it is renewed for this
  // one at once, so a check-in takes it; when Trae won't, it does as is
  if (site.deviceExchange) {
    try {
      const x = await boundExchange(s, site, authHost)
      s = { ...s, token: x.token, refresh: x.refresh, expires: x.expires || s.expires }
    } catch {}
  }
  return s
}

// authorizationUrl is the realm's authorization page, naming the device and where the browser comes back to
export function authorizationUrl(site, device, trace, callback) {
  const q = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: site.pluginVersion,
    auth_type: "local",
    client_id: site.clientId,
    redirect: "0",
    login_trace_id: trace,
    auth_callback_url: callback,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: site.brand,
    x_device_type: "windows",
    x_os_version: "Windows 10 Pro",
    x_env: "",
    x_app_version: site.ideVersion,
    x_app_type: "stable",
    // the enterprise (SaaS) sign-in is offered beside the personal one: an
    // enterprise subscription signs in there (@shad70w0 on X)
    hide_saas_login: "false",
  })
  return `${site.hosts.web}/authorization?${q}`
}

// browserSignIn is the IDE's sign-in: trae.cn's authorization page, back
// to a callback on 127.0.0.1 (the page takes no other kind)
export async function browserSignIn(site) {
  const device = newDevice()
  const trace = randomUUID()
  let over = false
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }
  const server = createServer(async (req, res) => {
    // the site's page may call the callback from script as well as open it
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end()
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const html = (body) => {
      res.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(body)
    }
    if (url.pathname !== "/authorize") return res.writeHead(404, cors).end()
    const q = url.searchParams
    if (over) return html(resultPage(false, "This sign-in is over", "Start it again in magpie."))
    if (q.get("error")) {
      const msg = q.get("error_description") || q.get("error")
      finish({ type: "failed", error: msg })
      return html(resultPage(false, "Sign-in didn't finish", msg))
    }
    if (!q.get("userJwt") && !q.get("refreshToken")) return html(resultPage(false, "Nothing to sign in with", `${site.webHost} sent no token; start the sign-in again.`))
    try {
      const s = await signedIn(q, device, site)
      finish({ ...toAuth(s, site), type: "success" })
      html(resultPage(true, "You're signed in", `${s.name || s.uid || `Your ${site.name} account`} is signed in. You can close this tab.`))
    } catch (e) {
      finish({ type: "failed", error: e.message })
      html(resultPage(false, "Sign-in didn't finish", e.message))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const callback = `http://127.0.0.1:${server.address().port}/authorize`
  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 5_000).unref?.()
  })
  return {
    url: authorizationUrl(site, device, trace, callback),
    instructions: `Sign in to ${site.name} (${site.webHost}) in the browser and allow the sign-in. It finishes here by itself.`,
    method: "auto",
    callback: () => done,
  }
}
