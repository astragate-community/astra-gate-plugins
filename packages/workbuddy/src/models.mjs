// WorkBuddy: the models an account has.
import { api, textOnly } from "./sites.mjs"
import { APP_VERSION, NPM, UA_VERSION } from "./constants.mjs"
import { sign } from "./api.mjs"

// ---- models -----------------------------------------------------------------

// variants are the reasoning levels as OpenCode gives them to the AI SDK.
function variants(efforts) {
  return Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))
}

export function configModels(site) {
  return Object.fromEntries(site.models.map(([id, name, context, efforts]) => [id, {
    name,
    limit: { context, output: 0 },
    tool_call: true,
    ...(efforts ? { reasoning: true, variants: variants(efforts) } : {}),
  }]))
}

export function modelOf(site, provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: api(site), npm: NPM },
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
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(m.efforts),
    // magpie's own: served at no cost to the plan's credits
    free: !!m.free,
    // magpie's own: the credits a request costs, as a multiple (0: none)
    rate: m.rate ?? 0,
  }
}

// liveModels asks WorkBuddy's product config for the plan's models: the
// "cli" agent's list, each with its details. The CLI User-Agent picks
// WorkBuddy's config (a bare WorkBuddy/<v> gets CodeBuddy IDE's, no cli).
// creditsOf reads a model's credits, the multiple WorkBuddy's picker shows
// by it: "x0.03", "0" or 0; "x0.00" is free. A rate it can't read (or
// none, or an infinite one) is undefined: the model is neither free nor
// rated. The same rule as magpie's built-in (wbCredits).
function creditsOf(c) {
  if (c == null || c === "") return undefined
  const s = String(c).trim().toLowerCase().replace(/^x/, "")
  const n = Number(s)
  return s !== "" && Number.isFinite(n) && n >= 0 ? n : undefined
}

export async function liveModels(site, a) {
  const headers = new Headers()
  sign(site, a, headers)
  headers.set("User-Agent", `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`)
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("Accept", "application/json")
  const res = await fetch(site.endpoint + "/v3/config", { headers, signal: AbortSignal.timeout(15000) })
  const env = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${site.name}'s config: HTTP ${res.status}`)
  if (env.code) throw new Error(`${site.name}'s config: ${env.msg} (${env.code})`)
  const cfg = env.data ?? {}
  const out = []
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== "cli") continue
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x) => x.id === id)
      const m = { id, name: d?.name || id }
      if (d) {
        m.context = d.maxInputTokens
        m.output = d.maxOutputTokens
        m.images = d.supportsImages === true && !textOnly(site, id)
        const r = creditsOf(d.credits)
        if (r !== undefined) {
          m.free = r === 0
          m.rate = r
        }
        const es = d.reasoning?.supportedEfforts ?? []
        if (es.length) {
          const canOff = d.reasoning?.canDisableThinking
          m.efforts = [...(!d.onlyReasoning && (canOff == null || canOff) ? ["none"] : []), ...es]
        }
      }
      out.push(m)
    }
  }
  // tell apart models the config names alike: deepseek-v4.1-flash and
  // deepseek-v4.1-flash-sg are both "Deepseek-V4.1-Flash"
  const first = new Map()
  for (const m of out) {
    const id = first.get(m.name)
    if (id === undefined) {
      first.set(m.name, m.id)
      continue
    }
    const rest = m.id.startsWith(id + "-") ? m.id.slice(id.length + 1) : ""
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`
  }
  return out
}