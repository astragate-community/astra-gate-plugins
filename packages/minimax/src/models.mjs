// MiniMax Code: the model list — the built-in one, and MiniMax Code's live model config.
import { NPM, chatBase } from "./constants.mjs"
import { num, obj, str } from "./values.mjs"

// MiniMax Code's own list, for when the live one can't be had.
// thinking: "switchable" (on or off), "forced_on" (always on, at an effort)
export const MODELS = [
  { id: "MiniMax-M3.1-Flash-Preview", name: "M3.1-Flash-Preview", context: 512000, output: 128000, images: true, thinking: "forced_on", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "MiniMax-M3", name: "MiniMax-M3", context: 512000, output: 128000, images: true, thinking: "switchable", efforts: [] },
  { id: "MiniMax-M2.7", name: "MiniMax-M2.7", context: 200000, output: 128000, images: false, thinking: "on", efforts: [] },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax-M2.7-highspeed", context: 200000, output: 128000, images: false, thinking: "on", efforts: [] },
]

// variants are a model's reasoning levels as @ai-sdk/anthropic options,
// sent as MiniMax Code sends them: adaptive thinking at an effort
// (output_config.effort), "none" turning thinking off where it can be.
export function variants(m) {
  const out = {}
  if (m.thinking === "switchable") out.none = { thinking: { type: "disabled" } }
  if (m.efforts?.length) for (const e of m.efforts) out[e] = { thinking: { type: "adaptive" }, effort: e }
  else if (m.thinking === "switchable") out.high = { thinking: { type: "adaptive" } }
  return out
}

const reasons = (m) => m.thinking !== "off"

export function configModels() {
  return Object.fromEntries(MODELS.map((m) => [m.id, {
    name: m.name,
    reasoning: reasons(m),
    tool_call: true,
    attachment: !!m.images,
    modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context, output: m.output },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: variants(m),
  }]))
}

export function modelOf(site, provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: chatBase(site), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: reasons(m),
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(m),
  }
}

// parseModels reads MiniMax Code's model config ({providers:[{providerId:
// "minimax", config:{models:{<id>:{…}}, model_order?}}]}) as models.
export function parseModels(body) {
  const p = (Array.isArray(body?.providers) ? body.providers : []).find((x) => x?.providerId === "minimax")
  const ms = obj(obj(p?.config)?.models)
  if (!ms) return []
  const order = Array.isArray(p.config.model_order) ? p.config.model_order.filter((id) => ms[id]) : []
  const ids = [...order, ...Object.keys(ms).filter((id) => !order.includes(id))]
  const out = []
  for (const id of ids) {
    const d = obj(ms[id])
    if (!d || !id.trim()) continue
    const input = Array.isArray(d.modalities?.input) ? d.modalities.input : []
    const mode = str(d.thinking_config, "mode")
    const efforts = (d.thinking?.effortOptions ?? d.thinking?.effort_options ?? d.effort_options ?? [])
      .filter((e) => typeof e === "string" && e && e !== "default" && e !== "none")
    out.push({
      id,
      name: str(d, "name") ?? id,
      context: num(d.limit?.context) ?? 0,
      output: num(d.limit?.output) ?? 0,
      images: input.includes("image") || d.attachment === true,
      thinking: mode === "switchable" ? "switchable"
        : mode === "forced_off" ? "off"
        : mode === "forced_on" ? "forced_on"
        : d.reasoning === false ? "off" : "on",
      efforts,
    })
  }
  return out
}

// liveModels asks MiniMax Code's model config, as mcode does at start: the
// signed-in account's first, then, when that is refused, no one's.
export async function liveModels(site, access) {
  const url = new URL("/mavis/api/v1/models", site.llm)
  url.searchParams.set("region", site.region)
  url.searchParams.set("buildEnv", "prod")
  const ask = (auth) => fetch(url, {
    headers: { Accept: "application/json", ...(auth ? { Authorization: "Bearer " + auth } : {}) },
    signal: AbortSignal.timeout(10000),
  })
  let res = await ask(access)
  if (res.status === 401 || res.status === 403) res = await ask("")
  if (!res.ok) throw new Error(`${site.name}'s models: HTTP ${res.status}`)
  return parseModels(await res.json())
}
