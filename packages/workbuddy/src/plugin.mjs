// WorkBuddy: the plugin for one build, as OpenCode and magpie load it.
import { LEAD_MS, NPM } from "./constants.mjs"
import { api } from "./sites.mjs"
import { configModels, liveModels, modelOf } from "./models.mjs"
import { SESSION, attend, normalizeToolChoice, sessionOf, withSystem } from "./request.mjs"
import { current, refreshed } from "./session.mjs"
import { meter, sign } from "./api.mjs"
import { fitted, renamed } from "./tools.mjs"
import { explained } from "./refusals.mjs"
import { kept } from "@astragate-community/plugin-kit"
import { enterpriseUsageOf, packagesOf, runsOutOf, usageOf } from "./usage.mjs"
import { checkinOf } from "./checkin.mjs"
import { browserSignIn, desktopSignIn } from "./signin.mjs"

// ---- the plugins --------------------------------------------------------------

export function makePlugin(site) {
  return async ({ client }) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[site.id] ??= {}
      const p = config.provider[site.id]
      p.name ??= site.name
      p.npm ??= NPM
      p.api ??= api(site)
      p.models = { ...configModels(site), ...(p.models ?? {}) }
    },
    // the conversation's id, which the chats below carry to WorkBuddy:
    // magpie's (or OpenCode's) session for this request, when it names one
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== site.id || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },
    provider: {
      id: site.id,
      // the account's own list, when it's signed in and WorkBuddy answers;
      // else the list above
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return provider.models
        try {
          const a = await current(site, client, auth)
          const ms = await liveModels(site, a)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, modelOf(site, provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: site.id,
      // magpie renews a browser sign-in LEAD_MS before its end (an hour's
      // token), once for the account, before its requests, models and
      // usage ask; the check before each request stays for OpenCode,
      // which doesn't call this. Desktop's sign-in has no expiry stored
      // and is renewed as before.
      refreshLead: LEAD_MS,
      refresh: (auth) => refreshed(site, auth),
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: api(site),
          apiKey: "",
          async fetch(input, init) {
            let a = await getAuth()
            if (a?.type !== "oauth") throw new Error(`${site.name} isn't signed in`)
            a = await current(site, client, a)
            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.delete("content-length")
            const session = sessionOf(headers)
            sign(site, a, headers)
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            body = withSystem(body)
            const fit = fitted(body)
            body = normalizeToolChoice(fit.body)
            attend(headers, body, session)
            const res = await fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method, headers, body })
            return res.status >= 400 ? explained(res) : kept(await renamed(res, fit.names))
          },
        }
      },
      // the account's credits, as magpie's built-in showed them; each
      // read keeps the sign-in (signIn), as the built-in's neither marked
      // an account lapsed nor cleared it
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { error: "not signed in", signIn: "kept" }
        try {
          const a = await current(site, client, auth)
          // the meter has no /v2 prefix, on either site
          const sum = await meter(site, a, "/billing/meter/get-user-resource-summary")
          const out = usageOf(sum, auth.plan)
          // an enterprise account's summary has no packages: its credits
          // are the enterprise meter's (#1904). A personal account's
          // refusal of it (10001 "uid or enterpriseID is empty") leaves
          // the card as the summary said.
          if (!out.windows.length) {
            let ent = null
            try {
              ent = enterpriseUsageOf(await meter(site, a, "/billing/meter/get-enterprise-user-usage"))
            } catch {}
            if (ent) return { plan: auth.plan || "Enterprise", windows: [ent], signIn: "kept" }
          }
          // when the credits left run out, for routing to spend them first;
          // a list that can't be read leaves it unknown, the card stands
          const credits = out.windows.find((w) => w.name === "Credits")
          if (credits) {
            try {
              Object.assign(credits, runsOutOf(sum, await packagesOf(site, a)) ?? {})
            } catch {}
          }
          return { ...out, signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      // the daily check-in (签到): magpie's auth.checkin, answering
      // {outcome, credit?, streak?, message?}; a token it renews is kept
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { outcome: "failed", message: "not signed in" }
        try {
          return await checkinOf(site, await current(site, client, auth))
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
      methods: [
        {
          type: "oauth",
          label: `${site.name} account (browser)`,
          authorize: () => browserSignIn(site),
        },
        {
          type: "oauth",
          label: `${site.name} desktop's sign-in`,
          authorize: async () => desktopSignIn(site),
        },
      ],
    },
  })
}