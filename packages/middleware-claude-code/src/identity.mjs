// What a request from the real Claude Code CLI looks like, in the parts channels check: the headers, the system
// prompt's first blocks (the billing attribution and the "You are Claude Code" line) and metadata.user_id. The
// values follow Astra's own ClaudeCodeMimicry (src/Astra.Gateway/Pipeline/ClaudeCodeMimicry.cs), which is aligned
// with captures of claude-cli 2.1.281; keep the two in step when the CLI moves.

export const CLI_VERSION = "2.1.281"

export const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

// The betas claude-cli 2.1.281 sends, without the OAuth one: a channel is called with an API key, not a login.
export const BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
].join(",")

// Salt of the cc_version fingerprint, from real CLI traffic (must not change).
const FINGERPRINT_SALT = "59cf53e54c78"

// (OS, arch, node) of a plausible CLI host; one channel always gets the same one.
const HOSTS = [
  ["MacOS", "arm64", "v22.14.0"], ["MacOS", "arm64", "v24.3.0"], ["MacOS", "arm64", "v20.18.1"],
  ["MacOS", "x64", "v22.11.0"], ["MacOS", "x64", "v20.18.1"],
  ["Linux", "x64", "v22.14.0"], ["Linux", "x64", "v20.18.1"], ["Linux", "arm64", "v24.3.0"],
  ["Windows", "x64", "v22.11.0"], ["Windows", "x64", "v20.18.1"],
]

/** The CLI's headers for this channel and version. `sha256` is ctx.sha256. */
export function headers(protocol, seed, version, betas, sha256) {
  const [os, arch, node] = HOSTS[parseInt(sha256("cc-hostprofile::" + deviceId(seed, sha256)).slice(0, 8), 16) % HOSTS.length]
  const h = {
    "User-Agent": `claude-cli/${version} (external, cli)`,
    "X-App": "cli",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": node,
    "X-Stainless-OS": os,
    "X-Stainless-Arch": arch,
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "Accept-Language": "en-US,en;q=0.9",
  }
  if (protocol === "anthropic") {
    h["anthropic-version"] = "2023-06-01"
    if (betas) h["anthropic-beta"] = betas
  }
  return h
}

/** A stable device id (64 hex) for a channel. */
export const deviceId = (seed, sha256) => sha256("astra-claude-device::" + seed)

/** A v4-shaped UUID derived from a seed, so one conversation keeps one session id across its turns. */
export function sessionUuid(seed, sha256) {
  const h = sha256(seed).slice(0, 32).split("")
  h[12] = "4"
  h[16] = "89ab"[parseInt(h[16], 16) & 3]
  const s = h.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/** UTF-8 bytes of a string (the engine has no TextEncoder). */
export function utf8(text) {
  const out = []
  for (const ch of text) {
    let c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/**
 * The 3-character cc_version suffix: sha256(salt + bytes 4, 7 and 20 of the first user message's UTF-8 + version),
 * hex, first three — over raw bytes, so a byte cut out of a multi-byte character hashes as it is.
 */
export function fingerprint(firstUserText, version, sha256) {
  const bytes = utf8(firstUserText)
  const picked = [4, 7, 20].map((i) => (i < bytes.length ? bytes[i] : 0x30))
  return sha256([...utf8(FINGERPRINT_SALT), ...picked, ...utf8(version)]).slice(0, 3)
}

export const billingLine = (version, fp) => `x-anthropic-billing-header: cc_version=${version}.${fp}; cc_entrypoint=cli;`
