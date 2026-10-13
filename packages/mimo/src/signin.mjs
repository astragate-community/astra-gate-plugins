// Xiaomi MiMo: signing in at account.xiaomi.com's long-poll page (a QR code for the Xiaomi phone app, or the password).
import { ACCOUNT, HOSTS, REGION, SIGN_IN_LIFE, UA, appHeaders, baseOf, deviceId } from "./constants.mjs"
import { Lapsed, session } from "./sso.mjs"
import { toAuth } from "./store.mjs"
import { tryJSON } from "./json.mjs"
import { sleep } from "@astragate-community/plugin-kit"

// the account server's JSON comes after a "&&&START&&&" guard
function accountJSON(text) {
  return tryJSON(text.trim().replace(/^&&&START&&&/, "")) ?? null
}

// serviceOf is the sid and callback the MiMo server sends a browser with
// no session to account.xiaomi.com with
async function serviceOf(base) {
  let sid = "mimosgp"
  let callback = base.replace(/\/+$/, "") + "/sts"
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/user/xiaomi/me", { headers: appHeaders(), redirect: "manual", signal: AbortSignal.timeout(15_000) })
    await res.arrayBuffer().catch(() => {})
    const loc = res.headers.get("location")
    if (loc) {
      const q = new URL(loc, base).searchParams
      sid = q.get("sid") || sid
      callback = q.get("callback") || callback
    }
  } catch {}
  return { sid, callback }
}

async function accountGet(url, device, signal) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Cookie: `deviceId=${device}; pass_ua=pc; uLocale=zh_CN` }, signal })
  return { status: res.status, text: await res.text() }
}

export async function startSignIn() {
  const base = HOSTS[REGION]
  const device = deviceId()
  const { sid, callback } = await serviceOf(base)
  const q = new URLSearchParams({
    _group: "DEFAULT",
    _qrsize: "240",
    qs: "%3Fsid%3D" + encodeURIComponent(sid) + "%26_json%3Dtrue",
    callback,
    _hasLogo: "false",
    sid,
    serviceParam: "",
    _locale: "en_US",
  })
  const { status, text } = await accountGet(`${ACCOUNT}/longPolling/loginUrl?${q}`, device, AbortSignal.timeout(20_000))
  const lp = accountJSON(text)
  if (!lp || lp.code !== 0 || !lp.loginUrl || !lp.lp) {
    throw new Error(`Xiaomi MiMo sign-in: account.xiaomi.com answered ${status} ${lp?.desc || text.trim().slice(0, 200)}`)
  }
  const life = lp.timeout > 0 ? Math.min(lp.timeout * 1000, SIGN_IN_LIFE) : SIGN_IN_LIFE
  return { url: lp.loginUrl, lp: lp.lp, device, until: Date.now() + life }
}

// waitPoll asks the ticket's long poll until Xiaomi says the account is in
async function waitPoll(t) {
  while (Date.now() < t.until) {
    try {
      const left = t.until - Date.now()
      const { status, text } = await accountGet(t.lp, t.device, AbortSignal.timeout(Math.min(70_000, Math.max(left, 1))))
      const p = status === 200 ? accountJSON(text) : null
      if (p?.passToken && String(p.userId ?? "")) return p
    } catch {}
    await sleep(1000)
  }
  throw new Error("the Xiaomi sign-in page expired before the sign-in finished; start it again")
}

async function signedInWith(p, device) {
  let creds = { userId: String(p.userId), cUserId: p.cUserId ?? "", passToken: p.passToken, deviceId: device, region: REGION, base: HOSTS[REGION] }
  let s
  try {
    s = await session(creds, creds.base)
  } catch (e) {
    if (e instanceof Lapsed) throw new Error("Xiaomi signed the account in, but the MiMo server didn't take it; try again")
    throw e
  }
  // an account of another region is served by that region's server
  const r = String(s.me?.region ?? "").trim().toUpperCase()
  const nb = baseOf(r)
  if (r && r !== creds.region && nb && nb !== creds.base) {
    try {
      s = await session(creds, nb)
      creds = { ...creds, region: r, base: nb }
    } catch {}
  }
  return { creds: { ...creds, userId: String(s.me?.userId ?? "") || creds.userId }, cookies: s.cookies }
}

// the "Xiaomi account" sign-in method: the page to open, and the callback that waits for it
export const xiaomiAccount = {
  type: "oauth",
  label: "Xiaomi account",
  authorize: async () => {
    const t = await startSignIn()
    return {
      url: t.url,
      instructions: "Sign in to your Xiaomi account on the page that opens (or scan its QR code with the Xiaomi app). The sign-in finishes here by itself.",
      method: "auto",
      callback: async () => {
        try {
          const p = await waitPoll(t)
          const { creds, cookies } = await signedInWith(p, t.device)
          return { ...toAuth(creds, cookies, Date.now()), type: "success" }
        } catch (e) {
          return { type: "failed", error: e.message }
        }
      },
    }
  },
}
