// Which Cursor variant (id, parameters, Max Mode) a chat's model, effort and speed run as.
import { LEVEL_RANK, needsMax, tokensOf, valuesOf } from "./models.mjs"

// the effort words of Cursor's own ids and the levels they are; extra-high
// before high
const ID_EFFORTS = [["extra-high", "xhigh"], ["xhigh", "xhigh"], ["minimal", "minimal"], ["none", "none"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"]]

const cut = (s, suffix) => (s.endsWith(suffix) && s.length > suffix.length ? s.slice(0, -suffix.length) : null)

// splitID is one of Cursor's own ids (a variant's legacySlug, as
// cursor-agent models lists it) taken apart: its family, and the effort
// ("" for none named) it is at. Thinking comes before the effort or after
// it; in the family it goes after, as does fast. The family is the id 0.1.x
// listed a model by.
export function splitID(id) {
  let s = id
  let fast = false
  let thinking = false
  let effort = ""
  let b
  if ((b = cut(s, "-fast")) !== null) [s, fast] = [b, true]
  if ((b = cut(s, "-thinking")) !== null) [s, thinking] = [b, true]
  for (const [word, level] of ID_EFFORTS) {
    if ((b = cut(s, "-" + word)) !== null) {
      ;[s, effort] = [b, level]
      break
    }
  }
  if (!thinking && (b = cut(s, "-thinking")) !== null) [s, thinking] = [b, true]
  if (thinking) s += "-thinking"
  if (fast) s += "-fast"
  return [s, effort]
}

// nearest is the variant of vs most like the parameters wanted, one at
// their context size before any other.
function nearest(vs, want) {
  let best
  let most = -1
  for (const v of vs) {
    const have = valuesOf(v)
    const n = Object.keys(want).filter((k) => have[k] === want[k]).length + (have.context === want.context ? 100 : 0)
    if (n > most) [best, most] = [v, n]
  }
  return best
}

// pick is the variant a request runs as: the model's context size, the
// effort asked for (else the default's) and fast as asked, matched against
// Cursor's variants. With no variant that matches, the parameters go as
// they are, from the default's; of a model served in part, as the nearest
// variant the account has. seed is the variant an id of Cursor's own named
// (request), in the default's place.
function pick(entry, effort, fast, seed) {
  const def = entry.def
  const want = { ...valuesOf(seed ?? def) }
  if (entry.size) want.context = entry.size
  if (effort === "off") effort = "none"
  if (entry.pid && entry.pid !== "thinking" && effort === "none" && !("none" in entry.levels) && "thinking" in want) {
    // a Claude asked not to think: thinking off at its default effort
    want.thinking = "false"
  } else if (entry.pid) {
    const at = effort ? fitEffort(effort, Object.keys(entry.levels)) : ""
    if (at && entry.levels[at]) want[entry.pid] = entry.levels[at]
    // a variant named says for itself whether it thinks
    if (!seed && entry.pid !== "thinking" && "thinking" in want && at) want.thinking = "true"
  }
  // fast only when asked: it costs more
  if (entry.fast) want.fast = fast ? "true" : "false"
  const same = (v) => {
    const have = valuesOf(v)
    return Object.keys({ ...have, ...want }).every((k) => have[k] === undefined || want[k] === undefined || have[k] === want[k])
  }
  const v = entry.variants.find(same) ?? (seed ? branch(entry, want) : undefined) ?? (entry.partial ? nearest(entry.variants, want) : undefined)
  const params = Object.entries(v ? { ...want, ...valuesOf(v) } : want).map(([id, value]) => ({ id, value }))
  // no variant: Max Mode when the size is more than Cursor allows outside it
  const maxMode = v ? needsMax(entry.model, v) : needsMax(entry.model, def) || tokensOf(entry.size) > (entry.model.contextTokenLimit || Infinity)
  // the agent API takes the variant's own id (its legacySlug, as
  // cursor-agent models lists it: claude-opus-5-5-high), not the picker's
  // model name; the default's when no variant matched
  const id = v?.legacySlug || def?.legacySlug || entry.run
  return { id, params, maxMode }
}

// branch is, for an id of Cursor's own asked at an effort no variant has
// with the rest of its parameters (claude-opus-5-low at xhigh: Opus 5
// without thinking stops at high), the variant with those parameters at the
// nearest effort it has, not the default's id with parameters that
// contradict it (claude-opus-5-thinking-high with thinking=false). Where
// the default differs from what is asked in the effort alone, and no
// variant at all is named for that effort, the effort goes as asked, as for
// a listed model (claude-opus-5-5-xhigh). When another branch has it, the
// default's own branch stops short there, and its nearest goes (#55).
function branch(entry, want) {
  if (!entry.pid || entry.pid === "thinking") return undefined
  const level = (x) => (x === "extra-high" ? "xhigh" : x)
  const def = valuesOf(entry.def)
  const named = entry.variants.some((v) => level(valuesOf(v)[entry.pid]) === level(want[entry.pid]))
  if (!named && Object.keys(want).every((k) => k === entry.pid || k === "context" || def[k] === undefined || def[k] === want[k])) return undefined
  const vs = entry.variants.filter((v) => {
    const have = valuesOf(v)
    return entry.pid in have && Object.keys(want).every((k) => k === entry.pid || have[k] === undefined || have[k] === want[k])
  })
  const at = fitEffort(level(want[entry.pid]), vs.map((v) => level(valuesOf(v)[entry.pid])))
  return at ? vs.find((v) => level(valuesOf(v)[entry.pid]) === at) : undefined
}

// fitEffort is the nearest effort a model has to the one asked for; max
// for ultra, and none only when asked.
export function fitEffort(want, levels) {
  if (want === "ultra") want = "max"
  if (!levels.length || levels.includes(want)) return want
  const at = LEVEL_RANK.indexOf(want)
  if (at < 0) return ""
  let best = ""
  let dist = LEVEL_RANK.length
  for (const l of levels) {
    const i = LEVEL_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// named is the model and variant an id the list doesn't have stands for,
// when it is one of Cursor's own, as the CLI reads one and as 0.1.x listed
// them, so a model picked before the list changed still runs: a variant's
// own id (claude-opus-5-5-high) is that variant; a family of them, the id
// 0.1.x listed (claude-opus-5-5, claude-opus-5-5-fast, cursor-grok-4.6,
// or with an effort the account lacks), is the family's variant nearest
// the default, fast when the family is and at the id's effort; the picker's
// name for a model, or a legacy slug of it, is its default. Each at the
// variant's context size, the default's when the id doesn't say.
function named(raw, id) {
  const models = raw.filter((e, i) => raw.findIndex((x) => x.model === e.model) === i)
  const at = (e, v) => raw.find((x) => x.model === e.model && x.size === (valuesOf(v).context ?? "")) ?? e
  const as = (e, vs, effort) => {
    const seed = nearest(vs, valuesOf(e.def))
    return { entry: at(e, seed), seed, effort, fast: valuesOf(seed).fast === "true" }
  }
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug === id)
    if (vs.length) return as(e, vs, "")
  }
  const [family, effort] = splitID(id)
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug && splitID(v.legacySlug)[0] === family)
    if (vs.length) return as(e, vs, effort)
  }
  for (const e of models) {
    const m = e.model
    if ([m.name, ...(m.legacySlugs ?? []), ...(m.idAliases ?? [])].includes(id)) return { entry: at(e, e.def), seed: undefined, effort: "", fast: false }
  }
  return null
}

// request is how a chat's model is asked of Cursor: the variant's own id,
// its parameters and its mode. An id the list doesn't have that is one of
// Cursor's own goes as the variant it names, at the effort asked for, fast
// when it says so or the request does; any other goes as it is named.
export function request(raw, model, effort, fast) {
  const entry = raw.find((m) => m.id === model)
  if (entry) return pick(entry, effort, fast)
  const old = named(raw, model)
  if (old) return pick(old.entry, effort || old.effort, fast || old.fast, old.seed)
  return { id: model === "auto" ? "default" : model, params: [], maxMode: false }
}
