// Antigravity: ids, endpoints and timings.
export const ID = "antigravity"

// Code Assist (cloudcode-pa) is the API Antigravity's IDE and CLI talk to: Gemini's request wrapped in an envelope of
// its own, under a Google Cloud project it gives the account. The daily host takes the requests; the account's project
// and plan are asked of prod, as the app does.
export const DAILY = "https://daily-cloudcode-pa.googleapis.com"
export const PROD = "https://cloudcode-pa.googleapis.com"
export const ENDPOINTS = [DAILY, PROD]
// the provider's address as the models are listed under it
export const BASE = DAILY + "/v1beta"

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
// A desktop client takes any loopback port; Google's page ends on this address, which fails to load where the browser
// runs, and the address is pasted back (a plugin cannot listen on a port)
export const REDIRECT = "http://localhost:51121/oauth-callback"

// The version Antigravity's updater says is newest is what the requests carry, asked at most every few hours
export const VERSION_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml"
export const VERSION_ORIGIN = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app"
export const FALLBACK_VERSION = "2.24.0"
export const VERSION_TTL = 6 * 60 * 60 * 1000

export const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request

export const ONBOARD_POLLS = 3
export const ONBOARD_WAIT = 1500

// Antigravity's own ids the account lists but a chat can't use: completion and tab models, internal chats
export const HIDDEN = new Set(["chat_20706", "chat_23310", "tab_flash_lite_preview", "tab_jump_flash_lite_preview", "gemini-2.5-flash-thinking", "gemini-2.5-pro"])
export const INTERNAL = /^(chat|tab)_/

// A Gemini thought signature Google skips the check of, for a call the model didn't make here
export const SKIP_SIGNATURE = "skip_thought_signature_validator"
