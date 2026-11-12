// Qoder: lifting the tool calls Qoder writes as XML in its text out of the stream.

const CALL_OPEN = "\x3ctool_call\x3e"
const CALL_CLOSE = "\x3c/tool_call\x3e"
const FUNC = /\x3cfunction=([^>]+)\x3e([\s\S]*?)\x3c\/function\x3e/
const PARAM = /\x3cparameter=([^>]+)\x3e([\s\S]*?)\x3c\/parameter\x3e/g

// parseCall reads one tool-call block: JSON {name, arguments}, or the XML
// function/parameter form.
export function parseCall(v) {
  try {
    const f = JSON.parse(v.trim())
    if (String(f?.name ?? "").trim() && f.arguments && typeof f.arguments === "object" && !Array.isArray(f.arguments))
      return { name: f.name.trim(), args: JSON.stringify(f.arguments) }
  } catch {}
  const m = FUNC.exec(v)
  if (!m || !m[1].trim()) return null
  const args = {}
  for (const pm of m[2].matchAll(PARAM)) {
    const key = pm[1].trim()
    if (!key) continue
    const val = pm[2].trim()
    try {
      args[key] = JSON.parse(val)
    } catch {
      args[key] = val
    }
  }
  return { name: m[1].trim(), args: JSON.stringify(args) }
}

// Splitter holds text until a whole tool-call block has come, then gives
// it as a call.
export class Splitter {
  textBuf = ""
  callBuf = ""
  inCall = false
  sawTool = false
  feed(input) {
    const out = []
    while (input) {
      if (!this.inCall) {
        const comb = this.textBuf + input
        this.textBuf = ""
        const i = comb.indexOf(CALL_OPEN)
        if (i < 0) {
          let keep = 0
          for (let n = CALL_OPEN.length - 1; n > 0; n--)
            if (comb.endsWith(CALL_OPEN.slice(0, n))) {
              keep = n
              break
            }
          if (keep < comb.length) out.push({ text: comb.slice(0, comb.length - keep) })
          this.textBuf = comb.slice(comb.length - keep)
          break
        }
        if (i > 0) out.push({ text: comb.slice(0, i) })
        input = comb.slice(i + CALL_OPEN.length)
        this.inCall = true
        continue
      }
      const comb = this.callBuf + input
      this.callBuf = ""
      const j = comb.indexOf(CALL_CLOSE)
      if (j < 0) {
        this.callBuf = comb
        break
      }
      const c = parseCall(comb.slice(0, j))
      if (c) {
        this.sawTool = true
        out.push({ call: c })
      } else out.push({ text: CALL_OPEN + comb.slice(0, j) + CALL_CLOSE })
      input = comb.slice(j + CALL_CLOSE.length)
      this.inCall = false
    }
    return out
  }
  flush() {
    const t = this.inCall ? CALL_OPEN + this.callBuf : this.textBuf
    this.inCall = false
    this.callBuf = ""
    this.textBuf = ""
    return t ? [{ text: t }] : []
  }
}
