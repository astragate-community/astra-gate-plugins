// Antigravity: how hard the model thinks, and how much it may write.
import { isClaude, isImageModel, levelOfId } from "./models.mjs"

const MAX_OUTPUT = { claude: 64000, other: 65536 }
const FLASH_25_BUDGET = 24576
const LEVELS = new Set(["minimal", "low", "medium", "high"])

// The major version in a Gemini model's id: gemini-4-argon, gemini-3.8-flash, gemini-2.5-pro
export const geminiGeneration = (id) => Number(/^(?:models\/)?gemini-(\d+)/.exec(id)?.[1] ?? 0)

// From Gemini 3 a model is told a level; a budget is turned away ("Thinking budget is not supported for this model.
// Use thinking level instead."), and so is it on every model after
const takesLevel = (id) => geminiGeneration(id) >= 3 || id.startsWith("gemini-pro-agent")

/** The level a thinking config asks for: a level it names, else the one its budget is the size of (Astra's low/medium/high budgets). */
export function levelOf(tc) {
  const named = String(tc?.thinkingLevel ?? "").toLowerCase()
  if (LEVELS.has(named)) return named
  const budget = Number(tc?.thinkingBudget)
  if (!Number.isFinite(budget) || budget < 0) return "high" // a dynamic budget leaves it to the model, which thinks hard by default
  if (budget <= 1024) return "low"
  if (budget <= 4096) return "medium"
  return "high"
}

// A Gemini 3 Pro takes low and high only, a Flash (and any later Gemini) also medium; minimal is a Flash's alone
function fitLevel(level, id) {
  const flash = /flash/.test(id)
  if (level === "xhigh") return "high"
  if (level === "minimal") return flash && levelOfId(id) === "minimal" ? "minimal" : "low"
  if (level === "medium" && !(flash || geminiGeneration(id) > 3)) return "high"
  return level
}

/**
 * The generation config as Antigravity takes it for `id`: the thinking asked for in the form the model takes it in —
 * a level for Gemini 3 and later (the one the id names, when it names one), a budget for the rest, none for a model
 * that doesn't think or (Claude's) one whose id doesn't say "thinking" — and an output limit within what it writes.
 */
export function generation(gen, id) {
  if (!gen || typeof gen !== "object") return undefined
  const out = { ...gen }
  const claude = isClaude(id)
  const asked = out.thinkingConfig && typeof out.thinkingConfig === "object" ? out.thinkingConfig : null
  delete out.thinkingConfig
  if (asked && !/^gpt-oss/.test(id)) {
    const off = Number(asked.thinkingBudget) === 0
    const include = asked.includeThoughts ?? !off
    if (claude) {
      if (/thinking/i.test(id)) {
        let budget = Number(asked.thinkingBudget)
        if (!(budget > 0)) budget = 1024 * 8
        // the answer has to have room past its thinking
        if (out.maxOutputTokens && budget >= out.maxOutputTokens) budget = out.maxOutputTokens - 1
        if (budget >= 1024 && !off) out.thinkingConfig = { includeThoughts: include, thinkingBudget: budget }
        if (out.thinkingConfig && !out.maxOutputTokens) out.maxOutputTokens = budget + 32000
      }
    } else if (takesLevel(id)) {
      out.thinkingConfig = { includeThoughts: include, thinkingLevel: fitLevel(levelOfId(id) || levelOf(asked), id) }
    } else if (!isImageModel(id)) {
      const tc = { includeThoughts: include }
      if (asked.thinkingBudget !== undefined) tc.thinkingBudget = /gemini-2\.5-flash/.test(id) ? Math.min(Number(asked.thinkingBudget), FLASH_25_BUDGET) : asked.thinkingBudget
      out.thinkingConfig = tc
    }
  }
  if (out.maxOutputTokens) out.maxOutputTokens = Math.min(Number(out.maxOutputTokens), claude ? MAX_OUTPUT.claude : MAX_OUTPUT.other)
  // an image model draws only when asked for images as well as text
  if (isImageModel(id) && !out.responseModalities) out.responseModalities = ["TEXT", "IMAGE"]
  return Object.keys(out).length ? out : undefined
}
