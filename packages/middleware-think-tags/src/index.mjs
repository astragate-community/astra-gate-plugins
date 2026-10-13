// A model's thinking, where its reply's text is: New API's thinking_to_content, and the other way round. Based on
// an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
//   {"mode": "strip"}       (the default)
//   {"mode": "to_content"}
//
// "strip": a model that writes its thinking into the reply as <think>…</think> at the start of its text has that
// block taken out, so an agent doesn't keep it in its history and send it back each turn. Only a block that
// opens the text is taken; <think> later on, in code the model writes, stays. Anthropic, Chat and Responses
// replies, streamed or whole.
//
// "to_content": a Chat reply's reasoning_content (or reasoning) is put in its text as <think>…</think>, for a
// client that shows only the text. Chat only: an Anthropic thinking block carries a signature, and turned into
// text it would fail the next turn. It changes what the agent keeps and sends back, so it suits a chat client
// better than a coding agent.
//
// Astra runs the built file as an ES module in Jint: only onEvent and onResponse are exported (no onRequest: it
// never touches a request), and nothing imports a package or a node: module.
import { stripEvent, stripReply } from "./strip.mjs"
import { reasoningToText, reasoningIntoReply } from "./reasoning.mjs"

const toContent = (ctx) => !!ctx.options && ctx.options.mode === "to_content"

export function onEvent(ev, ctx) {
  if (toContent(ctx)) return Array.isArray(ev.choices) ? reasoningToText(ev, ctx.state) : undefined
  return stripEvent(ev, ctx.state)
}

export function onResponse(body, ctx) {
  if (ctx.status >= 400) return
  return toContent(ctx) ? reasoningIntoReply(body) : stripReply(body)
}
