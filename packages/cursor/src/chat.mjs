// A chat completion on Cursor: the Run, retried where Cursor says it can be, answered as OpenAI's.
import { kept } from "@astragate-community/plugin-kit"
import { tokenOf } from "./session.mjs"
import { cursorError, maxRequired, regional } from "./errors.mjs"
import { usable } from "./models.mjs"
import { request } from "./variants.mjs"
import { conversation, toolsOf } from "./conversation.mjs"
import { conversationID } from "./run-request.mjs"
import { agentURL, resetH1 } from "./transport.mjs"
import { runOnce } from "./run.mjs"
import { replyOf } from "./reply.mjs"

// answer runs a chat completion on Cursor, the account kept (cursorError).
// Every answer says X-Magpie-Sign-In: kept. The built-in marked no Cursor
// account lapsed, not for a 401 nor for any "expired" (a token, a session,
// a trial), and cleared none on a success or a renewed token.
export const answer = async (auth, chat, signal, session) => kept(await answerOf(auth, chat, signal, session))

// maxOnly are the ids Cursor said it serves in Max Mode only.
export const maxOnly = new Set()

// answerOf runs a chat completion on Cursor and answers it as one, streamed
// or not.
export async function answerOf(auth, chat, signal, session = "") {
  let tok
  try {
    tok = await tokenOf(auth)
  } catch (e) {
    return cursorError({ status: e.status ?? 401, message: e.message })
  }
  const model = String(chat.model ?? "")
  let raw = []
  try {
    raw = await usable(tok)
  } catch {}
  // fast only when asked: a service_tier of priority or fast is on; any
  // other tier, or none, is off, unless the id is a fast one of Cursor's own
  const tier = chat.service_tier
  const fast = tier === "priority" || tier === "fast" ? true : tier ? false : undefined
  const req = request(raw, model, chat.reasoning_effort ?? "", fast)
  const id = req.id
  const params = req.params
  let maxMode = req.maxMode || maxOnly.has(id)
  const tools = toolsOf(chat)
  const conv = conversation(chat, tools)
  const convID = conversationID(chat, session)
  let base = await agentURL(tok, false)
  const once = () => runOnce({ tok, base, id, tools, conv, convID, signal, maxMode, params })
  let r = await once()
  if (r.error && regional(r.error.message)) {
    // the team moved, or the config was kept from before: once more with
    // what the config says now. A Run that went over HTTP/1.1 went to api2,
    // not the region's agent host: once more over HTTP/2 there.
    const viaH1 = !!r.h1
    resetH1()
    const fresh = await agentURL(tok, true)
    if (fresh !== base || viaH1) {
      base = fresh
      r = await once()
    }
  }
  if (r.error && !maxMode && maxRequired(r.error.message)) {
    // a model Cursor serves only in Max Mode that neither list said so of:
    // in Max Mode, as the CLI turns it on for such a model, and so from
    // now on. An account Max Mode isn't open to is answered as Cursor
    // answers that.
    maxMode = true
    maxOnly.add(id)
    r = await once()
  }
  if (r.error) return cursorError(r.error)
  return replyOf(r.events, model, !!chat.stream)
}
