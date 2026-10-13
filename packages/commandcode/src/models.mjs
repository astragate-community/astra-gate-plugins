// The plan's model list: the Provider API's, the Go plan's (read without a key), and the built-in ones standing in
import { statusText } from "@astragate-community/plugin-kit"
import { BASE, CHAT, ID, MESSAGES, RESPONSES } from "./constants.mjs"
import { GO_MODELS, GO_REFUSED, MODELS, refuses } from "./catalog.mjs"
import { extraNow, planNow } from "./account.mjs"
import { liveKey } from "./signin.mjs"

// FELL_BACK marks a list handed back for one that can't be had (magpie's
// plugin host reads it; OpenCode never sees a symbol's key)
const FELL_BACK = Symbol.for("magpie.fellBack")

const isClaude = (id) => /^claude-/i.test(id) || id.startsWith("anthropic/")

// the AI SDK package a model is spoken to through: its own when the list said, else by name
const npmOf = (m) => m.npm ?? (isClaude(m.id) ? MESSAGES : CHAT)

const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]))

// configModel is a model as opencode.json's provider.models has it.
export function configModel(m) {
  const npm = npmOf(m)
  return {
    name: m.name,
    ...(npm !== CHAT ? { provider: { npm, api: BASE } } : {}),
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(m.efforts?.length
      ? { reasoning: true, variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])) }
      : {}),
    tool_call: true,
  }
}

// runtimeModel is a model as OpenCode's provider.models hook returns it.
// Whether it takes pictures is said only when known (m.images a boolean):
// Command Code's list doesn't say, and a false said for every model
// unknown is taken by magpie as the plan's answer, over models.dev's,
// which the built-in asks for a model its list says nothing of
// (yetone/magpie: every model of the plan without image input).
export function runtimeModel(m) {
  const npm = npmOf(m)
  const input = { text: true, ...(typeof m.images === "boolean" ? { image: m.images } : {}), audio: false, video: false, pdf: false }
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: BASE, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.efforts?.length,
      attachment: !!m.images,
      toolcall: true,
      input,
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries((m.efforts ?? []).map((e) => [e, { reasoningEffort: e }])),
  }
}

// liveModels is the Provider API's list, with the APIs each model is
// served on (its Claude models on /messages alone, the open ones on
// /chat/completions and /responses, some on /responses alone); the default list's names and
// windows fill in what it leaves out. The list says nothing of pictures:
// a model takes them as the default list or the CLI's table (GO_MODELS)
// says, and every Claude model does; of any other nothing is said, and
// magpie answers from models.dev.
export async function liveModels(key) {
  const res = await fetch(BASE + "/models", { headers: { Authorization: `Bearer ${key}`, "x-api-key": key } })
  if (!res.ok) throw new Error(`models: ${res.status}`)
  const body = await res.json()
  const known = byId(MODELS)
  const table = byId(GO_MODELS)
  const out = []
  for (const m of body?.data ?? []) {
    if (!m?.id) continue
    const k = known[m.id]
    let images = Array.isArray(m.modalities?.input) ? m.modalities.input.includes("image") : undefined
    if (images === undefined) images = k?.images ?? table[m.id]?.images ?? (isClaude(m.id) || undefined)
    const eps = (m.supported_endpoints ?? []).map((e) => String(e).replace(/\/$/, "").replace(/^\/v1/, ""))
    let npm = isClaude(m.id) ? MESSAGES : CHAT
    // the first of the APIs it is served on, in magpie's order (chat
    // completions, Responses, Messages), as the built-in picks it
    if (eps.length) npm = eps.includes("/chat/completions") ? CHAT : eps.includes("/responses") ? RESPONSES : eps.includes("/messages") ? MESSAGES : CHAT
    const ctx = Number(m.context_length)
    out.push({
      id: m.id,
      name: m.name && m.name !== m.id ? m.name : m.display_name || k?.name || m.id,
      context: Number.isFinite(ctx) && ctx > 0 ? ctx : k?.context ?? 0,
      images,
      npm,
    })
  }
  if (!out.length) throw new Error("models: an empty list")
  return out
}

// drawsID and textID are catalog.DrawsID and catalog.textModel on an id.
const drawsID = (id) =>
  ["image", "imagen", "imagine", "dall-e", "flux", "seedream", "cogview", "stable-diffusion", "sdxl", "wanx", "kolors", "hidream"].some((w) => id.toLowerCase().includes(w))
const textID = (id) =>
  !["embed", "-tts", "image", "audio", "-live", "robotics", "computer-use", "deep-research", "transcribe", "realtime", "moderation", "whisper", "dall-e", "sora"].some((w) => id.includes(w))

// listError is a model list's error reply's message ({"error":{"message"}},
// {"error":"…"}, {"message"}), cut at 160 characters, as catalog's
// errorMessage reads it.
function listError(text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return ""
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return ""
  let msg = typeof v.message === "string" ? v.message : ""
  if (typeof v.error?.message === "string" && v.error.message) msg = v.error.message
  else if (typeof v.error === "string" && v.error) msg = v.error
  msg = msg.trim()
  const r = [...msg]
  return r.length > 160 ? r.slice(0, 160).join("") + "…" : msg
}

// goModels is the Go plan's list, as magpie's cmdGoFetch has it: the
// Provider API's list, which answers without a key (Go's key has no
// Provider API) and is asked without it, less what Go is refused; each
// model takes its name when the list gives none, its reasoning levels and,
// when the list doesn't say, its pictures and window from GO_MODELS
// (catalog.Decorate). Every Go model is asked on chat completions, which
// the fetch sends on to /alpha/generate. An account with credits beyond
// the plan's (open) is let every model, as the CLI lets it.
export async function goModels(open = false) {
  const url = BASE + "/models"
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "magpie" }, signal: AbortSignal.timeout(8_000) })
  const text = await res.text()
  // catalog.FetchURL's errors
  if (res.status !== 200) {
    const status = `${res.status} ${statusText(res.status)}`.trimEnd()
    const msg = listError(text)
    throw new Error(msg ? `${url}: ${status} (${msg})` : `${url}: ${status}`)
  }
  let body
  try {
    body = JSON.parse(text)
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw 0
  } catch {
    throw new Error(`${url}: not a model list`)
  }
  let rows = Array.isArray(body.data) ? body.data : []
  if (!rows.length) rows = Array.isArray(body.models) ? body.models : []
  const known = byId(GO_MODELS)
  const listed = []
  for (const r of rows) {
    const id = (typeof r?.id === "string" && r.id) || (typeof r?.name === "string" && r.name) || ""
    // a model that draws, or isn't for text (embeddings, speech), is
    // left out, as catalog.Chat and fetchOne leave it
    if (!id || drawsID(id) || !textID(id)) continue
    const input = Array.isArray(r.modalities?.input) ? r.modalities.input.includes("image") : undefined
    const ctx = typeof r.context_length === "number" && r.context_length > 0 ? Math.trunc(r.context_length) : 0
    let m = { id, name: (typeof r.display_name === "string" && r.display_name) || id, context: ctx, images: input, npm: CHAT }
    let k = known[id]
    const i = id.lastIndexOf("/")
    if (!k && i >= 0) k = known[id.slice(i + 1)]
    if (k) {
      m = {
        ...m,
        name: m.name === id ? k.name : m.name,
        efforts: k.efforts,
        images: input === undefined ? k.images : input,
        context: m.context || k.context,
      }
    }
    listed.push(m)
  }
  if (!listed.length) throw new Error(`${url}: no models listed`)
  const out = open ? listed : listed.filter((m) => !GO_REFUSED.has(m.id))
  if (!out.length) throw new Error("Command Code listed no models for the Go plan")
  return out
}

const asModels = (list, make = runtimeModel) => Object.fromEntries(list.map((m) => [m.id, make(m)]))

// The plan's list: the Provider API's, with what each model is served
// on, less what the plan refuses (PLAN_MODELS); Go's key has no
// Provider API: its list is the same one, asked without it, less what
// Go is refused, and the CLI's table when that can't be had. A plan
// not read (nothing saved, billing/subscriptions failing) keeps the
// whole list, and so does an account with credits beyond its plan's.
export async function modelsOf(provider, { auth } = {}) {
  if (auth?.type !== "api" || !auth.key) return provider.models
  const key = await liveKey(auth)
  const [plan, extra] = await Promise.all([planNow(key, auth.metadata?.plan), extraNow(key)])
  const keep = (id) => extra || !refuses(plan, id)
  if (plan === "Go") {
    let ms = GO_MODELS
    let fell = false
    try {
      ms = await goModels(extra)
    } catch {
      fell = true
    }
    const out = asModels(ms.map((m) => ({ ...m, npm: CHAT })))
    // the CLI's table stands in: magpie keeps the list it was told
    // last, as the built-in keeps the one it fetched last
    if (fell) out[FELL_BACK] = true
    return out
  }
  try {
    const out = asModels((await liveModels(key)).filter((m) => keep(m.id)))
    if (Object.keys(out).length) return out
  } catch {}
  // the default list stands in, less what the plan refuses
  const out = Object.fromEntries(Object.entries(provider.models ?? {}).filter(([id]) => keep(id)))
  return Object.assign(out, { [FELL_BACK]: true })
}

// the defaults the config hook offers before any list is asked
export const configModels = () => asModels(MODELS, configModel)
