// Cursor's endpoints, timings and the names the plugin and the Run share.
import { platform } from "node:os"

export const ID = "cursor"
export const API = "https://api2.cursor.sh"
export const WEBSITE = "https://cursor.com"
export const AGENT = "https://agentn.global.api5.cursor.sh" // when the server config can't say
export const CHAT = "@ai-sdk/openai-compatible"
export const VERSION_FALLBACK = "2026.09.23-86fc751" // the CLI version said when no install names one
export const DEFAULT_CONTEXT = 200_000 // a model Cursor gives no limit for
export const MODELS_KEEP = 10 * 60 * 1000
export const CALL = "CallDynamicTool" // how the model calls an MCP tool
export const NO_RESULT = "Tool use was interrupted and did not produce a result."
export const CLI_MARK = "cursor-agent" // an oauth sign-in's refresh when the token is cursor-agent's own

export const GOOS = { win32: "windows" }[platform()] ?? platform()
export const EMPTY = Buffer.alloc(0)
export const enc = new TextEncoder()

// a token with less than this left is renewed (cursor-agent) or exchanged again (an API key)
export const SOON = 5 * 60 * 1000

// SESSION carries the session magpie (or OpenCode) names a request's
// conversation by, from the chat.headers hook to the loader's fetch. It
// goes no further: nothing of the request's headers is sent to Cursor.
export const SESSION = "x-magpie-cursor-session"
