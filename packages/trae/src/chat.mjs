// Trae: a chat completion asked of the IDE agent — through the chat function that lists the model, the others if
// Trae says it isn't one it takes — and its answer as an OpenAI one.
import { randomUUID } from "node:crypto"
import { MAX } from "./constants.mjs"
import { ideHeaders } from "./api.mjs"
import { errorOf, errorResponse, failure, wrongFunction } from "./errors.mjs"
import { chain, first, parts } from "./parts.mjs"
import { chatBody, conversationID, sessionOf } from "./request.mjs"
import { completion } from "./reply.mjs"
import { signInOf, whoOf } from "./session.mjs"
import { sse } from "./sse.mjs"
import { ownRequest } from "./checkin.mjs"
import { parseJSON } from "./values.mjs"

// what a request the engine hands the loader's fetch is made of, as a Request or as (url, init)
async function requestOf(input, init) {
  const r0 = input instanceof Request ? input : null
  let body = init.body ?? (r0 ? await r0.text() : undefined)
  if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body)
  else if (ArrayBuffer.isView(body)) body = new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  return {
    body,
    url: r0 ? r0.url : input instanceof URL ? input.href : String(input),
    method: init.method ?? r0?.method ?? "POST",
    signal: init.signal ?? r0?.signal,
    headers: init.headers ?? r0?.headers ?? {},
  }
}

/**
 * The loader's fetch of one plugin instance: Trae CN's own pages go as the account, a chat completion goes to
 * the IDE agent. `fnOf` remembers the chat function that served each account last.
 */
export function createChat(site, sessions, catalog) {
  const fnOf = new Map()

  // asks Trae through one chat function: { answer } the OpenAI response, or { refusal, retry } the response
  // for what Trae said and whether another function may take the request
  const ask = async (a, req, who, fn, named, session, ac, signIn) => {
    const max = named?.max ?? null
    // the model name and reply limit are the function's own: those of its list's entry, when it has one
    const listed = named?.fn === fn || max
    const res = await fetch(site.apiOf(a) + "/api/agent/v3/llm_utils_chat", {
      method: "POST",
      headers: ideHeaders(a, site, { Accept: "text/event-stream", "X-Request-ID": randomUUID() }),
      body: JSON.stringify(chatBody(req, fn, listed ? named.name : "", listed ? named.most : 0, max, session)),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      const e = errorOf(text)
      return { refusal: failure(site, res.status, e.code, e.message || text.trim().slice(0, 300)), retry: res.status === 400 && wrongFunction(e.code) }
    }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("event-stream") && ct.includes("json")) {
      // an answer that isn't a stream is an error in a 200
      const e = errorOf(await res.text())
      return { refusal: failure(site, 502, e.code, e.message), retry: wrongFunction(e.code) }
    }
    const it = parts(sse(res.body), Array.isArray(req.tools) ? req.tools : [])[Symbol.asyncIterator]()
    const { held, done } = await first(it)
    const err = held.find((p) => p.error)
    if (err) {
      const retry = wrongFunction(err.code)
      if (retry) {
        // another function may take it: this answer's read goes
        // with the function it came from, not left hanging
        it.return?.()
        res.body.cancel?.().catch(() => {})
      }
      return { refusal: failure(site, 502, err.code, err.error), retry }
    }
    fnOf.set(who, fn)
    const answer = await completion(req, done ? held : chain(held, it), () => ac.abort(), site)
    answer.headers.set("X-Magpie-Sign-In", signIn)
    return { answer }
  }

  return async function chatFetch(getAuth, a0, input, init = {}) {
    const { body, url, method, signal: outer, headers } = await requestOf(input, init)
    if (site.ownPage(url)) return ownRequest(site, sessions, getAuth, a0, url, method, body, outer)
    const req = parseJSON(body)
    if (!Array.isArray(req.messages)) return errorResponse(400, `${site.realm}: only chat completions are served`)
    const { a, refusal } = await sessions.freshOrRefusal(getAuth, a0)
    if (refusal) return refusal
    const signIn = signInOf(a)
    const who = whoOf(a)
    // the function that lists the model first, then the one that
    // served this account last, then the rest
    const fns = [...new Set([catalog.listedBy.get(String(req.model)), fnOf.get(who), ...site.functions].filter(Boolean))]
    let last
    let named = catalog.modelNames.get(String(req.model))
    if (!named && String(req.model).endsWith(MAX)) {
      // a Max asked before the list was read here: read it
      await catalog.live(a).catch(() => {})
      named = catalog.modelNames.get(String(req.model))
      if (named) fns.unshift(named.fn)
    }
    // the answer's own signal: the caller's abort (a cancelled
    // request) and the stream's cancel both stop Trae's fetch, so
    // no read is left hanging on a connection the agent walked
    // away from
    const ac = new AbortController()
    if (outer) {
      if (outer.aborted) ac.abort()
      else outer.addEventListener("abort", () => ac.abort(), { once: true })
    }
    // the conversation this request belongs to, from the chat.headers
    // hook (magpie's session) or the chat's own first user message, as
    // the account answering it, so a failover inside one conversation
    // is not one Trae reads as another's
    const session = conversationID(req, sessionOf(new Headers(headers)), who)
    for (const fn of new Set(fns)) {
      const got = await ask(a, req, who, fn, named, session, ac, signIn)
      if (got.answer) return got.answer
      last = got.refusal
      if (!got.retry) break
    }
    if (!last.headers.has("X-Magpie-Sign-In")) last.headers.set("X-Magpie-Sign-In", signIn)
    return last
  }
}
