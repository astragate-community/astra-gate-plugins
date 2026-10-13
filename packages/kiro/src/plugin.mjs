// Kiro: the hook object OpenCode / magpie load.
import { LEAD_MS, ID, BASE, MESSAGES } from "./constants.mjs"
import { usageLimits } from "./api.mjs"
import { chatFetch } from "./fetch.mjs"
import { MODELS, configModel, listModels, runtimeModel } from "./models.mjs"
import { account, hasSignIn } from "./session.mjs"
import { browserSignIn, ownSignIn } from "./signin.mjs"
import { usageOf } from "./usage.mjs"

export async function KiroAuthPlugin({ client } = {}) {
  const creds = account(client)
  return {
    auth: {
      provider: ID,
      // magpie renews a sign-in kept here LEAD_MS before its end, once for
      // the account, before its requests, models and usage ask for it; the
      // check before each request stays for OpenCode, which doesn't call
      // this. kiro-cli's and the IDE's sign-ins have no end magpie knows
      // (expires 0) and are never asked for.
      refreshLead: LEAD_MS,
      // A failure is thrown as it is, a refusal too: the built-in marked
      // no Kiro account lapsed (see gone).
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source || !auth.access || !auth.refresh) return undefined
        return creds.renew(auth)
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!hasSignIn(auth)) return {}
        return {
          baseURL: BASE,
          apiKey: "kiro", // the fetch signs each request itself
          // every Messages request answered through Kiro's own API
          fetch: (input, init = {}) => chatFetch(creds, getAuth, auth, input, init),
        }
      },
      // the account's credits, as magpie's built-in showed them; a read,
      // clean or failed, marked the built-in's account nothing
      async usage(getAuth) {
        const auth = await getAuth()
        if (!hasSignIn(auth)) return { error: "not signed in", signIn: "kept" }
        try {
          return { ...usageOf(await usageLimits(await creds(auth), true)), signIn: "kept" }
        } catch (e) {
          return { error: e.message, signIn: "kept" }
        }
      },
      methods: [
        { type: "oauth", label: "Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)", authorize: browserSignIn },
        { type: "oauth", label: "Kiro CLI's or Kiro IDE's sign-in", authorize: ownSignIn },
        { type: "api", label: "Kiro API key (ksk_…)" },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Kiro",
        npm: MESSAGES,
        api: BASE,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, the default first
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
