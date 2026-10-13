// "strip" mode: taking the think block out of a reply, streamed or whole, in each API's shape.
import { stripWhole, streamStripper } from "./think.mjs"

// Writes f(obj[key]) back when it differs; the event (or body) when something was written, else undefined.
function rewrite(obj, key, f, whole) {
  if (!obj || typeof obj[key] !== "string") return
  const u = f(obj[key])
  if (u === obj[key]) return
  obj[key] = u
  return whole
}

// A Responses message item: the block comes off its output_text. Whether it changed.
function stripItem(item) {
  if (!item || item.type !== "message" || !Array.isArray(item.content)) return false
  const part = item.content.find((x) => x && x.type === "output_text")
  if (!part || typeof part.text !== "string") return false
  const u = stripWhole(part.text)
  if (u === part.text) return false
  part.text = u
  return true
}

// Chat chunks: each choice is its own stream ("c" + index in the shared state).
function stripChatChunk(ev, state) {
  let changed = false
  for (const c of ev.choices) {
    if (!c || !c.delta) continue
    const key = "c" + c.index
    const strip = streamStripper(state, key)
    if (typeof c.delta.content === "string") {
      const u = strip(c.delta.content)
      if (u !== c.delta.content) {
        c.delta.content = u
        changed = true
      }
    }
    // a stream that ends while text is held back gives it back
    if (c.finish_reason && state[key] && state[key].carry) {
      c.delta.content = (c.delta.content || "") + state[key].carry
      state[key].carry = ""
      changed = true
    }
  }
  return changed ? ev : undefined
}

/**
 * One stream event with the think block taken out of its text: Anthropic text deltas, Responses text events (a
 * delta is streamed; the done / completed ones carry whole texts), Chat chunks. Undefined when nothing changed.
 * Stream keys in `state`: "a" + block index, "r" + item and part, "c" + choice index.
 */
export function stripEvent(ev, state) {
  if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
    return rewrite(ev.delta, "text", streamStripper(state, "a" + ev.index), ev)
  }
  if (ev.type === "response.output_text.delta") return rewrite(ev, "delta", streamStripper(state, "r" + ev.item_id + ":" + ev.content_index), ev)
  if (ev.type === "response.output_text.done" && typeof ev.text === "string") return rewrite(ev, "text", stripWhole, ev)
  if (ev.type === "response.content_part.done" && ev.part && typeof ev.part.text === "string") return rewrite(ev.part, "text", stripWhole, ev)
  if (ev.type === "response.output_item.done" && ev.item) return stripItem(ev.item) ? ev : undefined
  if (ev.type === "response.completed" && ev.response && Array.isArray(ev.response.output)) {
    let changed = false
    for (const item of ev.response.output) changed = stripItem(item) || changed
    return changed ? ev : undefined
  }
  if (Array.isArray(ev.choices)) return stripChatChunk(ev, state)
}

/** A whole reply with the think block taken out of its text: Anthropic, Chat or Responses. Undefined when unchanged. */
export function stripReply(body) {
  let changed = false
  const fix = (obj, key) => {
    if (rewrite(obj, key, stripWhole, true)) changed = true
  }
  // Anthropic: the block opens the first text block, thinking blocks are another type
  if (Array.isArray(body.content)) fix(body.content.find((b) => b && b.type === "text"), "text")
  if (Array.isArray(body.choices)) for (const c of body.choices) fix(c && c.message, "content")
  if (Array.isArray(body.output)) for (const item of body.output) changed = stripItem(item) || changed
  return changed ? body : undefined
}
