// How a request presents itself: as the Grok CLI, at the newest version known.
import { CLIENT_VERSION } from "./constants.mjs"
import { executable, run } from "./cli.mjs"

const cache = { v: CLIENT_VERSION, at: 0 }

// clientVersion is the CLI version the requests say they come from, unless
// the installed one is newer: without it the backend calls the CLI outdated.
async function clientVersion() {
  if (Date.now() - cache.at < 10 * 60 * 1000) return cache.v
  let v = CLIENT_VERSION
  const exe = executable()
  if (exe) {
    const { err, stdout } = await run(exe, ["--version"], { timeout: 5000 }) // "grok 1.0.41 (4220f3b224a6)"
    const got = !err && stdout.match(/\d+\.\d+\.\d+/)?.[0]
    if (got && newer(got, v)) v = got
  }
  cache.v = v
  cache.at = Date.now()
  return v
}

export function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

// sign says a request comes from the Grok CLI.
export async function sign(headers, key) {
  const v = await clientVersion()
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform
  const arch = { arm64: "aarch64", x64: "x86_64", ia32: "386" }[process.arch] ?? process.arch
  headers.set("Authorization", `Bearer ${key}`)
  headers.set("x-grok-client-version", v)
  headers.set("x-xai-token-auth", "xai-grok-cli")
  headers.set("x-grok-client-identifier", "grok-shell")
  headers.set("x-grok-client-mode", "headless")
  headers.set("User-Agent", `grok-shell/${v} (${os}; ${arch})`)
}
