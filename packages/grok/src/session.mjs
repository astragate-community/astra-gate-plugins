// An account's sign-in over time: having the CLI renew it, reading back a token that is still good, and telling
// OpenCode what changed.
import { dirname } from "node:path"
import { LEAD_MS, NOT_SIGNED_IN, PROVIDER, REFRESH_MARGIN, SIGN_IN_EXPIRED } from "./constants.mjs"
import { credential, envFor, executable, run } from "./cli.mjs"

// renewals runs the CLI's renewals one after another (queue.tail); renewing is the one
// asked for each home, which those who come while it is due or running join
// rather than running the CLI there again.
const queue = { tail: Promise.resolve() }
const renewing = new Map()

// renew has the CLI renew the sign-in in home: a `grok models` there renews
// it as any use of the CLI does.
function renew(exe, home) {
  let r = renewing.get(home)
  if (!r) {
    r = queue.tail.then(() => run(exe, ["models"], { cwd: dirname(home), env: envFor(home) })).finally(() => renewing.delete(home))
    queue.tail = r.catch(() => {})
    renewing.set(home, r)
  }
  return r
}

// token is the CLI's sign-in in home with a token still good. One about to
// expire (or that a request found expired) is first renewed by the CLI in
// its own home.
export async function token(home, expired) {
  let c = credential(home)
  const exe = executable()
  if (c && exe && (expired || c.expires - Date.now() < REFRESH_MARGIN)) {
    await renew(exe, home)
    c = credential(home)
  }
  if (!c) throw new Error(NOT_SIGNED_IN)
  if (c.expires && c.expires <= Date.now()) throw new Error(SIGN_IN_EXPIRED)
  return c
}

// The account's home, or an error when it holds no sign-in made by the CLI.
export function homeOf(auth) {
  if (!auth || auth.type !== "oauth" || !auth.refresh) throw new Error(NOT_SIGNED_IN)
  return auth.refresh
}

// refreshAuth is auth.refresh: magpie renews the sign-in LEAD_MS before its end, once for the
// account, before its requests, models and usage ask for it: the CLI
// renews it in its home, as before a request, and what it gives is
// read back. The check before each request stays for OpenCode, which
// doesn't call this.
export async function refreshAuth(auth) {
  const home = auth?.refresh
  if (auth?.type !== "oauth" || !home) return undefined
  let c = credential(home)
  // renewed already (by the CLI, or before a request), the store not
  // yet saying so
  const renewed = c && c.key !== auth.access && c.expires - Date.now() >= LEAD_MS
  const exe = executable()
  if (!renewed && exe) {
    await renew(exe, home)
    c = credential(home)
  }
  // the CLI holds no sign-in there any more (`grok logout`): one
  // has to be made again
  if (!c) throw Object.assign(new Error(NOT_SIGNED_IN), { signIn: "expired" })
  // the CLI couldn't renew it: tried again later
  if (exe && c.expires && c.expires <= Date.now()) throw new Error("Grok's sign-in has expired and Grok Build couldn't renew it")
  if (c.key === auth.access && c.expires === auth.expires) return undefined
  // magpie saves what this gives
  const out = { access: c.key, expires: c.expires }
  if (c.email && c.email !== auth.accountId) out.accountId = c.email
  return out
}

// remember tells OpenCode's store the token the CLI renewed, if it differs from what it holds.
export async function remember(client, auth, c) {
  if (auth.access === c.key && auth.expires === c.expires) return
  try {
    await client.auth.set({ path: { id: PROVIDER }, body: { ...auth, access: c.key, expires: c.expires, accountId: c.email || auth.accountId } })
  } catch {}
}
