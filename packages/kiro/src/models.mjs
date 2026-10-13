// Kiro: the model list, and how a model is declared to OpenCode / magpie.
import { BASE, ID, MESSAGES } from "./constants.mjs"
import { managementCall } from "./api.mjs"

// a model's context, as Kiro last listed it (what the stream's context percentage is counted against)
export const windows = new Map()

export const thinks = (id) => /claude/i.test(id) || id === "auto"
const BUDGETS = { low: 10000, medium: 20000, high: 30000, max: 50000 }

// the thinking variants of a model that thinks, none otherwise (a fresh object each time)
const variantsOf = (id) =>
  thinks(id) ? Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, { thinking: { type: "enabled", budgetTokens: b } }])) : {}

export function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(thinks(m.id) ? { reasoning: true, variants: variantsOf(m.id) } : {}),
    tool_call: true,
  }
}

export function runtimeModel(m) {
  const input = { text: true, image: !!m.images, audio: false, video: false, pdf: false }
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: BASE, npm: MESSAGES },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: thinks(m.id),
      attachment: !!m.images,
      toolcall: true,
      input,
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variantsOf(m.id),
  }
}

// Kiro's own list is asked for once signed in; until then, Auto, which
// picks a model for each request.
export const MODELS = [{ id: "auto", name: "Auto" }]

// listModels is List-Available-Models, the default first.
export async function listModels(a) {
  const out = await managementCall(a.region, a, "List-Available-Models", { origin: "KIRO_CLI", profileArn: a.profile })
  const list = []
  for (const m of out?.models ?? []) {
    if (!m?.modelId) continue
    let name = m.modelName
    if (!name || name === m.modelId) name = m.modelId === "auto" ? "Auto" : m.modelId
    const model = { id: m.modelId, name, context: m.tokenLimits?.maxInputTokens ?? 0, output: m.tokenLimits?.maxOutputTokens ?? 0,
      images: (m.supportedInputTypes ?? []).some((t) => String(t).toUpperCase() === "IMAGE") }
    if (m.modelId === out?.defaultModel?.modelId) list.unshift(model)
    else list.push(model)
  }
  if (!list.length) throw new Error("Kiro listed no models")
  for (const m of list) windows.set(m.id, m.context)
  return list
}
