// gjson-style paths into a request body. A path is first split into keys, then resolved against the body into
// concrete paths (arrays of keys / indexes), which getAt / setAt / delAt then walk.
import { isObj } from "./json.mjs"

/** A gjson path's keys: "a.b\.c.0" is a, b.c, 0. A backslash escapes the next character; "" has no keys. */
export function split(path) {
  path = String(path ?? "")
  if (!path) return []
  const out = []
  let cur = ""
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === "\\" && i + 1 < path.length) cur += path[++i]
    else if (c === ".") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out
}

/**
 * The concrete paths keys stand for in root: "*" is each key (sorted) or index there, "-1" an array's last.
 * A key not there yet resolves (set makes it); a wildcard over nothing, or an index out of range, resolves to
 * nothing. No keys is the root itself: [[]].
 */
export function resolve(root, keys) {
  let paths = [[]]
  for (const k of keys) {
    const next = []
    for (const p of paths) {
      const node = getAt(root, p)
      if (k === "*") {
        if (Array.isArray(node)) node.forEach((_, i) => next.push(p.concat(i)))
        else if (isObj(node)) Object.keys(node).sort().forEach((key) => next.push(p.concat(key)))
      } else if (Array.isArray(node)) {
        let i = /^-?\d+$/.test(k) ? Number(k) : NaN
        if (i < 0) i += node.length
        if (i >= 0 && i < node.length) next.push(p.concat(i))
      } else if (node === undefined || isObj(node)) next.push(p.concat(k))
    }
    paths = next
  }
  return paths
}

/** The value at a concrete path; undefined when any step is missing or isn't a container. */
export function getAt(root, p) {
  let n = root
  for (const k of p) {
    if (n === null || typeof n !== "object") return undefined
    n = n[k]
  }
  return n
}

/** Sets the value at a concrete path, making objects on the way; gives the root (the new value, for an empty path). */
export function setAt(root, p, v) {
  if (!p.length) return v
  let n = root
  for (let i = 0; i < p.length - 1; i++) {
    if (n[p[i]] === null || typeof n[p[i]] !== "object") n[p[i]] = {}
    n = n[p[i]]
  }
  n[p[p.length - 1]] = v
  return root
}

/** Removes the value at a concrete path: an array's element is spliced out, an object's key deleted. */
export function delAt(root, p) {
  const parent = getAt(root, p.slice(0, -1))
  const k = p[p.length - 1]
  if (Array.isArray(parent)) parent.splice(k, 1)
  else if (isObj(parent)) delete parent[k]
}

/** The single value a path names, or undefined: a wildcard that matches several names none. */
export function lookup(root, path) {
  const ps = resolve(root, split(path))
  return ps.length === 1 ? getAt(root, ps[0]) : undefined
}
