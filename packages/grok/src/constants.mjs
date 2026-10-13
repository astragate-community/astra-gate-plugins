// Versions, timings, endpoints and the words the plugin says in more than one place.
export const PROVIDER = "grok"
export const BASE = "https://cli-chat-proxy.grok.com/v1"
export const CLIENT_VERSION = "1.0.41"
export const CPA_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const CPA_SCOPE = `https://auth.x.ai::${CPA_CLIENT_ID}`
export const REFRESH_MARGIN = 5 * 60 * 1000 // a token this close to its end is renewed before a request
export const LEAD_MS = REFRESH_MARGIN // and this close, magpie renews it ahead of time (auth.refresh)
export const LINK_WAIT = 30 * 1000
export const INSTALL = process.platform === "win32" ? "irm https://x.ai/cli/install.ps1 | iex" : "curl -fsSL https://x.ai/cli/install.sh | bash"

export const NOT_SIGNED_IN = "Grok is not signed in; run `grok login`"
export const SIGN_IN_EXPIRED = "Grok's sign-in has expired; run `grok login`"
