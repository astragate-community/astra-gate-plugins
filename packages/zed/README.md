# Zed (Astra v2 plugin)

Zed subscriptions (Pro, trial, student, business) as an Astra provider. Plugin id `astragate-community.zed`, provider
id `zed`. It replaces the v1 package `@astragate-community/zed-auth`.

## What works

- **Account**: the sign-in flow takes Zed's user id and access token (the pair Zed's editor keeps in the system
  keychain for `zed.dev`), checks it with `GET /client/users/me`, picks the organization (the default one, else the
  first) and refuses an organization with Zed's hosted models turned off. The account's secret holds
  `{ userId, access, systemId, org, plan, who }`. Zed has no refresh token: the pair lasts until Zed refuses it.
- **Models**: `POST /client/llm_tokens` mints a short-lived model token (kept in memory, minted again when Zed calls it
  stale), `GET /models` lists what the account may call. Each model gets the wire of its provider (Anthropic on
  Messages, OpenAI on Responses, xAI on chat completions, Google on Gemini). The built-in list stands in when Zed
  cannot answer.
- **Usage**: `{ plan, until?, error? }` from `/client/users/me` (the plan's name, when its period ends, an overdue
  invoice as the error; `expired: true` when Zed refuses the sign-in).

- **Requests**: `prepare` mints the model token and wraps the gateway's request as Zed's `/completions` takes it
  (`{provider, model, provider_request}`, always streaming; Anthropic without `stream` and with `is_error` on tool
  results, xAI's `max_completion_tokens`, Gemini's `models/<id>`). Zed answers newline-delimited JSON (`{"event": …}` lines
  with status lines between); the manifest's `reply: { framing: "ndjson" }` has the host cut it into lines and
  `transformResponse` (`src/reply.js`) hands each provider event back in its own format: Anthropic and Responses as
  `event:`/`data:` pairs, chat and Gemini as plain chunks (chat ends with `[DONE]`), or, for a caller that did not ask for
  a stream, folded into one whole reply. As in v1, the lead of a reply (message_start, role-only chunks, status lines) is
  held until something is said, so a failed status, the provider's own error event or a reply that ends without an
  answer becomes a real refused request (a rate limit is a 429), and a reply that ends without `stream_ended` fails
  instead of being cut short. A 401 asks `refresh`, which mints a new model token (or marks the account expired).
  `reply.output` is `anthropic` (the first protocol): the plugin writes each wire's own events by `ctx.request.protocol`
  and emits the chat `[DONE]` itself.

## Not carried over from v1

- **Zed's browser sign-in** (RSA-2048 key, loopback listener, encrypted callback): a plugin still cannot listen on a
  port (the RSA decryption alone would be possible now). The pasted pair replaces it.
- Reasoning-effort variants per model (model records have no per-model variants), and the `X-Magpie-Sign-In` marks.
- Not live-verified: the tests use frames shaped like Zed's documented stream, not a captured session.

Permissions: `providers`, `ui` (the sign-in flow) and `net:https://cloud.zed.dev`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # the SDK is a file: dependency
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.zed-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
