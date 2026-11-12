# WorkBuddy (Astra v2 plugin)

WorkBuddy, Tencent's desktop agent from CodeBuddy, as Astra providers. Plugin id `astragate-community.workbuddy`; it
replaces the v1 package `@astragate-community/workbuddy-auth`. One plugin, both builds:

| Provider id | Build | API |
|---|---|---|
| `workbuddy` | WorkBuddy, the China build (CodeBuddy plan) | `https://copilot.tencent.com` |
| `workbuddy-ai` | WorkBuddy AI, the international build | `https://www.workbuddy.ai` |

The provider ids are the v1 ones, so an upgrade can repoint token pools and client bindings.

## Sign in

"Add account" opens a sheet that opens WorkBuddy's own sign-in page in the browser and polls WorkBuddy for the token every
second (5 minutes at most); nothing is pasted. The account's tokens (access, refresh, expiry, uid, enterprise) are kept by
Astra as the account's credential and renewed a minute before they end and after a 401 / 403. An enterprise (team) account
sends its enterprise on every request, as WorkBuddy's client does.

Upgrading from the v1 plugin hands its browser sign-ins over once (`legacy.auth:import`). A v1 account that used
"WorkBuddy desktop's sign-in" is not carried over (see below): sign in again with the browser.

## Requests

`prepare` sends a chat to `<build>/v2/chat/completions`, or an Anthropic Messages request to `<build>/v1/messages` (the
China build's `hy3` / `hy3-x`, the only models on that route; the manifest marks them `anthropic`), with the account's
identity headers and the conversation, turn and message ids WorkBuddy's usage list groups by. Mending kept from v1:

- WorkBuddy's default system prompt when a chat has none, `developer` read as `system`, `max_completion_tokens` as `max_tokens`;
- the words WorkBuddy refuses a chat for ("illegal API invocation from an unapproved channel") rewritten, and Claude
  Code's system prompt moved into the messages on the Anthropic route;
- tools fitted to what WorkBuddy accepts (names, `\0` in patterns, tuple `items`, object roots), `tool_choice` as a string.

`models()` lists the account's own models from WorkBuddy's product config (the `cli` agent); the manifest's lists are the
offline fallback. `usage()` is the credits card (plan packages or the enterprise meter, plus when credits run out).

## Daily check-in (签到)

The "WorkBuddy check-in" page (Tools) lists the accounts with the last result and a button each. A job runs every 30
minutes and checks every account in once per Beijing day (a failure is retried after 30 minutes); the plugin's setting
"Check in automatically each day" (on) switches it off. It calls `POST /billing/meter/daily-checkin` (code 0 claimed,
10001 already done) and reads the streak from `/billing/meter/checkin-activity-status`: WorkBuddy's undocumented endpoints.

## Not carried over from v1

- **Reply handling.** A v2 provider plugin does not see the reply, so these v1 behaviours are gone: naming a mended tool
  back to the client's own name (a tool whose name WorkBuddy refuses is sent under a safe name and the model calls it by
  that name), the stream-to-JSON fold for a chat sent unstreamed (WorkBuddy answers streams only, so such a chat, e.g. a
  session-title ask, fails), and the explanatory hints appended to WorkBuddy's refusals (unapproved channel, restricted
  account, credits exhausted).
- **WorkBuddy desktop's own sign-in file** is not read (a v2 plugin has no file access).
- **Reasoning levels** (`variants`) have no place in a v2 model record; a client's own `reasoning_effort` passes through.
  The models' "free" flag and credit rate are not reported either.
- The conversation id comes from the client's session header (`x-session-id`, `x-opencode-session`, …) or the chat's first
  user message, not from magpie's session.

## Permissions

`providers`, `storage`, `secrets` (a plugin-side copy of each sign-in, which only the check-in job can read: a job gets no
account secret from the host), `ui`, `jobs`, `legacy.auth:import`, and `net:` for `copilot.tencent.com` and `www.workbuddy.ai`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # inside this directory
npm test
npm run build && npm run validate
npm run pack                                        # writes ../../out/astragate-community.workbuddy-2.0.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
