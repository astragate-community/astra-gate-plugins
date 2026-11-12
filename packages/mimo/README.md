# Xiaomi MiMo (Astra v2 plugin)

Xiaomi MiMo as an Astra provider: a Xiaomi account (the app's `/route`, with its Token Plan as the fallback) or a **Token Plan** key. Plugin id `astragate-community.mimo`, provider id `mimo-app`. It replaces
the v1 package `@astragate-community/mimo-auth`.

## Two kinds of account

Press "Add account" on the provider's page:

- **Xiaomi account** (as v1). The page opens account.xiaomi.com's sign-in (or scan its QR code with the Xiaomi app); the
  plugin asks the page's long poll in slices of about 35 seconds (a view action has a wall-clock limit; "I signed in, keep
  waiting" asks again) and, once Xiaomi says the account is in, signs it on at the MiMo server as the app's window does:
  the server's `/user/xiaomi/me` sends the browser to `account.xiaomi.com/pass/serviceLogin`, which (holding the account's
  `passToken`) sends it back through the server's `/sts`, where the session cookies are set. Every hop is a `http.fetch`
  with `redirect: 'manual'`, the plugin's own cookie jar and the `cookie` header; an `http://` followup on the server's own
  host is asked over `https://`. An account of another region is moved to that region's server. The account's secret holds
  the Xiaomi account (`passToken`, ids) and the MiMo session's cookies; the session is signed on again after a day (the
  app's rule), on a request when it is due, and on a 401. Xiaomi no longer taking the `passToken` marks the account expired.
- **Token Plan key** (`tp-…`). Paste the key from the Token Plan page of the open platform and pick its region (below).

## Requests

A Xiaomi account sends Chat Completions to the app's `<server>/route` with the session's cookies, `x-mimo-source`,
`x-client-version` and the app's user agent; `mimo-auto` is asked as `mimo-pro`. When the app answers `membership_required`
(403) the host asks the plugin's `refresh`, which reads the account's Token Plan from the open platform (the same Xiaomi
account signs on there too: `/api/v1/tokenPlan/detail`, `apiKey`, `apiKey/raw`) and, if there is one, sends this account's
requests to the plan from then on (for an hour), as v1 did: at its `token-plan-<region>` endpoint with its `tp-` key and the
plan's model names. The host then sends the refused request again. A key the plan turns away (401) is read again.
`prepare` has five seconds in all, so it signs on again or reads the platform only within 3.5 seconds; the slower reads
happen in `refresh` and the usage card, which have thirty.

A Token Plan key account sends Chat Completions to `https://token-plan-<region>.xiaomimimo.com/v1/chat/completions` with
`Authorization: Bearer <key>`. `mimo-auto` is asked as `mimo-pro`, `mimo-pro` as `mimo-v2.6-pro` and `mimo-flash` as
`mimo-v2.6-flash`; any other model name passes as it is. Regions: `cn` is the endpoint v1's documentation showed; `sgp`,
`ru` and `in` follow the MiMo servers' region names and are untested here. A key the plan turns away marks the account expired.

## The usage card

For a Xiaomi account: the app's plan in force and its end (`/user/xiaomi/subscription/self`), the week's allowance
(`/user/usage`), and the platform's Token Plan beside it (the plan itself, with no app plan; its credits as an aside with
one). No plan at all is MiMo's free offer. (The host does not call a provider's `usage` yet; the card is built and tested,
and shows once it does.)

## Models

| Model | Name | Context | Output | Input |
|---|---|---|---|---|
| `mimo-pro` | MiMo Pro | 1,000,000 | 128,000 | text, image |
| `mimo-flash` | MiMo Flash | 1,000,000 | 128,000 | text, image |

## Not carried over from v1

- Reading the `tp-` key of a Token Plan *key* account from the platform: you paste it. (A Xiaomi account reads it by itself.)
- Reply marking (`X-Magpie-Sign-In`): Astra decides from `refresh`'s answer instead.
- A server error while signing on is a hiccup here (the session in hand goes on), where v1 read any non-JSON answer as a
  lapsed passToken.
- Untested against the live service: the sign-on was written from v1's source and checked against a fake of Xiaomi's
  redirects, not run against account.xiaomi.com.

Permissions: `providers`, `ui` (the add-account flow) and `net:` for the four Token Plan hosts, `account.xiaomi.com`, the three
`mimo-server-<region>` hosts and `platform.xiaomimimo.com`. Origins are exact: a redirect to any other host fails.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # in this directory
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.mimo-2.1.0.tgz
```

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
