// The models: ZCode's provider config (zcode.z.ai's or an installed ZCode's), a plan's models read from it, and how
// each is declared to OpenCode / magpie.
import { APP_VERSION, MODELS, PROVIDER, START_BASE, START_MODELS, UA, ZAI_BASE, ZCODE } from "./constants.mjs"
import { call } from "./api.mjs"
import { giftID, giftNames, startPlan } from "./gift.mjs"
import { localConfig } from "./local.mjs"
import { plansOf } from "./routing.mjs"
import { stateOf } from "./session.mjs"
import { isBigModel } from "./sites.mjs"
import { platform } from "./util.mjs"

// planID is ZCode's providerId for the plan served at base; a team's plan
// has the individual one's models.
export const planID = (base) =>
  base.includes("/zcode-plan/")
    ? "account:zai-start-plan"
    : isBigModel(base)
      ? "account:bigmodel-individual-coding-plan"
      : "account:zai-individual-coding-plan"

const efforts = (vs) => [...new Set(vs.map((v) => (v === "disabled" ? "none" : v === "enabled" ? "high" : v)))]

// modelsOf is a plan's models in ZCode's provider config.
export function modelsOf(cfg, plan) {
  const c = cfg?.config ?? {}
  const ids = []
  const on = new Set()
  const add = (id) => {
    if (!on.has(id.toLowerCase())) on.add(id.toLowerCase()), ids.push(id)
  }
  for (const r of c.providerConfigRules?.providerRules ?? []) if (r.providerId === plan) (r.builtinModelIds ?? []).forEach(add)
  const off = new Set()
  for (const r of c.modelConfigRules?.builtinProviderModelRules ?? []) {
    if (r.providerId !== plan) continue
    if (r.config?.enabled === false) off.add(String(r.modelId).toLowerCase())
    else add(r.modelId)
  }
  const out = []
  for (const id of ids) {
    if (off.has(id.toLowerCase())) continue
    const m = { id, context: 0, output: 0, efforts: [] }
    for (const r of c.modelConfigRules?.modelRules ?? []) {
      let re
      try {
        re = new RegExp(`^(?:${r.modelMatch})$`, "i")
      } catch {
        continue
      }
      if (!re.test(id)) continue
      const x = r.config ?? {}
      if (x.properties?.contextWindow > 0) m.context = x.properties.contextWindow
      if (x.optionSpecs?.maxOutputTokens?.max > 0) m.output = x.optionSpecs.maxOutputTokens.max
      if (typeof x.properties?.inputFormat?.supportsImage === "boolean") m.image = x.properties.inputFormat.supportsImage
      if (x.optionSpecs?.reasoningLevel?.values?.length) m.efforts = efforts(x.optionSpecs.reasoningLevel.values)
    }
    out.push(m)
  }
  return out
}

// remoteConfig is the release of ZCode's provider config zcode.z.ai names now.
async function remoteConfig() {
  const signal = AbortSignal.timeout(8000)
  const c = await call("GET", `${ZCODE}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platform()}`, { signal })
  const url = c?.configs?.builtin_provider_config_json
  if (!String(url ?? "").startsWith("https://")) throw new Error("ZCode's configs name no provider config")
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal })
  if (!res.ok) throw new Error(`ZCode's provider config: ${res.status}`)
  return res.json()
}

// the config zcodeConfig kept, and when
export const configCache = { cfg: null, at: 0 }

// zcodeConfig is ZCode's provider config, the later of zcode.z.ai's and an
// installed ZCode's, kept for 10 minutes.
export async function zcodeConfig() {
  if (Date.now() - configCache.at < 600_000) return configCache.cfg
  let cfg = null
  try {
    cfg = await remoteConfig()
  } catch {}
  const local = localConfig()
  if (local && (!cfg || (local.revision ?? 0) > (cfg.revision ?? 0))) cfg = local
  configCache.cfg = cfg
  configCache.at = Date.now()
  return cfg
}

// variants are a model's reasoning efforts as @ai-sdk/anthropic options.
const BUDGET = { minimal: 1024, low: 4096, medium: 8192, high: 16_000, max: 31_999 }
function variants(es) {
  const out = {}
  for (const e of es) out[e] = e === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled", budgetTokens: BUDGET[e] ?? 16_000 } }
  return out
}

// entry is a model as a config hook declares it.
export const entry = (m) => ({
  id: m.id,
  name: m.id,
  reasoning: m.efforts.some((e) => e !== "none"),
  tool_call: true,
  attachment: !!m.image,
  modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
  // what ZCode's config names, else 0 (unknown), as magpie's built-in
  limit: { context: m.context || 0, output: m.output || 0 },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  variants: variants(m.efforts),
})

// model is a model as OpenCode's provider hands it to provider.models.
export function model(m, url) {
  const e = entry(m)
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.id,
    api: { id: m.id, url, npm: "@ai-sdk/anthropic" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: e.attachment,
      toolcall: true,
      input: { text: true, image: !!m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: e.variants,
  }
}

// the account's plan's models, as ZCode's config lists them now (the provider hook's `models`)
export async function modelsFor(provider, auth) {
  const s = stateOf(auth)
  if (!s) return provider.models
  const { start, gift: known } = await plansOf(s).catch(() => ({ start: false, gift: null }))
  const gift = start ? await startPlan(s.jwt, s.device).catch(() => null) : known
  const base = start ? START_BASE : s.base
  const cfg = await zcodeConfig().catch(() => null)
  let ms = modelsOf(cfg, planID(base))
  // ZCode's config can't be had: its table stands in, and magpie keeps
  // the list it was told last, as the built-in keeps the one it fetched last
  const fell = !ms.length
  if (fell) ms = start ? START_MODELS : MODELS
  const url = s.base + "/v1"
  const out = Object.fromEntries(ms.map((m) => [m.id, model(m, url)]))
  const details = [...ms, ...modelsOf(cfg, planID(START_BASE)), ...modelsOf(cfg, planID(ZAI_BASE)), ...MODELS]
  const about = (raw) => details.find((m) => m.id.toLowerCase() === raw.toLowerCase()) ?? { efforts: [] }
  const has = new Set(Object.keys(out).map((id) => id.toLowerCase()))
  for (const raw of giftNames(gift)) {
    // a gift-only account's models are its gift's, by their own
    // names, as ZCode lists them (its Start Plan's GLM-5.3, which the
    // plan's config leaves out): every request of it goes to the gift
    // anyway, and the card counts them by that name too (#1261)
    if (start && !has.has(raw.toLowerCase())) {
      const plain = about(raw).id ?? raw
      has.add(raw.toLowerCase())
      out[plain] = model({ ...about(raw), id: plain }, url)
    }
    const id = giftID(raw)
    if (out[id]) continue
    out[id] = model({ ...about(raw), id }, url)
  }
  if (fell) out[Symbol.for("magpie.fellBack")] = true
  return out
}
