// Factory (Droid) subscriptions for OpenCode and magpie: WorkOS's device
// flow under droid's client, as `droid` signs in, and each model request
// sent to Factory's API with the headers droid sends. Ported from magpie's
// built-in Factory account (internal/provider/factory*.go).
import { MAGPIE_LEAD, PROVIDER } from "./constants.mjs"
import { CHAT, configModels } from "./models.mjs"
import { explain, statusLine, vendorError } from "./errors.mjs"
import { isKey } from "./keys.mjs"
import { errorReply, said } from "./response.mjs"
import { send } from "./request.mjs"
import { createSession } from "./session.mjs"
import { deviceSignIn } from "./signin.mjs"
import { readUsage } from "./usage.mjs"

// The fetch OpenCode and magpie send a model request through. A 403 is first tried again once the account's
// org has been put right.
function modelFetch({ fresh, mendOrg }, sessionId) {
  return async (input, init) => {
    let body = init?.body
    if (body == null && input instanceof Request && input.body) body = new Uint8Array(await input.arrayBuffer())
    if (body instanceof ReadableStream) body = new Uint8Array(await new Response(body).arrayBuffer())
    const url = input instanceof Request ? input.url : String(input)
    // the built-in takes an account's lapse off when it renews the
    // token, whatever the request then meets, and never for an
    // answer: a 401 of Factory's leaves it be, and so does a success
    // with no renewal on the way
    let renewed = false
    const onRenew = () => (renewed = true)
    const answer = (res) => said(res, renewed ? "renewed" : "kept")
    const attempt = async () => send(await fresh(onRenew), input, init, body, sessionId)
    let res
    try {
      res = await attempt()
      if (res.status !== 403) return answer(res)
      let text = await res.text()
      if (await mendOrg(res.status, text, onRenew).catch(() => false)) {
        res = await attempt()
        if (res.status !== 403) return answer(res)
        text = await res.text()
      }
      const why = explain(res.status, text)
      // the refusal, then what to do about it, as provider.Explain joins them
      const msg = `${vendorError(text, statusLine(res.status))} — ${why}`
      return answer(errorReply(url, res.status, "permission_error", msg, new Headers(res.headers)))
    } catch (e) {
      // Factory refused to renew the sign-in: the built-in failed the
      // request (magpie's 502) and marked the account lapsed
      if (e?.lapsed) return said(errorReply(url, 502, "api_error", e.message), "expired")
      throw e
    }
  }
}

export const FactoryAuthPlugin = async ({ client }) => {
  // the session id this process's requests carry
  const sessionId = crypto.randomUUID()
  const session = createSession(client)

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER] ?? {}
      config.provider[PROVIDER] = {
        name: "Factory",
        npm: CHAT.npm,
        api: CHAT.api,
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Factory (device code)",
          authorize: deviceSignIn,
        },
        // droid's FACTORY_API_KEY: the key is the bearer, never renewed
        { type: "api", label: "Factory API key (fk-…)", placeholder: "fk-…" },
      ],
      // magpie renews the sign-in MAGPIE_LEAD before its end, before its
      // requests and usage ask for it, and saves what this gives. Under
      // the same lock as the renewal before a request, so the two never
      // spend one refresh token; that check stays for OpenCode, which
      // doesn't call this
      refreshLead: MAGPIE_LEAD,
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.access || !auth.refresh) return undefined
        return session.refresh(auth)
      },
      // magpie's own hook: the account's limits
      async usage(getAuth) {
        return readUsage(session.account(getAuth))
      },
      async loader(getAuth) {
        const first = await getAuth()
        if (first?.type !== "oauth" && !isKey(first)) return {}
        return { apiKey: "placeholder", fetch: modelFetch(session.account(getAuth), sessionId) }
      },
    },
  }
}
