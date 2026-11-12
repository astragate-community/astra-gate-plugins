// Factory: rewriting the texts inside a parsed request, reporting whether anything changed.

/** Sets holder[key] to fn(holder[key]) when that differs: true when it did. */
export function rewrite(holder, key, fn) {
  const adapted = fn(holder[key])
  if (adapted === holder[key]) return false
  holder[key] = adapted
  return true
}

/**
 * rewrite for a message's content: a string, or the text blocks of an array (any other block, and the blocks'
 * other fields, stay as they are).
 */
export function rewriteContent(holder, key, fn) {
  if (typeof holder[key] === "string") return rewrite(holder, key, fn)
  let changed = false
  if (Array.isArray(holder[key])) {
    for (const block of holder[key]) {
      if (block?.type === "text" && typeof block.text === "string" && rewrite(block, "text", fn)) changed = true
    }
  }
  return changed
}
