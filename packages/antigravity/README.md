# Antigravity plugin for Astra (`@astragate-community/antigravity-auth`)

Install: `astra plugin add @astragate-community/antigravity-auth`, or the console's Plugins page.

Signs in to a Google account the way [Antigravity](https://antigravity.google) (Google's agentic IDE) does, and makes
its requests, in OpenCode, in magpie and in Astra: the Claude, Gemini and GPT-OSS models Antigravity offers the account,
with the quota of each. Provider id: `antigravity`.

This is a fresh implementation written from how Antigravity's own client talks to Google, and from reading other
open-source clients of the same API (see `THIRD_PARTY_NOTICES.md`). It is not derived from a magpie-community plugin.

## Risk

Read this before you use the package:
- **Antigravity is for Antigravity.** Google gives its allowance for use in its own IDE and CLI. This package uses it
  from other agents, which Google hasn't approved.
- **The risk to the account is yours.** Google may suspend an Antigravity account it sees used outside Antigravity
  (the sign-in's instructions say so too). Use a Google account you can afford to lose.
- **This is a community package.** It has nothing to do with Google.

## Signing in

Two methods, both Google's own sign-in with Antigravity's OAuth client (an installed app's: its "secret" ships inside
the app) — PKCE S256, offline access, a loopback redirect:

- **Sign in on this machine**: the plugin listens on the first free one of `localhost:51121`, `8085`, `51122–51124` and
  Google's page sends the browser back to it. This is the one to use when the browser runs on the machine Astra runs on.
- **Paste the address the sign-in ends on**: for a server or a container, where the browser can't reach that port.
  Open the page anywhere; it ends on an address that fails to load, `http://localhost:51121/oauth-callback?state=…&code=…`.
  Paste that whole address (or just its `code`).

The account is named by its email, and set up as Antigravity does:

1. `loadCodeAssist` (on `cloudcode-pa.googleapis.com`) says its tier, its plan and, if it has been set up, its Google
   Cloud project.
2. An account that has none is set up with `onboardUser` on its default tier, which gives the project.

An account Google won't serve (its region, its age) gets Google's own reason as the error. A project that can't be found
at sign-in is asked for again with the first request, which then says why.

The sign-in is kept as an OpenCode `oauth` auth (`auth.json`; in magpie `plugin-auth.json`): the access and refresh
tokens, their expiry, the email, and the project, plan and tier. Google's refresh tokens don't turn over, so the refresh
token never changes; magpie renews the access token 10 minutes before its end (`auth.refresh`), OpenCode (which doesn't
call that) two minutes before a request. A token Google turns down is refreshed and the request tried once more. Only
one refresh runs at a time. A refresh token Google refuses (`invalid_grant`: revoked, or the account's password changed)
marks the account signed out; a network failure doesn't.

If Google answers with no refresh token, remove Antigravity from the account's connected apps
(myaccount.google.com/permissions) and sign in again.

## Requests

Antigravity has no API OpenCode speaks. It talks to Google's Code Assist (`cloudcode-pa.googleapis.com`), which takes a
Gemini request wrapped in an envelope — `{project, requestId, userAgent: "antigravity", requestType: "agent", model,
request}` — and streams the answer wrapped the same way (`{"response": …}`). Antigravity serves its Claude and GPT-OSS
models in Gemini's shape too, so the models are all declared on Gemini's API (`@ai-sdk/google`), and the plugin's `fetch`
does the rest. In Astra, the gateway turns whatever the agent speaks (Claude Code's Messages, OpenAI's chat or Responses,
Gemini's) into that, so the plugin only ever sees Gemini's.

The fetch:

- sends the request to `daily-cloudcode-pa.googleapis.com`, and to prod when the daily host can't answer (it didn't,
  answered 404, 408 or 5xx, or said it was busy — "Resource has been exhausted" without "capacity on this model"); the
  host that answered last goes first next time. Requests carry `antigravity/hub/<version> <os>/<arch>` as User-Agent, the
  version being the newest Antigravity's, as its updater says (`2.24.0` when it can't be asked);
- asks for a stream always — Code Assist answers one only — so a reply that isn't streamed is the stream collected;
- waits out a rate limit of 7 seconds or less once (Google says how long, in `RetryInfo`); a longer limit is answered as
  429 with `Retry-After`, for the caller to route around (another account, another model);
- answers a refusal in Gemini's error shape, with Google's own words: an account that must verify itself says where
  (`validation_url`), one Google suspended says so.

Shaping the request for Antigravity:

- **Tools**: a function's schema is cut down to the OpenAPI subset Code Assist takes (no `$ref`, unions, `format`,
  `default`, `additionalProperties`, …); it turns a request away over a keyword it doesn't know. Google's own tools
  (search, code execution) are dropped when functions are declared: Code Assist rejects the mix.
- **Conversations**: a call and its answer are paired (a Claude model by id, Gemini's by name and order); a call nobody
  answered is answered with a note, as an interrupted turn leaves one and Google then turns every later turn away; a
  history may not open or end with the model's turn; a turn of answers and a turn of words are separate for Gemini and
  one for Claude; a function's answer is read from `result`.
- **Thought signatures**: a function call the model didn't make here gets the signature Google skips the check of; a
  Claude model's calls always do, and its turns carry none of Gemini's.
- **Thinking**: Astra says how hard to think as a token budget, and Gemini 3 and later refuse one ("Use thinking level
  instead"), so it becomes the level its size is (up to 1,024 low, up to 4,096 medium, above that high; a Pro takes low
  and high only). A model whose id names a level (`gemini-3.7-flash-low`) is told that level. Gemini 2.5 keeps its
  budget. A Claude model thinks only where its id says (`claude-opus-4-6-thinking`), with room left for the answer.
- **Models listed once for each level**: Antigravity lists `gemini-3.7-flash-low`, `-medium`, `-high` and no
  `gemini-3.7-flash`, which it answers 404. A request for the family goes out as the level asked for, else high.
- **The system prompt**: Antigravity answers a prompt that reads as Claude Code's or the Claude Agent SDK's — its
  `x-anthropic-billing-header:` line, or "built on Anthropic's Claude Agent SDK" — with a 429 "Resource has been
  exhausted" whatever the quota, and lets the same words through with a zero-width space inside. The plugin puts one
  there, in the system prompt only; Claude Code and Claude Desktop work as they are, and the
  `middleware-antigravity-cloak` middleware isn't needed.
- A conversation has one session id, made from its first words, as Antigravity makes it.

## Models

Asked of Antigravity once the account is signed in (`fetchAvailableModels`, with the account's paid tier named as
Antigravity does), in the order of Antigravity's own picker, without what isn't for chat (its completion and tab
models). Each model comes with its context and output size and whether it takes images, as Antigravity says; Claude's is
250,000 here, not Anthropic's. The list is asked for at most every 5 minutes. Until it is read, and when it can't be,
a short built-in list stands in.

## Usage

The card shows one window for each family of models that shares a quota — Claude and GPT-OSS, Gemini Pro, Gemini Flash,
Gemini image — as full as the fullest model of it is, with when it resets; the plan as Google names it, and the AI
credits of a paid plan.

## Not here

- Google's **AI credits** are shown but not spent: the quota is the plan's own allowance (the `enabledCreditTypes`
  overage some clients use is not sent).
- **Gemini CLI's** sign-in, which Google serves only to Code Assist Standard and Enterprise accounts with a project of
  their own, isn't this plugin's.
- Switching accounts: the plugin doesn't; Astra's account-switch policy does, on a 429 (with its `Retry-After`) or a 401.

Not tried with a live account when this was written: it was run against a stand-in for Google's endpoints, through
Astra, and its unit tests (`npm test`).

## Building

The OAuth client values (`CLIENT_ID`, `CLIENT_SECRET`) stay out of git — the organisation's push
protection blocks them — and are baked into the built bundle at build time from
`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` (`scripts/build.mjs` reads them from the
environment; the `.env` beside the repository holds them). What the market installs carries them,
so a user sets nothing; building or packing without them says so. The tests say their own values.
