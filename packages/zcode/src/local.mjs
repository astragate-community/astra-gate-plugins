// ZCode's own files: its sign-in, which a plugin account can follow, and the provider config it keeps.
// ZCode keeps its sign-in in ~/.zcode/v2/credentials.json, each value
// encrypted (AES-256-GCM, "enc:v1:<iv>.<tag>.<data>") with a key made from
// the machine's user; ~/.zcode/v2/setting.json says whether it is on a
// team's plan. An account signed in "as ZCode" reads them for every
// request, so it follows ZCode's own sign-in, its renewed session and its
// switches between plans, as magpie's built-in did (zcode.go zcodeOwn).
//
// ZCode 3.14 can move its data (数据存储路径, "data storage path"): it copies
// ~/.zcode/v2 to <folder>/.zcode/v2, all but setting.json, and from its next
// start reads credentials.json and runtime/provider from there. The choice
// stays in the home folder's setting.json as dataBaseDir, which ZCode's main
// process reads before anything else (readBootstrapDataBaseDirFromDisk);
// setting.json itself, and the team plan it names, stay in the home folder.
import { createDecipheriv, createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { isAbsolute, join } from "node:path"
import { BIGMODEL_BASE, ZAI_BASE } from "./constants.mjs"
import { SITES } from "./sites.mjs"
import { first, isTeam, who } from "./util.mjs"

// settingDir is where ZCode keeps setting.json, moved or not.
const settingDir = () => join(homedir(), ".zcode", "v2")

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// dataIn is the folder ZCode keeps its .zcode data in: the home folder,
// unless dataBaseDir moved it. A value that isn't an absolute path is
// ignored, as magpie's built-in does (internal/appdir ZCodeDataIn).
function dataIn() {
  const d = readJSON(join(settingDir(), "setting.json"))?.dataBaseDir
  const t = typeof d === "string" ? d.trim() : ""
  return t && isAbsolute(t) ? t : homedir()
}

// zcodeDir is where ZCode keeps credentials.json and runtime/provider.
const zcodeDir = () => join(dataIn(), ".zcode", "v2")

// secret is the key ZCode encrypts its credentials with.
function secret() {
  let seed = process.env.ZCODE_CREDENTIAL_SECRET
  if (!seed) {
    let name = ""
    try {
      name = userInfo().username
    } catch {}
    name = name.slice(name.lastIndexOf("\\") + 1) // DOMAIN\user
    seed = `zcode-credential-fallback:${process.platform}:${homedir()}:${name}`
  }
  return createHash("sha256").update(seed).digest()
}

export function decrypt(key, v) {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return null
  const parts = v.slice(7).split(".")
  if (parts.length !== 3) return null
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ""), "base64url"))
    const d = createDecipheriv("aes-256-gcm", key, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString("utf8")
  } catch {
    return null
  }
}

// ownTeam is the team plan ZCode switched to, when it did.
function ownTeam(store, key) {
  const set = readJSON(join(settingDir(), "setting.json"))
  if (!set) return null
  const families = set.providerFamilyDomain === "zai" || set.providerFamilyDomain === "bigmodel" ? [set.providerFamilyDomain] : ["zai", "bigmodel"]
  for (const fam of families) {
    let org = ""
    let project = ""
    const sel = set.providerFamilyConnectionSelections?.[fam]
    if (sel) {
      if (sel.kind === "team-coding-plan") [org, project] = [first(sel.organizationId), first(sel.projectId)]
    } else {
      // before providerFamilyConnectionSelections
      const legacy = first(set.modelProviderFamilySelectedKeys?.[fam])
      const pre = `team-plan:builtin:${fam}-coding-plan:`
      if (legacy.startsWith(pre)) {
        const ps = legacy.slice(pre.length).split(":")
        if (ps.length === 3) {
          try {
            ;[org, project] = [decodeURIComponent(ps[1]), decodeURIComponent(ps[2])]
          } catch {}
        }
      }
    }
    if (!org || !project) continue
    const tok = first(decrypt(key, store[`oauth:${fam}:access_token`]))
    if (!tok) continue
    // a stale token ZCode won't use either
    if (fam === "bigmodel" && first(decrypt(key, store.zcodejwttoken)) === tok) continue
    return { site: fam, base: SITES[fam].base, key: "", token: tok, org, project }
  }
  return null
}

// ownSignIn is what ZCode is signed in to now: the account, its coding
// plan key, ZCode's session token (the Start Plan's key) and the team plan
// it is switched to; null when it has none of them.
export function ownSignIn() {
  const store = readJSON(join(zcodeDir(), "credentials.json"))
  if (!store || typeof store !== "object") return null
  const key = secret()
  let s = { key: "", base: "" }
  for (const [name, v] of Object.entries(store)) {
    // account-provider:coding-plan:account:zai-individual-coding-plan:account:<uuid>:api-key
    if (!name.includes(":coding-plan:") || !name.endsWith(":api-key")) continue
    const k = decrypt(key, v)
    if (!k || !k.includes(".")) continue
    const base = name.includes(":bigmodel-") ? BIGMODEL_BASE : ZAI_BASE
    // Z.ai's first, as ZCode lists it
    if (!s.key || (base === ZAI_BASE && s.base !== ZAI_BASE)) s = { key: k, base }
  }
  const jwt = first(first(decrypt(key, store.zcodejwttoken)).replace(/^Bearer /, ""))
  const team = ownTeam(store, key)
  if (team) s = { ...team, jwt }
  else s = { ...s, jwt, base: s.base || ZAI_BASE, site: s.base === BIGMODEL_BASE ? "bigmodel" : "zai" }
  if (!s.key && !s.jwt && !isTeam(s)) return null
  let info = {}
  for (const name of ["oauth:zai:user_info", "oauth:bigmodel:user_info"]) {
    const v = decrypt(key, store[name])
    if (v && !first(info.email, info.name, info.user_id)) {
      try {
        info = JSON.parse(v)
      } catch {}
    }
  }
  return { ...s, user: who(info) }
}

// localConfig is the latest provider config an installed ZCode has.
export function localConfig() {
  const files = []
  const rt = join(zcodeDir(), "runtime", "provider")
  const walk = (dir, depth) => {
    let es
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (depth < 3 && e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (depth === 3 && e.name === "zcode-builtin.json") files.push(join(dir, e.name))
    }
  }
  walk(rt, 0)
  if (process.platform === "darwin") files.push("/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json")
  let best = null
  for (const f of files) {
    try {
      if (!existsSync(f)) continue
      const b = JSON.parse(readFileSync(f, "utf8"))
      if (!best || (b.revision ?? 0) > (best.revision ?? 0)) best = b
    } catch {}
  }
  return best
}
