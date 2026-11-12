# Trae (Astra v2 plugin)

Trae CN (trae.cn, ByteDance's AI IDE) and Trae international (trae.ai) as two Astra providers, `trae-cn` and
`trae-global`. Plugin id `astragate-community.trae`. It replaces the v1 package `@astragate-community/trae-auth`
(the provider ids are unchanged, so Astra can repoint pools and client bindings on upgrade).

> **Experimental.** Chat goes through Trae's IDE agent (`/api/agent/v3/llm_utils_chat`) and its own SSE events
> (`output`, `token_usage`, `done`, ...) are turned into an OpenAI chat reply by the provider's reply transform. The
> protocol was worked out from two open-source relays and the v1 plugin; it is covered by tests with captured-shape
> fixtures and has **not been run against a real Trae CN or Trae Global account**.

## Chat

`prepare` renews the token if it is near its end, picks the chat function that lists the model (`chat_v3`, then
`solo_work_lite`, `solo_agent`, `solo_agent_lite`), puts in the model's `__dev` name, reply limit and, for a `-max`
model, its `__max` name and window, and sends the conversation as the IDE does: text only, the tools both natively and
in a system prompt that asks for each call as a `<tool_call>` block, earlier calls and their results as text. The
conversation's `session_id` is derived from its first user message and the account, so one conversation is counted as
one by Trae. The manifest's `reply: { framing: "sse", output: "chat" }` and `transformResponse` do the rest: reasoning,
text, native and text-written tool calls (JSON, GLM and DeepSeek DSML forms, repaired when slightly broken), token counts
and the finish reason, as chunks for a stream or one body for a non-streaming request. An error event or refusal becomes
a status (401 sign-in lapsed, so the host asks the plugin's renewal; 429 allowance spent; otherwise 502 / Trae's own).

Differences from v1: v1 retried a model through the other chat functions inside one request when Trae said the function
does not take it; v2 remembers the refusal and the next request (the host's failover retry) asks another function. A
mid-stream error ends the connection with an error instead of an error chunk and `[DONE]`. The request's tool names (to
write a call's name as the request spells it) reach the reply only through a per-account-and-model memory, because the
reply transform sees the reply, not the request.

## Sign in

Provider page, "Add account". The flow has two steps:

1. Press the button: the realm's authorization page (`www.trae.cn/authorization` or `www.trae.ai/authorization`, the
   IDE's own client) opens. Sign in and allow it. The v1 plugin also offered Trae's enterprise (SaaS / SSO) sign-in on that page; so does this one.
2. The page then sends the browser to `http://127.0.0.1:58472/authorize?...`. A plugin cannot listen on a port, so that
   page fails to load; that is expected. Copy the whole address from the address bar and paste it into the form. It
   carries the account's Cloud-IDE-JWT and refresh token, so treat it like a password.

At sign-in the plugin creates the account's device (`device_id`, 19 digits, and `machine_id`, 32 hex), names it to the
authorization page and sends the same one with every request. The sign-in is kept in the plugin's secrets
(`auth:<provider>:<account key>`), never on the account row.

An account of one realm does not sign in to the other.

## Models

The account's own list, from `/api/ide/v1/batch_get_detail_param` (every chat function's list in one ask) or, when that
gives none, `get_detail_param` per function. The lists are merged: SOLO and the TRAE agent list models `chat_v3`
doesn't, a model several functions list takes the entry that names a `__dev` model and the name most lists agree on,
helpers (`usage` other than `chat_completion`), switched-off configs and custom-model slots are left out, and Trae
Global's picker-hidden entries too. Context is `context_window_tokens.dev`, output the `__dev` model's `max_tokens`; a
model with a bigger Max window is listed again as `<id>-max`. Without a readable list the realm's fallback list is used
(the manifest's models are the same list).

## Renewal

The JWT is renewed two minutes before its end, and after an upstream 401/403, at the realm's auth host
(`api.trae.cn`, `growsg-normal.trae.ai`) `/cloudide/api/v3/trae/oauth/ExchangeToken`. Trae issues a new refresh token
each time and spends the old one, so only one renewal runs at a time per refresh token and the new pair is stored at
once. A refused refresh token marks the account for a new sign-in; so does a 401 or code 1001 (both realms) / 20101
(Global) from a model list or usage call.

## Usage

The account card shows the plan and allowance: Trae CN's credits page (`api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`,
one Credits window) or Trae Global's dollar billing (`user_current_entitlement_list` on `api-sg-central.trae.ai`, or
`api-us-east.trae.ai` for a US account, one Dollar Usage window). The international realm's SG / US region comes from
the sign-in (`AIRegion`, or a US host it names).

## Daily check-in (Trae CN only)

Setting "Daily check-in (Trae CN)", off by default. A job runs every six hours and, once a day (Beijing time) for each
signed-in account, asks `/trae/api/v2/ug/checkin_credits/status` and claims when it is on and today's is not in, with
the headers Trae CN's IDE sends a growth page and a client's User-Agent. Code 9095 means this device checked in today.
Trae CN answered a token that is not bound to its device with 9074 (too many users): see the porting notes below.

## Not carried over from v1

- **Device-bound renewal.** v1 renewed a CN token bound to the account's device with an ECDSA P-256 `DeviceProof`. The
  sandbox can sign (`crypto.sign`) but cannot generate a key pair or derive the public half from a private key, and the
  device key was made locally at sign-in, so only the `/cloudide/` renewal is used (which v1 also fell back to). That
  token carries no device, so the daily check-in may answer 9074.
- **Local callback listener.** The pasted address replaces it (above).
- **Enterprise hosts.** A tenant's own model or token host (a `trae.cn` / `trae.ai` / `mchost.guru` host the sign-in
  names) cannot be reached, since a v2 plugin may call only the origins its manifest lists; such an account uses the
  consumer hosts.
- **Session header and `config` hook** (the session id is derived from the conversation instead).

## Permissions

`providers`, `storage` (the check-in day), `secrets` (the sign-ins), `ui` (the sign-in flow), `jobs` (the check-in) and
`net:` for `api.trae.cn`, `trae-api-cn.mchost.guru`, `growsg-normal.trae.ai`, `coresg-normal.trae.ai`,
`coreva-normal.trae.ai`, `api-sg-central.trae.ai` and `api-us-east.trae.ai`. The authorization pages are opened in the
browser, not fetched.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency
npm test
npm run build && npm run validate
npm run pack   # writes ../../out/astragate-community.trae-2.1.0.tgz
```

Layout: `src/main.js` (providers, sign-in views, check-in job), `sites.js` (the realms' tables), `values.js` /
`errors.js`, `api.js` (the IDE's headers, renewal, model lists), `session.js` (the stored sign-in, device, renewal),
`signin.js`, `models.js`, `usage.js`, `checkin.js`, and the chat: `request.js` (the IDE agent's body), `reply.js` + `parts.js`
(the reply transform), `tools.js`, `text-tools.js`, `call-syntax.js`, `json-repair.js`, `native-calls.js` (tool calls); `locales/{en,zh}.json`; `assets/icon.svg`.

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
