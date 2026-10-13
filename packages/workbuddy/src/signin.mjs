// WorkBuddy: signing in — through the browser, or from the desktop app's own sign-in.
import { call, domainOf } from "./api.mjs"
import { sleep } from "@astragate-community/plugin-kit"
import { APP_VERSION, POLL_MS, SIGN_IN_MS } from "./constants.mjs"
import { hex } from "./request.mjs"
import { merge } from "./session.mjs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

// enterpriseOf is the enterprise the account a sign-in gave belongs to:
// the one /login/account names, else, for an account that isn't personal,
// the one WorkBuddy's account list has for it — the same choice WorkBuddy's
// own client makes (mergeCurrentAccountDetails): the uid's only entry of that
// type, or the only one it last signed in to. None found is personal.
async function enterpriseOf(site, a, who) {
  const own = typeof who?.enterpriseId === "string" ? who.enterpriseId.trim() : ""
  if (own) return own
  const type = String(who?.type ?? "").trim().toLowerCase()
  if (!type || type === "personal") return ""
  let list
  try {
    list = await call(site, "GET", "/v2/plugin/accounts", {
      Authorization: "Bearer " + a.access,
      "X-Domain": domainOf(site, a),
    })
  } catch {
    return ""
  }
  const mine = (list?.accounts ?? []).filter((x) => x?.uid === who.uid && typeof x.enterpriseId === "string" && x.enterpriseId.trim())
  const same = mine.filter((x) => String(x.type ?? "").trim().toLowerCase() === type)
  const last = mine.filter((x) => x.lastLogin)
  const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined
  return pick ? pick.enterpriseId.trim() : ""
}

// ---- signing in -------------------------------------------------------------

// poll asks path until WorkBuddy answers with data, retrying the codes
// that mean "not yet".
async function poll(site, path, headers, retry, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${site.name} sign-in timed out`)
    try {
      const data = await call(site, "GET", path, headers)
      if (data && Object.keys(data).length) return data
    } catch (e) {
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw e
    }
    await sleep(POLL_MS)
  }
}

export async function browserSignIn(site) {
  const state = await call(site, "POST", `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  }, {})
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} gave no sign-in page`)
  const url = new URL(state.authUrl)
  if (url.protocol !== "https:") throw new Error(`${site.name}'s sign-in page isn't https`)
  url.searchParams.set("version", APP_VERSION)
  url.searchParams.set("loginSessionId", hex())
  return {
    url: url.toString(),
    instructions: `Sign in to ${site.name} in the browser; this finishes by itself.`,
    method: "auto",
    async callback() {
      try {
        const deadline = Date.now() + SIGN_IN_MS
        const q = encodeURIComponent(state.state)
        const token = await poll(site, `/v2/plugin/auth/token?state=${q}`, {}, [11217], deadline)
        if (!token.accessToken) return { type: "failed", error: `${site.name} sent back no token` }
        let a = merge({}, token)
        const who = await poll(site, `/v2/plugin/login/account?state=${q}`, {
          Authorization: "Bearer " + a.access,
          "X-Domain": domainOf(site, a),
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
        }, [12151], deadline)
        a.uid = who.uid ?? ""
        a.enterpriseId = await enterpriseOf(site, a, who)
        return success(site, a, who.nickname || who.phoneNumber || who.uid)
      } catch (e) {
        return { type: "failed", error: e.message }
      }
    },
  }
}

function success(site, a, name) {
  return {
    type: "success",
    refresh: a.refresh ?? "",
    access: a.access,
    expires: a.expires ?? 0,
    accountId: name || site.name,
    uid: a.uid ?? "",
    domain: a.domain ?? "",
    ...(a.enterpriseId ? { enterpriseId: a.enterpriseId } : {}),
    ...(a.refreshExpiresAt ? { refreshExpiresAt: a.refreshExpiresAt } : {}),
    ...(a.tokenType ? { tokenType: a.tokenType } : {}),
  }
}

// desktopFile is where WorkBuddy's desktop app keeps its sign-in.
function desktopFile(site) {
  const home = homedir()
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth", site.authID + ".info")
}

// readDesktop is WorkBuddy desktop's sign-in as the app keeps it now, null
// for none (or tokens the app keeps encrypted, which can't be read).
export function readDesktop(site) {
  try {
    const f = JSON.parse(readFileSync(desktopFile(site), "utf8"))
    const t = f?.auth ?? {}
    if (typeof t.accessToken !== "string" || !t.accessToken || !f?.account?.uid) return null
    const now = Date.now()
    const acct = f.account
    return {
      access: t.accessToken,
      refresh: typeof t.refreshToken === "string" ? t.refreshToken : "",
      expires: t.expiresAt > 0 ? t.expiresAt : t.expiresIn > 0 ? now + t.expiresIn * 1000 : 0,
      refreshExpiresAt: t.refreshExpiresAt > 0 ? t.refreshExpiresAt : t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : 0,
      domain: typeof t.domain === "string" ? t.domain : "",
      tokenType: typeof t.tokenType === "string" ? t.tokenType : "",
      uid: acct.uid,
      ...(typeof acct.enterpriseId === "string" && acct.enterpriseId.trim() ? { enterpriseId: acct.enterpriseId.trim() } : {}),
      name: acct.nickname || acct.phoneNumber || acct.uid,
    }
  } catch {
    return null
  }
}

// notDesktop says why there is no desktop sign-in to use: WorkBuddy 5.6
// and later seal its tokens at rest ({$wbEncrypted: 1, envelope}), which
// only the app itself opens (plugins#18), so the browser sign-in is the way;
// else the app isn't signed in.
export function notDesktop(site) {
  try {
    const t = JSON.parse(readFileSync(desktopFile(site), "utf8"))?.auth ?? {}
    if (t.accessToken?.$wbEncrypted || t.refreshToken?.$wbEncrypted)
      return `${site.name} desktop keeps its sign-in encrypted (WorkBuddy 5.6 and later), which magpie can't read; sign in with "${site.name} account (browser)" instead`
  } catch {}
  return `${site.name} desktop isn't signed in`
}

// desktopSignIn uses the account WorkBuddy desktop is signed in to: nothing
// is copied (a copied refresh token would be the app's and the plugin's
// both, and the first to use it would sign the other out); its file is
// read each time, as the app keeps it.
export function desktopSignIn(site) {
  return {
    url: "",
    instructions: `Uses the account ${site.name} desktop is signed in to.`,
    method: "auto",
    async callback() {
      const d = readDesktop(site)
      if (!d) return { type: "failed", error: notDesktop(site) }
      return { type: "success", refresh: "", access: "", expires: 0, source: "desktop", accountId: d.name || site.name, uid: d.uid }
    },
  }
}