// The account's model list: Cursor's picker, the variants it is served, and the entries OpenCode is given.
import { AGENT, API, CHAT, DEFAULT_CONTEXT, ID, MODELS_KEEP } from "./constants.mjs"
import { hashOf } from "./hash.mjs"
import { unary } from "./api.mjs"

//
// The list is Cursor's model picker (AiService/AvailableModels, asked as the
// CLI asks it), the way pi-cursor-sdk lists Cursor's SDK catalog: each model
// is offered once for each of its context sizes, named "Claude Opus 5.5 @
// 300k" and with that many tokens as its window; one without a context
// parameter is offered once, with Cursor's limit for it. Effort is the
// request's reasoning_effort and fast its service_tier, sent as the model's
// own parameters, so neither is a model of its own. A request goes as the
// variant those parameters pick, in Max Mode when that variant is Max Mode's.

export const LEVEL_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"]

// left out of the CLI's picker as it leaves them out (model-service.ts)
const PICKER_SKIP = new Set(["claude-4.5-haiku", "claude-4.5-haiku-thinking", "gemini-2.5-pro", "gemini-2.5-flash", "claude-haiku-4-5"])

const clean = (s) => String(s ?? "").replaceAll("\u200b", "").split(/\s+/).filter(Boolean).join(" ")

// tokensOf is a context value as tokens: "300k" 300000, "1m" 1000000.
export function tokensOf(value) {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value ?? "").trim())
  return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000)) : 0
}

// paramDefs is a picker model's parameters: id to the values it takes.
function paramDefs(m) {
  const out = {}
  for (const d of m.parameterDefinitions ?? []) {
    const t = d?.parameterType ?? {}
    const vs = (t.enumParameter ?? t.booleanParameter)?.values ?? []
    if (d?.id) out[d.id] = vs.map((v) => String(v.value))
  }
  return out
}

export const valuesOf = (v) => Object.fromEntries((v?.parameterValues ?? []).map((p) => [String(p.id), String(p.value)]))

// defaultVariant is the variant the CLI picks for a model asked for by
// name: its default without Max Mode, else with it, else the first.
const defaultVariant = (m) => {
  const vs = m?.variants ?? []
  return vs.find((v) => v.isDefaultNonMaxConfig) ?? vs.find((v) => v.isDefaultMaxConfig) ?? vs[0]
}

// needsMax is whether a variant is run in Max Mode only, as the CLI reads
// it: a model with no other mode, or a Max Mode variant.
export const needsMax = (m, v) => m?.supportsNonMaxMode === false || v?.isMaxMode === true

// effortsOf is the efforts a model takes, as pi's levels, each with the
// value Cursor's parameter has for it (extra-high is xhigh).
function effortsOf(defs) {
  const pid = EFFORT_PARAMS.find((p) => defs[p]?.length)
  // thinking alone, on or off: high and none
  if (!pid && defs.thinking?.includes("true") && defs.thinking.includes("false")) return { pid: "thinking", levels: { none: "false", high: "true" } }
  if (!pid) return { pid: "", levels: {} }
  const levels = {}
  for (const v of defs[pid]) {
    const l = v === "extra-high" ? "xhigh" : v
    if (LEVEL_RANK.includes(l)) levels[l] = v
  }
  return { pid, levels }
}

// served is a picker model's variants the account is served. With the
// usable list at hand (the ids cursor-agent models shows), a variant whose
// own id isn't in it is one the account hasn't got (Sonnet 4.6 at any effort
// but medium, say). A model the usable list has nothing of is the picker's
// alone (GLM-5.3), and is kept whole.
function served(m, ids) {
  const vs = m.variants ?? []
  if (!ids) return vs
  const got = vs.filter((v) => !v.legacySlug || ids.has(v.legacySlug))
  return got.some((v) => v.legacySlug) ? got : vs
}

// modelsOf is the picker's models as offered: one entry for each context
// size a model has, or one with Cursor's limit when it has none. A model
// served in part is offered at the sizes and efforts it is served at.
export function modelsOf(picker, ids) {
  const out = []
  const used = new Set()
  for (const m of picker) {
    if (!m?.name || m.isHidden || m.isChatOnly || m.onlySupportsCmdK || m.supportsAgent === false || PICKER_SKIP.has(m.name)) continue
    const defs = paramDefs(m)
    const variants = served(m, ids)
    const partial = variants.length < (m.variants ?? []).length
    const has = (pid, value) => !partial || !variants.some((v) => pid in valuesOf(v)) || variants.some((v) => valuesOf(v)[pid] === value)
    const def = defaultVariant({ variants })
    const { pid, levels: all } = effortsOf(defs)
    const levels = Object.fromEntries(Object.entries(all).filter(([, value]) => has(pid, value)))
    const base = { run: m.name, title: clean(m.clientDisplayName || m.name), pid, levels, fast: !!defs.fast?.length, variants, def, partial, model: m }
    const contexts = (defs.context ?? []).filter((c) => has("context", c))
    if (contexts.length) {
      for (const c of contexts) {
        const id = m.name + "@" + c
        if (used.has(id)) continue
        used.add(id)
        out.push({ ...base, id, name: base.title + " @ " + c, context: tokensOf(c) || DEFAULT_CONTEXT, size: c, offersFast: fastAt(variants, c) })
      }
    } else if (!used.has(m.name)) {
      used.add(m.name)
      const limit = needsMax(m, def) ? m.contextTokenLimitForMaxMode || m.contextTokenLimit : m.contextTokenLimit
      out.push({ ...base, id: m.name === "default" ? "auto" : m.name, name: base.title, context: limit > 0 ? limit : DEFAULT_CONTEXT, size: "", offersFast: fastAt(variants, "") })
    }
  }
  return out
}

// fastAt is whether Cursor has a fast variant the account is served at
// the context size (any, for a model without sizes): what magpie offers
// fast for, which 0.1.x said with a -fast model of its own.
const fastAt = (variants, size) =>
  variants.some((v) => {
    const have = valuesOf(v)
    return have.fast === "true" && (!size || have.context === undefined || have.context === size)
  })

// usable is the account's list, kept a while, by token: Cursor's picker,
// less the variants the usable list (AgentService/GetUsableModels, what
// cursor-agent models shows) says the account hasn't got. A picker Cursor
// can't give is a failure: magpie keeps the list it had. A usable list it
// can't give leaves the picker as it is.
const lists = new Map()
export async function usable(tok) {
  const h = hashOf(tok)
  const had = lists.get(h)
  if (had && Date.now() - had.at < MODELS_KEEP) return had.raw
  const [j, ids] = await Promise.all([
    unary(API, "aiserver.v1.AiService/AvailableModels", tok, { useModelParameters: true, doNotUseMarkdown: true }, 30_000),
    unary(API, "agent.v1.AgentService/GetUsableModels", tok, {}, 8_000).then(
      (u) => {
        const ids = new Set((u?.models ?? []).flatMap((m) => [m.modelId, m.displayModelId]).filter(Boolean))
        return ids.size ? ids : null
      },
      () => null,
    ),
  ])
  const raw = modelsOf(Array.isArray(j?.models) ? j.models : [], ids)
  if (!raw.length) throw new Error("Cursor listed no models")
  lists.set(h, { at: Date.now(), raw })
  return raw
}

export function runtimeModel(m) {
  const efforts = LEVEL_RANK.filter((l) => l in m.levels)
  return {
    id: m.id,
    providerID: ID,
    name: m.name,
    api: { id: m.id, url: AGENT, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context || DEFAULT_CONTEXT, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: efforts.length > 0,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
    // a request's service_tier priority (or fast) runs it as Cursor's fast
    // variant: magpie offers Fast for the models that have one
    ...(m.offersFast ? { fast: true } : {}),
  }
}
