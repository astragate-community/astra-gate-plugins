// "to_content" mode: a Chat reply's reasoning put in its text between <think> tags.
import { OPEN, CLOSE } from "./think.mjs"

// Servers disagree on the field: reasoning_content, or reasoning. The first one that is a string; null for none.
const reasoningOf = (obj) => (typeof obj.reasoning_content === "string" ? obj.reasoning_content : typeof obj.reasoning === "string" ? obj.reasoning : null)

/**
 * A Chat chunk's reasoning moved into its text: <think> opens with the first reasoning and closes when real text
 * or the end of the stream comes. State per choice ("t" + index) is "open" then "closed". The reasoning fields
 * are removed even when empty. Undefined when the chunk had neither reasoning nor text to add.
 */
export function reasoningToText(ev, state) {
  let changed = false
  for (const c of ev.choices) {
    const delta = c && c.delta
    if (!delta) continue
    const key = "t" + c.index
    const reasoning = reasoningOf(delta)
    let text = ""
    if (reasoning !== null) {
      delete delta.reasoning_content
      delete delta.reasoning
      changed = true
      if (reasoning) {
        if (!state[key]) {
          state[key] = "open"
          text += OPEN + "\n"
        }
        text += reasoning
      }
    }
    const content = typeof delta.content === "string" ? delta.content : ""
    if (state[key] === "open" && (content || c.finish_reason)) {
      text += "\n" + CLOSE + "\n\n"
      state[key] = "closed"
    }
    if (text) {
      delta.content = text + content
      changed = true
    }
  }
  return changed ? ev : undefined
}

/** A whole Chat reply's reasoning moved in front of its text. Undefined when no choice had any. */
export function reasoningIntoReply(body) {
  if (!Array.isArray(body.choices)) return
  let changed = false
  for (const c of body.choices) {
    const message = c && c.message
    if (!message) continue
    const reasoning = reasoningOf(message)
    if (!reasoning) continue
    message.content = OPEN + "\n" + reasoning + "\n" + CLOSE + "\n\n" + (message.content || "")
    delete message.reasoning_content
    delete message.reasoning
    changed = true
  }
  return changed ? body : undefined
}
