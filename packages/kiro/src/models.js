// Kiro: the model list.
import { managementCall } from "./api.js"

// a model's context, as Kiro last listed it
export const windows = new Map()

export const thinks = (id) => /claude/i.test(id) || id === "auto"

// Kiro's own list is asked for once signed in; until then, Auto, which picks a model for each request.
export const MODELS = [{ id: "auto", name: "Auto" }]

/** A model as the host takes it (provider.models): Kiro is reached on Anthropic's Messages. */
export const hostModel = (m) => ({
  id: m.id,
  name: m.name ?? m.id,
  protocol: "anthropic",
  ...(m.context ? { context: m.context } : {}),
  ...(m.output ? { output: m.output } : {}),
  vision: !!m.images,
  reasoning: thinks(m.id),
})

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
