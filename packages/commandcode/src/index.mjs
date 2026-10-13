// Command Code's plans (commandcode.ai) as an OpenCode provider plugin. Based on
// an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
// An account is a Command Code API key. It is got the way Command Code's
// CLI gets one (Studio approves a key for this machine and posts it to a
// callback on 127.0.0.1), taken from the CLI's own sign-in
// (~/.commandcode/auth.json, read only), or pasted from Studio's keys page.
// A key doesn't expire: there is nothing to refresh.
//
// Every plan but Go is served on the Provider API: chat completions and
// Responses at /provider/v1, Anthropic's Messages at /provider/v1/messages,
// the key in Authorization and x-api-key. Go's key has no Provider API: it
// is only taken where the CLI itself asks, POST /alpha/generate, in the
// CLI's own format (command-code 1.72.2), which the fetch here writes from
// the chat completion OpenCode sends and turns back into one.
export { CommandCodePlugin } from "./plugin.mjs"
