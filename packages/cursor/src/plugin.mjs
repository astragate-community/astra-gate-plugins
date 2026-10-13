// The hook object OpenCode / magpie load.
import { AGENT, CHAT, DEFAULT_CONTEXT, ID, SESSION } from "./constants.mjs"
import { cursorError } from "./errors.mjs"
import { answer } from "./chat.mjs"
import { browserSignIn, cliSignIn } from "./signin.mjs"
import { tokenOf } from "./session.mjs"
import { allowance, botUsage } from "./usage.mjs"
import { planOf } from "./api.mjs"
import { sessionOf } from "./run-request.mjs"
import { runtimeModel, usable } from "./models.mjs"

export async function CursorAuthPlugin() {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || (auth.type !== "oauth" && auth.type !== "api")) return {}
        return {
          baseURL: AGENT,
          apiKey: "cursor",
          // every chat completion run on Cursor's agent API, with the
          // sign-in as it is now
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return cursorError({ status: 404, message: "only chat completions are served" })
            let chat
            try {
              const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
              chat = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
            } catch {
              return cursorError({ status: 400, message: "a request that isn't JSON" })
            }
            const session = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).get(SESSION) ?? ""
            return answer((await getAuth()) ?? auth, chat, init.signal ?? (input instanceof Request ? input.signal : undefined), session)
          },
        }
      },
      methods: [
        { type: "oauth", label: "Cursor (browser)", authorize: browserSignIn },
        { type: "oauth", label: "cursor-agent's sign-in", authorize: cliSignIn },
        { type: "api", label: "Cursor API key (cursor.com/dashboard → Integrations)" },
      ],
      // magpie's: how much of the plan's included usage is gone (the plan
      // is the one the sign-in read). The built-in's read, clean or not,
      // neither marked the account nor cleared it.
      async usage(getAuth, provider) {
        let tok
        try {
          tok = await tokenOf(await getAuth())
        } catch (e) {
          return { error: e.message, windows: [], signIn: "kept" }
        }
        const [u, plan, bot] = await Promise.all([allowance(tok, Object.keys(provider?.models ?? {})), planOf(tok), botUsage(tok)])
        // Put Bot before Total for magpie's three menu-bar rings.
        const windows = [...u.windows.filter((w) => w.name !== "Total"), ...bot, ...u.windows.filter((w) => w.name === "Total")]
        return { ...u, windows, ...(plan ? { plan } : {}), signIn: "kept" }
      },
    },
    // the session the request is part of, for the conversation_id
    // (conversationID): magpie and OpenCode name it here, and the loader's
    // fetch reads it back. Every plugin's hook sees every provider's
    // requests, so it is put on Cursor's alone.
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return
      const s = sessionOf(input)
      if (s) output.headers[SESSION] = s
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Cursor",
        npm: CHAT,
        api: AGENT,
        ...was,
        models: {
          auto: { name: "Auto", limit: { context: DEFAULT_CONTEXT, output: 0 }, attachment: true, tool_call: true },
          ...(was.models ?? {}),
        },
      }
    },
    // the account's list: each picker model once for each context size,
    // with that window
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        // a list Cursor couldn't give is a failure, not the few models
        // configured: magpie keeps the list it had
        const tok = await tokenOf(auth)
        return Object.fromEntries((await usable(tok)).map((m) => [m.id, runtimeModel(m)]))
      },
    },
  }
}
