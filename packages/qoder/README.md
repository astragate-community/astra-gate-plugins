# Qoder (Astra v2 plugin)

[Qoder](https://qoder.com) and Qoder CN ([qoder.cn](https://qoder.cn)) subscriptions as Astra providers. Plugin id
`astragate-community.qoder`, provider ids `qoder` and `qoder-cn`. It replaces the v1 package
`@astragate-community/qoder-auth`. The protocol (endpoints, COSY envelope, device flow) is ported from magpie's
`internal/qoder`, which ported it from CLIProxyAPI's Qoder support (MIT, see `LICENSE-CLIProxyAPI`). Based on an
MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).

## Use

Install the plugin, open the provider's page and press "Add account": the flow opens the site's device page, you authorize
this device in the browser, and the flow polls Qoder for the device token (in slices of about 40 seconds: press "I have signed
in" if the wait ends first), trades it for the job token the model calls use and adds the account. Qoder CN, whose CLI never
makes a job token, chats on the device token when qoder.cn refuses to trade it. Tokens renew themselves (a refresh token is
spent once, so the new pair is saved at once, under a lock), and a refused chat triggers the plugin's `refresh`.

## Requests

`prepare` takes the gateway's chat completion, finds the model in the account's own listing (signed `model/list`, cached while
the plugin runs, asked again for an unknown model), writes it as Qoder's `agent_chat_generation` body (system text, tools,
tool results with images, thinking effort fitted to what the model offers, the context window grown only when the
conversation needs it) and signs it with the COSY envelope: `crypto.aes` (CBC) for the account blob, `crypto.rsa` (PKCS#1
v1.5, Qoder's embedded key) for the wrapped key, `crypto.digest('md5')` for the signature.

The signature covers the body's bytes, and the host writes the body a plugin returns itself (System.Text.Json's default
escaping). The plugin therefore signs `hostJson(body)`, a serializer that reproduces that escaping (pinned by a test against
the host's own output), not `JSON.stringify`.

## The reply

Qoder always streams an SSE whose lines are an envelope `{ statusCodeValue, body }`, the body being an OpenAI chunk as a
string. The provider declares `reply: { framing: "sse", output: "chat" }`: the host frames the SSE and `transformResponse`
unwraps each envelope into chat chunks. Tool calls Qoder writes as XML or JSON in its text (`<tool_call>…</tool_call>`) are
lifted out as tool calls (held back across frames until a whole block has come); native `tool_calls` keep Qoder's ids;
`reasoning_content` is passed on; the usage chunk that follows the finish is carried into the last chunk. A non-streaming
request gets one gathered `chat.completion`. Failures are read as Qoder's client reads them: an error envelope or a refused
reply with code 10605/queued is a 503, a quota code a 429, a refused request (406, 416, …) a 400; a bare 401/403 is passed on
so the host's refresh and failover see it.

## Not carried over from v1, and why

- **Encoded request bodies.** v1 sent `Encode=1` and a body in Qoder's own codec (a shuffled base64 alphabet), which is not
  JSON; a v2 `prepare` can only return a JSON body. This plugin leaves `Encode` off and sends the plain JSON, with the
  signature computed over exactly those bytes. **Whether Qoder's gateway accepts the unencoded form is not verified**: that
  was never tried against the live service. If it does not, requests fail upstream (a 4xx the gateway shows) and the fix needs
  a host feature that lets `prepare` return a text body. The model list keeps `Encode=1` as v1 did (its body is empty).
- **Enterprise VPC sign-in (Qoder CN).** An instance's own hosts (`<name>-openapi.vpc.qoder.com.cn`, …) differ per account and
  `net:` permissions are fixed origins (one per `{config.x}` setting), so they cannot be reached.
- **Per-model effort variants.** v1 registered an effort variant for each model; a v2 model record has none. The effort a
  client asks for (`reasoning_effort`) is still fitted to what the model offers.
- **Usage and the campaign pages** (`usage` percentages, the claim-a-promotion pages): the host does not call `usage` yet, and
  the campaign pages were an OpenCode-only fetch interception with no v2 surface.
- **Price and "free" marks** (`rate`, `rateWas`, `free`) of the model list: v2 model records have no such fields. The reading
  of them is kept in `src/models.js` (tested), unused by the host for now.
- **The machine's architecture** in the `Cosy-MachineOS` header: the sandbox knows the platform, not the CPU, so `x86_64` is
  always named.
- **The `retryAfter`** of a queued model: only a status and a message reach the gateway, so "try again in Ns" is in the message.

Permissions: `providers`, `ui` (the sign-in flow) and `net:` for `api3.qoder.sh`, `openapi.qoder.sh`, `gateway.qoder.com.cn`
and `openapi.qoder.com.cn`.

## Develop

```sh
npm install --workspaces=false --no-package-lock   # in this directory
npm test
npm run build && npm run validate
npm run pack   # writes out/astragate-community.qoder-2.1.0.tgz
```
