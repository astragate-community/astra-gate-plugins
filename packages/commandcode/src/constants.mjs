// Command Code's endpoints, the CLI version this plugin speaks as, and the provider ids of the AI SDK packages
export const ID = "commandcode-plan"
export const API = "https://api.commandcode.ai"
export const STUDIO = "https://commandcode.ai"
export const BASE = API + "/provider/v1"
export const CLI_VERSION = "1.72.2"
export const MAX_TOKENS = 64000 // the CLI's max_tokens when none is asked
export const ORIGINS = ["https://commandcode.ai", "https://staging.commandcode.ai"]
export const SIGN_IN_TIMEOUT = 10 * 60 * 1000

export const CHAT = "@ai-sdk/openai-compatible"
export const MESSAGES = "@ai-sdk/anthropic"
export const RESPONSES = "@ai-sdk/openai" // the Responses API, which magpie speaks to it on
