// MiniMax Code: the plugin for one site, as OpenCode and magpie load it.
import { randomUUID } from "node:crypto"
import { LEAD_MS, NPM, chatBase } from "./constants.mjs"
import { configModels, liveModels, modelOf } from "./models.mjs"
import { SignInExpired, freshOf, latest, renew, saverOf, signedOut } from "./session.mjs"
import { signInMethod } from "./signin.mjs"
import { loaderOf } from "./request.mjs"
import { usageHookOf } from "./usage.mjs"

export function makePlugin(site) {
  return async ({ client }) => {
    const fresh = freshOf(site, saverOf(site, client))

    // one conversation id for requests that come with none of their own
    const session = randomUUID()

    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const p = config.provider[site.id]
        p.name ??= site.name
        p.npm ??= NPM
        p.api ??= chatBase(site)
        p.models = { ...configModels(), ...(p.models ?? {}) }
      },
      // the conversation's id, which MiniMax Code sends with each request
      "chat.headers": async (input, output) => {
        const id = input?.model?.providerID ?? input?.provider?.info?.id
        if (id !== site.id || !input?.sessionID) return
        output.headers["X-Mavis-Session-Id"] = input.sessionID
      },
      provider: {
        id: site.id,
        // MiniMax Code's live list, when it answers; else the built-in one
        async models(provider, { auth }) {
          if (auth?.type !== "oauth" || !auth.access) return provider.models
          try {
            const { a } = await fresh(async () => auth)
            const ms = await liveModels(site, a.access)
            if (!ms.length) return provider.models
            return Object.fromEntries(ms.map((m) => [m.id, modelOf(site, provider, m)]))
          } catch (e) {
            if (e instanceof SignInExpired) throw e
            return provider.models
          }
        },
      },
      auth: {
        provider: site.id,
        // magpie renews the sign-in LEAD_MS before its end, once for the
        // account, before its requests, models and usage ask for it; the
        // check before each request stays for OpenCode, which
        // doesn't call this
        refreshLead: LEAD_MS,
        async refresh(auth) {
          if (auth?.type !== "oauth" || !auth.access || !auth.refresh) return undefined
          const a = latest(site, auth)
          // renewed here already, the store not yet saying so
          if (a.access !== auth.access && Date.now() < a.expires - LEAD_MS) return { access: a.access, refresh: a.refresh, expires: a.expires }
          try {
            // magpie saves what this gives
            return await renew(site, a, async () => true)
          } catch (e) {
            if (signedOut(e)) throw new SignInExpired(site)
            throw e
          }
        },
        loader: loaderOf(site, fresh, session),
        usage: usageHookOf(site, fresh),
        methods: [signInMethod(site)],
      },
    }
  }
}
