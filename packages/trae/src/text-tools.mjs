// Trae: the model's text as the answer's text — the tool calls it wrote there as blocks are taken out, and
// the reasoning it wrote as JSON.
import { CLOSE, OPEN } from "./constants.mjs"
import { DSML_AT, DSML_CLOSE, DSML_INVOKE, DSML_INVOKE_AT, DSML_TAG, LEFTOVER, PARAM_HEAD, callArgs, callJSON, dsmlArgs, glmCall, paramArgs } from "./call-syntax.mjs"
import { looseJSON, objectEnd, repairedJSON } from "./json-repair.mjs"

// TextTools splits the model's text into what the agent sees and the tool
// calls it wrote as blocks, holding back the start of a block until it
// is whole. A block is ours (<tool_call>{…}</tool_call>), its JSON taken
// once whole even when DeepSeek closes it with its own tags in place of
// </tool_call>, or DeepSeek's (<｜DSML｜invoke name="…">, magpie#823); the
// tags left around a call are dropped.
//
// GLM writes a call as its own template has it, <tool_call>name
// <arg_key>k</arg_key><arg_value>v</arg_value></tool_call>, which is read
// too; and a {"reasoning_content": …} object in the text is the model's
// reasoning, not its answer (歧路亡羊 on magpie's Discord).
export class TextTools {
  constructor(tools = []) {
    this.buf = ""
    this.after = false
    this.tools = tools
    this.sent = "" // the text given out so far, to tell a block in code from a call
    this.bad = new Set() // where the waiting block's JSON was tried and not read, not tried again
    this.mark = 0 // where in sent the text after the last call starts
  }
  push(s, end = false) {
    this.buf += s
    let text = ""
    let reasoning = ""
    const calls = []
    for (;;) {
      if (this.after) {
        const m = this.buf.match(LEFTOVER)
        if (m) this.buf = this.buf.slice(m[0].length)
        if (!this.buf || (!end && MARKS.some((k) => k.startsWith(this.buf)))) break
        // a tag cut short at the end (</), after the others: dropped too
        if (end && this.buf.length > 1 && MARKS.some((k) => k.startsWith(this.buf.trimEnd()))) {
          this.buf = ""
          break
        }
        this.after = false
      }
      const om = this.buf.match(OPEN_AT)
      const i = om ? om.index : -1
      const d = this.buf.search(DSML_AT)
      const r = this.buf.search(REASON_AT)
      const sm = this.buf.match(STRAY_AT)
      const s = sm ? sm.index : -1
      if (s >= 0 && [i, d, r].every((x) => x < 0 || s < x)) {
        // a close with no call open, with what GLM left before it
        // (}}</tool_call>, magpie#1945): not the answer, dropped; in code,
        // shown
        const head = this.buf.slice(0, s)
        // only a tail: a close with nothing before it since the last call
        // (or the start), or with GLM's braces, quotes or > right before
        // it; a close a sentence names in passing stays
        const tail = /^[}\]"'>]/.test(sm[0]) || !(this.sent + text + head).slice(this.mark).trim()
        if (!tail || quoted(this.sent + text + head)) {
          text += this.buf.slice(0, s + sm[0].length)
          this.buf = this.buf.slice(s + sm[0].length)
          continue
        }
        text += head
        this.buf = this.buf.slice(s + sm[0].length)
        this.after = true
        continue
      }
      if (r >= 0 && (i < 0 || r < i) && (d < 0 || r < d)) {
        const o = objectEnd(this.buf, r)
        if (o === -1 && !end) {
          // not whole yet: held, the text before it sent
          text += this.buf.slice(0, r)
          this.buf = this.buf.slice(r)
          break
        }
        const v = o > 0 ? looseJSON(this.buf.slice(r, o)) : null
        if (v && typeof v.reasoning_content === "string") {
          text += this.buf.slice(0, r)
          reasoning += v.reasoning_content
          this.buf = this.buf.slice(o)
          continue
        }
        // not one after all: text, and what follows read on
        text += this.buf.slice(0, r + 1)
        this.buf = this.buf.slice(r + 1)
        continue
      }
      if (i < 0 && d < 0) break
      if (d >= 0 && (i < 0 || d < i)) {
        text += this.buf.slice(0, d)
        this.buf = this.buf.slice(d)
        const tag = this.buf.match(DSML_TAG)
        if (!tag) {
          // a tag not closed yet; at the end, or with another tag after it,
          // a stray one dropped
          const next = this.buf.indexOf("<", 1)
          if (next < 0 && !end) break
          this.buf = next < 0 ? "" : this.buf.slice(next)
          continue
        }
        const inv = tag[0].match(DSML_INVOKE)
        if (!inv) {
          // function_calls, a parameter's close, any other tag: dropped,
          // with the blanks after it
          this.buf = this.buf.slice(tag[0].length)
          this.after = true
          continue
        }
        const body = this.buf.slice(tag[0].length)
        const c = body.match(DSML_CLOSE)
        const n = body.search(DSML_INVOKE_AT)
        let stop = c ? c.index : n >= 0 ? n : -1
        if (n >= 0 && n < stop) stop = n
        if (stop < 0) {
          if (!end) break
          stop = body.length
        }
        calls.push({ name: inv[1], arguments: dsmlArgs(body.slice(0, stop)) })
        this.mark = this.sent.length + text.length
        this.buf = body.slice(c && c.index === stop ? stop + c[0].length : stop)
        this.after = true
        continue
      }
      const head = this.buf.slice(0, i)
      const body = this.buf.slice(i + om[0].length)
      if (quoted(this.sent + text + head)) {
        // a <tool_call> in backticks or a code fence is prose about one
        text += head + om[0]
        this.buf = body
        continue
      }
      const named = om[1]?.match(/\bname\s*=\s*"([^"]+)"/)?.[1]
      const inner = body.trimStart()
      if (!named && (inner.startsWith("<") || (end && !inner))) {
        // no JSON in it: DeepSeek's own invoke, or only the closes of one
        // (magpie#823 again); the opener is dropped and what follows read
        // as it is
        text += head
        this.buf = inner
        this.after = true
        continue
      }
      const b = this.block(body, named, end)
      if (b.wait) break
      this.bad.clear()
      if (b.text) {
        // not a call: the opener is text, and what follows read on
        text += head + om[0]
        this.buf = body
        continue
      }
      text += head
      if (b.error) {
        // a call that can't be read is not the answer (community plugins issue #38): the
        // turn ends as a failure, so the gateway can try it again
        this.buf = ""
        this.sent += text
        return { text, calls, reasoning, error: b.error }
      }
      calls.push(b.call)
      this.mark = this.sent.length + text.length
      this.buf = b.rest
      this.after = true
    }
    if (end) {
      // an opener the stream ended inside (<tool_call name): a call cut
      // short, not the answer (community plugins issue #38)
      const h = this.buf.search(OPEN_HOLD)
      if (h >= 0 && !quoted(this.sent + text + this.buf.slice(0, h))) {
        text += this.buf.slice(0, h)
        this.buf = ""
        this.sent += text
        return { text, calls, reasoning, error: CUT_SHORT }
      }
      text += this.buf
      this.buf = ""
    } else {
      // keep back an opened block, or what may be the start of one
      const at = [this.buf.search(OPEN_AT), this.buf.search(OPEN_HOLD), this.buf.search(DSML_AT), this.buf.search(REASON_AT)].filter((x) => x >= 0)
      let keep = at.length ? this.buf.length - Math.min(...at) : 0
      if (!keep) for (let k = Math.min(MARK_MAX - 1, this.buf.length); k > 0; k--) if (MARKS.some((m) => m.startsWith(this.buf.slice(-k)))) { keep = k; break }
      // and braces, brackets, quotes or a > a close may still come after
      const sh = this.buf.slice(0, this.buf.length - keep).match(STRAY_HOLD)
      if (sh) keep = this.buf.length - sh.index
      text += this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
    }
    this.sent += text
    return { text, calls, reasoning }
  }

  // block reads what follows a <tool_call> opener: {call, rest} for a
  // call, {wait} while it may still become one, {text} when it is no call
  // at all, {error} for one that can't be read: cut short, or not JSON
  // even as models get it wrong (community plugins issue #38). named is the name an opener
  // gave as <tool_call name="…">.
  block(body, named, end) {
    if (!end && !body.trim()) return { wait: true }
    const [close, closeLen] = closeAt(body)
    if (named) {
      if (close < 0 && !end) return { wait: true }
      const region = close >= 0 ? body.slice(0, close) : body
      const rest = close >= 0 ? body.slice(close + closeLen) : ""
      if (region.trimStart().startsWith("{")) {
        const v = repairedJSON(region.trim())
        if (!v) return { error: close >= 0 ? UNREADABLE : CUT_SHORT }
        return { call: v.name ? { name: String(v.name), arguments: callArgs(v) } : { name: named, arguments: JSON.stringify(v) }, rest }
      }
      if (region.includes("<arg_key>")) {
        const w = glmCall(named + region, this.tools)
        return w ? { call: { name: w.name, arguments: callArgs(w) }, rest } : { error: close >= 0 ? UNREADABLE : CUT_SHORT }
      }
      const p = paramArgs(region, named, this.tools)
      // cut short at the end: whole only when each parameter was closed
      if (close < 0 && !p.closed) return { error: CUT_SHORT }
      return { call: { name: named, arguments: JSON.stringify(p.args) }, rest }
    }
    if (body.trimStart().startsWith("{")) {
      const ph = body.match(PARAM_HEAD)
      if (ph) {
        // DeepSeek's half-and-half: the name as JSON, then its parameters
        // (magpie#917)
        if (close < 0 && !end) return { wait: true }
        const region = body.slice(ph[0].length, close >= 0 ? close : body.length)
        const p = paramArgs(region, ph[1], this.tools)
        if (close < 0 && !p.closed) return { error: CUT_SHORT }
        return { call: { name: ph[1], arguments: JSON.stringify(p.args) }, rest: close >= 0 ? body.slice(close + closeLen) : "" }
      }
      const o = objectEnd(body, 0)
      if (o > 0 && !this.bad.has(":" + o)) {
        const v = callJSON(body.slice(0, o))
        // a name alone may have its parameters still to come
        if (v && !end && Object.keys(v).length === 1 && "<parameter".startsWith(body.slice(o).replace(/^\s*>?\s*/, ""))) return { wait: true }
        if (v) {
          // what follows the object up to the close: GLM leaves braces,
          // brackets, quotes or a > of its own there (}}</tool_call>,
          // "></tool_call>, magpie#1945), dropped with the close; held
          // while only those have come
          const tail = body.slice(o)
          const junk = tail.match(TAIL_JUNK)[0]
          const next = tail.slice(junk.length)
          const call = { name: String(v.name), arguments: callArgs(v) }
          if (!end && (!next || ["</tool_call>", "</toolcall>"].some((k) => k.startsWith(next)))) return { wait: true }
          const [c, n] = closeAt(next)
          if (c === 0) return { call, rest: next.slice(n) }
          // after blanks alone, or with no close to come: the call, and
          // what follows read on as before. Other text before the close
          // right after the object means the object ended early, at a
          // quote inside a string left unescaped: that cut is wrong (a
          // heredoc's command cut short, magpie#1945), so it is read up to
          // the close below, or not at all
          if (!/\S/.test(junk) && !/^[^\s<]/.test(next)) return { call, rest: tail }
          if (close < 0 && end) return { call, rest: tail }
        } else this.bad.add(":" + o)
      }
      // not whole, or not JSON as it stands: read up to a close (a file's
      // content may hold one), or at the end all of it
      for (let [j, n] = [close, closeLen]; j >= 0; [j, n] = closeAt(body, j + 1)) {
        if (this.bad.has("<" + j)) continue
        const v = callJSON(body.slice(0, j))
        if (v) return { call: { name: String(v.name), arguments: callArgs(v) }, rest: body.slice(j + n) }
        this.bad.add("<" + j)
      }
      if (!end) return { wait: true }
      const v = callJSON(body)
      if (v) return { call: { name: String(v.name), arguments: callArgs(v) }, rest: "" }
      return { error: close >= 0 ? UNREADABLE : CUT_SHORT }
    }
    // GLM's own (a name, then <arg_key>/<arg_value> pairs), or text
    if (!/^\s*[\w.:-]{1,128}\s*(?:<|$)/.test(body)) return { text: true }
    if (close < 0 && !end) return { wait: true }
    const region = close >= 0 ? body.slice(0, close) : body
    const w = glmCall(region, this.tools)
    // GLM's call, cut short at the end, is still the call
    if (w) return { call: { name: w.name, arguments: callArgs(w) }, rest: close >= 0 ? body.slice(close + closeLen) : "" }
    if (/^\s*[\w.:-]{1,128}\s*<arg_key>/.test(body)) return { error: close >= 0 ? UNREADABLE : CUT_SHORT }
    return { text: true }
  }
}

const CUT_SHORT = "the model's tool call, written as text, was cut short; it is not sent on as the answer"
const UNREADABLE = "the model's tool call, written as text, can't be read; it is not sent on as the answer"

// an opener: <tool_call>, one with attributes (<tool_call name="bash">),
// or <tool_call right before its JSON; and one still being written. GLM
// also writes it without the underscore, <toolcall> (community plugins issue #38)
const OPEN_AT = /<tool_?call(?:(\s[^<>{}]*)?>|(?=\s*\{))/
const OPEN_HOLD = /<tool_?call(?:\s[^<>{}\n]{0,200})?$/
// what GLM leaves between a call's JSON and its close: blanks, closing
// braces and brackets, quotes, a > (magpie#1945)
const TAIL_JUNK = /^[\s}\]"'>]*/
// a close with no call open, and that leftover before it: the tail of a
// call Trae's service read itself, or of one already read (magpie#1945)
const STRAY_AT = /[}\]"'>]*\s*<\/tool_?calls?>/
// the end of text that may be such a tail still being written
const STRAY_HOLD = /[}\]"'>][\s}\]"'>]*$/
// closeAt is where the next close is from i, </tool_call> or </toolcall>,
// and its length: [-1, 0] when there is none
function closeAt(s, i = 0) {
  const re = /<\/tool_?call>/g
  re.lastIndex = i
  const m = re.exec(s)
  return m ? [m.index, m[0].length] : [-1, 0]
}

// quoted says text ends inside a code fence or inline code: what comes
// next is shown, not done
function quoted(text) {
  if ((text.match(/```/g)?.length ?? 0) % 2) return true
  const line = text.slice(text.lastIndexOf("\n") + 1).replace(/```/g, "")
  return (line.match(/`/g)?.length ?? 0) % 2 === 1
}

// what text may be the start of, so held back
const MARKS = [OPEN, CLOSE, "<toolcall>", "</toolcall>", "<｜DSML｜", "<|DSML|", "</｜DSML｜", "</|DSML|", '{"reasoning_content"']
// reasoning a model wrote into its text as JSON
const REASON_AT = /\{\s*"reasoning_content"\s*:/
const MARK_MAX = Math.max(...MARKS.map((m) => m.length))
