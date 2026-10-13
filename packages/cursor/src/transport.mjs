// The agent API's address and how a Run is opened: HTTP/2, or HTTP/1.1 where that is blocked.
import { hashOf } from "./hash.mjs"
import { AGENT, API } from "./constants.mjs"
import { unary } from "./api.mjs"
import { badGateway } from "./errors.mjs"
import http2 from "node:http2"
import { Duplex } from "node:stream"
import { frame, pb } from "./protobuf.mjs"

// endpoints are the agent API picked for each token (by its hash). As
// cursor-agent does, it is what ServerConfigService/GetServerConfig names —
// a team may be served in one region only, and the global API turns it
// away — asked once a token, and again when fresh is set; the global one
// while it can't be had.
const endpoints = new Map()
export async function agentURL(tok, fresh) {
  const key = hashOf(tok)
  const had = endpoints.get(key)
  if (!fresh && had && (had.listed || Date.now() - had.at < 60_000)) return had.url
  let url = AGENT
  let listed = false
  try {
    const cfg = await unary(API, "aiserver.v1.ServerConfigService/GetServerConfig", tok, {}, 10_000)
    for (const raw of [cfg?.agentUrlConfig?.agentUrl, cfg?.agentUrlConfig?.agentnUrl]) {
      try {
        const u = new URL(raw)
        if ((u.protocol === "https:" || u.protocol === "http:") && u.host) {
          url = raw.replace(/\/+$/, "")
          listed = true
          break
        }
      } catch {}
    }
  } catch {}
  endpoints.set(key, { url, at: Date.now(), listed })
  return url
}

// h1Fallback.until is when the Runs go back to trying HTTP/2 (0: they try it now).
const h1Fallback = { until: 0 }

// resetH1 sends the next Run back to HTTP/2 at once (a region error: the retry goes to another host).
export const resetH1 = () => {
  h1Fallback.until = 0
}

// open starts a Run at base: the session, the stream, and the response's
// status, or an error the request never got past. A Run HTTP/2 can't open
// goes over HTTP/1.1 (openH1). When the failure says HTTP/2 itself can't be
// had here (h2Blocked), the Runs after it go straight to HTTP/1.1 for
// H2.retryAfter, or until a region error sends one back (answerOf); a
// connection that failed (refused, no network) or a stream the server
// refused leaves the next Run to try HTTP/2 again.
export async function open(base, headers, signal) {
  if (Date.now() >= h1Fallback.until) {
    const o = await openH2(base, headers, signal)
    if (!o.h2Failed) return o
    if (o.blocked) h1Fallback.until = Date.now() + H2.retryAfter
  }
  return openH1(headers, signal)
}

export const H2 = {
  wait: 15_000, // ms an HTTP/2 Run waits for its response's head
  retryAfter: 10 * 60_000, // ms the Runs after one found HTTP/2 blocked stay on HTTP/1.1
}

// NET are the failures of a connection itself, which say nothing of HTTP/2
const NET = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"]

// h2Blocked is whether a failure to open an HTTP/2 Run says HTTP/2 itself
// can't be had: no head in H2.wait, the "h2 is not supported" magpie's
// host gives a tunnel that can't carry it, a server or proxy that won't
// negotiate it (ALPN), an HTTP/2 protocol error. Anything else, a failed
// connection above all, is not.
export function h2Blocked(e) {
  if (e?.h2Timeout) return true
  const code = String(e?.code ?? "")
  const text = `${code} ${e?.message ?? ""}`
  if (NET.some((c) => text.includes(c))) return false
  // a stream the server refused or reset: HTTP/2 itself got through
  if (code === "ERR_HTTP2_STREAM_ERROR") return false
  return code.startsWith("ERR_HTTP2") || /h2 is not supported|alpn|nghttp2|protocol error/i.test(text)
}

// openH2 is open over HTTP/2. A Run that fails before its response, other
// than by being cancelled, says h2Failed, and blocked when h2Blocked says
// so of the failure.
function openH2(base, headers, signal) {
  return new Promise((resolve) => {
    const u = new URL(base)
    const session = http2.connect(u.origin)
    let done = false
    const fail = (e, h2Failed = true) => {
      if (done) return
      done = true
      clearTimeout(timer)
      session.destroy()
      resolve({ error: badGateway(e?.message ?? String(e)), h2Failed, blocked: h2Failed && h2Blocked(e) })
    }
    const timer = setTimeout(() => fail(Object.assign(new Error(`no answer over HTTP/2 in ${H2.wait / 1000}s`), { h2Timeout: true })), H2.wait)
    session.on("error", fail)
    const req = session.request({
      ":method": "POST",
      ":path": u.pathname.replace(/\/+$/, "") + "/agent.v1.AgentService/Run",
      ...headers,
    })
    req.on("error", fail)
    // a stream reset before its head (RST_STREAM, REFUSED_STREAM) may close
    // it with no error said
    req.once("close", () => fail(Object.assign(new Error(`the HTTP/2 stream closed before its response (code ${req.rstCode ?? "?"})`), { code: "ERR_HTTP2_STREAM_ERROR" })))
    req.once("response", (h) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ session, req, status: Number(h[":status"]) })
    })
    signal?.addEventListener("abort", () => fail(new Error("the request was cancelled"), false), { once: true })
  })
}

export const H1 = { appendWait: 60_000 } // ms a BidiAppend may take before the Run fails, as cursor-agent's appendTimeoutMs

// connectCode is Connect's code for an HTTP status that came with no
// Connect error of its own
function connectCode(status) {
  return { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 429: "resource_exhausted" }[status] ?? "unavailable"
}

// openH1 is open over HTTP/1.1, as Cursor's clients run a Run without
// HTTP/2: what runOnce writes (a Connect frame each time) goes up as
// BidiAppend calls in turn, numbered from 0, and what RunSSE sends down is
// the stream it reads, Connect's frames as the HTTP/2 Run's. Its response
// is a 200 at once; an error Cursor says later, or a call that fails,
// ends the stream with Connect's end frame, which runOnce reads as the
// Run's own.
export function openH1(headers, signal) {
  const ac = new AbortController()
  signal?.addEventListener("abort", () => ac.abort(), { once: true })
  const id = headers["x-request-id"]
  const h = { ...headers, "accept-encoding": "identity", "x-cursor-streaming": "true" }
  let ended = false
  let seq = 0
  let chain = Promise.resolve()
  const req = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      // runOnce writes one whole frame each time
      const msg = Buffer.from(chunk).subarray(5)
      const n = seq++
      chain = chain.then(() => (ended ? undefined : append(msg, n)))
      cb()
    },
  })
  const end = (body) => {
    if (ended || req.destroyed) return
    ended = true
    const f = frame(Buffer.from(body))
    f[0] = 2
    req.push(f)
    req.push(null)
    ac.abort()
  }
  const failed = async (res) => {
    const text = await res.text().catch(() => "")
    let e
    try {
      e = JSON.parse(text)
    } catch {}
    end(JSON.stringify({ error: typeof e?.code === "string" ? e : { code: connectCode(res.status), message: text.trim() || `HTTP ${res.status}` } }))
  }
  // append sends one message up. One that gets no answer by its deadline
  // (more time for a large one) ends the Run, as cursor-agent's
  // bidi_append_deadline_exceeded does: the messages after it wait on it.
  const append = async (msg, n) => {
    const body = pb().str(1, msg.toString("hex")).bytes(2, pb().str(1, id).done()).varint(3, n).done()
    const ms = H1.appendWait + Math.ceil(body.length / 65536) * 1000
    const deadline = AbortSignal.timeout(ms)
    try {
      const res = await fetch(API + "/aiserver.v1.BidiService/BidiAppend", {
        method: "POST",
        headers: { ...h, "content-type": "application/proto", "connect-protocol-version": "1" },
        body,
        signal: AbortSignal.any([ac.signal, deadline]),
      })
      if (!res.ok) return failed(res)
      await res.arrayBuffer()
    } catch (e) {
      if (ac.signal.aborted) return
      if (deadline.aborted) return end(JSON.stringify({ error: { code: "deadline_exceeded", message: `BidiAppend got no answer in ${Math.round(ms / 1000)}s` } }))
      end(JSON.stringify({ error: { code: "unavailable", message: `BidiAppend: ${e?.message ?? e}` } }))
    }
  }
  ;(async () => {
    try {
      const res = await fetch(API + "/agent.v1.AgentService/RunSSE", {
        method: "POST",
        headers: { ...h, "content-type": "application/connect+proto", "connect-protocol-version": "1" },
        body: frame(pb().str(1, id).done()),
        signal: ac.signal,
      })
      if (!res.ok) return failed(res)
      for await (const c of res.body) {
        if (ended || req.destroyed) return
        req.push(Buffer.from(c))
      }
      if (!ended && !req.destroyed) {
        ended = true
        req.push(null)
      }
    } catch (e) {
      if (!ac.signal.aborted) end(JSON.stringify({ error: { code: "unavailable", message: `RunSSE: ${e?.message ?? e}` } }))
    }
  })()
  const close = () => {
    ended = true
    ac.abort()
    req.destroy()
  }
  return Promise.resolve({ session: { close, destroy: close }, req: Object.assign(req, { close }), status: 200, h1: true })
}
