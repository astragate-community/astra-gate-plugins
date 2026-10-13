// OpenCode Zen free: the provider id, the wire protocols it speaks and the endpoints it is discovered from.

export const PROVIDER = "opencode-zen-free"
export const ICON = "https://opencode.ai/favicon-v3.ico"

// the AI SDK package OpenCode loads for each of Zen's wire protocols
export const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
}

export const DEFAULT_BASE = "https://opencode.ai/zen/v1"
export const CATALOG = "https://models.opencode.ai/api.json"
export const DOCS = "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx"
export const PATHS = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" }

export const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"]
export const OPENCODE_VERSION = "1.18.34"

// the most a reply (or one SSE event) may buffer before it is refused
export const MAX_BYTES = 32 * 1024 * 1024
export const DISCOVERY_TIMEOUT_MS = 15000
