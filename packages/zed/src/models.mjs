// The models an account may call: Zed's list, and how each is declared to OpenCode.
import { BASE, CLOUD, NPM, PROVIDER } from "./constants.mjs"
import { userAgent } from "./api.mjs"
import { parse } from "./json.mjs"
import { stale, ZedStatus } from "./refusals.mjs"
import { modelToken } from "./token.mjs"

// vendors is each model's provider as the last list said, so a request
// goes out in its own provider's API.
export const vendors = new Map()
// lists is each account's last model list, by user id: { at, models }
export const lists = new Map()

// fetchModels reads GET /models, minting the token again once if it is stale.
export async function fetchModels(s) {
  for (let t = 0; ; t++) {
    const tok = await modelToken(s, t > 0)
    const res = await fetch(CLOUD + "/models", {
      headers: { Authorization: "Bearer " + tok, "x-zed-client-supports-x-ai": "true", "User-Agent": userAgent() },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (!res.ok && t === 0 && stale(res.status, res.headers)) continue
    if (!res.ok) throw new ZedStatus(res.status, text, res.headers)
    return parseModels(text)
  }
}

// parseModels is what /models lists that can be called, the disabled ones
// and those of providers the plugin can't write left out.
export function parseModels(text) {
  const r = parse(text)
  const out = (r?.models ?? []).filter((m) => m && m.id && !m.is_disabled && NPM[m.provider])
  if (!out.length) throw new Error("Zed lists no models for this account — its plan may not include Zed's hosted models (see zed.dev/account)")
  for (const m of out) vendors.set(m.id, m.provider)
  return out
}

// variant is what the AI SDK package a model is on is given for an effort.
function variant(provider, effort) {
  if (provider === "anthropic") return { effort }
  if (provider === "google") return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
  return { reasoningEffort: effort }
}

const effortsOf = (m) => (m.supported_effort_levels ?? []).map((e) => e?.value).filter(Boolean)

// entry is a model as OpenCode's config declares it.
export function entry(m) {
  const img = !!m.supports_images
  return {
    id: m.id,
    name: m.display_name || m.id,
    provider: { npm: NPM[m.provider], api: BASE },
    reasoning: !!m.supports_thinking || effortsOf(m).length > 0,
    attachment: img,
    tool_call: true,
    temperature: true,
    modalities: { input: img ? ["text", "image"] : ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
    limit: { context: m.max_token_count || 0, output: m.max_output_tokens || 0 },
    variants: Object.fromEntries(effortsOf(m).map((e) => [e, variant(m.provider, e)])),
  }
}

// model is a model as OpenCode's provider hands it to provider.models.
export function model(m) {
  const e = entry(m)
  const img = !!m.supports_images
  return {
    id: m.id,
    providerID: PROVIDER,
    name: e.name,
    api: { id: m.id, url: BASE, npm: NPM[m.provider] },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: img,
      toolcall: true,
      input: { text: true, image: img, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: e.variants,
  }
}
