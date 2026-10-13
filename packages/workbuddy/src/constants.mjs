// WorkBuddy: the versions it is told and the timings it keeps.

export const APP_VERSION = "2.0.0" // the version WorkBuddy's sign-in page is opened with
export const UA_VERSION = "5.5.6" // WorkBuddy/<this> is the User-Agent the API takes
export const POLL_MS = 1000
export const SIGN_IN_MS = 5 * 60 * 1000
export const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed before a request
export const LEAD_MS = 5 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
export const KEEP_RENEWED_MS = 60 * 1000

export const NPM = "@ai-sdk/openai-compatible"