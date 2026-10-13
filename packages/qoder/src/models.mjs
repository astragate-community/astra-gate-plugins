// Qoder: the model list — reading a listing's entries (price, windows, efforts), asking for it, and the shapes
// OpenCode and magpie take it in.
import { CHAT, MODELS_PATH } from "./constants.mjs"
import { cosyHeaders } from "./cosy.mjs"
import { siteOf } from "./sites.mjs"
import { listingKey } from "./session.mjs"

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]

// freeOf reads whether a model costs the plan no credits: a price_factor
// (the credits a request costs, as a multiple; priceFactor in camel case)
// of 0, the price Qoder's own client shows ("0×"). is_free is no word on
// that: Qoder's listing has it true on Qwen3.8-Max at 0.5×, an off-peak
// discount (错峰 4 折) on it, and Qoder's client shows the price, not it.
// It is taken only from a listing with no price at all. A price of 0 for
// the while an active promotion lasts, with a price before it, is a
// discount, not a free model; a limited-time free model (Qwen3.8-Flash:
// 0×, its original_price_factor 0.1 struck through) is free while it is.
export function freeOf(raw) {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price === "number" && Number.isFinite(price)) {
    if (price !== 0) return false
    const p = raw.promotion ?? raw.prommotion
    const before = p?.before_promotion_price_factor ?? p?.beforePromotionPriceFactor
    return !(p?.active === true && typeof before === "number" && before > 0)
  }
  return (raw.is_free ?? raw.isFree) === true
}

// rateOf reads a model's price as Qoder's client shows it beside the model
// (magpie shows it in its lists, so the cheap ones can be picked without
// opening Qoder): rate, the price_factor (0.5×), and rateWas, the price
// struck through beside it while a discount runs: an active promotion's
// before_promotion_price_factor, else an original_price_factor above the
// price (Qwen3.8-Flash: 0×, 0.1× struck through). A promotion's 0 that
// isn't free is its price before times its discount_factor. A listing with
// no price gives none (0). The same rule as magpie's built-in
// (internal/qoder/models.go, ModelInfo.free).
export function rateOf(raw) {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price !== "number" || !Number.isFinite(price)) return { rate: 0, rateWas: 0 }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const p = raw.promotion ?? raw.prommotion
  const before = p?.before_promotion_price_factor ?? p?.beforePromotionPriceFactor
  const discount = num(p?.discount_factor) || num(p?.discountFactor)
  const discounted = p?.active === true && typeof before === "number" && before > 0
  let rate = Math.max(price, 0)
  let rateWas = Math.max(num(raw.original_price_factor), num(raw.originalPriceFactor))
  if (discounted) {
    rateWas = before
    if (rate === 0) rate = before * discount
  }
  if (rateWas <= rate) rateWas = 0
  return { rate, rateWas }
}

// windowsOf reads the context windows a listing entry offers, smallest
// first, and the one Qoder's client picks unless asked for another:
// context_config's entries ({"200k": {token_count: 200000, is_default:
// true}, "1m": {token_count: 1000000}, …}), else available_context_windows,
// as Qoder's client reads them (qodercli's catalog). Qoder's Context
// setting (200K / 400K / 1M) offers them on Qwen3.8-Flash and the rest;
// max_input_tokens (180K there) is only what a request that names none
// gets.
export function windowsOf(raw) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0)
  const windows = []
  let def = 0
  const cc = raw?.context_config ?? raw?.contextConfig
  if (cc && typeof cc === "object" && !Array.isArray(cc)) {
    for (const e of Object.values(cc)) {
      const t = n(e?.token_count)
      if (!t) continue
      if (!windows.includes(t)) windows.push(t)
      if (e.is_default === true || e.is_default === 1 || e.is_default === "1") def = t
    }
  }
  if (!windows.length) {
    const list = raw?.available_context_windows ?? raw?.availableContextWindows
    for (const v of Array.isArray(list) ? list : []) if (n(v) && !windows.includes(v)) windows.push(v)
    def = n(raw?.default_context_window ?? raw?.defaultContextWindow)
    if (!windows.includes(def)) def = 0
  }
  windows.sort((a, b) => a - b)
  return { windows, defaultWindow: def }
}

// modelInfo reads one entry of the listing's "chat" array: its efforts and
// default from thinking_config (is_reasoning alone when it has none), and
// its context: the largest window it offers (windowsOf), since a request
// that needs more than the default is sent a larger one (windowFor).
export function modelInfo(raw) {
  const { windows, defaultWindow } = windowsOf(raw)
  const m = {
    key: raw.key,
    source: raw.source ?? "",
    name: raw.display_name || raw.key,
    images: !!raw.is_vl,
    context: windows.length ? windows[windows.length - 1] : raw.max_input_tokens || 0,
    windows,
    defaultWindow,
    thinks: !!raw.is_reasoning,
    alwaysThinks: false,
    efforts: Array.isArray(raw.reasoning_efforts) ? [...raw.reasoning_efforts] : [],
    defaultEffort: "",
    free: freeOf(raw),
    ...rateOf(raw),
    config: raw,
  }
  const tc = raw.thinking_config
  if (tc && typeof tc === "object") {
    m.thinks = tc.enabled != null
    m.alwaysThinks = m.thinks && tc.disabled == null
    m.efforts = []
    if (m.thinks) {
      for (const [name, e] of Object.entries(tc.enabled.efforts ?? {})) {
        m.efforts.push(name)
        if (e?.is_default) m.defaultEffort = name
      }
      const rank = (s) => (EFFORT_ORDER.includes(s) ? EFFORT_ORDER.indexOf(s) : EFFORT_ORDER.length)
      m.efforts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    }
  }
  return m
}

// sceneModels is the models an agent can pick from the listing: the "app"
// scene's, which is what Qoder's app shows and what a request names
// (qoderBody's product and session_type "app"), in its order, then any
// "chat" model the app no longer lists, after the model it followed there,
// so a pick made before stays served. On 2026-10-12 the app listed Fast
// (fast, 0.8×) where Performance (1.1×) had been, and chat still listed
// Performance (magpie-community/plugins#97). A listing with only one scene
// gives that one. Each key once: the app's entry wins.
export function sceneModels(listing) {
  const app = Array.isArray(listing?.app) ? listing.app : []
  const chat = Array.isArray(listing?.chat) ? listing.chat : []
  const out = [...app]
  let after = -1
  for (const m of chat) {
    const i = out.findIndex((x) => x?.key === m?.key)
    if (i >= 0) {
      after = i
      continue
    }
    out.splice(++after, 0, m)
  }
  return out
}

// modelInfos is the listing's enabled models an agent can pick: "auto"
// and "default" route inside Qoder and aren't one model.
export function modelInfos(listing) {
  return sceneModels(listing)
    .filter((m) => m?.enable && !["", "auto", "default"].includes(String(m.key ?? "").trim()))
    .map(modelInfo)
}

async function fetchListing(site, cred) {
  const url = site.api + MODELS_PATH
  const res = await fetch(url, { headers: cosyHeaders(url, cred, ""), signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${site.name} models: HTTP ${res.status}: ${text.trim().slice(0, 512)}`)
  return JSON.parse(text)
}

/** A plugin's cache of each account's listing (the model configs a request carries): `(cred, again) => models`. */
export function createListings(site) {
  const listings = new Map()
  return async (cred, again = false) => {
    const key = listingKey(cred)
    let l = listings.get(key)
    if (!l || again) {
      l = modelInfos(await fetchListing(siteOf(site, cred), cred))
      listings.set(key, l)
    }
    return l
  }
}

/** A built-in model as the `config` hook gives it. */
export function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(m.efforts?.length ? { reasoning: true, variants: effortVariants(m.efforts) } : {}),
    tool_call: true,
  }
}

const effortVariants = (efforts) => Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))

/** A model as the provider's `models` hook gives it at run time. */
export function runtimeModel(site, m) {
  return {
    id: m.id,
    providerID: site.id,
    name: m.name ?? m.id,
    api: { id: m.id, url: site.api, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: 0 },
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
    variants: effortVariants(m.efforts ?? []),
    // magpie's own: served at no cost to the plan's credits
    free: !!m.free,
    // magpie's own: the credits a request costs, as a multiple, and the
    // price before a discount running now (0: none)
    rate: m.rate ?? 0,
    rateWas: m.rateWas ?? 0,
  }
}

/**
 * The `models` hook's answer for an account's listing: each model keyed by its Qoder key, as the runtime shape.
 * (The listing's models name their efforts only when they think.)
 */
export function runtimeModels(site, listing) {
  return Object.fromEntries(
    listing.map((m) => [m.key, runtimeModel(site, { id: m.key, name: m.name, context: m.context, images: m.images, efforts: m.thinks ? m.efforts : [], free: m.free, rate: m.rate, rateWas: m.rateWas })]),
  )
}
