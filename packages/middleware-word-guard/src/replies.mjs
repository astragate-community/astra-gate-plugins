import { maskText } from "./matcher.mjs"

// The text in a reply, in each API's shape, as [object, key] slots to mask. Slots are listed first and masked
// after, so a hook that meets a malformed reply fails before it has changed any of it.

/** A stream event's text slots: Anthropic, Responses, Chat chunks or Gemini candidates. */
export function eventTextSlots(ev) {
  if (ev.type === "content_block_delta") return [[ev.delta, "text"]]
  if (ev.type === "response.output_text.delta") return [[ev, "delta"]]
  if (ev.type === "response.output_text.done") return [[ev, "text"]]
  if (Array.isArray(ev.choices)) return ev.choices.map((c) => [c.delta, "content"])
  // Gemini streams its text in candidates[].content.parts[].text, the shape a whole reply has too
  if (Array.isArray(ev.candidates)) return ev.candidates.flatMap((c) => (c && c.content && Array.isArray(c.content.parts) ? c.content.parts.map((p) => [p, "text"]) : []))
  return []
}

/** A whole reply's text slots: Anthropic content, Chat choices, Responses output or Gemini candidates. */
export function responseTextSlots(body) {
  const slots = []
  if (Array.isArray(body.content)) for (const b of body.content) if (b && b.type === "text") slots.push([b, "text"])
  if (Array.isArray(body.choices)) for (const c of body.choices) slots.push([c.message, "content"])
  if (Array.isArray(body.output)) for (const it of body.output) if (it && Array.isArray(it.content)) for (const p of it.content) slots.push([p, "text"])
  if (Array.isArray(body.candidates)) for (const c of body.candidates) if (c.content && Array.isArray(c.content.parts)) for (const p of c.content.parts) slots.push([p, "text"])
  return slots
}

/** Masks each slot that holds a string; whether any of them changed. */
export function maskSlots(slots, re, mask) {
  let changed = false
  for (const [holder, key] of slots) {
    if (!holder || typeof holder[key] !== "string") continue
    const masked = maskText(re, holder[key], mask)
    if (masked !== holder[key]) {
      holder[key] = masked
      changed = true
    }
  }
  return changed
}
