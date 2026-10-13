// prune_objects: dropping the objects inside a value that match a rule.
import { isObj } from "./json.mjs"
import { conditions, when } from "./conditions.mjs"

/** prune_objects' value as a rule: a type name, or {type, where, conditions, logic, recursive}. */
export function pruneRule(v) {
  const r = { conds: [], logic: "AND", recursive: true }
  if (typeof v === "string" && v.trim()) r.conds.push({ path: "type", mode: "full", value: v.trim() })
  else if (isObj(v)) {
    if (typeof v.logic === "string" && v.logic.trim()) r.logic = v.logic
    if (typeof v.recursive === "boolean") r.recursive = v.recursive
    r.conds.push(...conditions(v.conditions))
    if (isObj(v.where)) for (const k of Object.keys(v.where)) r.conds.push({ path: k, mode: "full", value: v.where[k] })
    if (v.type !== undefined) r.conds.push({ path: "type", mode: "full", value: v.type })
  }
  return r
}

/**
 * Drops every object below `node` that the rule matches; `node` itself stays. Copy on write: nodes nothing
 * changed under come back as the same value, so the caller can tell nothing happened (`===`). A rule without
 * conditions drops nothing.
 */
export function prune(node, rule, req) {
  if (!rule.conds.length) return node
  const keep = (x) => !(isObj(x) && when(x, req, rule.conds, rule.logic))
  const deeper = (x) => (rule.recursive && (isObj(x) || Array.isArray(x)) ? prune(x, rule, req) : x)
  if (Array.isArray(node)) {
    const out = node.filter(keep).map(deeper)
    const same = out.length === node.length && out.every((x, i) => x === node[i])
    return same ? node : out
  }
  if (isObj(node)) {
    let out = null
    for (const k of Object.keys(node)) {
      const x = node[k]
      if (!keep(x)) {
        if (!out) out = { ...node }
        delete out[k]
      } else {
        const y = deeper(x)
        if (y !== x) {
          if (!out) out = { ...node }
          out[k] = y
        }
      }
    }
    return out ?? node
  }
  return node
}
