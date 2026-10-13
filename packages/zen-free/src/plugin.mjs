// The hook object OpenCode / magpie load: the provider's config, its public-credential sign-in, the fetch that
// talks to Zen, and the model list.
import { CATALOG, DEFAULT_BASE, DOCS, ICON, PATHS, PROVIDER, SDK } from "./constants.mjs"
import { createModelBook } from "./discovery.mjs"
import { collapseResponse } from "./collapse.mjs"
import { guardToolResponse } from "./guard.mjs"
import { configModels } from "./models.mjs"
import { httpURL, normalizeTools, requirePublic, upstreamHeaders } from "./request.mjs"

export async function server(input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE)
  const catalogURL = httpURL(options.catalogURL ?? CATALOG)
  const docsURL = httpURL(options.docsURL ?? DOCS)
  const book = createModelBook({ baseURL, catalogURL, docsURL })

  // one request through the provider: validated, shaped for Zen, and its reply guarded
  async function zenFetch(getAuth, requestInput, init) {
    requirePublic(await getAuth())
    const request = new Request(requestInput, init)
    const protocol = Object.keys(PATHS).find((key) => request.url === `${baseURL}${PATHS[key]}`)
    if (!protocol || request.method !== "POST") throw new Error("Unsupported Zen endpoint or method")
    request.signal.throwIfAborted()
    const body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON request object")
    if (!book.listed && !Object.hasOwn(book.known, body.model)) {
      await book.discover(request.signal)
    }
    const model = book.known[body.model]
    if (!model || model.api.npm !== SDK[protocol]) {
      throw new Error("Model is not an available free model for this protocol. Refresh the model list.")
    }
    const streaming = body.stream === true
    body.stream = true
    const toolPolicy = normalizeTools(body, protocol)
    if (protocol === "chat") body.stream_options = { ...body.stream_options, include_usage: true }
    const headers = upstreamHeaders(request, body, protocol, input?.project)
    const response = await fetch(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
      redirect: "error",
    })
    const guarded = await guardToolResponse(response, protocol, toolPolicy)
    return streaming ? guarded : collapseResponse(guarded, protocol)
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free",
        npm: SDK.chat,
        api: baseURL,
        models: configModels(book.known),
      }
    },
    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "Zen 免费访问（密钥填写 public）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        requirePublic(auth)
        return {
          baseURL,
          apiKey: "public",
          fetch: (requestInput, init) => zenFetch(getAuth, requestInput, init),
        }
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        requirePublic(auth)
        return book.discover()
      },
    },
    async "chat.headers"(hookInput, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(hookInput.model?.providerID) || !hookInput.sessionID) return
      output.headers["x-session-id"] = hookInput.sessionID
      output.headers["x-opencode-session"] = hookInput.sessionID
      output.headers["x-session-affinity"] = hookInput.sessionID
    },
  }
}
