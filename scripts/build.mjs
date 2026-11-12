// Builds, validates, tests and packs every v2 plugin (a package with an astra.plugin.json) into out/<id>-<version>.tgz.
//   node scripts/build.mjs [name…]     all v2 packages, or just the named ones (directory names under packages/)
//   node scripts/build.mjs --no-test   skip the tests
// A package that is still v1 (no astra.plugin.json, e.g. qoder) is skipped with a note.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const args = process.argv.slice(2)
const noTest = args.includes("--no-test")
const wanted = args.filter((a) => !a.startsWith("--"))
const dirs = readdirSync(join(root, "packages"))
  .filter((d) => statSync(join(root, "packages", d)).isDirectory())
  .filter((d) => wanted.length === 0 || wanted.includes(d))
  .sort()

const run = (cwd, script) => spawnSync("npm", ["run", script, "--silent"], { cwd, stdio: "inherit" }).status === 0
let failed = 0
for (const d of dirs) {
  const cwd = join(root, "packages", d)
  if (!existsSync(join(cwd, "astra.plugin.json"))) {
    console.log(`skip ${d}: not a v2 plugin yet`)
    continue
  }
  if (!existsSync(join(cwd, "node_modules"))) {
    spawnSync("npm", ["install", "--workspaces=false", "--no-package-lock"], { cwd, stdio: "inherit" })
  }
  console.log(`== ${d}`)
  if (!((noTest || run(cwd, "test")) && run(cwd, "build") && run(cwd, "pack"))) {
    failed++
    console.error(`FAILED ${d}`)
  }
}
if (failed) process.exit(1)
