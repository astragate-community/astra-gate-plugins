// One Run of a chat on the agent API.
import { randomUUID } from "node:crypto"
import { ledger } from "./step-usage.mjs"
import { buildRun } from "./run-request.mjs"
import { open } from "./transport.mjs"
import { clientVersion } from "./cli.mjs"
import { frame, frames, pb } from "./protobuf.mjs"
import { EMPTY } from "./constants.mjs"
import http2 from "node:http2"
import { badGateway, failure } from "./errors.mjs"
import { decode } from "./decode.mjs"

// runOnce is one Run of the chat on the agent API at base: an async
// iterator of the answer's pieces, or the error it failed with before any.
export async function runOnce({ tok, base, id, tools, conv, convID, signal, maxMode, params }) {
  // the Run's conversation_id, a new one when nothing names the session:
  // its usage event is found by it
  const cid = convID || randomUUID()
  const since = Date.now()
  // how its usage is counted: a debt of the conversation's is collected
  // while it goes, which only a conversation_id that names the session
  // could have run up
  const book = ledger(tok, cid, since, signal, !!convID)
  const { first, blobs } = buildRun(conv.msgs, conv.last, tools, id, cid, { maxMode, params })
  const o = await open(
    base,
    {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: `Bearer ${tok}`,
      "x-cursor-client-version": await clientVersion(),
      "x-cursor-client-type": "cli", // else Cursor adds a prompt of its own
      "x-ghost-mode": "true", // privacy mode: nothing kept for training
      "x-request-id": randomUUID(),
      // none of Cursor's own tools, only the caller's
      "x-cursor-agent-allowed-tools": "mcp_tool_call,get_mcp_tools_tool_call",
    },
    signal,
  )
  if (o.error) return book.done(), o
  const { session, req } = o
  let closed = false
  const send = (msg) => {
    if (!closed && !req.destroyed && req.writable) req.write(frame(msg))
  }
  const heartbeat = setInterval(() => send(pb().bytes(7, EMPTY).done()), 5000) // the client is still there, as the CLI says
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    try {
      req.close(http2.constants.NGHTTP2_CANCEL)
    } catch {}
    session.close()
    setTimeout(() => session.destroy(), 1000).unref?.()
  }
  signal?.addEventListener("abort", close, { once: true })
  send(first)
  if (o.status < 200 || o.status > 299) {
    const chunks = []
    try {
      for await (const c of req) chunks.push(c)
    } catch {}
    close()
    book.done()
    return { error: failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20)) }
  }
  const it = decode(frames(req), {
    send,
    blobs,
    tools,
    estimate: conv.estimate,
    close,
    stepUsage: book.own,
    owedUsage: book.owed,
  })
  const wrapped = (async function* () {
    try {
      yield* it
    } finally {
      close()
      book.done()
    }
  })()
  // an error comes before anything of the answer: out of quota, a model the
  // plan doesn't have — answered with its own status
  const head = await wrapped.next()
  if (head.done) return book.done(), { error: badGateway("an empty reply") }
  if (head.value.error) {
    await wrapped.return()
    return { error: head.value.error, h1: !!o.h1 }
  }
  return {
    events: (async function* () {
      yield head.value
      yield* wrapped
    })(),
  }
}
