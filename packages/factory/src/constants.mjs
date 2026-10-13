// Factory: droid's identity, Factory's hosts and the timings of tokens.

export const PROVIDER = "factory"

export const WORKOS = "https://api.workos.com/user_management"
export const API = "https://api.factory.ai"
export const API_EU = "https://api.eu.factory.ai"
// droid's WorkOS client, production
export const CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB"
// the droid release the requests say they are
export const VERSION = "0.233.0"
// how long before an access token lapses it is renewed (droid: a minute)
export const REFRESH_LEAD = 2 * 60 * 1000
// and how long before, magpie renews it ahead of time (auth.refresh): a
// minute more, so under magpie the check before a request finds it fresh.
// WorkOS's access tokens are short-lived, so not much more
export const MAGPIE_LEAD = 3 * 60 * 1000
// how long an account whose whoami failed waits before asking again
export const ASK_AGAIN = 10 * 60 * 1000