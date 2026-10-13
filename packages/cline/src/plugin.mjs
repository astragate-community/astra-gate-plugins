// The hook object OpenCode / magpie load: provider config, sign-in methods, the signed fetch, models and usage.
import { API, PROVIDER, RENEW_LEAD, SESSION } from "./constants.mjs"
import { DEFAULT_MODELS, configModel, providerModels } from "./models.mjs"
import { chatBody, chatHeaders, isOn, sessionOf, urlOf } from "./request.mjs"
import { failure, refusal, signed, signedInError, unwrapped } from "./response.mjs"
import { createSession } from "./session.mjs"
import { deviceSignIn } from "./signin.mjs"
import { accountUsage } from "./usage.mjs"

export const ClinePlugin = async ({ client } = {}, options = {}) => {
  const { fresh, renew } = createSession(client)

  return {
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return
      const session = sessionOf(input)
      if (session) output.headers[SESSION] = session
    },
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Cline",
        npm: "@ai-sdk/openai-compatible",
        api: API,
        ...was,
        models: { ...Object.fromEntries(DEFAULT_MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },

    auth: {
      provider: PROVIDER,

      // magpie renews the sign-in RENEW_LEAD before its end (see renew in
      // session.mjs); the check before each request stays for OpenCode, which
      // doesn't call this.
      refreshLead: RENEW_LEAD,
      refresh: renew,

      async loader(getAuth, provider) {
        const a = await getAuth()
        // pinUpstream: the plugin's own option, or the provider's in
        // OpenCode's config (provider.cline.options.pinUpstream)
        const pin = isOn(options?.pinUpstream) || isOn(provider?.options?.pinUpstream)
        if (a?.type !== "oauth" && a?.type !== "api") return {}
        return {
          baseURL: API,
          apiKey: "cline",
          // every chat completion as Cline's gateway takes it: OpenAI's
          // format, the account's token, Cline's own headers
          async fetch(input, init = {}) {
            const url = urlOf(input)
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return refusal({ status: 404, message: "only chat completions are served" })
            let body
            try {
              body = await chatBody(input, init, pin)
            } catch {
              return refusal({ status: 400, message: "a request that isn't a chat completion" })
            }
            let cred
            try {
              cred = await fresh(getAuth)
            } catch (e) {
              return signedInError(e)
            }
            const headers = chatHeaders(input, init, cred.bearer)
            let res
            try {
              res = await fetch(url, { ...init, method: init?.method ?? "POST", headers, body, signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) })
            } catch (e) {
              return signed(refusal({ status: 502, message: String(e?.message ?? e) }), cred.renewed)
            }
            // a renewed token cleared the lapse mark whatever the
            // request then met, a refused one included (as qoder's does):
            // the failure is reported, the mark stays off
            if (!res.ok) return signed(refusal(failure(res.status, (await res.text()).slice(0, 1 << 20))), cred.renewed)
            return signed(await unwrapped(res), cred.renewed)
          },
        }
      },

      usage: (getAuth) => accountUsage(fresh, getAuth),

      methods: [
        { type: "oauth", label: "Sign in to Cline (browser)", authorize: deviceSignIn },
        { type: "api", label: "Cline API key (app.cline.bot → Settings → API Keys)" },
      ],
    },

    provider: {
      id: PROVIDER,
      models: providerModels,
    },
  }
}
