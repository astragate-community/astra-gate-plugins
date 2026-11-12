# ZCode (Astra v2 plugin)

Z.ai's and BigModel's (智谱) GLM Coding Plan, the way [ZCode](https://zcode.z.ai) uses it, as an Astra provider. Plugin id
`astragate-community.zcode`, provider id `zcode` (unchanged from v1, so upgrades can repoint pools). It replaces the v1
package `@astragate-community/zcode-auth`. The GLM models are served over Anthropic Messages.

## Signing in

Open the provider's page and add an account; the sign-in flow offers three ways:

- **Z.ai** or **BigModel (智谱)**: zcode.z.ai opens a sign-in flow, the browser signs in, and the flow polls until it is done.
  With that sign-in the plugin takes the key named `zcode-api-key` from the account's default project (making it if it isn't
  there), as ZCode does. With no plan of its own it looks for a seat on a team's plan and uses that project's
  `zcode-team-api-key`; failing both it uses ZCode's free **Start Plan** with ZCode's session token (which cannot be renewed:
  sign in again when it runs out).
- **A GLM Coding Plan API key** (`<id>.<secret>`) and the site it is from.

The account's sign-in is kept as the account's host-held secret (encrypted by Astra), never in plugin storage.

## Requests

`prepare` decides where each request goes, and the host sends it:

- the **coding plan**: the plan's own endpoint with the key as both `x-api-key` and `Authorization: Bearer`;
- a **team seat**: the same with the seat's key (made, and kept, on first use);
- the **Start Plan**: zcode.z.ai only serves what looks like ZCode's own request, so the request goes with ZCode's headers,
  ZCode's system prompt ahead of the agent's, the environment, powered-by line and the day as `<system-reminder>` turns, and the
  sign-in's device id in `metadata.user_id`.

Which plan an account is on is read from `/api/biz/subscription/list` and kept for 10 minutes (a minute when unsure).

**The gift's trial entries.** An account with a coding plan can also hold gift plans from ZCode activities. Every model a live
gift bucket serves is listed again as `<model>-Trial` (GLM-5.3-Flash-Trial); asking a trial entry sends the model to the gift,
dressed as ZCode's own, and asking the plain model spends the coding plan. A trial entry whose bucket is spent, or that the gift
does not have, is refused before a request goes out.

**The gift's refusals.** The manifest declares `reply: { framing: ndjson, output: anthropic }` and `transformResponse` reads what a
`-Trial` request gets back, as v1 did: a spent bucket's quota error (code 1113 "Insufficient balance or no resource package",
1005 "exceed quota limit", even inside an HTTP 200 JSON body) becomes a 429, and keeps that entry off for a minute (prepare
refuses it meanwhile). Any other gift answer goes on as sent, so the coding plan is not spent behind the user's back; every
429 counts as spent. Only `-Trial` requests are judged. The framing is `ndjson` on purpose: a 200 JSON body has to reach the
plugin, and an `sse` reader would pass it as a stream with no events. ZCode's one-line `event:` / `data:` pairs come as lines
and the plugin puts them back together (a multi-line `data:` event would not survive; Anthropic's are one line).

## Models

The list is ZCode's provider config for the account's plan (read from zcode.z.ai, kept 10 minutes). The config's file sits on a
host of ZCode's choosing; a v2 plugin may fetch it only when its `net:` permissions name that origin, so without a grant the
built-in table stands in: GLM-5.3, GLM-5.3-Flash, GLM-5.2 and GLM-5-Turbo (1M context, 128K output; the Start Plan has all but
GLM-5.3). A gift-only account also lists every model its gift serves under the model's own name.

## The usage card

The coding plan's windows and term, a team seat's windows and plan end, or the Start Plan's buckets; an account with both shows
both allowances, the gift's after the coding plan's. Gift plans ZCode holds but has not granted are named on the card (set aside,
stopping nothing) and are claimed in the ZCode app. A failed gift read leaves just the coding card.

## Not carried over from v1

- **"ZCode app's sign-in"**: it read ZCode's own encrypted credential store (`~/.zcode/v2`); a v2 plugin has no file access.
  Sign in with Z.ai or BigModel instead.
- **A newer provider config from an installed ZCode** (`~/.zcode`, `/Applications/ZCode.app`): no file access.
- **Reasoning-effort variants** (`none` / `high` thinking budgets per model): a v2 model record has no variants.
- **The machine's details in the Start Plan request**: the shell and OS version lines are left out of the environment block, the
  platform comes from Astra's host (the architecture is assumed arm64 on macOS, x64 elsewhere), the locale and time zone are
  those of the console the sign-in was made in, and the agent's working directory is passed on only if the host sends
  `x-magpie-work-dir` / `x-magpie-work-git` (Astra's gateway does not today). Whether zcode.z.ai still accepts such a request is
  not something this plugin can promise.

Permissions: `providers`, `storage`, `ui` (the sign-in flow) and `net:` for `zcode.z.ai`, `api.z.ai`, `bigmodel.cn` and
`open.bigmodel.cn`.

## Develop

```sh
npm install --workspaces=false --no-package-lock
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.zcode-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
