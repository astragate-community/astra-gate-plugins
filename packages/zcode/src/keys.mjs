// An account's API keys in a project: finding them, making them, and a team seat's key when the sign-in kept none.
import { call } from "./api.mjs"
import { SITES, isBigModel } from "./sites.mjs"
import { first } from "./util.mjs"

export function teamHeaders(base, org, project) {
  return {
    "Bigmodel-Organization": org,
    "Bigmodel-Project": project,
    "Set-Language": isBigModel(base) ? "zh" : "en",
    "Accept-Language": "en-US,en",
  }
}

export const keysURL = (root, org, project) =>
  `${root}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`

// projectKey finds the project's key named want.name (of want.keyType, when
// given), makes it when it isn't there and reads its secret: `<id>.<secret>`.
export async function projectKey(site, keys, auth, headers, want) {
  const name = SITES[site].name
  let list
  try {
    list = (await call("GET", keys, { auth, headers })) ?? []
  } catch (e) {
    throw new Error(`${name} API keys: ${e.message}`)
  }
  const typed = "keyType" in want
  let id = ""
  for (const k of Array.isArray(list) ? list : []) {
    if (k.name === want.name && (!typed || String(k.keyType) === String(want.keyType)) && first(k.apiKey)) id = first(k.apiKey)
  }
  if (!id) {
    try {
      id = first((await call("POST", keys, { auth, headers, body: want }))?.apiKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  let secret = ""
  if (id) {
    try {
      secret = first((await call("GET", `${keys}/copy/${encodeURIComponent(id)}`, { auth, headers }))?.secretKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  if (id && !secret && typed) return id // a team's key with no secret goes as it is
  if (!id || !secret) throw new Error(`${name} gave no API key`)
  return `${id}.${secret}`
}

// teamKey is a team seat's key when the sign-in kept none; a key (or a failure, for a minute) is remembered.
export const teamKeys = new Map()
export async function teamKey(s) {
  if (s.key) return s.key
  const id = [s.token, s.org, s.project].join("\0")
  const got = teamKeys.get(id)
  if (got && (!got.err || Date.now() - got.at < 60_000)) {
    if (got.err) throw got.err
    return got.key
  }
  const site = isBigModel(s.base) ? "bigmodel" : "zai"
  try {
    const key = await projectKey(site, keysURL(SITES[site].api, s.org, s.project), s.token, teamHeaders(s.base, s.org, s.project), { name: "zcode-team-api-key", keyType: 2 })
    teamKeys.set(id, { key, at: Date.now() })
    return key
  } catch (e) {
    const err = new Error(`ZCode's team plan: ${e.message} — sign in to ZCode again`)
    teamKeys.set(id, { err, at: Date.now() })
    throw err
  }
}
