// Devin's models as families of variants, one variant per effort: reading the CLI's list, picking the variant a
// request's effort asks for, and the list as it is offered.
import { SNAPSHOT } from "./snapshot.mjs"

export const familiesOf = (rows) => rows.map(([uid, label, aliases, vs]) => ({ uid, label, aliases, models: vs.map(([id, name, context, output]) => ({ id, name, context, output })) }))

// Devin's list as of SNAPSHOT, for when the CLI can't be asked.
export const snapshotFamilies = () => familiesOf(SNAPSHOT)

// parseFamilies reads `devin models list --format json`.
export function parseFamilies(text) {
  let list
  try {
    list = JSON.parse(text)
  } catch {
    return []
  }
  const out = []
  for (const f of list?.families ?? []) {
    if (!f?.family_uid) continue
    const low = String(f.family_uid).toLowerCase()
    if (low === "adaptive" || low === "fusion") continue
    out.push({
      uid: f.family_uid,
      label: f.family_label || f.family_uid,
      aliases: f.aliases ?? [],
      models: (f.variants ?? [])
        .filter((v) => v?.model_uid)
        .map((v) => ({ id: v.model_uid, name: v.label || v.model_uid, context: v.max_context_tokens || 0, output: v.max_output_tokens || 0 })),
    })
  }
  return out
}

const LEVEL_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
// the effort words Devin's variant ids end in (swe-2-high, …_HIGH,
// gpt-6-sol-none), and the level each is
const LEVELS = [["none", "none"], ["xhigh", "xhigh"], ["minimal", "minimal"], ["min", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"]]
// the words a variant id may end in after its effort, for a quicker run of
// the same model at it (claude-opus-5-5-high-fast)
const TIERS = [["fast", "Fast"], ["priority", "Priority"]]

// levelOf is the effort an id says it runs at, "" when it says none.
function levelOf(id) {
  const low = id.toLowerCase()
  for (const [word, level] of LEVELS) if (low.endsWith("-" + word) || low.endsWith("_" + word)) return level
  return ""
}

// tierOf is the tier an id is in and its effort: claude-opus-5-5-high-fast
// is ["fast", "high"], swe-2-high ["", "high"]; a tier word with no effort
// before it (swe-1-6-fast) is no tier.
function tierOf(id) {
  const low = id.toLowerCase()
  for (const [word] of TIERS)
    for (const sep of ["-", "_"])
      if (low.endsWith(sep + word)) {
        const l = levelOf(low.slice(0, -(sep + word).length))
        if (l) return [word, l]
      }
  return ["", levelOf(id)]
}

const named = (f, id) => f.uid === id || f.aliases.includes(id)

// byLevel is the family's variant at each effort, in the tier, the first
// at each.
function byLevel(f, tier) {
  const out = {}
  for (const m of f.models) {
    const [t, l] = tierOf(m.id)
    if (t === tier && l && m.id !== f.uid && !out[l]) out[l] = m.id
  }
  return out
}

const efforts = (f, tier) => {
  const by = byLevel(f, tier)
  return LEVEL_RANK.filter((l) => by[l])
}

const tiers = (f) => TIERS.map(([w]) => w).filter((t) => Object.keys(byLevel(f, t)).length > 0)

// defaultLevel is the effort of the variant the family's id asks for when
// none is asked (its first), medium when that names none.
function defaultLevel(f) {
  if (f.models.length) {
    const [t, l] = tierOf(f.models[0].id)
    if (!t && l) return l
  }
  return "medium"
}

// nearest is the one of levels nearest the one asked for, a tie going up.
function nearest(want, levels) {
  const at = LEVEL_RANK.indexOf(want)
  if (at < 0 || !levels.length || levels.includes(want)) return want
  let best = want
  let dist = LEVEL_RANK.length
  for (const l of levels) {
    const i = LEVEL_RANK.indexOf(l)
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// variantFor is the model to ask the API for: a family's id follows its
// newest model, which the API takes only as one of its variants — the one
// at the effort asked for, or the nearest the family has; with none asked,
// the family's default. A family's fast run is its fast variant at that
// effort. Any other id (a variant's own) goes as it is.
export function variantFor(families, model, effort) {
  for (const f of families) {
    if (!named(f, model) || !f.models.length) continue
    if (effort) {
      const id = byLevel(f, "")[nearest(effort, efforts(f, ""))]
      if (id) return id
    }
    return f.models[0].id
  }
  for (const f of families)
    for (const tier of tiers(f)) {
      if (!model.endsWith("-" + tier) || !named(f, model.slice(0, -(tier.length + 1)))) continue
      const by = byLevel(f, tier)
      const levels = efforts(f, tier)
      return by[nearest(effort || defaultLevel(f), levels)] || by[levels[0]]
    }
  return model
}

// listed is Devin's list as it is offered: each family one model, with
// the efforts its variants are at (picked as any model's effort is, and
// turned into the variant by variantFor), its fast run likewise, and the
// variants at no effort (glm-5-2-1m); a family's only variant is its id.
// A variant in keep (one the user picked: swe-2-medium) stays, at the one
// effort its id is at, and goes to Devin as it is, as magpie's built-in
// keeps it (devinCollapse).
// Each entry says whether it takes images (image) as images, Devin's word
// for each variant id, gives it: a variant its own, a family (and its fast
// run) what all its variants Devin named say; undefined when Devin said
// nothing of it or its variants disagree.
export function listed(families, keep = [], images = {}) {
  const out = []
  const seen = new Set()
  const add = (m) => {
    if (seen.has(m.id)) return
    seen.add(m.id)
    out.push(m)
  }
  for (const f of families) {
    const context = f.models.find((m) => m.context)?.context ?? 0
    const output = f.models.find((m) => m.output)?.output ?? 0
    const image = familyImages(f, images)
    add({ id: f.uid, name: f.label, context, output, efforts: efforts(f, ""), image })
    for (const t of tiers(f)) {
      const id = f.uid + "-" + t
      if (families.some((g) => named(g, id))) continue
      add({ id, name: f.label + " " + TIERS.find(([w]) => w === t)[1], context, output, efforts: efforts(f, t), image })
    }
    if (f.models.length === 1) continue
    for (const m of f.models) {
      if (m.id === f.uid || tierOf(m.id)[1]) continue
      add({ id: m.id, name: m.name, context: m.context || context, output: m.output || output, efforts: [], image: images[m.id] })
    }
  }
  for (const id of keep) {
    if (seen.has(id)) continue
    const f = families.find((g) => g.models.some((m) => m.id === id))
    const m = f?.models.find((m) => m.id === id)
    const level = tierOf(id)[1]
    if (!m && !level) continue
    add({ id, name: m?.name || id, context: m?.context ?? 0, output: m?.output ?? 0, efforts: level ? [level] : [], image: images[id] })
  }
  return out
}

// familyImages is what a family's variants Devin named all say of images.
function familyImages(f, images) {
  let said
  for (const m of f.models) {
    const v = images[m.id]
    if (typeof v !== "boolean") continue
    if (said !== undefined && said !== v) return undefined
    said = v
  }
  return said
}

// effortOf is the effort a request names, as magpie reads it.
export function effortOf(s) {
  const e = String(s ?? "").trim().toLowerCase()
  // none and minimal go as given: the family's variant nearest them, as
  // magpie's built-in picks it (devinVariantIn)
  if (LEVEL_RANK.includes(e)) return e
  if (e === "ultra") return "max"
  return ""
}
