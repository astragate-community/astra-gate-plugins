// One operation of an "operations" list: what each mode does to the value at each path it names.
import { isObj, clone } from "./json.mjs"
import { split, resolve, getAt, setAt, delAt } from "./paths.mjs"
import { prune, pruneRule } from "./prune.mjs"

/** applyOperation's answers besides a new root: the operation touched nothing / it turned the request away. */
export const UNCHANGED = Symbol("unchanged")
export const REJECTED = Symbol("rejected")

// What an edit says about one path: leave it alone.
const SKIP = Symbol("skip")

/**
 * Applies one operation: gives the new root, UNCHANGED when it touched nothing, or REJECTED when it turned the
 * request away (return_error). Modes New API has but nothing here can act on (the header modes, sync_fields)
 * and unknown ones are UNCHANGED.
 */
export function applyOperation(root, op, req, ctx) {
  const mode = String(op.mode || "")
  if (mode === "return_error") {
    const e = returnError(op.value)
    ctx.reject(e.status, e.message)
    return REJECTED
  }
  if (mode === "move" || mode === "copy") return moveOrCopy(root, op, mode)
  if (mode !== "delete" && !EDITS.has(mode)) return UNCHANGED
  // prune_objects without a path prunes the whole body
  const paths = mode === "prune_objects" && !op.path ? [[]] : resolve(root, split(op.path))
  if (!paths.length) return UNCHANGED
  let touched = false
  if (mode === "delete") {
    // deleting from the end keeps the indexes still to come in place
    for (const p of paths.reverse()) {
      if (getAt(root, p) === undefined) continue
      delAt(root, p)
      touched = true
    }
    return touched ? root : UNCHANGED
  }
  const edit = EDITS.get(mode)
  for (const p of paths) {
    const cur = getAt(root, p)
    const next = edit(cur, op, req)
    if (next === SKIP || next === cur) continue
    root = setAt(root, p, next)
    touched = true
  }
  return touched ? root : UNCHANGED
}

// move / copy: one path to one path. Anything else (a wildcard, a missing source) does nothing.
function moveOrCopy(root, op, mode) {
  const from = resolve(root, split(op.from))
  const to = resolve(root, split(op.to))
  if (from.length !== 1 || to.length !== 1) return UNCHANGED
  const v = getAt(root, from[0])
  if (v === undefined) return UNCHANGED
  root = setAt(root, to[0], clone(v))
  if (mode === "move") delAt(root, from[0])
  return root
}

// Each edit: (current value, operation, request facts) => the new value, or SKIP.
const onStrings = (f) => (cur, op, req) => (typeof cur === "string" ? f(cur, op, req) : SKIP)
// the trim / ensure modes also need a value (an empty string is one)
const withValue = (f) => onStrings((cur, op) => (op.value == null ? SKIP : f(cur, String(op.value))))
// the replace modes need a non-empty `from`
const withFrom = (f) => onStrings((cur, op) => (op.from ? f(cur, String(op.from), String(op.to ?? "")) : SKIP))

const EDITS = new Map([
  ["set", (cur, op) => (op.keep_origin && cur !== undefined ? SKIP : clone(op.value))],
  ["prepend", (cur, op) => join(cur, op.value, true, op.keep_origin) ?? SKIP],
  ["append", (cur, op) => join(cur, op.value, false, op.keep_origin) ?? SKIP],
  ["trim_prefix", withValue((cur, v) => (cur.startsWith(v) ? cur.slice(v.length) : cur))],
  ["trim_suffix", withValue((cur, v) => (v && cur.endsWith(v) ? cur.slice(0, cur.length - v.length) : cur))],
  ["ensure_prefix", withValue((cur, v) => (cur.startsWith(v) ? cur : v + cur))],
  ["ensure_suffix", withValue((cur, v) => (cur.endsWith(v) ? cur : cur + v))],
  ["trim_space", onStrings((cur) => cur.trim())],
  ["to_lower", onStrings((cur) => cur.toLowerCase())],
  ["to_upper", onStrings((cur) => cur.toUpperCase())],
  ["replace", withFrom((cur, from, to) => cur.split(from).join(to))],
  ["regex_replace", withFrom((cur, from, to) => cur.replace(goRegexp(from), goReplacement(to)))],
  ["prune_objects", (cur, op, req) => (cur === undefined ? SKIP : prune(cur, pruneRule(op.value), req))],
])

/**
 * prepend / append: arrays are joined (an array value spread in), strings joined, objects merged (keep_origin
 * keeps the keys already there). Undefined for any other pair: nothing to join.
 */
export function join(cur, value, before, keep) {
  if (Array.isArray(cur)) {
    const add = Array.isArray(value) ? clone(value) : [clone(value)]
    return before ? add.concat(cur) : cur.concat(add)
  }
  if (typeof cur === "string") {
    const v = typeof value === "string" ? value : JSON.stringify(value)
    return before ? v + cur : cur + v
  }
  if (isObj(cur) && isObj(value)) {
    const out = { ...cur }
    for (const k of Object.keys(value)) if (!keep || !(k in out)) out[k] = clone(value[k])
    return out
  }
}

/** return_error's value: a message, or {message | msg, status_code | status}. Status 400 unless it says another. */
export function returnError(v) {
  let status = 400
  let message = ""
  if (typeof v === "string") message = v.trim()
  else if (isObj(v)) {
    message = String(v.message ?? v.msg ?? "").trim()
    const s = Number(v.status_code ?? v.status)
    if (Number.isInteger(s)) status = s
  }
  return { status, message: message || "turned away by param-override" }
}

/**
 * New API's (Go's) pattern as JavaScript's: Go's leading flag group (?i) becomes a flag, (?P<name>) becomes
 * (?<name>), and every match is replaced, as Go's ReplaceAllString does (so the "g" flag is always on).
 */
export function goRegexp(src) {
  let flags = "g"
  const m = /^\(\?([imsU]+)\)/.exec(src)
  if (m) {
    src = src.slice(m[0].length)
    // U (ungreedy) has no JavaScript flag; it is dropped
    for (const f of m[1]) if (f !== "U" && !flags.includes(f)) flags += f
  }
  return new RegExp(src.replace(/\(\?P</g, "(?<"), flags)
}

/** Go's ${1} and ${name} as JavaScript's $1 and $<name>. */
export function goReplacement(to) {
  return to.replace(/\$\{(\d+)\}/g, "$$$1").replace(/\$\{([A-Za-z_]\w*)\}/g, "$$<$1>")
}
