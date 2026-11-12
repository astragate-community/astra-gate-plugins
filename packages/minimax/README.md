# MiniMax Code (Astra v2 plugin)

MiniMax Code (mcode) accounts as Astra providers: the credits a MiniMax Code account gets and its M Plan, on MiniMax Code's
own models. Plugin id `astragate-community.minimax`. It replaces the v1 package `@astragate-community/minimax-auth` and
keeps its provider ids, so token pools and client bindings can be repointed on upgrade.

| Provider id | Site | API |
|---|---|---|
| `minimax-code` | MiniMax Code, China (minimax.cn / minimaxi.com) | `https://agent.minimax.cn/mavis/api/v1/llm/v1` |
| `minimax-code-global` | MiniMax Code, international (minimax.io) | `https://agent.minimax.io/mavis/api/v1/llm/v1` |

## Risk

- **The credits are for MiniMax's services.** MiniMax gives them for use in MiniMax Code, and its terms decide where else
  they may be used. This plugin uses them from other agents; MiniMax has not approved that.
- **The risk to the account is yours.** MiniMax may limit, suspend or close an account used this way.
- **This is a community plugin.** It has nothing to do with MiniMax.

## Signing in

Open the provider's page and press "Add account". The flow is MiniMax Code's own device sign-in (OAuth device flow, PKCE
S256, client `mcode-public`, the same as `mcode /login`): it opens MiniMax's page and shows a code to confirm there. The
plugin polls in slices of about 40 seconds (a view action has a wall-clock limit); if the slice ends before you confirm,
the code stays on screen and "I confirmed it, keep waiting" polls again. MiniMax Code's own sign-in (`~/.minimax`) is never
read or changed.

The account's credential (kept by Astra as the account's secret) holds the access and refresh tokens, their expiry and the
MiniMax user id and email. The account row is keyed by the MiniMax user id.

## Refreshing

- MiniMax spends a refresh token once; sent a second time it is `invalid_grant`, which signs the account out, so the plugin
  never sends one twice. Only one refresh runs at a time per account; requests that arrive meanwhile wait for it.
- `prepare` refreshes the access token two minutes before it ends and saves the new credential on the account. When MiniMax
  turns a token away (401/403), Astra calls the plugin's `refresh`, which returns `renewed` or, for a signed-out account,
  `expired` (the account is marked and needs a new sign-in). A passing failure (a 5xx, a timeout) leaves the account alone.

## Requests

Every request is Anthropic Messages at `<agent>/mavis/api/v1/llm/v1/messages` with MiniMax Code's headers
(`User-Agent: MiniMaxAgent`, `X-Mavis-Agent-Id`, `X-Mavis-Timezone-Offset`, `X-Mavis-Session-Id`, the account in
`Authorization`). The session id is the client's `x-mavis-session-id` / `x-session-id` header, else one id per loaded plugin.

## Models

MiniMax Code's own list is built in (M3.1-Flash-Preview, M3, M2.7, M2.7-highspeed); for an account the plugin asks MiniMax
Code's live model config and falls back to the built-in list.

## Usage card

The account's plan (the M Plan's tier, else Free), its credits and the M Plan's windows (each model group's interval and week).

## Replies

The manifest declares `reply: { framing: sse, output: anthropic }`; the plugin's `transformResponse`:

- turns an out-of-credits refusal (402/403 whose text is about credits, balance, quota or the plan) into a 429
  (`usage limit reached: …`), so a pool can move on to another account (the v1 reply guard). Other refusals pass as sent;
- passes the Anthropic events on as event pairs. MiniMax is always asked to stream, and a client that wanted one JSON
  message gets the stream put back together (text, thinking with its signature, tool calls with parsed input); a stream
  that ends without `message_stop` is a 502.

Not carried over from v1:

- Model "variants" (thinking levels as provider options). v2 models have none; a client sends `thinking` / `output_config`
  in its own Anthropic request, which passes through untouched.
- OpenCode's `chat.headers` hook (the conversation id): see Requests.

Permissions: `providers`, `ui` (the sign-in flow) and `net:` for the account, agent, platform and chat hosts of both sites.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # in this directory
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.minimax-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
