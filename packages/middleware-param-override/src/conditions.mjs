// Conditions: when an operation (or a prune_objects rule) applies. New API's shape, so a param_override copied
// from there works unchanged.
import { isObj } from "./json.mjs"
import { lookup } from "./paths.mjs"

/** A conditions value as a list: an array of condition objects, or an object of path: value (mode "full") pairs. */
export function conditions(c) {
  if (Array.isArray(c)) return c.filter(isObj)
  if (isObj(c)) return Object.keys(c).map((k) => ({ path: k, mode: "full", value: c[k] }))
  return []
}

/**
 * Whether the conditions hold: any of them (New API's default, OR), or all with logic AND. None hold always.
 * A path is looked up in the body first, then in `req` (the request's own facts). A missing value fails its
 * condition unless it sets pass_missing_key; invert flips the result of a comparison.
 */
export function when(body, req, raw, logic) {
  const cs = conditions(raw)
  if (!cs.length) return true
  const hit = (c) => {
    let v = lookup(body, String(c.path ?? ""))
    if (v === undefined) v = lookup(req, String(c.path ?? ""))
    if (v === undefined) return !!c.pass_missing_key
    const r = compare(v, c.value, String(c.mode || "full").toLowerCase())
    return c.invert ? !r : r
  }
  return String(logic).toUpperCase() === "AND" ? cs.every(hit) : cs.some(hit)
}

/** One comparison. Anything not a string is compared as its JSON; the numeric modes need two numbers. */
export function compare(v, t, mode) {
  const s = (x) => (typeof x === "string" ? x : JSON.stringify(x))
  switch (mode) {
    case "full":
      if (v === null || t === null || typeof v !== typeof t) return v === t
      return typeof v === "object" ? JSON.stringify(v) === JSON.stringify(t) : v === t
    case "prefix":
      return s(v).startsWith(s(t))
    case "suffix":
      return s(v).endsWith(s(t))
    case "contains":
      return s(v).includes(s(t))
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (typeof v !== "number" || typeof t !== "number") return false
      return mode === "gt" ? v > t : mode === "gte" ? v >= t : mode === "lt" ? v < t : v <= t
  }
  return false
}
