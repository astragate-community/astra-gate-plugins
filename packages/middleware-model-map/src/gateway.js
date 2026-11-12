// New API's 模型重定向 (a channel's model_mapping) as an Astra v2 gateway hook set, a rewrite of the v1 magpie
// middleware: the model an agent asks for is sent as another, and the reply names the model the agent asked for
// again, so an agent that reads its model's name back (Claude Code does, for its context window) sees what it asked for.
//
// The rules and the keepUpstreamName switch are what main.js's settings view keeps in storage; the hook set
// reads them from ctx.shared (manifest `reads`), synchronously. The raw view is deliberate: the model sits in
// body.model for every protocol (the gateway puts a Gemini request's URL model there too).

import { gateway } from "astra"
import { compileRules, resolveModel } from "./rules.js"
import { nameAskedInEvent, nameAskedInResponse } from "./rename.js"

export function onRequest(body, ctx) {
  if (body.model === null || typeof body.model !== "string") return
  const to = resolveModel(body.model, compileRules(ctx.shared.rules))
  if (to === body.model) return
  // remembered for onEvent / onResponse, which share ctx.state with this call
  ctx.state.asked = body.model
  body.model = to
  return body
}

export function onEvent(ev, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.shared.keepUpstreamName === true) return
  return nameAskedInEvent(ev, asked)
}

export function onResponse(body, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.shared.keepUpstreamName === true || ctx.status >= 400) return
  return nameAskedInResponse(body, asked)
}

export default gateway.defineHooks({ map: { onRequest, onEvent, onResponse } })
