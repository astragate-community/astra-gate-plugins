// Antigravity: the hook object OpenCode / magpie load.
import { availableModels, loadCodeAssist } from "./api.mjs"
import { BASE, GEMINI, ID, LEAD_MS } from "./constants.mjs"
import { chatFetch } from "./fetch.mjs"
import { MODELS, configModel, listModels, parseModels, runtimeModel } from "./models.mjs"
import { account, hasSignIn } from "./session.mjs"
import { browserSignIn, pasteSignIn } from "./signin.mjs"
import { usageOf } from "./usage.mjs"

export async function AntigravityAuthPlugin({ client } = {}) {
  const creds = account(client)
  return {
    auth: {
      provider: ID,
      // magpie renews a sign-in LEAD_MS before its end, once for the account, before its requests, models and usage ask
      // for it; the check before each request stays for OpenCode, which doesn't call this.
      refreshLead: LEAD_MS,
      refresh: (auth) => creds.renew(auth),
      async loader(getAuth) {
        const auth = await getAuth()
        if (!hasSignIn(auth)) return {}
        return {
          baseURL: BASE,
          apiKey: "antigravity", // the fetch signs each request itself
          // every Gemini request answered through Code Assist, Antigravity's own API
          fetch: (input, init = {}) => chatFetch(creds, getAuth, auth, input, init),
        }
      },
      // each model family's share of the quota, and the plan
      async usage(getAuth) {
        const auth = await getAuth()
        if (!hasSignIn(auth)) return { error: "not signed in", signIn: "kept" }
        try {
          const c = await creds(auth)
          const [models, load] = await Promise.all([availableModels(c.token, c.project, [c.paid, c.tier]), loadCodeAssist(c.token).catch(() => null)])
          return { ...usageOf(parseModels(models), load, auth.accountId), signIn: "kept" }
        } catch (e) {
          return { error: e.message, signIn: e?.signIn ?? "kept" }
        }
      },
      methods: [
        { type: "oauth", label: "Antigravity (Google account — sign in on this machine)", authorize: browserSignIn },
        { type: "oauth", label: "Antigravity (Google account — paste the address the sign-in ends on)", authorize: pasteSignIn },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Antigravity",
        npm: GEMINI,
        api: BASE,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, in the order of Antigravity's picker
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!hasSignIn(auth)) return provider.models
        try {
          const list = await listModels(await creds(auth))
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
  }
}
