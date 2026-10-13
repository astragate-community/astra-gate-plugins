// Grok (SuperGrok / X Premium+) through the Grok Build CLI's own sign-in.
//
// The CLI (https://x.ai/cli) signs in with a device code and keeps the
// sign-in in its home (GROK_HOME, else ~/.grok) as auth.json. This plugin
// only reads that file: the CLI refreshes the token, which changes each
// time, so a token about to expire is renewed by running the CLI there
// (`grok models`), never by the plugin itself. Requests go to the CLI's
// backend, which speaks OpenAI's Responses API, signed as the CLI signs
// them. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
export { GrokAuthPlugin } from "./plugin.mjs"
