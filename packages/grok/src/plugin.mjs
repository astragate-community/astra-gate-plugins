// The hook object OpenCode / magpie load: provider config, sign-in methods, the signed fetch, models and usage.
import { BASE, LEAD_MS, NOT_SIGNED_IN, PROVIDER } from "./constants.mjs"
import { DEFAULT_MODELS, providerModels } from "./models.mjs"
import { outgoing } from "./request.mjs"
import { note } from "./ratelimit.mjs"
import { refreshAuth, remember, token } from "./session.mjs"
import { current, importCPA, signIn } from "./signin.mjs"
import { accountUsage } from "./usage.mjs"
import { kept } from "@astragate-community/plugin-kit"

export const GrokAuthPlugin = async ({ client }) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Grok (SuperGrok)",
      npm: "@ai-sdk/openai",
      api: BASE,
      models: DEFAULT_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    // magpie renews the sign-in LEAD_MS before its end (see refreshAuth). The check before each request
    // stays for OpenCode, which doesn't call this.
    refreshLead: LEAD_MS,
    refresh: refreshAuth,
    async loader(getAuth) {
      const auth = await getAuth()
      if (!auth || auth.type !== "oauth") return {}
      return {
        baseURL: BASE,
        apiKey: "grok",
        async fetch(input, init) {
          const auth = await getAuth()
          const home = auth?.refresh
          if (!home) throw new Error(NOT_SIGNED_IN)
          const req = new Request(input, init)
          const c = await token(home, false)
          await remember(client, auth, c)
          const { headers, body } = await outgoing(req, init?.body, c.key)
          // sent once, as the built-in sent it: Grok's answer goes on as
          // it came, the account kept, as the built-in never marked a Grok
          // account lapsed nor cleared one
          const res = await fetch(req.url, { ...init, method: req.method, headers, body })
          note(home, res)
          return kept(res)
        },
      }
    },
    methods: [
      {
        type: "oauth",
        label: "Sign in with Grok Build (device code)",
        authorize: signIn,
      },
      {
        type: "oauth",
        label: "Use Grok Build's current sign-in",
        authorize: current,
      },
      {
        type: "oauth",
        label: "Import CPA Grok account JSON",
        prompts: [
          {
            type: "text",
            key: "path",
            message: "Path to the CPA xAI account JSON. Stop using this account in CPA after import; its refresh token rotates.",
            placeholder: "~/.cli-proxy-api/xai-<email>.json",
            validate: (v) => (String(v ?? "").trim() ? undefined : "Enter the path to a CPA xAI account JSON file"),
          },
        ],
        authorize: importCPA,
      },
    ],
    usage: (getAuth) => accountUsage(client, getAuth),
  },

  provider: {
    id: PROVIDER,
    models: providerModels,
  },
})
