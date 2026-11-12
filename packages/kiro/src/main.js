// Kiro's subscriptions (kiro.dev) as an Astra v2 provider plugin.
//
// Kiro has no API the gateway speaks: it talks to its own runtime (runtime.<region>.kiro.dev/generateAssistantResponse,
// the one kiro-cli talks to) with a conversation, and answers with an AWS event stream. The models are declared on
// Anthropic's Messages; prepare turns the Messages request the gateway hands over into a Kiro conversation and points
// the host at the account's region; transformResponse (reply.js) turns the event stream the host framed back into Messages. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, crypto, definePlugin, providers } from "astra"
import { usageLimits } from "./api.js"
import { ID, runtime } from "./constants.js"
import { MODELS, hostModel, listModels } from "./models.js"
import { buildKiro, thinking } from "./request.js"
import { transformResponse } from "./reply.js"
import { rememberToolNames } from "./tools.js"
import { creds } from "./session.js"
import { usageOf } from "./usage.js"
export { signIn } from "./signin.js"

const provider = {
  async prepare(req, account) {
    if (req.protocol !== "anthropic") throw new AstraError("not_supported", `Kiro is reached on Anthropic's Messages, not ${req.protocol}`)
    if (!/\/messages$/.test(String(req.path ?? "").split("?")[0])) throw new AstraError("not_supported", `this plugin only answers Anthropic Messages requests, not ${req.path}`)
    const body = req.body && typeof req.body === "object" ? req.body : null
    if (!body) throw new AstraError("invalid_argument", "a request that isn't JSON")
    let a
    try {
      a = await creds(account)
    } catch (e) {
      throw new AstraError(e?.gone ? "permission_denied" : "unavailable", String(e?.message ?? e))
    }
    const model = String(req.model ?? body.model ?? "auto")
    rememberToolNames(body)
    const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${crypto.randomUUID().replaceAll("-", "")}`
    return {
      url: runtime(a.region) + "/generateAssistantResponse",
      method: "POST",
      headers: {
        authorization: `Bearer ${a.token}`,
        ...(a.tokenType ? { tokentype: a.tokenType } : {}),
        "content-type": "application/json",
        accept: "application/vnd.amazon.eventstream",
        "x-amzn-codewhisperer-optout": "true",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "x-amzn-kiro-agent-mode": "vibe",
        "x-amz-user-agent": ua,
        "user-agent": ua,
      },
      body: buildKiro(body, model, a.profile, thinking(body, model)),
    }
  },

  // Kiro's AWS event stream, as Messages (manifest: reply.framing aws-eventstream)
  transformResponse,

  // the account's own list, the default first
  async models(account) {
    if (!account) return MODELS.map(hostModel)
    try {
      return (await listModels(await creds(account))).map(hostModel)
    } catch {
      return MODELS.map(hostModel)
    }
  },

  // a token Kiro turned down (a 403 too): renewed, or the sign-in is gone
  async refresh(account) {
    try {
      await creds(account, { force: true })
      return "renewed"
    } catch (e) {
      return e?.gone ? "expired" : undefined
    }
  },

  // the account's credits
  async usage(account) {
    return usageOf(await usageLimits(await creds(account), true))
  },
}

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(ID, provider))
  },
})
