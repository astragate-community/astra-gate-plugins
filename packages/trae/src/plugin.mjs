// Trae: the hook object OpenCode / magpie load, for one realm.
import { LEAD_MS, SESSION } from "./constants.mjs"
import { createChat } from "./chat.mjs"
import { Expired } from "./errors.mjs"
import { createCatalog } from "./models.mjs"
import { createSessions, fromAuth } from "./session.mjs"
import { browserSignIn } from "./signin.mjs"
import { SITES } from "./sites.mjs"
import { readUsage } from "./usage.mjs"

const makePlugin = (site) => async ({ client }) => {
  const sessions = createSessions(site, client)
  const catalog = createCatalog(site)
  const chatFetch = createChat(site, sessions, catalog)

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[site.id] ?? {}
      config.provider[site.id] = {
        name: site.name,
        npm: "@ai-sdk/openai-compatible",
        api: site.hosts.api + "/v1",
        ...was,
        models: { ...site.models, ...(was.models ?? {}) },
      }
    },
    // the conversation's id, which the requests below carry as their
    // session_id: magpie's (or OpenCode's) session for this request, when it
    // names one
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== site.id || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },
    provider: {
      id: site.id,
      // the account's own list, when Trae answers; else the list above
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !auth.access) return provider.models
        try {
          const ms = await catalog.live(await sessions.fresh(async () => auth))
          if (!ms.length) return provider.models
          return catalog.models(provider, ms)
        } catch (e) {
          if (e instanceof Expired) throw e
          return provider.models
        }
      },
    },
    auth: {
      provider: site.id,
      usage: (getAuth) => readUsage(site, sessions, getAuth),
      // magpie renews the token LEAD_MS before its end, once, before its
      // requests, models and usage ask; the check before each request
      // stays for OpenCode, which doesn't call this
      refreshLead: LEAD_MS,
      refresh: sessions.refresh,
      loader: async (getAuth) => {
        const a0 = fromAuth(await getAuth(), site)
        if (!a0) return {}
        return {
          baseURL: site.apiOf(a0) + "/v1",
          apiKey: "trae", // the engine's placeholder; the request carries the JWT
          fetch: (input, init) => chatFetch(getAuth, a0, input, init),
        }
      },
      methods: [{ type: "oauth", label: `${site.name} account (browser)`, authorize: () => browserSignIn(site) }],
    },
  }
}

export const TraeCNAuthPlugin = makePlugin(SITES["trae-cn"])
export const TraeGlobalAuthPlugin = makePlugin(SITES["trae-global"])
