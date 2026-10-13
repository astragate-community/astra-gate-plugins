// Trae: the model lists — which entries are models to chat with, which function and __dev / __max model asks for
// each, and the models as OpenCode's provider carries them.
import { MAX, MODEL } from "./constants.mjs"
import { batchLists, listOf } from "./api.mjs"
import { Expired } from "./errors.mjs"

// chatModel: an entry of a function's list that is a model to chat with.
// The lists also hold the IDE's own helpers (summary, fast_apply, title
// generation: usage other than chat_completion), configs switched off, and
// the slots of custom models, which need a provider bound in the IDE.
export function chatModel(m, site) {
  const id = String(m?.config_name ?? "")
  if (!id || /^custom_model/i.test(id)) return false
  if (m.usage && m.usage !== "chat_completion") return false
  if (m.config_switch === false) return false
  if (m.is_custom_model === true || m.display_config?.is_custom_model === true) return false
  // the IDE's own picker hides these: Auto-mode routing channels and
  // pay-as-you-go twins of another entry (gemini-3.1-pro vs -paygo/-auto,
  // the search_agent family), not entries to pick by hand
  if (site?.hidesInvisible && m.is_invisible_to_user === true) return false
  return true
}

// devModel is the model an entry serves requests with: its __dev one
export const devModel = (m) => (Array.isArray(m?.model_detail_list) ? m.model_detail_list : []).find((d) => /__dev$/.test(String(d?.model_name ?? "")))

// maxModel is a model's Max mode, from the entries its lists give it (the
// one it is asked through first): the first __max model one names, and the
// window context_window_tokens.max gives it, when that is bigger than dev's.
// The lists needn't agree: chat_v3 can name the __max model while the SOLO
// list the model is asked through names only __dev, and the window can be
// another entry's again. A model with no __max, or no bigger window, has no
// Max.
export const maxModel = (...ms) => {
  const details = (m) => (Array.isArray(m?.model_detail_list) ? m.model_detail_list : [])
  const at = ms.find((m) => details(m).some((d) => /__max$/.test(String(d?.model_name ?? ""))))
  if (!at) return null
  const d = details(at).find((d) => /__max$/.test(String(d?.model_name ?? "")))
  const first = (k) => [at, ...ms].map((m) => Number(m?.context_window_tokens?.[k]) || 0).find((n) => n > 0) || 0
  const window = first("max")
  return window > first("dev") ? { name: String(d.model_name), most: Number(d.max_tokens) || 0, window, entry: at } : null
}

const nameOf = (m) => String(m.display_config?.display_name || m.display_name || m.display_model_name || m.config_name)

// liveLists is every chat function's model list: from batch_get_detail_param, as TRAE SOLO CN asks them;
// when that gives none, from get_detail_param, one function at a time. One function's list failing leaves
// the others'; all failing is the error.
async function liveLists(a, site) {
  let lists = null
  try {
    lists = await batchLists(a, site)
  } catch (e) {
    if (e instanceof Expired) throw e
  }
  if (!lists) {
    const got = await Promise.allSettled(site.functions.map((fn) => listOf(a, site, fn)))
    const expired = got.find((g) => g.status === "rejected" && g.reason instanceof Expired)
    if (expired) throw expired.reason
    if (got.every((g) => g.status === "rejected")) throw got[0].reason
    lists = {}
    got.forEach((g, i) => {
      if (g.status === "fulfilled") lists[site.functions[i]] = g.value
    })
  }
  return lists
}

// chooseModels is the account's model list out of the functions' lists: every chat function's, since
// SOLO lists models the classic IDE's chat_v3 doesn't (deepseek-v4.1-flash
// came to the TRAE agent's first, yetone/magpie#681); a model listed by one function
// only is asked through that one.
//
// A model several functions list is asked through the first whose entry
// names a __dev model (one Trae serves) and isn't misnamed, else the
// first that names one, else the first.
//
// Each choice is { id, m, fn, dev }: the entry, the function it is asked through and its __dev model; and,
// unless the lists have a "<id>-max" entry of their own, { max, maxFn }: its Max (null: none) and the
// function that Max is asked through.
export function chooseModels(lists, site) {
  // a function can give a model another's name: chat_v3 calls
  // deepseek-v4.1-flash "DeepSeek-V4-Flash 正式版", as it does
  // DeepSeek-V4-Flash-Official, where SOLO's lists call it
  // DeepSeek-V4.1-Flash (yetone/magpie#681) — Trae's usage page then books
  // a request under the name of the list it was served through. Such an
  // entry is misnamed: its name is another model's in the same list, and
  // other lists name it otherwise.
  const names = new Map() // id → the names its lists give it, and how many give each
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!chatModel(m, site)) continue
      const id = String(m.config_name), name = nameOf(m)
      const by = names.get(id) ?? new Map()
      by.set(name, (by.get(name) ?? 0) + 1)
      names.set(id, by)
    }
  }
  // the name most of a model's lists give it: the one Trae's own client is
  // served under, and so the one its usage page books it as. Trae renames
  // entries when it likes, and its 2026-10-09 rename of
  // DeepSeek-V4-Flash-Official left chat_v3 the only list still calling
  // deepseek-v4.1-flash by another's name — which neither signal above
  // catches. A tie leaves the name to its entry.
  const agreed = new Map() // id → that name, "" when the lists tie
  for (const [id, by] of names) {
    const top = Math.max(...by.values())
    const most = [...by].filter(([, n]) => n === top)
    agreed.set(id, most.length === 1 ? most[0][0] : "")
  }
  const misnamed = (fn, m) => {
    const id = String(m.config_name), name = nameOf(m)
    return names.get(id).size > 1 && (lists[fn] ?? []).some((o) => chatModel(o, site) && String(o.config_name) !== id && nameOf(o) === name)
  }
  // a function's entry is worth more when it names a __dev model, then
  // when it isn't misnamed, then when it carries the name its lists agree
  // on; the first of the best is taken
  const worth = (fn, m) => (devModel(m) ? 2 : 0) + (misnamed(fn, m) ? 0 : 1) + (nameOf(m) === agreed.get(String(m.config_name)) ? 1 : 0)
  const out = new Map()
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!chatModel(m, site)) continue
      const id = String(m.config_name)
      const was = out.get(id)
      if (!was || worth(fn, m) > was.worth) out.set(id, { m, fn, worth: worth(fn, m) })
    }
  }
  const chosen = []
  for (const [id, { m, fn }] of out) {
    const choice = { id, m, fn, dev: devModel(m) }
    chosen.push(choice)
    if (out.has(id + MAX)) continue
    // its Max is asked through the function whose entry names the __max
    // model, the entries carrying the agreed name first: Trae books the
    // Max under that name too
    const plain = (e) => (nameOf(e.m) === agreed.get(id) ? 0 : 1)
    const entries = [{ m, fn }, ...site.functions.flatMap((f) => (lists[f] ?? []).filter((o) => o !== m && chatModel(o, site) && String(o.config_name) === id).map((o) => ({ m: o, fn: f })))].sort((a, b) => plain(a) - plain(b))
    choice.max = maxModel(...entries.map((e) => e.m))
    if (choice.max) choice.maxFn = entries.find((e) => e.m === choice.max.entry).fn
  }
  return chosen
}

// modelOf is a model of the account's list as OpenCode's provider
// carries one. A model of the site's fallback list has capabilities
// already (magpie's host spreads the config's into them); one the list
// doesn't have gets them from MODEL's flat fields, so that magpie reads
// it as a model that reasons rather than one that doesn't (its host
// reads capabilities.reasoning alone, host.js). The fallback list stays
// the authority where it has an entry.
export function modelOf(site, provider, m) {
  const id = String(m.config_name)
  const was = provider.models?.[id] ?? {}
  // context_window_tokens: dev is what a request gets, max only in Max mode
  const ctx = Number(m.context_window_tokens?.dev ?? m.context_window_size?.max?.[0] ?? m.context_window_size?.max ?? m.context_window_tokens?.max ?? m.prompt_max_tokens) || was.limit?.context || MODEL.limit.context
  const out = Number(devModel(m)?.max_tokens) || was.limit?.output || 0
  const name = m.display_config?.display_name || m.display_name || m.display_model_name || was.name || id
  const input = (k) => (MODEL.modalities?.input ?? []).includes(k)
  return {
    ...MODEL, ...was, id, providerID: site.id, name: String(name), limit: { context: ctx, output: out },
    api: was.api ?? { id, url: site.hosts.api, npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      ...(was.capabilities ?? {}),
      reasoning: was.capabilities?.reasoning ?? MODEL.reasoning,
      temperature: was.capabilities?.temperature ?? MODEL.temperature,
      attachment: was.capabilities?.attachment ?? MODEL.attachment,
      toolcall: was.capabilities?.toolcall ?? MODEL.tool_call,
      input: was.capabilities?.input ?? { text: true, image: input("image"), audio: input("audio"), video: input("video"), pdf: input("pdf") },
      output: was.capabilities?.output ?? { text: true, image: false, audio: false, video: false, pdf: false },
    },
    // Trae's request takes no effort or thinking level, so a model has
    // none to pick from (see the README's Reasoning)
    variants: was.variants ?? {},
  }
}

/**
 * What one plugin instance knows of the account's models from the list it last read: the function whose list has
 * each model, the __dev (or __max) model it is asked as there, and the Max each model has (null: none).
 */
export function createCatalog(site) {
  // the chat function whose model list has each model, and the __dev
  // model it names there
  const listedBy = new Map()
  const modelNames = new Map()
  // the Max each model the list last read has (null: none)
  const maxes = new Map()

  // live is the account's model list (the entries), remembered
  const live = async (a) => {
    const chosen = chooseModels(await liveLists(a, site), site)
    for (const { id, fn, dev, max, maxFn } of chosen) {
      listedBy.set(id, fn)
      if (dev) modelNames.set(id, { fn, name: dev.model_name, most: Number(dev.max_tokens) || 0 })
      else modelNames.delete(id)
      if (max === undefined) continue // the lists have its Max entry of their own
      maxes.set(id, max)
      if (max) {
        listedBy.set(id + MAX, maxFn)
        modelNames.set(id + MAX, { fn: maxFn, name: max.name, most: max.most, max: { base: id, window: max.window } })
      } else {
        listedBy.delete(id + MAX)
        modelNames.delete(id + MAX)
      }
    }
    return chosen.map((c) => c.m)
  }

  // models are the provider's models for a list read by live: each, and its Max where it has one
  const models = (provider, ms) => {
    const ids = new Set(ms.map((m) => String(m.config_name)))
    return Object.fromEntries(ms.flatMap((m) => {
      const id = String(m.config_name)
      const own = modelOf(site, provider, m)
      const max = maxes.get(id)
      if (!max || ids.has(id + MAX)) return [[id, own]]
      // its Max, a model of its own: the window and output Max mode gives
      const was = provider.models?.[id + MAX] ?? {}
      return [[id, own], [id + MAX, { ...own, ...was, id: id + MAX, name: own.name + " (Max)", limit: { context: max.window, output: max.most || own.limit.output }, api: { ...own.api, id: id + MAX } }]]
    }))
  }

  return { listedBy, modelNames, live, models }
}
