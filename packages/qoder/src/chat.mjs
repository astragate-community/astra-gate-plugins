// Qoder: answering a chat completion — the model lookup, the signed call to agent_chat_generation, and the reply.
import { CHAT_PATH } from "./constants.mjs"
import { cosyHeaders } from "./cosy.mjs"
import { encodeBody } from "./codec.mjs"
import { qoderBody } from "./request.mjs"
import { errorResponse, failure } from "./refusals.mjs"
import { answer } from "./response.mjs"
import { siteOf } from "./sites.mjs"

/** `ask(chat, cred, init)` is the answer to a chat completion on the live account cred; `models` is the plugin's listings cache. */
export function createChat(site, models) {
  return async (chat, cred, init) => {
    let m
    try {
      m = (await models(cred)).find((x) => x.key === chat.model) ?? (await models(cred, true)).find((x) => x.key === chat.model)
    } catch (e) {
      // the built-in answered any failure to read the list 400
      // (QoderModelOf), a refused one included, marking nothing
      return errorResponse({ status: 400, message: e.message })
    }
    if (!m) return errorResponse({ status: 400, message: `unknown or disabled model "${chat.model}"` })
    const url = siteOf(site, cred).api + CHAT_PATH
    const wire = encodeBody(JSON.stringify(qoderBody(chat, m)))
    const headers = {
      ...cosyHeaders(url, cred, wire),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Model-Key": m.key,
      "X-Model-Source": m.source,
    }
    let res
    try {
      res = await fetch(url, { method: "POST", headers, body: wire, signal: init.signal })
    } catch (e) {
      return errorResponse({ status: 502, message: e.message })
    }
    if (!res.ok) return errorResponse(failure(res.status, (await res.text()).slice(0, 1 << 20)))
    return answer(res, chat)
  }
}
