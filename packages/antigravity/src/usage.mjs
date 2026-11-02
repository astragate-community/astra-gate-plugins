// Antigravity: the allowance card — each model's share of the account's quota, and the plan.
import { isClaude, isImageModel } from "./models.mjs"

// Antigravity's quotas are shared by families of models, so a card of one line per model would say the same thing many times
function bucketOf(m) {
  if (isClaude(m.id) || /^gpt-oss/i.test(m.id)) return "Claude and GPT-OSS"
  if (isImageModel(m.id)) return "Gemini image"
  if (/pro/i.test(m.id)) return "Gemini Pro"
  if (/flash/i.test(m.id)) return "Gemini Flash"
  return m.name
}

/** The plan as it is named: Google's own name for it, else the tier's. */
export function planName(load) {
  const named = load?.paidTier?.name || load?.currentTier?.name
  if (named) return String(named)
  const id = String(load?.paidTier?.id ?? load?.paidTier ?? load?.currentTier?.id ?? load?.currentTier ?? "")
  if (!id || id === "free-tier") return id ? "Free" : ""
  const m = /^g1-(ultra|pro)(?:-|$)/.exec(id)
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : id
}

/** The AI credits of the plan, as a line of text; "" when it has none. */
export function balanceOf(load) {
  const credits = Array.isArray(load?.paidTier?.availableCredits) ? load.paidTier.availableCredits : []
  const lines = credits.filter((c) => Number(c?.creditAmount) > 0).map((c) => `${Number(c.creditAmount).toLocaleString("en-US")} ${c.creditType === "GOOGLE_ONE_AI" ? "AI credits" : String(c.creditType ?? "credits")}`)
  return lines.join(", ")
}

/** The card: one window per family of models, as full as the fullest of them is. */
export function usageOf(models, load, user) {
  const buckets = new Map()
  for (const m of models) {
    if (m.remaining < 0) continue // no allowance told
    const b = buckets.get(bucketOf(m)) ?? { name: bucketOf(m), models: [], remaining: 1, resets: "" }
    b.models.push(m.id)
    if (m.remaining <= b.remaining) {
      b.remaining = m.remaining
      b.resets = m.resets
    }
    buckets.set(b.name, b)
  }
  const windows = [...buckets.values()].map((b) => ({
    name: b.name,
    used: Math.round((1 - b.remaining) * 1000) / 10,
    ...(b.resets ? { resetsAt: b.resets } : {}),
    display: `${Math.round(b.remaining * 100)}% left`,
    models: b.models,
  }))
  const balance = balanceOf(load)
  return { plan: planName(load), ...(user ? { user } : {}), ...(balance ? { balance } : {}), windows }
}
