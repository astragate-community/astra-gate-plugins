// Devin: the plugin as OpenCode and magpie load it.
import { BASE, CHAT, ID } from "./constants.mjs"
import { dec } from "./protobuf.mjs"
import { complete, refusal } from "./response.mjs"
import { familiesFor, configModels, liveModels } from "./models.mjs"
import { imagesFor } from "./images.mjs"
import { live } from "./session.mjs"
import { browserSignIn, cliSignIn } from "./signin.mjs"
import { usage } from "./usage.mjs"

// the chat completion a request carries, undefined when it isn't JSON
async function chatOf(input, init) {
  try {
    const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
    return JSON.parse(typeof b === "string" ? b : dec.decode(b))
  } catch {
    return undefined
  }
}

export async function DevinAuthPlugin() {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          baseURL: BASE,
          apiKey: auth.key,
          async fetch(input, init = {}) {
            const now = await getAuth()
            if (now?.type !== "api" || !now.key) return refusal({ status: 401, message: "Devin isn't signed in" })
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return refusal({ status: 404, message: "only chat completions are served" })
            const chat = await chatOf(input, init)
            if (chat === undefined) return refusal({ status: 400, message: "a request that isn't JSON" })
            const { key, server } = await live(now)
            const families = await familiesFor(key, server)
            return complete({ key, server, families }, chat, init.signal)
          },
        }
      },
      methods: [
        { type: "oauth", label: "Devin (browser)", authorize: browserSignIn },
        { type: "oauth", label: "Devin CLI's sign-in", authorize: cliSignIn },
      ],
      // magpie's: the plan and how much of its quota is gone. The built-in
      // read none, so no read marks the account or clears it, not even a
      // key Devin turned away.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "Devin isn't signed in", signIn: "kept" }
        const { key, server } = await live(auth)
        return { ...(await usage(key, server)), signIn: "kept" }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Devin",
        npm: CHAT,
        api: BASE,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    // the account's list, as the devin CLI gives it, with what Devin says
    // of each model's images; with no CLI, the list it was given with that
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        const { key, server } = await live(auth)
        return liveModels(provider, key, server, await imagesFor(key, server))
      },
    },
  }
}
