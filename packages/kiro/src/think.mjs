// Kiro: splitting a reply's <thinking> from its text.

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>"
const CLOSE = "</thinking>"
function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n
  return 0
}
export class ThinkParser {
  state = 0 // 0: not yet known, 1: thinking, 2: text
  buf = ""
  said = false
  feed(s) {
    this.buf += s
    const out = []
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, "")
        if (t.startsWith(OPEN)) {
          ;[this.buf, this.state] = [t.slice(OPEN.length), 1]
          continue
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out // may yet be the tag
        this.state = 2
        continue
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, "")
          if (!this.buf) return out
        }
        const i = this.buf.indexOf(CLOSE)
        if (i >= 0) {
          if (i > 0) {
            out.push({ kind: "think", text: this.buf.slice(0, i) })
            this.said = true
          }
          ;[this.buf, this.state] = [this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, ""), 2]
          continue
        }
        // hold back what may be the start of the closing tag
        const n = this.buf.length - partialSuffix(this.buf, CLOSE)
        if (n > 0) {
          out.push({ kind: "think", text: this.buf.slice(0, n) })
          ;[this.buf, this.said] = [this.buf.slice(n), true]
        }
        return out
      }
      if (this.buf) out.push({ kind: "text", text: this.buf })
      this.buf = ""
      return out
    }
  }
  end() {
    if (!this.buf) return []
    const ev = { kind: this.state === 1 ? "think" : "text", text: this.buf }
    this.buf = ""
    if (this.state === 0) this.state = 2
    return [ev]
  }
}
