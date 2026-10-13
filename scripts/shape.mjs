// Prints a plugin file's structural fingerprint: what it exports and, for each plugin it exports, the shape it
// answers with (hooks, sign-in methods, provider and models) with functions as "fn". A refactor must keep it
// the same as the upstream package's. `node scripts/shape.mjs <index.mjs>`.
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const describe = (v, depth = 0) => {
  if (typeof v === "function") return "fn"
  if (Array.isArray(v)) return depth > 5 ? "[…]" : v.map((x) => describe(x, depth + 1))
  if (v && typeof v === "object") {
    if (depth > 5) return "{…}"
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, describe(v[k], depth + 1)]))
  }
  return v
}

export async function shapeOf(file) {
  const mod = await import(pathToFileURL(resolve(file)).href)
  const out = {}
  for (const name of Object.keys(mod).sort()) {
    const v = mod[name]
    if (name.startsWith("_")) {
      out[name] = Array.isArray(v) || typeof v !== "object" ? describe(v) : Object.keys(v).sort()
    } else if (typeof v === "function") {
      try {
        out[name] = describe(await v({ client: {}, project: {}, directory: process.cwd(), worktree: process.cwd(), $: () => {} }))
      } catch (e) {
        out[name] = "throws: " + (e?.message ?? e)
      }
    } else out[name] = describe(v)
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(JSON.stringify(await shapeOf(process.argv[2]), null, 2))
}
