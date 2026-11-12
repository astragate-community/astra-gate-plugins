# OpenCode Zen Free (Astra v2 plugin)

OpenCode Zen's free models as an Astra provider. Plugin id `astragate-community.zen-free`, provider id
`opencode-zen-free`. It replaces the v1 package `@astragate-community/zen-free-auth`.

## Use

Install the plugin, open the provider's page and press "Add account": the sign-in flow has one button, because Zen's
free access uses the shared `public` credential and needs no personal key. Availability and rate limits are Zen's.

## Models

`models()` merges Zen's `/models`, OpenCode's catalog (context windows, capabilities) and Zen's docs table (which wire
protocol each model speaks), and keeps retired models out. The last good list is kept in plugin storage and used when
Zen's listing is unreachable; the three models in the manifest are the offline bootstrap.

## Requests

`prepare` sends each request to `https://opencode.ai/zen/v1` on the protocol the gateway chose (Chat Completions,
Responses or Anthropic Messages), with OpenCode's client identity headers and one stable `ses_…` session id, and adds
stub entries for OpenCode's core tools (`bash`, `edit`, `glob`, `grep`, `read`) the agent did not declare. Zen is always
asked to stream.

## Replies

The manifest declares `reply: { framing: sse, output: anthropic }` and the plugin's `transformResponse` does what the v1
plugin did:

- **Tool guard.** A reply may only call tools the agent declared; a call to the same name in another case or separator
  style (`todowrite` for `todo_write`) is renamed when exactly one declared tool matches. A chat stream's tool calls are
  held back until their choice finishes, so a call reaches the client only once its name is known and checked. A violation
  cuts a stream with an error event of the protocol, and fails a one-body reply with a 502.
- **Stream collapse.** A client that asked for one JSON body gets Zen's stream put back together (chat, responses and
  anthropic accumulators); a stream that ends without its completion marker, or carries an error event, is a 502.
- The events leave in the client's protocol: chat as bare data events ending with `[DONE]`, the others as event pairs.
  (`output` names one protocol only to the host's own `[DONE]` rule; the plugin writes `[DONE]` for chat itself.)

Host limit, handled as well as it can be: the reply side is not told which tools the request declared. `prepare` leaves
the declared names in the plugin's memory per model, and a reply is checked against the union of the requests of that
model still pending (entries expire after 15 minutes). That can only let more calls through than the agent declared
(when sub-agents with different tool sets share a model), never refuse a declared one. After a plugin reload, with no
record, names are not checked.

Permissions: `providers`, `storage`, `ui` (the sign-in flow) and `net:` for `opencode.ai`, `models.opencode.ai` and
`raw.githubusercontent.com` (model discovery).

## Develop

```sh
npm install            # from the repository root
npm test -w packages/zen-free
npm run build -w packages/zen-free && npm run validate -w packages/zen-free
npm run pack -w packages/zen-free   # writes out/astragate-community.zen-free-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
