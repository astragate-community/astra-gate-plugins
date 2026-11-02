// Antigravity: a conversation in the shape Code Assist takes — function calls and answers paired, turns in an order it accepts.
import { SKIP_SIGNATURE } from "./constants.mjs"

const INTERRUPTED = "[The result of this tool call is unavailable: the turn was interrupted.]"
const CONTINUING = "[Continuing from previous AI thoughts...]"
const CONTINUE = "Continue."

const calls = (c) => c.parts.filter((p) => p.functionCall)
const answers = (c) => c.parts.filter((p) => p.functionResponse)
const hasAnswer = (c) => answers(c).length > 0

// an id the way Antigravity's Claude takes one
const safeId = (id) => (typeof id === "string" && id ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : "")

// parts as Code Assist reads them: no empty text with nothing else to say, a role of user or model only
function tidy(contents) {
  const out = []
  for (const c of Array.isArray(contents) ? contents : []) {
    if (!c || typeof c !== "object") continue
    const parts = (Array.isArray(c.parts) ? c.parts : []).filter((p) => p && typeof p === "object" && Object.keys(p).length > 0 && !(p.text === "" && Object.keys(p).length === 1))
    if (!parts.length) continue
    out.push({ ...c, role: c.role === "model" ? "model" : "user", parts: parts.map((p) => ({ ...p })) })
  }
  return out
}

// Signatures: Google checks the ones Gemini 3 hands out on a function call, and skips the check of the one it is told
// to skip. A call the model didn't make here has none of its own; a Claude model's calls never carry Gemini's.
function sign(contents, claude) {
  for (const c of contents) {
    if (c.role !== "model") continue
    const signed = calls(c).some((p) => p.thoughtSignature)
    for (const p of c.parts) {
      if (claude) {
        if (p.functionCall) p.thoughtSignature = SKIP_SIGNATURE
        else delete p.thoughtSignature
      } else if (p.functionCall && !signed) p.thoughtSignature = SKIP_SIGNATURE
    }
  }
}

// Antigravity reads a tool's answer from "result" (Gemini CLI's "output" and an error's "error" are Gemini's own words for it)
function resultKey(contents) {
  for (const c of contents)
    for (const p of answers(c)) {
      const r = p.functionResponse.response
      if (!r || typeof r !== "object" || "result" in r) continue
      const key = ["output", "error"].find((k) => k in r)
      if (key) p.functionResponse.response = { result: r[key] }
    }
}

// Ids: a call and its answer share one. Antigravity's Claude pairs them by id ("tool_use ids were found without
// tool_result blocks immediately after"), where Gemini's request pairs them by name and order, so each call is given an
// id and the answers after it take the ids of the calls of their name, in order.
function pair(contents, claude) {
  let n = 0
  let pending = []
  for (const c of contents) {
    if (c.role === "model") {
      pending = []
      for (const p of calls(c)) {
        const id = safeId(p.functionCall.id) || (claude ? `call_${++n}` : "")
        if (id) p.functionCall.id = id
        else delete p.functionCall.id
        pending.push({ id, name: p.functionCall.name, used: false })
      }
      continue
    }
    for (const p of answers(c)) {
      const r = p.functionResponse
      let id = safeId(r.id)
      if (!id) {
        const hit = pending.find((x) => !x.used && x.name === r.name) ?? pending.find((x) => !x.used)
        if (hit) {
          hit.used = true
          id = hit.id
        }
      } else pending.filter((x) => x.id === id).forEach((x) => (x.used = true))
      if (id) r.id = id
      else delete r.id
    }
  }
}

// A turn's calls with no answer in the turn after it (an interrupted turn leaves them pending, and Google turns every
// later turn of the conversation away over the one): answered with a note that says so.
function answerPending(contents, claude) {
  const out = []
  for (const [i, c] of contents.entries()) {
    out.push(c)
    if (c.role !== "model") continue
    const next = contents[i + 1]
    const given = next?.role === "user" ? answers(next) : []
    const synth = []
    for (const p of calls(c)) {
      const { id, name } = p.functionCall
      if (given.some((a) => (id ? a.functionResponse.id === id : a.functionResponse.name === name))) continue
      synth.push({ functionResponse: { name, ...(id ? { id } : {}), response: { result: INTERRUPTED } } })
    }
    if (!synth.length) continue
    // the answers lead the turn after; Claude keeps them with what the user said, Gemini's own turns don't mix the two
    if (next?.role === "user" && (claude || hasAnswer(next))) next.parts = [...synth, ...next.parts]
    else out.push({ role: "user", parts: synth })
  }
  return out
}

// Gemini turns away a turn that mixes a functionResponse with other parts ("Requests ending with a model turn are not
// supported" is what it says), and takes the two as separate turns; a Claude model keeps them in one, the tool_result
// turn Anthropic reads them as.
function separate(contents, claude) {
  if (claude) return contents
  const out = []
  for (const c of contents) {
    if (c.role === "user" && hasAnswer(c) && c.parts.some((p) => !p.functionResponse)) {
      out.push({ ...c, parts: c.parts.filter((p) => p.functionResponse) }, { ...c, parts: c.parts.filter((p) => !p.functionResponse) })
    } else out.push(c)
  }
  return out
}

// consecutive turns of one role are one turn, except a turn of answers from one of something said
function merge(contents) {
  const out = []
  for (const c of contents) {
    const last = out[out.length - 1]
    if (last && last.role === c.role && (c.role !== "user" || hasAnswer(last) === hasAnswer(c))) last.parts = [...last.parts, ...c.parts]
    else out.push({ ...c, parts: [...c.parts] })
  }
  return out
}

/**
 * The conversation as Code Assist takes it. A history may not open with the model's turn (an agent's compaction can
 * leave one) nor end with it, so a user turn is put where either happens.
 */
export function history(contents, { claude = false } = {}) {
  let list = tidy(contents)
  sign(list, claude)
  list = tidy(list) // a Claude model's turns lose Gemini's bare signatures, and with them parts that held nothing else
  resultKey(list)
  pair(list, claude)
  list = answerPending(list, claude)
  list = merge(separate(list, claude))
  if (list.length && list[0].role === "model") list.unshift({ role: "user", parts: [{ text: CONTINUING }] })
  if (list.length && list[list.length - 1].role === "model") list.push({ role: "user", parts: [{ text: CONTINUE }] })
  return list
}
