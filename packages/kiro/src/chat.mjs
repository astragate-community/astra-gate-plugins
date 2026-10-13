// Kiro: answering a Messages request through Kiro's API.
import { kept } from "@astragate-community/plugin-kit"
import { events } from "./events.mjs"
import { failure, messagesError } from "./refusals.mjs"
import { buildKiro, sendKiro, thinking } from "./request.mjs"
import { reply } from "./response.mjs"
import { toolNames } from "./tools.mjs"

// generate answers a Messages request through Kiro's API: once more,
// refreshed, when Kiro turns the token down (403). As the built-in: no
// credentials is a 401, a failed refresh after the 403 a 502; none marks
// the account.
export async function generate(creds, auth, req, signal) {
  const model = String(req.model ?? "auto")
  const budget = thinking(req, model)
  // sent is { res } for Kiro's answer, or { failure } for the answer to give when the call itself failed
  const send = async (a) => {
    try {
      return { res: await sendKiro(a, buildKiro(req, model, a.profile, budget), signal) }
    } catch (e) {
      if (e?.name === "AbortError") throw e
      return { failure: messagesError(502, e.message) }
    }
  }
  let a
  try {
    a = await creds(auth)
  } catch (e) {
    return messagesError(401, e.message)
  }
  let sent = await send(a)
  if (sent.res?.status === 403) {
    await sent.res.body?.cancel()
    try {
      a = await creds(auth, true)
    } catch (e) {
      return messagesError(502, e.message)
    }
    sent = await send(a)
  }
  if (sent.failure) return sent.failure
  const res = sent.res
  if (!res.ok) {
    // Kiro's own 401 is passed on, as the built-in did, the sign-in kept
    const f = failure(res.status, (await res.text()).slice(0, 1 << 20))
    return messagesError(f.status, f.message)
  }
  return kept(await reply(events(res.body, model, budget), model, req.stream === true, toolNames(req)))
}
