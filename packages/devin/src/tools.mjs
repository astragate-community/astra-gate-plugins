// The tools a request offers, and the ids of the calls they make.
import { Buffer } from "node:buffer"

// toolDescriptions is what each tool says of itself, for the
// instructions.
export function toolDescriptions(tools) {
  const said = tools.filter((t) => t.description)
  if (!said.length) return ""
  return "<tool_descriptions>\n" + said.map((t) => `<tool name="${t.name}">\n${t.description.trim()}\n</tool>\n`).join("") + "</tool_descriptions>"
}

// objectRoot is a tool's parameters as a plain object at the root, with no
// anyOf, oneOf or allOf there: Devin's Claude models turn away a request
// offering a tool whose schema has one ("There is an issue with this
// request, please try a different model", magpie#1196; Codex desktop's
// codex_app automation_update has a root oneOf), as Anthropic does behind
// Factory (magpie#646). It folds the schema as magpie's built-in does
// (provider.ObjectRoot): allOf's branches are all merged, properties and
// required alike; of anyOf's and oneOf's object branches the properties are
// merged, a field each of them requires stays required, and the other
// branches go; a branch that is a union itself is folded first, so its
// fields are kept (magpie#1271). Branches may be local $refs. A schema already a plain object
// is returned as it came; the caller's own is never changed.
export function objectRoot(ps) {
  return foldRoot(ps, ps, 0)
}

function foldRoot(root, ps, depth) {
  if (!isObj(ps)) return ps
  const has = (k) => Object.hasOwn(ps, k)
  if (ps.type === "object" && !has("anyOf") && !has("oneOf") && !has("allOf")) return ps
  const out = { ...ps }
  const props = { ...(isObj(ps.properties) ? ps.properties : {}) }
  let required = Array.isArray(ps.required) ? [...ps.required] : []
  const ref = (b) => {
    if (!isObj(b)) return null
    if (typeof b.$ref !== "string" || !b.$ref) return b
    for (const k of ["$defs", "definitions"]) {
      const pre = "#/" + k + "/"
      if (b.$ref.startsWith(pre)) {
        const d = root[k]?.[b.$ref.slice(pre.length)]
        return isObj(d) ? d : null
      }
    }
    return null
  }
  for (const b of Array.isArray(ps.allOf) ? ps.allOf : []) {
    const bm = ref(b)
    if (!bm) continue
    if (isObj(bm.properties)) for (const [k, v] of Object.entries(bm.properties)) if (!Object.hasOwn(props, k)) props[k] = v
    if (Array.isArray(bm.required)) required.push(...bm.required)
  }
  delete out.allOf
  const branches = []
  for (const k of ["anyOf", "oneOf"]) {
    for (const b of Array.isArray(ps[k]) ? ps[k] : []) {
      let bm = ref(b)
      if (!bm) continue
      // a branch that is itself a union (zod's discriminated create and
      // update in automation_update) is folded first, not dropped
      if (depth < 8 && ["anyOf", "oneOf", "allOf"].some((u) => Object.hasOwn(bm, u))) bm = foldRoot(root, bm, depth + 1)
      if (bm.type !== "object" && !Object.hasOwn(bm, "properties")) continue
      branches.push(bm)
    }
    delete out[k]
  }
  // a field every branch requires stays required, beside the root's and
  // allOf's own, which no branch can drop; a field the root doesn't define
  // takes each schema the branches give it, as anyOf when they differ
  let common = null
  const from = new Map()
  for (const b of branches) {
    for (const [k, v] of Object.entries(isObj(b.properties) ? b.properties : {})) {
      if (Object.hasOwn(props, k)) continue
      const vs = from.get(k) ?? []
      if (!vs.some((w) => JSON.stringify(w) === JSON.stringify(v))) vs.push(v)
      from.set(k, vs)
    }
    const br = Array.isArray(b.required) ? b.required : []
    common = common === null ? [...br] : common.filter((r) => br.includes(r))
  }
  for (const [k, vs] of from) props[k] = vs.length === 1 ? vs[0] : { anyOf: vs }
  for (const r of common ?? []) if (!required.includes(r)) required.push(r)
  required = [...new Set(required)]
  out.type = "object"
  out.properties = props
  if (required.length) out.required = required
  else delete out.required
  return out
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v)

// Devin names a call after its tool and turn (Bash:0#a65b6a5e…), and
// Claude Code takes a tool_use id only of [A-Za-z0-9_-]: it drops a call
// whose id has the ':' or '#', and the turn fails "could not be parsed"
// (yetone/magpie#1304). Such an id goes out as "dv_" and its base64url, and
// comes back to Devin as it was, so its result still answers its call. An
// id that is already safe goes out as it came, unless it begins "dv_".
const SAFE_ID = /^[A-Za-z0-9_-]+$/
export const outID = (id) => (SAFE_ID.test(id) && !id.startsWith("dv_") ? id : "dv_" + Buffer.from(id).toString("base64url"))
export const inID = (id) => {
  if (typeof id !== "string" || !id.startsWith("dv_") || !SAFE_ID.test(id)) return id
  const raw = Buffer.from(id.slice(3), "base64url").toString()
  return raw && outID(raw) === id ? raw : id
}
