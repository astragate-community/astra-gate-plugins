// Bundles each packages/<name>/src/index.mjs (with the kit) into packages/<name>/dist/index.mjs, the one file
// Astra installs, next to the package.json and README it ships. `node scripts/build.mjs [name…]`.
import { build } from "esbuild"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const all = (await readdir(join(root, "packages"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
const names = process.argv.length > 2 ? process.argv.slice(2) : all

for (const name of names) {
  const dir = join(root, "packages", name)
  const dist = join(dir, "dist")
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await build({
    entryPoints: [join(dir, "src/index.mjs")],
    outfile: join(dist, "index.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    legalComments: "inline",
    logLevel: "warning",
  })
  for (const f of ["package.json", "README.md"]) if (existsSync(join(dir, f))) await cp(join(dir, f), join(dist, f))
  // the MIT licence ships with every package, with any licence text a plugin carries of its own
  const own = (await readdir(dir)).filter((f) => /^LICENSE/.test(f))
  for (const f of own) await cp(join(dir, f), join(dist, f))
  if (!own.includes("LICENSE")) await cp(join(root, "LICENSE"), join(dist, "LICENSE"))
  console.log("built", name)
}
