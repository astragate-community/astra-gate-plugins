// Calling cloud.zed.dev's /client/* with an account's pair.
import { CLOUD, VERSION } from "./constants.mjs"
import { ZedStatus } from "./refusals.mjs"

// userAgent is Zed's: Zed/<version> (<os>; <arch>), in Rust's names.
export function userAgent() {
  const os = { darwin: "macos", win32: "windows" }[process.platform] ?? process.platform
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch] ?? process.arch
  return `Zed/${VERSION} (${os}; ${arch})`
}

// cloud sends one /client/* request with the account's pair.
export async function cloud(method, path, s, body, timeout = 20_000) {
  const headers = { Authorization: `${s.userId} ${s.access}`, "Content-Type": "application/json", "User-Agent": userAgent() }
  if (s.systemId) headers["x-zed-system-id"] = s.systemId
  const res = await fetch(CLOUD + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) throw new ZedStatus(res.status, text, res.headers)
  return text
}
