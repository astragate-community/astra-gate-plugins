// Antigravity: the model list, and how a model is declared to OpenCode / magpie.
import { BASE, GEMINI, HIDDEN, ID, INTERNAL } from "./constants.mjs"
import { availableModels } from "./api.mjs"

// Until the account's own list is read (and when it can't be): models Antigravity has offered, as it names them
export const MODELS = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", reasoning: true, images: true },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", reasoning: true, images: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: true, images: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, images: true },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", reasoning: true, images: true },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", reasoning: true, images: true },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", reasoning: true, images: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", images: true },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]

// the effort words of Antigravity's ids, and the level each is
const EFFORT_WORDS = [["extra-high", "xhigh"], ["extra-low", "minimal"], ["xhigh", "xhigh"], ["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"]]

/** The level an id says it thinks at ("gemini-3.7-flash-low" is low), "" for an id that says none. */
export function levelOfId(id) {
  for (const [word, level] of EFFORT_WORDS) if (id.endsWith("-" + word)) return level
  return ""
}

/** The model an id with an effort word is a level of ("gemini-3.7-flash-low" is gemini-3.7-flash). */
export function familyOf(id) {
  for (const [word] of EFFORT_WORDS) if (id.endsWith("-" + word)) return id.slice(0, -word.length - 1)
  return id
}

export const isClaude = (id) => /^claude/i.test(id)
export const isImageModel = (id) => /image/i.test(id)

/** Does the model think: Gemini's do, Claude's and GPT-OSS's do where the id says a level or "thinking". */
export const thinks = (id) => !isImageModel(id) && (/^gemini/i.test(id) || /thinking/i.test(id) || levelOfId(id) !== "" || /^gpt-oss/i.test(id))

// What a request for `id` is sent as. Antigravity lists some models once for each level it serves them at, with no
// id for the family: "gemini-3.7-flash" alone is a 404, "gemini-3.7-flash-high" is the model. A request for a bare
// family goes out as the variant of the level it asked for (else the highest there is).
export function resolveModel(id, known, level = "") {
  if (!known?.size || known.has(id)) return id
  const order = [level, "high", "medium", "low", "xhigh", "minimal"].filter(Boolean)
  for (const l of order) if (known.has(`${id}-${l}`)) return `${id}-${l}`
  return id
}

// each account's list of ids, by its project, for resolveModel
const catalogs = new Map()
export const remember = (project, list) => {
  if (project && list?.length) catalogs.set(project, new Set(list.map((m) => m.id)))
}
export const knownFor = (project) => catalogs.get(project)

const num = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)

/**
 * The models fetchAvailableModels lists, in the order of Antigravity's own picker, without those that aren't for chat.
 * Gives [{ id, name, context, output, images, reasoning, remaining, resets }].
 */
export function parseModels(res) {
  const rank = new Map()
  for (const s of Array.isArray(res?.agentModelSorts) ? res.agentModelSorts : [])
    for (const g of Array.isArray(s?.groups) ? s.groups : []) for (const id of Array.isArray(g?.modelIds) ? g.modelIds : []) if (!rank.has(id)) rank.set(id, rank.size + 1)
  const list = []
  for (const [id, m] of Object.entries(res?.models ?? {})) {
    if (HIDDEN.has(id) || INTERNAL.test(id)) continue
    const q = m?.quotaInfo
    list.push({
      id,
      name: typeof m?.displayName === "string" && m.displayName ? m.displayName : id,
      context: num(m?.maxTokens),
      output: num(m?.maxOutputTokens),
      images: m?.supportsImages === true,
      reasoning: thinks(id),
      // a model Antigravity leaves the fraction out of has none of its allowance left
      remaining: q ? (typeof q.remainingFraction === "number" ? q.remainingFraction : 0) : -1,
      resets: typeof q?.resetTime === "string" ? q.resetTime : "",
    })
  }
  const place = (m) => rank.get(m.id) ?? Infinity
  return list.sort((a, b) => place(a) - place(b) || a.id.localeCompare(b.id))
}

// An account's list is asked of Antigravity once in a while, not each time the host wants it (it wants it for every
// listing of providers, and Google counts the calls)
const LIST_TTL = 5 * 60 * 1000
const listed = new Map() // by project: { at, list } or { at, pending }

/** Forgets the lists asked for (tests). */
export const forgetLists = () => listed.clear()

/** The account's models, from Antigravity; throws when it lists none. */
export async function listModels({ token, project, tier, paid }) {
  const held = listed.get(project)
  if (held && Date.now() - held.at < LIST_TTL) return held.pending ?? held.list
  const pending = availableModels(token, project, [paid, tier]).then((res) => {
    const list = parseModels(res)
    if (!list.length) throw new Error("Antigravity listed no models for this account")
    remember(project, list)
    return list
  })
  listed.set(project, { at: Date.now(), pending })
  try {
    const list = await pending
    listed.set(project, { at: Date.now(), list })
    return list
  } catch (e) {
    listed.delete(project)
    throw e
  }
}

export function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(m.reasoning ? { reasoning: true } : {}),
    tool_call: true,
  }
}

export function runtimeModel(m) {
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: BASE, npm: GEMINI },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}
