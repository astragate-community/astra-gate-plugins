// New API's 模型重定向 (a channel's model_mapping) as magpie gateway middleware, based on
// @magpie-community/middleware-model-map 0.1.1 (MIT): the model an agent asks for is sent as another, and the
// reply names the model the agent asked for again, so an agent that reads its model's name back (Claude Code
// does, for its context window) sees what it asked for.
//
//   {"mapping": {"fast": "deepseek-chat", "/^claude-(.*)$/": "glm-$1"}}
//
// New API's own flat form, {"fast": "deepseek-chat"}, works too. A name maps on (a → b → c) until it maps to
// nothing more; a cycle stops where it would repeat. A key written /like this/ is a regular expression, and its
// value can use $1. "keep_upstream_name": true leaves the upstream model's name in replies.
//
// Astra runs the built file as an ES module in Jint: only the three hooks are exported, and nothing imports a
// package or a node: module (the helpers live in the relative modules beside this, bundled into dist/index.mjs).

import { compileRules, resolveModel } from "./rules.mjs"
import { nameAskedInEvent, nameAskedInResponse } from "./rename.mjs"

export function onRequest(body, ctx) {
  // the gateway puts a Gemini request's model in its body too (the URL's
  // model, which it reads from there as for every other API)
  if (body.model === null || typeof body.model !== "string") return
  const to = resolveModel(body.model, compileRules(ctx.options))
  if (to === body.model) return
  // remembered for onEvent / onResponse, which share ctx.state with this call
  ctx.state.asked = body.model
  body.model = to
  return body
}

export function onEvent(ev, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options.keep_upstream_name) return
  return nameAskedInEvent(ev, asked)
}

export function onResponse(body, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options.keep_upstream_name || ctx.status >= 400) return
  return nameAskedInResponse(body, asked)
}
