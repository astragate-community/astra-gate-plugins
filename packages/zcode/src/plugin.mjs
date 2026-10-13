// ZCode's GLM Coding Plan: the plugin as OpenCode and magpie load it.
import { MODELS, PROVIDER, ZAI_BASE } from "./constants.mjs"
import { planFetch } from "./fetch.mjs"
import { entry, modelsFor } from "./models.mjs"
import { asZCode, authorize } from "./signin.mjs"
import { SITES } from "./sites.mjs"
import { stateOf } from "./session.mjs"
import { usageOf } from "./usage.mjs"

export async function ZCodeAuthPlugin({ client }) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "zcode-auth", level: "error", message } })
    } catch {}
  }
  const oauth = (site) => ({
    type: "oauth",
    label: `ZCode: ${SITES[site].name}${site === "bigmodel" ? " (智谱)" : ""} GLM Coding Plan`,
    authorize: () => authorize(site, log),
  })
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "ZCode",
        npm: "@ai-sdk/anthropic",
        api: ZAI_BASE + "/v1",
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, entry(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      // the account's plan's models, as ZCode's config lists them now
      models: (provider, { auth } = {}) => modelsFor(provider, auth),
    },
    auth: {
      provider: PROVIDER,
      async loader(getAuth, provider) {
        const s0 = stateOf(await getAuth())
        if (!s0) return {}
        return {
          baseURL: s0.base + "/v1",
          apiKey: s0.key || "zcode", // the fetch puts the real one on
          fetch: planFetch(getAuth, client, provider?.id ?? PROVIDER),
        }
      },
      // the plan's allowance, as magpie's built-in showed it
      usage: (getAuth, provider) => usageOf(getAuth, client, provider),
      methods: [
        oauth("zai"),
        oauth("bigmodel"),
        { type: "oauth", label: "ZCode app's sign-in", authorize: async () => asZCode() },
        {
          type: "api",
          label: "GLM Coding Plan API key",
          prompts: [
            {
              type: "select",
              key: "site",
              message: "Where is the key from?",
              options: [
                { label: "Z.ai", value: "zai", hint: "api.z.ai" },
                { label: "BigModel (智谱)", value: "bigmodel", hint: "open.bigmodel.cn" },
              ],
            },
          ],
        },
      ],
    },
  }
}
