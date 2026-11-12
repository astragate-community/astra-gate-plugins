// Antigravity (Google's agentic IDE) on your own Google account, as an Astra v2 provider plugin.
//
// An account is signed in the way Antigravity signs in (Google's page, Antigravity's own OAuth client; see signin.js).
// Antigravity has no API the gateway speaks: it talks to Google's Code Assist (cloudcode-pa.googleapis.com), which takes
// a Gemini request wrapped in an envelope of its own — the account's project, the app's name. prepare shapes the Gemini
// request the gateway hands over, wraps it and points the host at Code Assist's streaming method.
//
// Google may suspend an account it sees used outside Antigravity: see the README.
import { AstraError, definePlugin, providers, storage } from "astra"
import { availableModels, loadCodeAssist } from "./api.js"
import { agentVersion, userAgent } from "./client.js"
import { DAILY, ID } from "./constants.js"
import { MODELS, hostModel, knownFor, listModels, parseModels, remember } from "./models.js"
import { transformResponse } from "./reply.js"
import { envelope, shape } from "./request.js"
import { creds } from "./session.js"
import { usageOf } from "./usage.js"
export { signIn } from "./signin.js"

const actionOf = (path) => /:(\w+)(?:\?|$)/.exec(String(path ?? ""))?.[1] ?? ""

// the ids of an account's models, kept so a restarted engine still knows which ids are variants of a family
async function known(project) {
  const held = knownFor(project)
  if (held) return held
  const ids = await storage.get("known:" + project)
  if (Array.isArray(ids) && ids.length) return new Set(ids)
  return undefined
}

const provider = {
  async prepare(req, account) {
    if (req.protocol !== "gemini") throw new AstraError("not_supported", `Antigravity is reached on Gemini's protocol, not ${req.protocol}`)
    const action = actionOf(req.path)
    if (action && action !== "generateContent" && action !== "streamGenerateContent")
      throw new AstraError("not_supported", `Antigravity doesn't answer ${action}`)
    const body = req.body && typeof req.body === "object" ? req.body : null
    if (!body) throw new AstraError("invalid_argument", "a request that isn't JSON")
    let cur
    try {
      cur = await creds(account)
    } catch (e) {
      throw new AstraError(e?.gone ? "permission_denied" : "unavailable", String(e?.message ?? e))
    }
    const version = await agentVersion()
    const wrapped = envelope(shape(body, req.model ?? "", { known: await known(cur.project) }), cur.project)
    return {
      // Code Assist answers a stream only
      url: `${DAILY}/v1internal:streamGenerateContent?alt=sse`,
      method: "POST",
      headers: { authorization: "Bearer " + cur.token, "user-agent": userAgent(version), "content-type": "application/json" },
      body: wrapped,
    }
  },

  // Code Assist's {"response": …} stream, as Gemini's (manifest: reply.framing sse)
  transformResponse,

  async models(account) {
    if (!account) return MODELS.map(hostModel)
    try {
      const c = await creds(account)
      const list = await listModels(c)
      await storage.set("known:" + c.project, list.map((m) => m.id))
      return list.map(hostModel)
    } catch {
      return MODELS.map(hostModel)
    }
  },

  // a token Google turned down: renewed (the request is tried again), or the sign-in is gone
  async refresh(account) {
    try {
      await creds(account, { force: true })
      return "renewed"
    } catch (e) {
      return e?.gone ? "expired" : undefined
    }
  },

  // each model family's share of the quota, and the plan
  async usage(account) {
    const c = await creds(account)
    const [models, load] = await Promise.all([availableModels(c.token, c.project, [c.paid, c.tier]), loadCodeAssist(c.token).catch(() => null)])
    const list = parseModels(models)
    remember(c.project, list)
    const who = (await providers.accounts.list(ID)).find((a) => a.key === account.key)?.email
    return usageOf(list, load, who ?? undefined)
  },
}

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(ID, provider))
  },
})
