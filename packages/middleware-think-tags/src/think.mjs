// The <think> block itself: finding it at the start of a text, whole or arriving a piece at a time.

export const OPEN = "<think>"
export const CLOSE = "</think>"

/** A whole text without the think block that opens it (and the whitespace after it). */
export function stripWhole(text) {
  const m = /^\s*<think>[\s\S]*?<\/think>\s*/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/**
 * A stream's text, a piece at a time, without a think block at its start: returns `piece => text to pass on`.
 * Its state lives in `state[key]` (one stream each, so it survives from one event to the next): whether we are
 * inside the block, text held back that may be the start of a tag (`carry`), whether the real text has begun
 * (after which every piece goes through untouched), and whether the whitespace after </think> is still being
 * dropped.
 */
export function streamStripper(state, key) {
  const st = state[key] || (state[key] = { inside: false, carry: "", begun: false, trim: false })
  return (piece) => {
    if (st.begun) return piece
    let s = st.carry + piece
    st.carry = ""
    let out = ""
    for (;;) {
      if (st.inside) {
        const i = s.indexOf(CLOSE)
        if (i < 0) {
          // no </think> yet: keep only the end that may turn into one with the next piece
          st.carry = tail(s, CLOSE)
          return out
        }
        s = s.slice(i + CLOSE.length)
        st.inside = false
        st.trim = true
        continue
      }
      if (st.trim) {
        s = s.replace(/^\s+/, "")
        if (!s) return out
        st.trim = false
        st.begun = true
        return out + s
      }
      const lead = /^\s*/.exec(s)[0]
      const rest = s.slice(lead.length)
      if (rest.startsWith(OPEN)) {
        s = rest.slice(OPEN.length)
        st.inside = true
        continue
      }
      if (rest.length < OPEN.length && OPEN.startsWith(rest)) {
        // maybe the start of <think>: wait for the next piece
        st.carry = s
        return out
      }
      st.begun = true
      return out + s
    }
  }
}

/** The end of `s` that may begin `tag` (its longest proper prefix `s` ends with), or "". */
export function tail(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
  return ""
}
