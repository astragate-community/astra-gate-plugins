// The model list: the bundled snapshot, Cline's two feeds merged, and the shapes OpenCode / magpie take them in.
import { API, PROVIDER } from "./constants.mjs"
import { feedJson } from "./api.mjs"
import { firstOf } from "./util.mjs"

// CAPS is the shorthand a model id spells in capitals, MIXED the ones with a
// capital of their own
const CAPS = new Set(["gpt", "glm", "ai", "api", "llm", "k3"])
const MIXED = { mimo: "MiMo" }

// prettify is a model id as a name: anthropic/claude-sonnet-5.5 becomes
// "Claude Sonnet 5.5"
export function prettify(id) {
  const seg = String(id).split("/").pop() ?? ""
  return seg
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => MIXED[w.toLowerCase()] ?? (CAPS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
}

// DEFAULT_MODELS is the list before Cline's feed answered: the bundled
// snapshot of Cline's own recommended-models feed — its recommended models,
// its free ones and ClinePass's (cline-recommended.generated.ts). The first is
// also Cline's own default.
export const DEFAULT_MODELS = [
  { id: "anthropic/claude-sonnet-5.5" },
  { id: "anthropic/claude-opus-5.5" },
  { id: "anthropic/claude-sonnet-5" },
  { id: "openai/gpt-6-astra" },
  { id: "openai/gpt-6.1-sol" },
  { id: "spacexai/grok-4.7" },
  { id: "moonshotai/kimi-k3" },
  { id: "cline-free/deepseek-v4.1-flash", free: true },
  { id: "stealth/space-bunny-alpha", free: true },
  { id: "cline-free/mimo-v2.6-flash", free: true },
  { id: "cline-free/muse-spark-1.3-contributor", free: true },
  { id: "cline-pass/deepseek-v4.1-flash" },
  { id: "cline-pass/mimo-v2.6-flash" },
  { id: "cline-pass/mimo-v2.6-pro" },
  { id: "cline-pass/glm-5.3" },
  { id: "cline-pass/deepseek-v4-pro" },
  { id: "cline-pass/qwen3.8-max" },
  { id: "cline-pass/muse-spark-1.3-contributor" },
  { id: "cline-pass/kimi-k3" },
  { id: "cline-pass/glm-5.3-flash" },
  { id: "cline-pass/qwen3.7-max" },
  { id: "cline-pass/qwen3.7-plus" },
  { id: "cline-pass/minimax-m3" },
  { id: "cline-pass/mimo-v2.5-pro" },
  { id: "cline-pass/mimo-v2.5" },
].map((m) => ({ name: prettify(m.id) + (m.free ? " (free)" : m.id.startsWith("cline-pass/") ? " (ClinePass)" : ""), ...m }))

const MODEL_ID = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i

// FEED_GROUPS is the recommended-models answer's shape, as Cline's own client
// reads it (cline-recommended.generated.ts): four arrays, and nothing else.
// clineCloud rides only under the client's includeClineCloudModels, so it is
// left out here the way the client leaves it out by default.
const FEED_GROUPS = ["recommended", "free", "clinePass"]

// a feed's own name for a model, or the prettified id when the feed's is just the id (or its last part): that is
// the raw id, not a name
const nameFor = (given, id) => (given && given !== id && given !== id.split("/").pop() ? given : prettify(id))

// parseFeed reads the recommended-models answer: the four arrays by name, not
// every value in the object (a description or tag is not a model). A model the
// feed lists twice keeps the stronger gate, so one in both recommended and
// free keeps its "(free)" mark.
export function parseFeed(v) {
  const payload = v && typeof v === "object" && !Array.isArray(v) ? v : {}
  const by = new Map()
  // entry is one model: an id bare or in an object, named for the plan gate a
  // picker should show. A feed name that is just the id (or its last part) is
  // the raw id, not a name, so it is prettified like the bundled list's.
  const entry = (e, group) => {
    const o = e && typeof e === "object" && !Array.isArray(e) ? e : {}
    const raw = typeof e === "string" ? e.trim() : firstOf(o.id, o.model, o.modelId, o.model_id, o.key, o.slug)
    if (!MODEL_ID.test(raw)) return null
    const free = group === "free" || o.free === true || o.free === "true"
    const pass = group === "clinePass" || raw.startsWith("cline-pass/")
    return { id: raw, name: nameFor(firstOf(o.display_name, o.displayName, o.name, o.label), raw), free, pass }
  }
  const add = (e, group) => {
    const m = entry(e, group)
    if (!m) return
    const was = by.get(m.id)
    if (!was) {
      by.set(m.id, m)
      return
    }
    // a model in both recommended and free keeps the free mark (and name)
    if (m.free && !was.free) {
      was.free = true
      was.name = m.name
    }
    if (m.pass) was.pass = true
  }
  for (const group of FEED_GROUPS) for (const e of Array.isArray(payload[group]) ? payload[group] : []) add(e, group)
  return [...by.values()].map((m) => ({ ...m, name: m.name + (m.free ? " (free)" : m.pass ? " (ClinePass)" : "") }))
}

// fetchRecommended is Cline's recommended-models feed, which it serves without
// a sign-in
export async function fetchRecommended() {
  const env = await feedJson("/ai/cline/recommended-models", "Cline model list")
  return parseFeed(env && typeof env === "object" && "data" in env ? env.data : env)
}

// tokens is a positive whole count of tokens, or undefined
export function tokens(...vs) {
  for (const v of vs) {
    const n = typeof v === "string" ? Number(v) : v
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return undefined
}

// fetchCloudModels is Cline's whole cloud catalog, which its clients load
// beside the recommended feed (loadCloudModels reads /ai/cline/models): the
// usage-billed models the recommended feed doesn't name. Entries carry an id,
// a display name and, OpenRouter's way, the window (context_length, or its
// top provider's).
export async function fetchCloudModels() {
  const j = await feedJson("/ai/cline/models", "Cline model catalog")
  const list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
  return list.flatMap((e) => {
    // the catalog's ids are bare (no provider prefix), unlike the
    // recommended feed's: any non-empty id is one
    const id = typeof e?.id === "string" ? e.id.trim() : ""
    if (!id) return []
    const context = tokens(e.context_length, e.top_provider?.context_length, e.context)
    // the reply limit is left out: OpenRouter's max_completion_tokens can
    // be most of the window (kimi-k3: 943718 of 1048576), and an agent
    // keeps that much of the window free for the reply, so it would
    // compact a tenth of the way in
    return [{ id, name: nameFor(firstOf(e.display_name, e.displayName, e.name), id), free: false, pass: id.startsWith("cline-pass/"), ...(context && { context }) }]
  })
}

// fetchFeed is both of Cline's model lists merged, recommended first: the
// recommended feed is required, the cloud catalog is what it adds.
export async function fetchFeed() {
  const [rec, cloud] = await Promise.all([fetchRecommended(), fetchCloudModels().catch(() => [])])
  // a recommended model takes the catalog's window for it: the recommended
  // feed gives none
  const sizes = new Map(cloud.map((m) => [m.id, m]))
  const ms = rec.map((m) => {
    const c = sizes.get(m.id)
    return c?.context ? { ...m, context: c.context } : m
  })
  const seen = new Set(ms.map((m) => m.id))
  for (const m of cloud) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    ms.push(m)
  }
  if (!ms.length) throw new Error("Cline listed no models")
  return ms
}

export const configModel = (m) => ({
  name: m.name ?? m.id,
  limit: { context: m.context ?? 0, output: 0 },
  tool_call: true,
})

export const runtimeModel = (m) => ({
  id: m.id,
  providerID: PROVIDER,
  name: m.name || m.id,
  api: { id: m.id, url: API, npm: "@ai-sdk/openai-compatible" },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  // 0 where Cline's catalog doesn't list the model (its cline-free/… and
  // cline-pass/… ids): magpie then gives the window models.dev has for the
  // model after the prefix
  limit: { context: m.context ?? 0, output: 0 },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "",
  variants: {},
  free: !!m.free,
})

/** The provider.models hook: the live list, or the list magpie already has when Cline couldn't give one. */
export async function providerModels(provider) {
  const have = provider?.models ?? {}
  try {
    const ms = await fetchFeed()
    return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(m)]))
  } catch {
    // a list Cline couldn't give is a failure, not the few
    // configured: magpie keeps the list it had
    return have
  }
}
