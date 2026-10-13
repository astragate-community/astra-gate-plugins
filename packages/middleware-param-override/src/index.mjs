// New API's 参数覆盖 (a channel's param_override) as magpie gateway middleware, based on
// an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md): the same JSON, so a param_override copied from New
// API works here unchanged, on every request an agent sends through the gateway.
//
// Two forms, as in New API:
//   {"temperature": 0.2, "max_tokens": 8000}     each key set as it is
//   {"operations": [{path, mode, value, ...}]}    run in order
// Keys beside "operations" are set first, the operations after.
//
// A path is gjson's: "a.b.0", "messages.-1" from the end, "*" any key or index, "\." a dot in a key. A condition
// looks in the body first, then in the request: model, original_model, request_path, protocol, agent, stream.
// What New API does with headers (set_header, pass_headers…) and with retries has nothing to act on here and is
// left out.
//
// Astra runs the built file as an ES module in Jint: only onRequest is exported, and nothing imports a package
// or a node: module (the modules beside this are bundled into dist/index.mjs).
import { when } from "./conditions.mjs"
import { applyOperation, REJECTED, UNCHANGED } from "./operations.mjs"

export function onRequest(body, ctx) {
  const o = ctx.options
  if (!o || typeof o !== "object") return
  // What a condition can name besides the body's own fields. The gateway knows one model per request, so the
  // model, original_model and upstream_model that New API tells apart are all the same here.
  const req = { model: ctx.model, original_model: ctx.model, upstream_model: ctx.model, request_path: ctx.path, protocol: ctx.protocol, agent: ctx.agent, stream: ctx.stream }
  let root = body
  let changed = false
  for (const k of Object.keys(o)) {
    if (k === "operations") continue
    root[k] = o[k]
    changed = true
  }
  const ops = Array.isArray(o.operations) ? o.operations : []
  for (const op of ops) {
    if (!op || typeof op !== "object" || !when(root, req, op.conditions, op.logic || "OR")) continue
    const next = applyOperation(root, op, req, ctx)
    if (next === REJECTED) return
    if (next !== UNCHANGED) {
      root = next
      changed = true
    }
  }
  // undefined tells the gateway the body is untouched, so it isn't re-encoded
  return changed ? root : undefined
}
