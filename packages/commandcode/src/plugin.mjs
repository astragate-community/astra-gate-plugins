// The hook object OpenCode / magpie load
import { BASE, CHAT, ID } from "./constants.mjs"
import { signedFetch } from "./fetch.mjs"
import { saveMetadata } from "./metadata.mjs"
import { configModels, modelsOf } from "./models.mjs"
import { browserSignIn, cliSignIn, liveKey } from "./signin.mjs"
import { usage } from "./usage.mjs"

export async function CommandCodePlugin({ client } = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const key = await liveKey(auth)
        return {
          baseURL: BASE,
          apiKey: key,
          headers: { "x-api-key": key },
          fetch: signedFetch(client, getAuth, auth, auth.metadata?.plan),
        }
      },
      methods: [
        { type: "oauth", label: "Command Code (browser)", authorize: browserSignIn },
        { type: "oauth", label: "Command Code CLI's sign-in", authorize: cliSignIn },
        { type: "api", label: "API key (commandcode.ai/settings/keys)" },
      ],
      // magpie's: the plan and how much of it is used
      async usage(getAuth) {
        const auth = await getAuth()
        // signIn kept on each: the built-in's usage read never marked the
        // account lapsed nor cleared it
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in", signIn: "kept" }
        const md = auth.metadata ?? {}
        const { out, read } = await usage(await liveKey(auth), md.plan ? { id: md.planId ?? "", plan: md.plan } : undefined)
        // the plan read is saved with the key, so a start doesn't wait on
        // billing/subscriptions again, for the models, Go's endpoint or this
        if (read && (read.plan !== md.plan || read.id !== (md.planId ?? ""))) await saveMetadata(client, auth, { plan: read.plan, planId: read.id })
        return { ...out, signIn: "kept" }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Command Code Plan",
        npm: CHAT,
        api: BASE,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    provider: { id: ID, models: modelsOf },
  }
}
