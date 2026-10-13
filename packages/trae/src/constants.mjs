// Trae: timings, the tool-call tags and the defaults every model of a fallback list starts from.

export const SIGN_IN_TIMEOUT = 10 * 60 * 1000
export const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is renewed before a request
export const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
export const DAY = 24 * 3600 * 1000
export const REQUEST_TIMEOUT = 20_000 // one of Trae's JSON pages, or a token renewal

// the domains a host a sign-in names must be on to be taken (see traeHost)
export const TRAE_DOMAINS = ["trae.cn", "trae.ai", "mchost.guru"]

// SESSION carries the conversation magpie (or OpenCode) names a request by, from the chat.headers hook to the
// loader's fetch. It goes no further.
export const SESSION = "x-magpie-trae-session"

// Trae's chat takes text only and has no turn for a tool call or its
// result. The agent's tools are named to it natively and in a system
// prompt that asks for each call as a tagged block; earlier calls and
// their results go in as text. A native call in its answer is taken too.
export const OPEN = "<tool_call>"
export const CLOSE = "</tool_call>"

// MAX is the suffix of a model's Max: deepseek-v4.1-flash-max is
// deepseek-v4.1-flash in Max mode
export const MAX = "-max"

// a reply limit of 0 is one Trae doesn't say: magpie then takes models.dev's
// for the model (magpie's catalog), where a made-up 32K told agents a far
// smaller one than DeepSeek V4.1 Flash's (ARNO on magpie's Discord)
export const MODEL = { attachment: false, tool_call: true, reasoning: true, temperature: true, limit: { context: 128_000, output: 0 }, modalities: { input: ["text"], output: ["text"] } }
