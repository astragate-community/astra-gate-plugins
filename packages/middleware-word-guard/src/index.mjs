// New API's 敏感词过滤 as magpie gateway middleware, based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md):
// words or patterns you list are kept out of what agents send, turned away or masked, and can be masked in what
// comes back.
//
//   {"words": ["project-x"], "patterns": ["\\b\\d{3}-\\d{4}\\b"],
//    "action": "reject", "check": "last", "mask": "***",
//    "replies": false, "message": ""}
//
// Only the user's own text is read: the API's user messages' text, not tool results, tool calls or the system
// prompt. "check": "last" reads the last user message that has text (New API reads the prompt, that is, the turn
// being sent), "all" every user message. Words match ignoring case. "action": "reject" turns the request away
// with an error naming the word; "mask" swaps each match for "mask". "replies": true masks matches in the text
// that comes back as well; a word split across two streamed events isn't seen.
//
// Astra runs the built file as an ES module in Jint: only the three hooks are exported, and nothing imports a
// package or a node: module.
import { matcher, maskOf, maskText } from "./matcher.mjs"
import { rewriteUserTexts } from "./request.mjs"
import { eventTextSlots, responseTextSlots, maskSlots } from "./replies.mjs"

export function onRequest(body, ctx) {
  const re = matcher(ctx.options)
  if (!re) return
  const o = ctx.options
  const all = o.check === "all"
  if (o.action === "mask") {
    const mask = maskOf(o)
    let changed = false
    rewriteUserTexts(body, ctx.protocol, all, (text) => {
      const masked = maskText(re, text, mask)
      if (masked !== text) changed = true
      return masked
    })
    return changed ? body : undefined
  }
  // anything but "mask" is a reject: look for the first word, without rewriting a thing
  let hit = null
  rewriteUserTexts(body, ctx.protocol, all, (text) => {
    if (hit === null) {
      re.lastIndex = 0
      const m = re.exec(text)
      if (m) hit = m[0]
    }
    return text
  })
  if (hit !== null) ctx.reject(400, o.message || `this request has "${hit}", which this gateway doesn't send`)
}

// Replies are only ever masked (a reply can't be turned away once the agent's request was let through), and
// only when the options ask for it.
export function onEvent(ev, ctx) {
  const o = ctx.options
  if (!o || !o.replies || o.action !== "mask") return
  const re = matcher(o)
  if (!re) return
  return maskSlots(eventTextSlots(ev), re, maskOf(o)) ? ev : undefined
}

export function onResponse(body, ctx) {
  const o = ctx.options
  if (!o || !o.replies || o.action !== "mask" || ctx.status >= 400) return
  const re = matcher(o)
  if (!re) return
  return maskSlots(responseTextSlots(body), re, maskOf(o)) ? body : undefined
}
