# Kiro (Astra v2 plugin)

[Kiro](https://kiro.dev) subscriptions (Free, Pro, Pro+, Power) as an Astra provider. Plugin id
`astragate-community.kiro`, provider id `kiro`. It replaces the v1 package `@astragate-community/kiro-auth`.

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).

## The reply

Kiro answers with a binary AWS event stream. The provider declares `reply: { framing: "aws-eventstream", output:
"anthropic" }`: the host cuts the stream into messages (checking their CRCs) and `transformResponse` turns each into
Anthropic Messages events (text, `reasoningContentEvent` thinking with its signature, tool calls with arguments in
pieces, usage, stop reason), or, for a non-streaming request, one message. Kiro's own words are kept: a throttle is
`rate limited: …`, a quota or rate-limit error before any of the answer is a 429 (else 502) so another account can take
over, `MONTHLY_REQUEST_COUNT` is a 429, `INSUFFICIENT_MODEL_CAPACITY` a 503, "input is too long" a 400; a 401 / 403
passes through so `refresh` runs. An error after part of the answer ends the stream with an `error` event.

Limits of the host seam: the reply step cannot see the request, so (1) `<thinking>…</thinking>` at the head of the text
is always split into a thinking block (v1 did it only when the request asked to think), and (2) the names of tools
shortened for Kiro are remembered by `prepare` in the plugin's memory (a few thousand) and mapped back from there; after
the plugin's engine restarts mid-conversation a shortened name comes back as sent.

## Sign in

Add an account on the provider's page. The flow offers:

- **Sign in with Kiro** (Google, GitHub, AWS Builder ID, IAM Identity Center): Kiro's page (`app.kiro.dev/signin`) is
  opened with the IDE's own parameters and sends the browser back to `localhost:3128`. A plugin cannot listen on a
  port, so that page will not load: copy its whole address from the browser's address bar and paste it back.
  - Google and GitHub come back with a code, which Kiro's auth service trades for tokens.
  - Builder ID and Identity Center come back with an AWS sign-in address and region: the plugin registers a client
    with AWS's OIDC service, opens AWS's page, and a second pasted address (`127.0.0.1:3128/oauth/callback?code=…`)
    is traded for the tokens.
  - The account is named by the email Kiro has for it (`Get-Usage-Limits`), which also gives its plan.
  - A company's own identity provider (`external_idp`) is not supported.
- **Kiro API key (`ksk_…`)**: sent with `tokentype: API_KEY`; its profile is found with `GetProfile`, so a key Kiro
  turns down is refused at once.

The sign-in (tokens, profile ARN, region and, for AWS, the registered client) is the account's secret in the host.
Tokens are refreshed two minutes before their end and after a 401 / 403 (`refresh`): Google / GitHub through
`prod.<region>.auth.desktop.kiro.dev/refreshToken`, Builder ID / Identity Center through AWS's
`oidc.<region>.amazonaws.com/token`; one refresh at a time, since a refresh may replace the refresh token. The
Identity Center region must be one of the AWS regions listed in the manifest's `net:` permissions.

## Requests

`prepare` takes the Messages request the gateway chose for the model and sends it to
`runtime.<region>.kiro.dev/generateAssistantResponse` (the region is the profile ARN's) with kiro-cli's headers, as a
Kiro conversation:

- the system prompt goes at the head of the first message, with `<thinking_mode>` when the request asked to think;
- tool calls and results are paired (an unanswered call gets an error result, a result over 250,000 characters is
  cut); tool ids and names Kiro wouldn't take are rewritten (a name over 64 characters is shortened with a hash);
- only the latest images are sent, as bytes; documents go in as text.

## Models and credits

`models()` is `List-Available-Models` (the default first); Auto is the offline bootstrap. `usage()` is the credits
card: the plan, the email, each allowance and a running free trial.

## Not carried over from v1

Reading kiro-cli's or the Kiro IDE's own sign-in from disk (a plugin has no file access; sign in again here or use an
API key); the sign-in that listens on a local port (paste the address instead).

Permissions: `providers`, `ui` (the sign-in flow), and `net:` for Kiro's runtime, management and auth hosts in
`us-east-1` and `eu-central-1`, and AWS's OIDC host in the listed regions.

## Develop

```sh
npm install --workspaces=false --no-package-lock
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.kiro-2.1.0.tgz
```
