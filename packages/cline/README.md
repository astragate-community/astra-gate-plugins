# Cline (Astra v2 plugin)

Cline's model gateway as an Astra provider. Plugin id `astragate-community.cline`, provider id `cline`. It replaces the
v1 package `@astragate-community/cline-auth`.

## Use

Install the plugin, open the provider's page and press "Add account". The sign-in flow offers two ways:

- **Browser**: Cline's own WorkOS device-code sign-in. The flow shows the code and a link; once you approve it, the
  tokens are traded at Cline's register endpoint for the account's own pair.
- **API key** from app.cline.bot (Settings, API Keys).

The pair (or the key) is the account's secret, kept encrypted by Astra. A token within five minutes of its end is
renewed in `prepare` before the request goes out; Cline rotates the refresh token, so the new pair is saved back to the
account at once. A refused refresh marks the sign-in as lapsed (the 401/403 path asks the plugin's `refresh`).

## Models and requests

`models()` merges Cline's recommended-models feed (recommended, free and ClinePass groups) with its cloud catalog for
context windows, and keeps the last good list in plugin storage (the bundled snapshot is the fallback).
`prepare` sends chat completions to `https://api.cline.bot/api/v1` with Cline's CLI identity headers and a task id
derived from the conversation's session header when the client sends one.

Setting **pinUpstream** (off by default): DeepSeek models (not `cline-free/`) get `providerOptions.gateway.only =
["deepseek"]` so Cline's gateway does not route them to a weaker upstream.

`usage()` returns the credit balance and, on ClinePass, the 5-hour, weekly and monthly limits as
`{ plan, balance, windows: [{ name, used, span, resetsAt }], user }` (`expired: true` when the sign-in is gone).

## Replies

The manifest's `reply: { framing: "sse", output: "chat" }` runs every reply through `transformResponse` (`src/reply.js`):

- A streaming reply passes chunk by chunk; a `{"data": {...}}` envelope around a chunk is taken off. The host closes the stream.
- A caller that did not ask for a stream (`stream: false`): the host frames one reply type per provider, so `prepare` asks
  Cline for a stream (with `stream_options.include_usage`) and `end` folds the chunks into the one `chat.completion`
  (content, reasoning, whole tool calls, usage), which also takes the `{"data": ...}` envelope off as v1 did. A reply that
  arrives as plain JSON despite the stream request is not read (Cline's OpenAI-compatible gateway answers a stream request with SSE).
- Refusals are re-mapped in `start`, as v1 did: a ClinePass entitlement error is a 403, an empty account a 429 "out of credits"
  (so a pool moves on), a lapsed sign-in a 401 (which asks `refresh`), spend and rate limits a 429.

## Not carried over from v1

- The sign-in marks on replies (`X-Magpie-Sign-In`): a refused 401 asks the plugin's `refresh` instead.
- The renewal ahead of time (`auth.refresh`, ten minutes before the end): renewal happens at the next request instead.
- Not live-verified: the tests use fixtures shaped like Cline's gateway replies, not a captured session.

Permissions: `providers`, `storage` (the last model list), `ui` (the sign-in flow) and `net:` for `api.cline.bot` and
`api.workos.com`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # the SDK is a file: dependency
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.cline-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
