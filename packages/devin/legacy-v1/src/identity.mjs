// Whose key it is: as Devin says (GetUserStatus), and as the CLI says (`devin auth status`).
import { SERVER } from "./constants.mjs"
import { readUserStatus } from "./api.mjs"
import { parseStatus, readsHome, runCLI, signedOut } from "./cli.mjs"

// tierName words a teamsTier as `devin auth status` says it:
// TEAMS_TIER_DEVIN_PRO is "Devin Pro", TEAMS_TIER_DEVIN_TEAMS_V2 "Devin
// Teams" (the CLI leaves the tier's version out).
export const tierName = (t) =>
  String(t ?? "")
    .replace(/^TEAMS_TIER_/, "")
    .split("_")
    .filter((w) => w && w !== "UNSPECIFIED" && !/^V\d+$/.test(w))
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ")

// whoByKey is whose key it is, as GetUserStatus (usage's) says, asked with
// the key itself: {user, plan}, null when Devin refuses the key, undefined
// when it can't tell.
export async function whoByKey(key, server) {
  let status
  try {
    status = await readUserStatus(key, server || SERVER)
  } catch {
    return undefined
  }
  if (status.refused) return null
  if (!status.res.ok) return undefined
  let u
  try {
    u = JSON.parse(status.text || "{}")?.userStatus ?? {}
  } catch {
    return undefined
  }
  const user = u.email || u.name
  if (!user) return undefined
  const info = u.planStatus?.planInfo ?? {}
  return { user, plan: tierName(u.teamsTier || info.teamsTier) || info.planName || "" }
}

// identity is who the CLI says is signed in in home: {user, plan}, null
// when it says nobody is, undefined when it can't tell (no CLI, no answer,
// a CLI that read another credentials.toml than home's).
export async function identity(home) {
  try {
    const { out } = await runCLI(home, "auth", "status")
    if (!readsHome(out, home)) return undefined
    const st = parseStatus(out)
    if (st?.user) return st
    if (signedOut(out)) return null
  } catch {}
  return undefined
}

// cliAnswersFor says whether the CLI, run with home as its data folder,
// answers for key's account: it reads home's credentials.toml, and the
// account it names is the one Devin says the key is. undefined when it
// can't tell.
export async function cliAnswersFor(key, server, home) {
  let out
  try {
    ;({ out } = await runCLI(home, "auth", "status"))
  } catch {
    return undefined
  }
  if (!readsHome(out, home)) return false
  const cli = parseStatus(out)?.user
  if (!cli) return true
  const who = await whoByKey(key, server)
  return !who?.user || who.user.toLowerCase() === cli.toLowerCase()
}
