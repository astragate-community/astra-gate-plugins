// Zed's endpoints, the release the requests say they come from, timings and the built-in model list.
export const PROVIDER = "zed"

export const SITE = "https://zed.dev"
export const CLOUD = "https://cloud.zed.dev"
// the Zed release the requests say they come from
export const VERSION = "1.23.0"
export const SUCCEEDED = SITE + "/native_app_signin_succeeded"
// the base URL the AI SDK is given; the fetch sends every request to
// CLOUD/completions, whatever path the SDK adds
export const BASE = CLOUD + "/v1"
// how long a sign-in waits for the browser (magpie: 10 minutes)
export const SIGN_IN_TIMEOUT = 10 * 60 * 1000
// how long the account's model list is kept
export const MODELS_TTL = 10 * 60 * 1000

// The API each of Zed's providers is asked in, as the AI SDK package that
// speaks it.
export const NPM = {
  anthropic: "@ai-sdk/anthropic",
  open_ai: "@ai-sdk/openai",
  x_ai: "@ai-sdk/openai-compatible",
  google: "@ai-sdk/google",
}

// The provider a request's wire stands for, when no model list says otherwise.
export const WIRE_VENDOR = { anthropic: "anthropic", responses: "open_ai", chat: "x_ai", gemini: "google" }

// What is declared before the account's own list is read (it replaces
// these once signed in): Zed's hosted families, one model each.
export const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_token_count: 1000000, max_output_tokens: 64000, supports_images: true, supports_thinking: true },
  { provider: "anthropic", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_token_count: 1000000, max_output_tokens: 128000, supports_images: true, supports_thinking: true },
  { provider: "anthropic", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_token_count: 200000, max_output_tokens: 64000, supports_images: true, supports_thinking: true },
  { provider: "open_ai", id: "gpt-5.5", display_name: "GPT-5.5", max_token_count: 400000, max_output_tokens: 128000, supports_images: true, supports_thinking: true },
  { provider: "google", id: "gemini-3.5-flash", display_name: "Gemini 3.5 Flash", max_token_count: 1048576, max_output_tokens: 65536, supports_images: true, supports_thinking: true },
  { provider: "x_ai", id: "grok-4.7", display_name: "Grok 4.7", max_token_count: 500000, max_output_tokens: 64000, supports_images: true, supports_thinking: true },
]
