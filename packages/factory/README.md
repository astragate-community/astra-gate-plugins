# Factory (Astra v2 plugin)

A Factory (Droid) subscription as an Astra provider. Plugin id `astragate-community.factory`, provider id `factory`.
It replaces the v1 package `@astragate-community/factory-auth` (an upgrade hands over the v1 sign-ins and repoints
token pools and client bindings to the new provider).

## Sign-in

Open the provider's page and press "Add account":

- **Device code.** WorkOS's device flow under droid's own client: the page opens Factory with the code filled in,
  confirm it there and the flow finishes by itself. A token that names no organization is put in the first one your
  account belongs to, and `whoami` says which organization is active and where it is served (EU organizations go to
  `api.eu.factory.ai`).
- **API key (`fk-…`).** As droid takes one from `FACTORY_API_KEY`: sent as the bearer token with droid's headers and
  never renewed. `whoami`, asked once with the key, says whose it is and where its organization is served.

An account's tokens are one secret the host keeps for it. WorkOS rotates the refresh token, so renewals run one at a
time and the new pair is saved before the request goes on. The account is marked expired only when WorkOS refuses the
refresh token (a 4xx other than 429); any other failure goes on with the token while it lasts.

## Models

33 models, each on the API droid uses for it: Anthropic Messages (`/api/llm/a/v1`) for the Claude models and
MiniMax M2.7, OpenAI Responses (`/api/llm/o/v1`) for GPT and Grok, chat completions (`/api/llm/o/v1`) for the open
models. Gemini (a route of Factory's own) and `auto` (picked by droid on the client side) are left out.

## Requests

`prepare` sends each request to the Factory API of the account's region with droid's client headers, one session id
and the organization header. Another agent's request opens as droid's does: on the OpenAI routes the system prompt
(Responses' `instructions`, chat's first system message) starts with "You are Droid, an AI software engineering agent
built by Factory."; on the Anthropic route Claude Code's fixed client metadata (identity line, environment and model
reminders, compaction openings, restored files, skill lists, quoted tool output) is reworded or quoted losslessly as
Factory requires, keeping instructions, tools, images and history. `pi`'s opening sentence and compaction summary are
reworded too. A streamed Anthropic request is sent without `context_management`, which Factory's streaming route
refuses.

`refresh` runs after Factory refused a request: it renews a token that was not just renewed, asks `whoami` again (an
organization the account can no longer reach is dropped), and puts a token that names no organization in the first
one it lists. `usage` shows the plan's 5-hour, weekly and monthly windows, Droid Core's own windows and the extra
usage balance.

## Replies

The manifest declares `reply: { framing: ndjson, output: anthropic }`; the plugin's `transformResponse` does what the v1
plugin did on the way back:

- **Wrapped tools.** Factory's Anthropic route rejects a tool schema with a root `anyOf` / `oneOf` / `allOf`, so `prepare`
  keeps such a schema under one `arguments` property (and wraps the `input` of that tool's earlier calls in the history),
  and the reply unwraps the arguments again, in a JSON message and in a stream (the tool's argument events are held back
  until its block ends, then go out as one delta). A call that does not carry the wrapper fails the stream with a 502.
- **403.** A refused request is worded as v1 did, the vendor's message and then what to do about it. The host's `refresh`
  hook now sees that refusal: an organization Factory says is not accessible is dropped (whoami is asked again; if it names
  the refused one, none is sent), a 403 about something else is left alone when an organization was sent, and a 403 to an
  account that sent none asks whoami for one. A `renewed` answer keeps the account; whether the request is then retried is the host's failover's call.
- Chat, Responses and Anthropic replies are otherwise passed on event for event, streamed or one JSON body.

Why `ndjson`: the framing is one per provider, and this provider speaks three protocols, as streams and as plain JSON
bodies; an `sse` reader would swallow a JSON body as a stream with no events. The plugin takes the lines and puts the
`event:` / `data:` pairs back together itself (a `data:` event spanning several lines would not survive; these APIs do not
write one).

Host limit, handled as well as it can be: the reply side is not told which tools were wrapped. `prepare` leaves the
names in the plugin's memory per model (15 minutes); a tool of such a name is unwrapped only when its input is exactly
`{ "arguments": … }`. After a plugin reload the reply of a request already in flight is not unwrapped.

## Not carried over from v1

- Reasoning effort variants (`none` … `max` per model) are not offered: the manifest's model records carry no variant list.
- An organization served from a host of its own (`premBaseHostV2`) is refused with an explanation: the manifest's
  `net:` permissions name Factory's public hosts only.
- The sign-in is not saved under OpenCode's `auth.json`; Astra keeps it as the account's secret.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # inside this directory
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.factory-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
