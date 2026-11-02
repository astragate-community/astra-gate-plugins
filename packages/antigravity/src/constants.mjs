// Antigravity: ids, endpoints, the OAuth client and timings.
export const ID = "antigravity"
export const GEMINI = "@ai-sdk/google"

// Code Assist (cloudcode-pa) is the API Antigravity's IDE and CLI talk to: Gemini's request wrapped in an envelope of
// its own, under a Google Cloud project it gives the account. Requests go to the daily host first and to prod when that
// one can't answer; the account's project and plan are asked of prod, as the app does.
export const DAILY = "https://daily-cloudcode-pa.googleapis.com"
export const PROD = "https://cloudcode-pa.googleapis.com"
export const ENDPOINTS = [DAILY, PROD]
// what OpenCode / magpie are given as the provider's address; the fetch sends each request to Code Assist itself
export const BASE = DAILY + "/v1beta"

// Antigravity's own OAuth client, an installed app's: its "secret" ships inside the app and is no secret.
// The values themselves stay out of git (the org's push protection blocks them): the build bakes them in
// from ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET (scripts/build.mjs reads them; the .env beside the
// repository holds them), the tests say their own, and a build without them says so. What the market
// installs carries them, so a user needs to set nothing.
export const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID ?? ""
export const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ?? ""
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const TOKEN_URL = "https://oauth2.googleapis.com/token"
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
// A desktop client takes any loopback port; the sign-in comes back to the first of these that is free
export const CALLBACK_HOST = "localhost"
export const CALLBACK_PATH = "/oauth-callback"
export const CALLBACK_PORTS = [51121, 8085, 51122, 51123, 51124]

// The version Antigravity's updater says is newest is what the requests carry, asked at most every few hours
export const VERSION_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml"
export const FALLBACK_VERSION = "2.24.0"
export const VERSION_TTL = 6 * 60 * 60 * 1000

export const SIGN_IN_TIMEOUT = 10 * 60 * 1000
export const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request
export const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)

// A request that waits for a rate limit to lift waits for this long at most; a longer limit is the caller's to route around
export const RETRY_WAIT_MAX = 7 * 1000
export const ONBOARD_POLLS = 5
export const ONBOARD_WAIT = 2 * 1000

// Antigravity's own ids the account lists but a chat can't use: completion and tab models, internal chats
export const HIDDEN = new Set(["chat_20706", "chat_23310", "tab_flash_lite_preview", "tab_jump_flash_lite_preview", "gemini-2.5-flash-thinking", "gemini-2.5-pro"])
export const INTERNAL = /^(chat|tab)_/

// A Gemini thought signature Google skips the check of, for a call the model didn't make here
export const SKIP_SIGNATURE = "skip_thought_signature_validator"
