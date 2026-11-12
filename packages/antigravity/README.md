# Antigravity (Astra v2 plugin)

[Antigravity](https://antigravity.google) (Google's agentic IDE) on your own Google account, as an Astra provider:
the Claude, Gemini and GPT-OSS models Antigravity offers the account, with the quota of each family. Plugin id
`astragate-community.antigravity`, provider id `antigravity`. It replaces the v1 package
`@astragate-community/antigravity-auth`.

This is a fresh implementation written from how Antigravity's own client talks to Google, and from reading other
open-source clients of the same API. It is not derived from a magpie-community plugin.

## Risk

- **Antigravity is for Antigravity.** Google gives its allowance for use in its own IDE and CLI. This plugin uses it
  from other agents, which Google hasn't approved.
- **The risk to the account is yours.** Google may suspend an account it sees used outside Antigravity. Use a Google
  account you can afford to lose.
- **This is a community plugin.** It has nothing to do with Google.

## The reply

Code Assist answers with a stream wrapped in an envelope (`{"response": …, "traceId": …}`). The provider declares
`reply: { framing: "sse", output: "gemini" }`: the host cuts the stream into events and `transformResponse` unwraps each
into Gemini's own chunk. Code Assist only streams, so a request that isn't streamed gets the chunks merged into one reply
(text goes on text of its kind, thoughts apart, calls whole). An error chunk, or a refused request, keeps Google's own
words under Google's status (a 403 that wants the account verified or says it broke the terms is said so; a 401 passes
through so `refresh` runs).

## Sign in

Add an account on the provider's page: the flow opens Google's sign-in page with Antigravity's own OAuth client (PKCE
S256, offline access). The page it ends on will not load, because a plugin cannot listen on a port: copy its whole
address from the browser's address bar and paste it back (or just its `code`). The account is named by its email and
set up as Antigravity does: `loadCodeAssist` says its tier, plan and project, and an account that has none is set up
with `onboardUser`. Google's refresh tokens don't turn over; the access token is refreshed two minutes before its end
and after a 401 / 403 (`refresh`).

The OAuth client is an installed app's (its "secret" ships inside the app). Its values are not in git: the packed
plugin carries them in `src/oauth.js` (`BAKED`, filled by the release step), and the plugin's settings `clientId` /
`clientSecret` override them. Without either, the sign-in says so.

The account's sign-in (access / refresh token, expiry, project, plan, tier) is the account's secret in the host.

## Requests

`prepare` takes the Gemini request the gateway chose for the model, shapes it for Antigravity (conversation order,
tool-call ids and signatures, schemas cut to the subset Code Assist takes, thinking level or budget per model, the
words Antigravity turns away broken with a zero-width space), wraps it in the envelope (`project`, `requestId`,
`userAgent: "antigravity"`, `requestType: "agent"`, `model`, `request`) and sends it to
`daily-cloudcode-pa.googleapis.com` `streamGenerateContent?alt=sse` with the app's User-Agent (the version comes from
Antigravity's updater, kept in plugin storage for six hours). A bare model family goes out as the variant of the level
asked for, from the account's own list.

Not carried over from v1: the second host (prod) and the one short wait on a rate limit (the gateway's own failover and
cooldown take over); the `Retry-After` the v1 plugin set on a rate limit (a refused reply can carry a status and words, not
headers; Google's own "reset after Ns" stays in the message); the local `countTokens` estimate (the gateway has no seam for
it from a provider); the sign-in that listens on `localhost`.

## Models and quota

`models()` lists the account's models in the order of Antigravity's picker (cached five minutes); the manifest's nine
are the offline bootstrap. `usage()` is the card: one window per model family, as full as the fullest, plus the plan
and AI credits.

Permissions: `providers`, `storage`, `ui` (the sign-in flow), and `net:` for `daily-cloudcode-pa`, `cloudcode-pa`,
`oauth2` and `www` `googleapis.com`, and Antigravity's updater host.

## Develop

```sh
npm install --workspaces=false --no-package-lock
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.antigravity-2.1.0.tgz
```
