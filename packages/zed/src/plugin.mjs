// The hook object OpenCode / magpie load.
import { stateOf } from "./account.mjs"
import { complete } from "./complete.mjs"
import { BASE, MODELS, MODELS_TTL, NPM, PROVIDER } from "./constants.mjs"
import { entry, fetchModels, lists, model } from "./models.mjs"
import { SignInExpired } from "./refusals.mjs"
import { signIn } from "./signin.mjs"
import { usage } from "./usage.mjs"

export async function ZedAuthPlugin({ client } = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Zed",
        npm: NPM.anthropic,
        api: BASE,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, entry(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      // the models the account may call, as Zed's /models lists them now
      async models(provider, { auth } = {}) {
        const s = stateOf(auth)
        if (!s) return provider.models
        let l = lists.get(s.userId)
        if (!l || Date.now() - l.at > MODELS_TTL) {
          try {
            l = { at: Date.now(), models: await fetchModels(s) }
            lists.set(s.userId, l)
          } catch (e) {
            // Zed refusing the account's own sign-in while its list was
            // read: the built-in marked the account then (zedFetchModels →
            // ZedToken → zedLapse), so magpie is told as an answer's
            // X-Magpie-Sign-In would tell it
            if (e instanceof SignInExpired) throw Object.assign(e, { signIn: "expired" })
            if (!l) return provider.models
          }
        }
        return Object.fromEntries(l.models.map((m) => [m.id, model(m)]))
      },
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "oauth", label: "Sign in with Zed (browser)", authorize: signIn }],
      async loader(getAuth) {
        if (!stateOf(await getAuth())) return {}
        return {
          baseURL: BASE,
          apiKey: "zed", // Zed's model token is put on by the fetch below
          async fetch(input, init) {
            const s = stateOf(await getAuth())
            if (!s) throw new Error("not signed in to Zed")
            const url = input instanceof Request ? input.url : String(input)
            if (input instanceof Request) init = { method: input.method, body: await input.text(), signal: input.signal, ...init }
            return complete(s, url, init)
          },
        }
      },
      // magpie's own hook: the account's plan and its period
      async usage(getAuth) {
        const save = client?.auth?.set ? (body) => client.auth.set({ path: { id: PROVIDER }, body }) : null
        return usage(await getAuth(), save)
      },
    },
  }
}
