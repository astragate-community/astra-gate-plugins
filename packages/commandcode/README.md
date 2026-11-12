# Command Code Plan (Astra v2 plugin)

Command Code's plans (commandcode.ai) as an Astra provider. Plugin id `astragate-community.commandcode`, provider id
`commandcode-plan`. It replaces the v1 package `@astragate-community/commandcode-auth`.

## Use

Install the plugin, open the provider's page and press "Add account". Create an API key at
commandcode.ai/settings/keys and paste it into the flow. The key is checked with `whoami`, its plan is read from
billing, and the account is named after the key's user. A key does not expire.

## Models and requests

Two providers. **Command Code Plan** (`commandcode-plan`) serves plans from Provider up on the Provider API
(`https://api.commandcode.ai/provider/v1`): chat completions, Responses and Anthropic Messages, with the key in
`Authorization` and `x-api-key`; replies pass straight through. `models()` reads the account's list, puts each model on the
API it is served on (Claude on Messages, the open ones on chat completions, some on Responses alone), and cuts it by what the
plan refuses (the CLI's own plan table, 1.79.2), unless the account has credits beyond its plan's. The built-in list stands in
when the live list fails. The plan is kept in plugin storage because billing's subscription read takes 15 to 20 seconds.

**Command Code Go Plan** (`commandcode-go`) serves the Go plan, whose key has no Provider API: `prepare` writes the chat
completion in the CLI's own format (`config` + `params`, tool calls and results as AI SDK parts, reasoning effort fitted to the
model's levels, always streaming) and sends it to `/alpha/generate`; the manifest's `reply: { framing: "ndjson", output: "chat" }`
has the host cut the answer (a JSON object a line: `text-delta`, `reasoning-delta`, `tool-call`, `finish` ...) into lines and
`transformResponse` (`src/reply.js`) writes chat completion chunks, or one whole `chat.completion` for a caller that did not ask
for a stream. As in v1 a reply that fails straight away keeps its status, a stream cut short after it said something ends with a
note and a finish, and Command Code's refusals are re-mapped (`MODEL_NOT_IN_PLAN` is a 403, credits a 402, window limits a 429).
Go models are the Provider API's list asked without a key, less what Go is refused, with the CLI's table filling in levels,
pictures and windows (the table stands in when the list fails). The sign-in flow decides by the key's plan which provider the
account joins; a Go key the plan was not known for and the Provider API turns away is added to the Go provider by `refresh`.

`usage()` returns the plan, the 5-hour and weekly windows and the credits pool as
`{ plan, until, renew, windows: [{ name, used, span?, resetsAt?, display? }], balance?, error? }`.

## Not carried over from v1

- **Browser sign-in and "use the CLI's sign-in"**: both need a loopback listener or a local file read, which v2 plugins
  do not have. Paste the key instead.
- **Reasoning-effort variants** (`low`/`high`/`max` per model): a v2 model record only says whether it reasons. The Go
  request still honours `reasoning_effort` when the client sends it.
- **Refusal re-mapping on the Provider API provider**: its replies pass straight through, and a `reply` block would force every
  reply (non-streaming JSON ones too) through one framing; the gateway sees Command Code's own status and body there.
- **The agent's working folder** for the Go request: v1 took it from magpie's `x-magpie-work-dir` / `x-magpie-work-git`
  headers (kept, if the client sends them); without them the folder is `~` (a plugin cannot read the user's home).
- A Go account is a Go-provider account: upgrading the plan means adding the key again on the Provider API provider.
- Not live-verified: the tests use fixtures shaped like the CLI's stream, not a captured session.

Permissions: `providers`, `storage` (the plan per account), `ui` (the sign-in flow) and `net:` for `api.commandcode.ai`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # the SDK is a file: dependency
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.commandcode-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
