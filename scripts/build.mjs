// Bundles each packages/<name>/src/index.mjs (with the kit) into packages/<name>/dist/index.mjs, the one file
// Astra installs, next to the package.json and README it ships. `node scripts/build.mjs [name…]`.
import { build } from "esbuild"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
  // what only the market and the shape check read stays out of the package, so changing it never changes the tarball
  const { astra: _a, upstream: _u, upstreamDiff: _d, ...shipped } = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
  await writeFile(join(dist, "package.json"), JSON.stringify(shipped, null, 2) + "\n")
  if (existsSync(join(dir, "README.md"))) await cp(join(dir, "README.md"), join(dist, "README.md"))
  // every package ships the MIT licence with upstream's copyright line kept (licenses/MIT.txt), and any licence text it carries of its own
  const own = (await readdir(dir)).filter((f) => /^LICENSE/.test(f))
  for (const f of own) await cp(join(dir, f), join(dist, f))
  if (!own.includes("LICENSE")) await cp(join(root, "licenses", "MIT.txt"), join(dist, "LICENSE"))
  console.log("built", name)
}
