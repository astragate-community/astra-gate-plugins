// Compares each built plugin's exported shape (shape.mjs: hooks, sign-in methods, providers, models) with the snapshot
// committed beside it, packages/<name>/shape.json: `node scripts/check.mjs [name…]`. A refactor must leave the shape as it
// was; a change on purpose is recorded with `--update`, which rewrites the snapshots (review the diff).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { shapeOf } from "./shape.mjs"

const root = new URL("..", import.meta.url).pathname
const args = process.argv.slice(2)
const update = args.includes("--update")
const names = args.filter((a) => !a.startsWith("--"))
let failed = 0
for (const name of names.length ? names : readdirSync(join(root, "packages"))) {
  const file = join(root, "packages", name, "shape.json")
  const now = await shapeOf(join(root, "packages", name, "dist", "index.mjs"))
  if (update || !existsSync(file)) {
    writeFileSync(file, JSON.stringify(now, null, 2) + "\n")
    console.log("wrote", name)
    continue
  }
  const before = JSON.parse(readFileSync(file, "utf8"))
  const diff = []
  const walk = (a, b, path) => {
    if (isDeepStrictEqual(a, b)) return
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path + "." + k)
    } else diff.push(path)
  }
  walk(before, JSON.parse(JSON.stringify(now)), "")
  console.log(`${diff.length ? "DIFF" : "ok  "} ${name}`)
  for (const d of diff) console.log("   ", d)
  failed += diff.length ? 1 : 0
}
process.exit(failed ? 1 : 0)
