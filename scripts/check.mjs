// Compares each built plugin's shape with its upstream package's: `node scripts/check.mjs [name…]`. The upstream
// is the npm package a plugin's package.json names in "upstream" ({ "package", "version" }); a difference must be
// listed in "upstreamDiff" (a plugin added a hook on purpose), or this fails.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { shapeOf } from "./shape.mjs"

const root = new URL("..", import.meta.url).pathname
const names = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(join(root, "packages"))
let failed = 0
for (const name of names) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"))
  if (!pkg.upstream) continue
  const dir = mkdtempSync(join(tmpdir(), "upstream-"))
  execFileSync("npm", ["pack", `${pkg.upstream.package}@${pkg.upstream.version}`, "--silent"], { cwd: dir })
  execFileSync("sh", ["-c", "tar xzf *.tgz"], { cwd: dir })
  const up = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8"))
  const entry = up.magpie?.middleware ?? up.main ?? "index.mjs"
  const before = await shapeOf(join(dir, "package", entry))
  const after = await shapeOf(join(root, "packages", name, "dist", "index.mjs"))
  const diff = []
  const walk = (a, b, path) => {
    if (isDeepStrictEqual(a, b)) return
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path + "." + k)
    } else diff.push(path)
  }
  walk(before, after, "")
  const allowed = new Set(pkg.upstreamDiff ?? [])
  const unexpected = diff.filter((d) => !allowed.has(d))
  console.log(`${unexpected.length ? "DIFF" : "ok  "} ${name}${diff.length ? ` (${diff.length} differ, ${diff.length - unexpected.length} allowed)` : ""}`)
  for (const d of unexpected) console.log("   ", d)
  failed += unexpected.length ? 1 : 0
}
process.exit(failed ? 1 : 0)
