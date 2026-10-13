// Xiaomi MiMo: the plugin, as OpenCode and magpie load it.
import { HOSTS, ID, LEAD_MS, MODELS, REGION } from "./constants.mjs"
import { createPlatform } from "./platform.mjs"
import { createRoute } from "./route.mjs"
import { createSessions } from "./session.mjs"
import { xiaomiAccount } from "./signin.mjs"
import { fromAuth } from "./store.mjs"
import { createUsage } from "./usage.mjs"

export const MimoAuthPlugin = async ({ client }) => {
  const { fresh, refresh } = createSessions(client)
  const platform = createPlatform()
  const usage = createUsage({ fresh, tokenPlan: platform.tokenPlan })
  const route = createRoute({ fresh, platform })

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Xiaomi MiMo",
        npm: "@ai-sdk/openai-compatible",
        api: HOSTS[REGION] + "/route",
        ...was,
        models: { ...MODELS, ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: ID,
      usage,
      // magpie signs the account on again LEAD_MS before the day is out,
      // once, before its requests, models and usage ask; fresh's check
      // before each request stays for OpenCode, which doesn't call this
      refreshLead: LEAD_MS,
      refresh,
      loader: async (getAuth) => {
        const a = fromAuth(await getAuth())
        if (!a) return {}
        return {
          baseURL: a.creds.base.replace(/\/+$/, "") + "/route",
          apiKey: "mimo", // the engine's placeholder; the app strips it
          fetch: (input, init) => route(getAuth, a, input, init),
        }
      },
      methods: [xiaomiAccount],
    },
  }
}
