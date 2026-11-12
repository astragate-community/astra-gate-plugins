# Devin (Astra v2 plugin) — account, allowance and models only

Devin subscriptions (the account the `devin` CLI uses) as an Astra provider. Plugin id `astragate-community.devin`,
provider id `devin` (the v1 id).

**This version cannot send chats.** Devin serves chat through Windsurf's `GetChatMessage`, a Connect RPC in protobuf with
an enveloped stream. Two host gaps remain as of the 2.1 provider reply transform: (1) `prepare` can return only a JSON body
(`body?: Json`), and the request must be binary protobuf; (2) the reply's framing is a Connect envelope (5-byte flag+length
header per message), which is none of `sse | ndjson | json | aws-eventstream`. `prepare` therefore still refuses every request
with an explanation instead of faking it.
For that reason the manifest has **no `replaces`**: upgrading a v1 Devin plugin to this one would repoint token pools and
client bindings onto a provider that cannot chat. Keep the v1 plugin (its sources are in `legacy-v1/`) for chat.

## What it does

- **Sign in** (a sheet from "Add account"): either the CLI's browser round (PKCE through `app.devin.ai`; a v2 plugin cannot
  listen on `127.0.0.1`, so the callback page fails to load and you paste its address back), or the session token itself
  (`windsurf_api_key` in the CLI's `credentials.toml`). The account is named as Devin names it (`GetUserStatus`: email and
  tier); a token Devin turns away is refused.
- **Allowance card**: the plan, the daily / weekly quota left, ACUs used and the extra usage balance.
- **Models**: Devin's list as of 2026-09-30 (every variant is a model of its own), with the images each takes.

Not carried over from v1: chat itself (above), reading the CLI's `credentials.toml`, running `devin models list` for the
account's live list (no file or process access), `WINDSURF_API_SERVER_URL`, and model families with effort variants.

Permissions: `providers`, `ui`, and `net:https://server.codeium.com`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # inside this directory
npm test
npm run build && npm run validate
npm run pack                                        # writes ../../out/astragate-community.devin-2.0.1.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
