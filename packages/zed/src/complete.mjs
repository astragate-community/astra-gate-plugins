// One request through Zed's /completions.
import { CLOUD, VERSION, WIRE_VENDOR } from "./constants.mjs"
import { userAgent } from "./api.mjs"
import { bodyText, parse, reasonOf } from "./json.mjs"
import { vendors } from "./models.mjs"
import { refusal, SignInExpired, stale } from "./refusals.mjs"
import { providerRequest, wireOf } from "./request.mjs"
import { streamed, whole } from "./response.mjs"
import { modelToken } from "./token.mjs"
import { errorResponse } from "./wire.mjs"

// complete sends one request through Zed's /completions.
export async function complete(s, url, init) {
  const w = wireOf(url)
  if (!w) return new Response(JSON.stringify({ error: { message: "nothing is served at " + new URL(url).pathname } }), { status: 404, headers: { "content-type": "application/json" } })
  const req = parse(await bodyText(init?.body))
  if (!req || typeof req !== "object") return errorResponse(w.wire, 400, "an unreadable request")
  const id = w.model ?? String(req.model ?? "")
  const vendor = vendors.get(id) ?? WIRE_VENDOR[w.wire]
  const { req: pr, stream = w.stream } = providerRequest(w.wire, req, id)
  const body = JSON.stringify({ provider: vendor, model: id, provider_request: pr })
  let res
  for (let t = 0; ; t++) {
    let tok
    try {
      tok = await modelToken(s, t > 0)
    } catch (e) {
      if (e instanceof SignInExpired) return errorResponse(w.wire, 401, e.message, "expired")
      return errorResponse(w.wire, 502, reasonOf(e))
    }
    res = await fetch(CLOUD + "/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tok,
        "Content-Type": "application/json",
        "x-zed-version": VERSION,
        "x-zed-client-supports-status-messages": "true",
        "x-zed-client-supports-stream-ended-request-completion-status": "true",
        "User-Agent": userAgent(),
      },
      body,
      signal: init?.signal,
    })
    // a model token Zed calls stale is minted again, once
    if (t === 0 && stale(res.status, res.headers)) {
      await res.body?.cancel?.().catch(() => {})
      continue
    }
    break
  }
  if (!res.ok) {
    const [status, msg] = refusal(res.status, await res.text())
    return errorResponse(w.wire, status, msg)
  }
  return stream ? streamed(w.wire, res) : whole(w.wire, res)
}
