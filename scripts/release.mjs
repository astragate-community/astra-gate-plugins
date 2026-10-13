// Packs each built plugin into a tarball, writes the market registry that lists them, and publishes the
// tarballs as GitHub Releases the registry points at. Astra's market reads registry.json (raw.githubusercontent.com
// …/main/registry.json) and fetches each tarball by the address and sha256 it lists — no npm account involved.
//   node scripts/release.mjs pack        build + npm pack every package into out/, then write registry.json
//   node scripts/release.mjs publish     create the release <dir>-v<version> for each package that has none (needs `gh`)
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const out = join(root, "out")
const REPO = "astragate-community/astra-gate-plugins"
const dirs = readdirSync(join(root, "packages")).filter((d) => statSync(join(root, "packages", d)).isDirectory()).sort()
const manifest = (d) => JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8"))
const tagOf = (d, v) => `${d}-v${v}`
const assetOf = (d, v) => `${d}-${v}.tgz`

function pack() {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  execFileSync("node", [join(root, "scripts/build.mjs")], { stdio: "inherit" })
  const plugins = []
  for (const d of dirs) {
    const pkg = manifest(d)
    const meta = pkg.astra
    if (!meta) throw new Error(`${d}: package.json has no "astra" block (name, summary, …)`)
    const made = execFileSync("npm", ["pack", join(root, "packages", d, "dist"), "--pack-destination", out, "--silent"], { encoding: "utf8" }).trim().split("\n").pop()
    const file = join(out, assetOf(d, pkg.version))
    execFileSync("mv", [join(out, made), file])
    const bytes = readFileSync(file)
    plugins.push({
      package: pkg.name,
      name: meta.name,
      ...(meta.icon ? { icon: meta.icon } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(meta.providers ? { providers: meta.providers } : {}),
      ...(meta.replaces ? { replaces: meta.replaces } : {}),
      summary: meta.summary,
      community: true,
      latest: pkg.version,
      description: pkg.description,
      license: pkg.license,
      repository: `https://github.com/${REPO}`,
      homepage: `https://github.com/${REPO}/tree/main/packages/${d}`,
      ...(meta.minAstraVersion ? { minAstraVersion: meta.minAstraVersion } : {}),
      tarballs: [
        {
          version: pkg.version,
          url: `https://github.com/${REPO}/releases/download/${tagOf(d, pkg.version)}/${assetOf(d, pkg.version)}`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sha512: createHash("sha512").update(bytes).digest("base64"),
          size: bytes.length,
        },
      ],
    })
    console.log("packed", assetOf(d, pkg.version), bytes.length)
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 2, plugins }, null, 2) + "\n")
  console.log("wrote registry.json:", plugins.length, "plugins")
}

function publish() {
  for (const d of dirs) {
    const v = manifest(d).version
    const tag = tagOf(d, v)
    const have = (() => {
      try {
        execFileSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" })
        return true
      } catch {
        return false
      }
    })()
    if (have) {
      console.log("exists ", tag)
      continue
    }
    const file = join(out, assetOf(d, v))
    if (!existsSync(file)) throw new Error(`${file} is missing: run "pack" first`)
    execFileSync("gh", ["release", "create", tag, file, "--repo", REPO, "--title", `${manifest(d).astra.name} ${v}`, "--notes", `${manifest(d).name}@${v}`], { stdio: "inherit" })
    console.log("created", tag)
  }
}

const cmd = process.argv[2]
if (cmd === "pack") pack()
else if (cmd === "publish") publish()
else {
  console.error("usage: node scripts/release.mjs pack|publish")
  process.exit(2)
}
