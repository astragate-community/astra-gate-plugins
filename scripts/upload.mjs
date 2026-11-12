// Uploads the tarballs in out/ to the plugin market service (the astra-gate-web site), which owns all market
// metadata: this repository only ships source and packed plugins.
//   PLUGIN_MARKET_URL=https://astra-gate.si PLUGIN_UPLOAD_TOKEN=… node scripts/upload.mjs [--dry-run] [file.tgz…]
// A version is immutable on the market: an upload of one that exists answers 409 and is reported as "already there".
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const args = process.argv.slice(2)
const dry = args.includes("--dry-run")
const base = (process.env.PLUGIN_MARKET_URL ?? "https://astra-gate.si").replace(/\/+$/, "")
const token = process.env.PLUGIN_UPLOAD_TOKEN
const files = args.filter((a) => !a.startsWith("--"))
const list = (files.length ? files : readdirSync(join(root, "out")).filter((f) => f.endsWith(".tgz")).map((f) => join(root, "out", f))).sort()

if (!dry && !token) {
  console.error("PLUGIN_UPLOAD_TOKEN is not set.")
  process.exit(1)
}
let failed = 0
for (const file of list) {
  if (dry) {
    console.log(`would upload ${basename(file)} to ${base}`)
    continue
  }
  const res = await fetch(`${base}/api/plugin-market/packages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: readFileSync(file),
  })
  const text = await res.text()
  if (res.ok) console.log(`uploaded ${basename(file)}`)
  else if (res.status === 409) console.log(`already there ${basename(file)}`)
  else {
    failed++
    console.error(`FAILED ${basename(file)}: ${res.status} ${text.slice(0, 300)}`)
  }
}
if (failed) process.exit(1)
