# Grok (Astra v2 plugin)

Grok models with a SuperGrok or X Premium+ subscription, through the Grok Build backend (`https://cli-chat-proxy.grok.com/v1`,
the OpenAI Responses API) and its xAI sign-in. Plugin id `astragate-community.grok`, provider id `grok`. It replaces the v1
package `@astragate-community/grok-auth`.

## What changed from v1, and why

v1 did not sign in itself: it ran the locally installed Grok Build CLI (`grok login --device-auth`, `grok models` to renew a
token) and read the CLI's `auth.json`. A v2 plugin has no file system and starts no processes, so all of that is gone. In
its place the plugin speaks the xAI sign-in server (`https://auth.x.ai`, OpenID Connect with the Grok Build client id)
directly, as the standards write it. **This was written from v1's source and the standards, and not run against the live
service** (no network was used): treat the device-code flow and the token refresh as untested until you have signed in once.

## Signing in

Open the provider's page and press "Add account". Two ways:

- **Device code.** Opens xAI's page and shows a code to confirm; the plugin polls for about 40 seconds at a time (a view
  action has a wall-clock limit) and "I confirmed it, keep waiting" polls again. The credential is the plugin's own, so Grok
  Build's own sign-in is untouched. The device-authorization and token endpoints come from the issuer's discovery document
  (only endpoints at `auth.x.ai` are used), with `/oauth2/device/code` and `/oauth2/token` as the fallback.
- **Import.** Paste the contents of Grok Build's `~/.grok/auth.json` (or one entry of it), or a CPA (CLIProxyAPI) xAI account
  file (the same checks as v1: an enabled xAI OAuth account for the Grok Build client). The refresh token rotates, so stop
  using that sign-in in Grok Build or CPA afterwards; a second client spending the same token signs both out.

An account's credential (kept by Astra as the account's secret) holds the access token, the refresh token and its expiry.
The token is renewed five minutes before it ends (the refresh token is spent once, so only one renewal runs per account);
after a 401/403 Astra calls the plugin's `refresh`; an account xAI signed out is marked expired.

## Requests

Responses requests only, to `/v1/responses` (and sub-paths) of the backend, signed as the Grok CLI signs them
(`x-grok-client-version`, `x-xai-token-auth`, `x-grok-client-identifier`, `x-grok-client-mode`, user agent). The body is
reshaped as in v1: tools of types Grok refuses are dropped, `external_web_access` removed, a union at the root of a
function's parameters folded into an object, Codex `agent_message` items turned into user messages, reasoning items'
`"content": null` removed. A model id `grok-4.7@500k` is sent as `grok-4.7` with `x-grok-context-window: 500000`; the
conversation's `prompt_cache_key` becomes `x-grok-conv-id`.

## Models

The built-in list is `grok-4.7`; for an account the plugin asks the backend (Responses models only), and offers each listed
context window beside the default as `<id>@<window>`.

## Usage card

The credits of the current period (weekly for SuperGrok), what on-demand spending has used of its cap, and a "Rate limit"
window made from the account's last 429 (billing says nothing of a plan's rate limit: a free account reads 0% used while
every request answers 429). The window runs until the reset the 429 named (`Retry-After`, or a `*ratelimit*reset*` header),
or five minutes when it named none, and ends sooner when a request goes through.

## Replies

The manifest declares `reply: { framing: ndjson, output: responses }`; the plugin's `transformResponse` only reads each
reply's status and headers to keep the rate-limit note above (the events pass on as they came, as Responses event pairs,
or as one JSON body). `ndjson` on purpose: an `sse` reader would swallow a plain JSON body (a non-streaming request) as a
stream with no events, so the plugin takes the lines and puts the `event:` / `data:` pairs back together (a `data:` event
spanning several lines would not survive; the Responses API writes none). The note is kept in the plugin's memory, so a
reload forgets it.

Every call that carries a credential (the model list, billing, the sign-in server) is made with `redirect: 'error'`, so a
bearer token is never sent anywhere a redirect points.

## Not carried over from v1

- Using the installed Grok Build CLI (its `auth.json`, renewing through `grok models`, `grok login`).
- The client version is always the plugin's own (1.0.41): v1 used the installed CLI's when newer. The user agent says
  `x86_64` whatever the machine, since the plugin cannot see the CPU.
- Marking the sign-in kept or renewed on replies (v1's header); Astra decides that from `refresh` instead.
- Reasoning-effort model variants (v2 models have none); a client sends `reasoning.effort` in its own request.

Permissions: `providers`, `ui` (the sign-in flow) and `net:` for `cli-chat-proxy.grok.com` and `auth.x.ai`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # in this directory
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.grok-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
