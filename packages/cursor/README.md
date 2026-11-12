# Cursor (Astra v2 plugin)

Cursor subscriptions (Pro, Pro+, Ultra, Teams) as an Astra provider. Plugin id `astragate-community.cursor`, provider id
`cursor` (unchanged from v1). It replaces the v1 package `@astragate-community/cursor-auth`.

Needs an Astra whose v2 host has the `connect` reply framing, `{ $end }`, byte bodies from `prepare` and `transformResponse.dispose`
(design/plugin-v2 08 §2.2); an older one refuses the manifest at install.

> **Not yet verified against Cursor itself.** The chat path is the v1 plugin's HTTP/1.1 Run, ported and tested with built
> frames only. Try it with a real account before publishing.

## What works

- **Chat** (OpenAI chat completions, streamed or not, with the caller's tools) on Cursor's agent API, run the way Cursor's
  clients run it over HTTP/1.1:
  - `prepare` builds the run request (the conversation as blobs, the caller's tools as MCP tools, the model as the variant
    the effort / `service_tier` / context size pick, in Max Mode where Cursor needs it), puts it up as `BidiAppend` 0 and
    waits for Cursor to take it, then hands the host `AgentService/RunSSE` with a binary Connect body.
  - The host reads the reply's Connect frames (`reply.framing: "connect"`); `transformResponse` decodes each: text,
    thinking (`reasoning_content`) and tool calls become chat chunks; the server's blob requests, tool-list and context
    requests are answered with more `BidiAppend` calls while the reply streams; Cursor's own tools (shell, file edits) are
    refused; a heartbeat goes up every 5 s. Once the turn ends, or the step has made all its tool calls, the reply ends
    (`{ $end: true }`) and the host closes the Run.
  - Cursor's errors keep their status (out of usage 429, a lapsed sign-in 401, a region refusal 403, …); an empty turn is a
    502 that says what came.
- **Sign in**, in the provider's "Add account" flow:
  - *the browser*: the login `cursor-agent login` does. `cursor.com/loginDeepControl` opens with a PKCE challenge and the flow
    polls `api2.cursor.sh/auth/poll` until the browser has signed in. The account is named by its email
    (`DashboardService/GetMe`). A browser sign-in's token lasts about two months and Cursor gives no way to renew it: sign in
    again after that.
  - *a Cursor API key* (cursor.com/dashboard → Integrations): exchanged at `/auth/exchange_user_api_key` as the CLI does with
    `CURSOR_API_KEY`, checked on the spot, and exchanged again when the token runs out (the refresh hook does it after a 401/403).
  The sign-in is the account's host-held secret (encrypted by Astra).
- **Models**: Cursor's picker (`AiService/AvailableModels`) less the variants the account hasn't got (`GetUsableModels`), each
  model once for each context size (`Claude Opus 5.5 @ 300k`), kept 10 minutes per account. Effort and fast tiers are request
  parameters in Cursor, not models of their own.
- **The usage card**: the plan's name, the Cursor Models and Other Models pools, the on-demand spend (a user's limit, none, or a
  team's pool), Grok Bot's separate allowance and the total, each with the billing period's end.

## What is missing (compared with v1)

- **HTTP/2 to the regional agent host.** v1 ran the Run over HTTP/2 on the host `ServerConfigService/GetServerConfig` names, and
  fell back to HTTP/1.1 on `api2.cursor.sh`. This plugin always uses the HTTP/1.1 path: the host's fetch has no request-side
  stream, and a regional host is not a static `net:` origin. A team Cursor serves only in some regions may be refused (403,
  "region"); v1 retried those over HTTP/2.
- **Retries inside one request.** v1 ran the Run again at once for a model Cursor serves only in Max Mode and for a region
  error. A reply can't start a new request, so the first such request fails saying so, and the plugin remembers the model
  (storage `maxOnly`) so the next request goes in Max Mode.
- **Exact usage of a step that ends in tool calls.** v1 closed the Run and read the dashboard's usage events for that step; a
  reply call has 2 s, so such a step reports an estimate (a turn that ends reports Cursor's own count). Usage owed by earlier
  steps (v1's `magpie_deferred`) is not reported.
- **cursor-agent's sign-in** (reading the macOS keychain or `~/.cursor/auth.json`, renewing through `cursor-agent status`): a v2
  plugin has no file access or child processes.
- The CLI version said to the API is a fixed value (v1 used an installed cursor-agent's); the conversation says it runs on
  `linux` with `/tmp` (v1 named the machine's own).
- The session that keeps a conversation on one Cursor machine (its prompt cache) is the request's `prompt_cache_key` or a
  `session_id` / `x-session-id` header; v1 also had the session magpie or OpenCode named.

Permissions: `providers`, `storage`, `ui` (the sign-in flow) and `net:` for `api2.cursor.sh` and `cursor.com`.

Internals: the base64url helpers use the host's `encoding`, `TextDecoder` and `crypto.sha256(..., {encoding:'bytes'})`-style
primitives instead of hand-rolled code (behaviour unchanged).

## Develop

```sh
npm install --workspaces=false --no-package-lock
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.cursor-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
