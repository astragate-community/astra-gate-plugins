// Xiaomi MiMo: a cookie jar, enough for the sign-on's redirects, and the walk through them.
import { ACCOUNT } from "./constants.mjs"

export class Jar {
  constructor() {
    this.cookies = []
  }
  put(c) {
    this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path))
    if (!c.gone) this.cookies.push(c)
  }
  seed(url, name, value) {
    this.put({ name, value, domain: new URL(url).hostname.toLowerCase(), hostOnly: false, path: "/", secure: false })
  }
  take(res, url) {
    const u = new URL(url)
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";")
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: u.hostname.toLowerCase(), hostOnly: true, secure: false }
      const dir = u.pathname.lastIndexOf("/")
      c.path = dir > 0 ? u.pathname.slice(0, dir) : "/"
      for (const a of attrs) {
        const i = a.indexOf("=")
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase()
        const v = i < 0 ? "" : a.slice(i + 1).trim()
        if (k === "domain" && v) {
          const d = v.replace(/^\./, "").toLowerCase()
          if (c.domain === d || c.domain.endsWith("." + d)) Object.assign(c, { domain: d, hostOnly: false })
        } else if (k === "path" && v.startsWith("/")) c.path = v
        else if (k === "secure") c.secure = true
        else if (k === "max-age" && Number(v) <= 0) c.gone = true
        else if (k === "expires" && Date.parse(v) <= Date.now()) c.gone = true
      }
      this.put(c)
    }
  }
  for(url) {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    return this.cookies.filter((c) => {
      if (c.secure && u.protocol !== "https:") return false
      if (c.hostOnly ? host !== c.domain : host !== c.domain && !host.endsWith("." + c.domain)) return false
      return u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/") || c.path === "/"
    })
  }
  header(url) {
    return this.for(url).map((c) => `${c.name}=${c.value}`).join("; ")
  }
}

// cookieHeader is a session as a Cookie header, in a steady order
export function cookieHeader(cookies) {
  const first = ["serviceToken", "userId", "cUserId"]
  const parts = first.filter((k) => k in cookies).map((k) => `${k}=${cookies[k]}`)
  for (const [k, v] of Object.entries(cookies)) if (!first.includes(k)) parts.push(`${k}=${v}`)
  return parts.join("; ")
}

// accountJar is a jar holding the Xiaomi account's own cookies: what the
// passToken signs on with
export function accountJar(creds) {
  const jar = new Jar()
  for (const [k, v] of [["userId", creds.userId], ["passToken", creds.passToken], ["cUserId", creds.cUserId],
    ["deviceId", creds.deviceId], ["pass_ua", "pc"], ["uLocale", "zh_CN"]]) {
    if (v) jar.seed(ACCOUNT, k, v)
  }
  return jar
}

// follow asks `start` and follows its redirects by hand, the jar keeping the
// cookies they set; gives the last response (not yet read) and the url it came
// from. `home` is the server whose http:// followups are asked over https; `failed`
// words a fetch that threw.
export async function follow(jar, start, { headers = {}, signal, home, tooMany, failed }) {
  const homeUrl = new URL(home)
  let url = start
  for (let hop = 0; ; hop++) {
    if (hop > 10) throw new Error(tooMany)
    const h = { ...headers }
    const cookie = jar.header(url)
    if (cookie) h.Cookie = cookie
    let res
    try {
      res = await fetch(url, { headers: h, redirect: "manual", signal })
    } catch (e) {
      throw failed ? failed(e) : e
    }
    jar.take(res, url)
    const loc = res.headers.get("location")
    if (res.status < 300 || res.status >= 400 || !loc) return { res, url }
    await res.arrayBuffer().catch(() => {})
    const next = new URL(loc, url)
    // the server's followup is written http://; its session cookies are
    // only sent back over https
    if (next.protocol === "http:" && homeUrl.protocol === "https:" && next.host.toLowerCase() === homeUrl.host.toLowerCase()) next.protocol = "https:"
    url = next.href
  }
}
