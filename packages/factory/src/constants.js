// Factory: droid's identity, Factory's hosts and the timings of tokens.
export const PROVIDER = "factory";

export const WORKOS = "https://api.workos.com/user_management";
export const API = "https://api.factory.ai";
export const API_EU = "https://api.eu.factory.ai";
// droid's WorkOS client, production
export const CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
// the droid release the requests say they are
export const VERSION = "0.233.0";
// how long before an access token lapses it is renewed (droid: a minute, here two: prepare has five seconds)
export const REFRESH_LEAD = 2 * 60 * 1000;
// how long an account whose whoami failed waits before asking again
export const ASK_AGAIN = 10 * 60 * 1000;
// where a model's requests go on each protocol the host can ask for
export const PATHS = { anthropic: "/api/llm/a/v1/messages", responses: "/api/llm/o/v1/responses", chat: "/api/llm/o/v1/chat/completions" };
export const COUNT_TOKENS = "/api/llm/a/v1/messages/count_tokens";
