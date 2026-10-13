// Trae: the tool calls it streams natively — put together from the events they come in.
import { randomBytes } from "node:crypto"
import { callArgs, glmCall } from "./call-syntax.mjs"
import { looseJSON } from "./json-repair.mjs"

// the numbering that keeps two ids made in one millisecond apart
const seq = { n: 0 }
export const callId = () => "call_" + randomBytes(12).toString("hex") + (seq.n++).toString(36)

// nativeCall is a tool call as Trae's events carry one
function nativeCall(tc) {
  const f = tc?.function ?? tc?.function_call ?? tc
  const name = f?.name ?? tc?.tool_name ?? ""
  const index = Number.isInteger(tc?.index) ? tc.index : null
  const a = f?.arguments ?? f?.args ?? tc?.params ?? tc?.input ?? tc?.parameters ?? ""
  const args = typeof a === "string" ? a : JSON.stringify(a)
  if (!name && index === null && !tc?.id && !args) return null
  return { id: tc?.id || tc?.tool_call_id || "", index, name: String(name), arguments: args }
}

// NativeCalls puts together the tool calls Trae streams: a call comes in
// several events under one id (or index), each with the arguments so far
// or only the new piece, so a call is sent on once the answer is whole,
// not from its first event (community plugins issue #799: bash's command cut to `echo "T`)
export class NativeCalls {
  constructor() {
    this.calls = []
  }
  push(tc) {
    const c = nativeCall(tc)
    if (!c) return
    let o = this.calls.find((x) => (c.id && x.id === c.id) || (!c.id && c.index !== null && x.index === c.index))
    if (!o && !c.id && c.index === null)
      o = this.calls.findLast((x) => x.name === c.name && (x.arguments === c.arguments || (!done(x.arguments) && c.arguments.startsWith(x.arguments))))
    // a piece with nothing to say whose it is (or an index its call's
    // first event didn't give) belongs to the call still being written
    if (!o && !c.name && !c.id) {
      o = this.calls.findLast((x) => !done(x.arguments))
      if (o && c.index !== null && o.index !== null && o.index !== c.index) o = null
    }
    if (!o) {
      if (!c.name) return
      this.calls.push({ ...c })
      return
    }
    if (!o.name) o.name = c.name
    if (c.index !== null && o.index === null) o.index = c.index
    const prev = o.arguments
    const next = c.arguments
    if (!next || prev.startsWith(next)) return // nothing new
    if (next.startsWith(prev) || done(prev)) o.arguments = next // the arguments so far
    else if (resent(prev, next)) o.arguments = next // the whole call again, written apart (community plugins issue #24)
    else o.arguments = prev + next // a piece
  }
  take(tools = []) {
    return this.calls.filter((c) => c.name).map(({ id, name, arguments: a }) => {
      // a name that holds the whole call, as JSON or in GLM's template:
      // that call, its arguments the name's when it gave none of its own
      const w = name.trimStart().startsWith("{") ? looseJSON(name) : name.includes("<arg_key>") ? glmCall(name, tools) : null
      if (w?.name) {
        name = String(w.name)
        if (!a || a.trim() === "{}") a = callArgs(w)
      }
      const v = a && !done(a) ? looseJSON(a) : null
      return { id: id || callId(), name, arguments: v ? JSON.stringify(v) : a || "{}" }
    })
  }
}

// resent says next is the call's whole arguments sent again after a
// partial snapshot, not a piece of them: Trae resends a snapshot whose
// punctuation isn't the first one's (− for -, ′ for '), so it doesn't
// start with it. A whole object under the same first key as prev's, which
// prev and it joined don't make whole; a piece that is a value of its own
// (12, "ls", {}) doesn't open with prev's first key.
function resent(prev, next) {
  const key = (s) => s.match(/^\s*\{\s*"((?:[^"\\]|\\.)*)"/)?.[1]
  if (!next.trimStart().startsWith("{") || !done(next) || done(prev + next)) return false
  const k = key(prev)
  return k !== undefined && k === key(next)
}

// done says arguments are a whole JSON value already
function done(a) {
  if (!a) return false
  try {
    JSON.parse(a)
    return true
  } catch {
    return false
  }
}
