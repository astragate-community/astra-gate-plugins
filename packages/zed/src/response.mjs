// Turning Zed's reply back into the provider's own: a server-sent stream, or one whole reply.
import { KEPT } from "@astragate-community/plugin-kit"
import { assemble } from "./assemble.mjs"
import { reasonOf } from "./json.mjs"
import { errorStatusOf, failedStatus } from "./refusals.mjs"
import { errorEvent, errorResponse, eventError, lines, said, sse } from "./wire.mjs"

// whether the reply said it sends statuses (and so ends with stream_ended)
const wrappedOf = (res) => !!res.headers.get("x-zed-server-supports-status-messages")

// a failed status line as a refused request
const failedReply = (wire, failed) => errorResponse(wire, errorStatusOf(failed.code), failed.message || failed.code)

// streamed turns Zed's lines into the provider's own server-sent events.
// What comes before the reply says anything is held, as magpie's built-in
// holds it (relayStatus): a failure there — a failed status, the
// provider's own error event, a reply that broke off or ended without an
// answer — is answered as a refused request with its status (a 429, a 402
// is another account's turn), not a 200 whose stream carries it.
export async function streamed(wire, res) {
  const wrapped = wrappedOf(res)
  const it = lines(res.body, wrapped)
  const head = []
  let ended = false
  let first = null // the first line that says something
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) break
      const l = r.value
      if (l.ended) {
        ended = true
        continue
      }
      if (l.failed) return failedReply(wire, l.failed)
      const bad = eventError(wire, l.event)
      if (bad !== undefined) return errorResponse(wire, 502, bad)
      if (said(wire, l.event)) {
        first = l
        break
      }
      head.push(l.event)
    }
  } catch (e) {
    return errorResponse(wire, 502, reasonOf(e))
  }
  if (!first) {
    if (wrapped && !ended) return errorResponse(wire, 502, "the reply ended before it was complete")
    return errorResponse(wire, 502, "Zed ended without an answer")
  }
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(ctl) {
      const put = (s) => ctl.enqueue(enc.encode(s))
      const fail = (status, message) => put(errorEvent(wire, status, message))
      for (const ev of head) put(sse(wire, ev))
      put(sse(wire, first.event))
      try {
        for (;;) {
          const r = await it.next()
          if (r.done) break
          const l = r.value
          if (l.ended) ended = true
          else if (l.failed) {
            // not clamped to an error status: the stream already said 200
            fail(failedStatus(l.failed.code), l.failed.message || l.failed.code)
            ctl.close()
            return
          } else put(sse(wire, l.event))
        }
        // Zed ends every whole reply with stream_ended
        if (wrapped && !ended) fail(502, "the reply ended before it was complete")
        else if (wire === "chat") put("data: [DONE]\n\n")
        ctl.close()
      } catch (e) {
        try {
          fail(502, reasonOf(e))
          ctl.close()
        } catch {}
      }
    },
    cancel() {
      it.return?.().catch?.(() => {})
      res.body?.cancel?.().catch(() => {})
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...KEPT } })
}

// whole reads all of Zed's lines into one reply of the provider's API.
export async function whole(wire, res) {
  const wrapped = wrappedOf(res)
  const events = []
  let ended = false
  try {
    for await (const l of lines(res.body, wrapped)) {
      if (l.ended) ended = true
      else if (l.failed) return failedReply(wire, l.failed)
      else {
        // the provider's own error, as the built-in's decoders read it
        const bad = eventError(wire, l.event)
        if (bad !== undefined) return errorResponse(wire, 502, bad)
        events.push(l.event)
      }
    }
  } catch (e) {
    return errorResponse(wire, 502, reasonOf(e))
  }
  if (wrapped && !ended) return errorResponse(wire, 502, "the reply ended before it was complete")
  const out = assemble(wire, events)
  if (!out) return errorResponse(wire, 502, "the reply ended before it was complete")
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", ...KEPT } })
}
