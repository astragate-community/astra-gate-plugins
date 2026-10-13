// Qoder's subscriptions as OpenCode provider plugins, one for each of its
// sites, whose accounts exist only on their own:
//   - qoder: the international site, qoder.com
//   - qoder-cn: Qoder CN, qoder.cn (Alibaba Cloud or phone sign-in)
//
// Qoder is signed in to the way its desktop client is: a PKCE device flow
// (qoder.com's page, then a poll of openapi.qoder.sh for the device token),
// whose device token is traded for the job token the model calls use. The
// job token is refreshed with its refresh token before it runs out; Qoder
// spends a refresh token once, so the new pair is saved straight away.
//
// Qoder's models are served on the API its client talks to, api3.qoder.sh's
// agent_chat_generation SSE, signed with the client's COSY envelope and sent
// in its body codec. The loader's fetch takes the chat completion OpenCode sends,
// writes it as Qoder's request, and turns Qoder's reply back into one; tool
// calls Qoder writes as XML in its text are lifted out as tool calls.
//
// The protocol (endpoints, COSY envelope, body codec, device flow) is ported
// from magpie's internal/qoder, which ported it from CLIProxyAPI's qoder
// support (https://github.com/ufec/CLIProxyAPI, MIT).
//
// This module is the plugin for one site, as OpenCode and magpie load it; the rest are in modules (sites,
// signin, session, request, response, models, usage, campaigns). Based on @magpie-community/opencode-qoder-auth
// 0.2.14 (MIT).
import { CHAT, RENEW_LEAD } from "./constants.mjs"
import { createCampaigns, campaignPage } from "./campaigns.mjs"
import { createChat } from "./chat.mjs"
import { expiredError } from "./errors.mjs"
import { configModel, createListings, runtimeModels } from "./models.mjs"
import { errorResponse, signed, signedInError } from "./refusals.mjs"
import { createSession } from "./session.mjs"
import { signInMethods } from "./signin.mjs"
import { siteOf } from "./sites.mjs"
import { createUsage } from "./usage.mjs"
import { bodyText } from "./util.mjs"

export const makePlugin = (site) => async ({ client }) => {
  const ID = site.id
  const session = createSession(site, client)
  const models = createListings(site)
  const ask = createChat(site, models)
  const campaign = createCampaigns(site, session)

  return {
    auth: {
      provider: ID,
      // magpie renews the chat token RENEW_LEAD before its end, once for
      // the account, before its requests, models and usage ask for it; the
      // check before each request (REFRESH_LEAD) stays for OpenCode, which
      // doesn't call this. The device token of a job-token account has no
      // end on record: usage rotates it once Qoder refuses it, as before.
      refreshLead: RENEW_LEAD,
      refresh: (auth) => session.refresh(auth),
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        let base = site
        try {
          base = siteOf(site, a)
        } catch {} // its requests say so
        return {
          baseURL: base.api,
          apiKey: "qoder",
          // every chat completion written as Qoder's own request
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (campaignPage(site, url) || campaignPage(base, url)) return campaign(getAuth, input, url, init)
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return errorResponse({ status: 404, message: "only chat completions are served" })
            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse({ status: 400, message: "a request that isn't JSON" })
            }
            let cred
            try {
              cred = await session.fresh(getAuth)
            } catch (e) {
              return signedInError(site, e)
            }
            return signed(await ask(chat, cred, init), session.renewed(cred))
          },
        }
      },
      methods: signInMethods(site),
      usage: createUsage(site, session),
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: site.name,
        npm: CHAT,
        api: site.api,
        ...was,
        models: { ...Object.fromEntries(site.models.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, as Qoder's client asks it
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "oauth") return provider.models
        let cred
        try {
          cred = await session.fresh(async () => auth)
        } catch (e) {
          // the built-in listed through QoderCredentialOf: a refused job
          // refresh marked the account there; anything else marked nothing
          if (e?.expired) throw expiredError(e)
          return provider.models
        }
        session.modelsRenewed(cred)
        try {
          const ms = await models(cred, true)
          if (!ms.length) return provider.models
          return runtimeModels(siteOf(site, cred), ms)
        } catch {
          return provider.models
        }
      },
    },
  }
}
