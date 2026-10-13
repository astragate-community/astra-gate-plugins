import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { onRequest, onEvent, onResponse } from "../src/index.mjs"
import { matcher, maskOf, maskText } from "../src/matcher.mjs"

// a ctx that records what the middleware turns away
const ctxOf = (options, protocol = "chat", extra = {}) => {
  const ctx = { options, protocol, status: 200, rejected: null, reject: (status, message) => (ctx.rejected = { status, message }), ...extra }
  return ctx
}
const user = (content) => ({ role: "user", content })

test("matcher: words are literal and case-insensitive, patterns are regexps, none gives null", () => {
  const re = matcher({ words: ["a.b", " x+ ", "", 5], patterns: ["\\d{3}", "", 7] })
  assert.ok(re.test("A.B"))
  re.lastIndex = 0
  assert.ok(!re.test("axb"))
  re.lastIndex = 0
  assert.ok(re.test("X+"))
  re.lastIndex = 0
  assert.ok(re.test("call 123"))
  assert.equal(matcher({ words: [], patterns: [] }), null)
  assert.equal(matcher({}), null)
  assert.equal(matcher(undefined), null)
  assert.equal(matcher("words"), null)
})

test("matcher: a pattern's own alternation stays inside it; the expression is cached per words and patterns", () => {
  const re = matcher({ words: ["zz"], patterns: ["a|b"] })
  assert.equal("zz a b".replace(re, "_"), "_ _ _")
  assert.equal(matcher({ words: ["zz"], patterns: ["a|b"] }), re)
  assert.notEqual(matcher({ words: ["zz"], patterns: ["a"] }), re)
})

test("matcher: a bad pattern throws, and the next good call still works", () => {
  assert.throws(() => matcher({ words: ["w"], patterns: ["("] }))
  assert.ok(matcher({ words: ["w"] }))
})

test("maskOf and maskText", () => {
  assert.equal(maskOf({}), "***")
  assert.equal(maskOf({ mask: 5 }), "***")
  assert.equal(maskOf({ mask: "" }), "")
  const re = matcher({ words: ["secret"] })
  // the shared expression is global: a second call must not start where the first stopped
  assert.equal(maskText(re, "secret Secret", "#"), "# #")
  assert.equal(maskText(re, "secret", "#"), "#")
})

test("onRequest with no words does nothing", () => {
  const ctx = ctxOf({ words: [] })
  assert.equal(onRequest({ messages: [user("hello")] }, ctx), undefined)
  assert.equal(ctx.rejected, null)
  assert.equal(onRequest({ messages: [] }, ctxOf(undefined)), undefined)
})

test("reject: turns the request away naming the word, status 400", () => {
  const ctx = ctxOf({ words: ["codename"] })
  assert.equal(onRequest({ messages: [user("about CodeName today")] }, ctx), undefined)
  assert.deepEqual(ctx.rejected, { status: 400, message: `this request has "CodeName", which this gateway doesn't send` })
})

test("reject: a custom message, and clean text passes", () => {
  const ctx = ctxOf({ words: ["x"], message: "no" })
  onRequest({ messages: [user("an x")] }, ctx)
  assert.equal(ctx.rejected.message, "no")
  const clean = ctxOf({ words: ["x"] })
  onRequest({ messages: [user("fine")] }, clean)
  assert.equal(clean.rejected, null)
})

test("reject is the action for anything that isn't mask", () => {
  const ctx = ctxOf({ words: ["x"], action: "whatever" })
  onRequest({ messages: [user("x")] }, ctx)
  assert.ok(ctx.rejected)
})

test("check last reads only the last user message with text; all reads every one", () => {
  const body = () => ({ messages: [user("bad word"), { role: "assistant", content: "ok" }, user("fine"), { role: "user", content: [{ type: "image_url" }] }] })
  const last = ctxOf({ words: ["bad"], check: "last" })
  onRequest(body(), last)
  assert.equal(last.rejected, null)
  const dflt = ctxOf({ words: ["bad"] })
  onRequest(body(), dflt)
  assert.equal(dflt.rejected, null)
  const all = ctxOf({ words: ["bad"], check: "all" })
  onRequest(body(), all)
  assert.ok(all.rejected)
})

test("only the user's text is read: not the system prompt, assistant, or tool results", () => {
  const ctx = ctxOf({ words: ["bad"], check: "all" })
  onRequest({ messages: [{ role: "system", content: "bad" }, { role: "assistant", content: "bad" }, { role: "tool", content: "bad" }, user("fine")] }, ctx)
  assert.equal(ctx.rejected, null)
})

test("mask: replaces every match in the chosen texts and returns the body", () => {
  const body = { messages: [user("old secret"), user("a secret and another SECRET")] }
  const out = onRequest(body, ctxOf({ words: ["secret"], action: "mask" }))
  assert.equal(out, body)
  assert.equal(body.messages[0].content, "old secret")
  assert.equal(body.messages[1].content, "a *** and another ***")
  const all = { messages: [user("old secret"), user("x")] }
  onRequest(all, ctxOf({ words: ["secret"], action: "mask", check: "all", mask: "[removed]" }))
  assert.equal(all.messages[0].content, "old [removed]")
})

test("mask: no match, no change, undefined", () => {
  assert.equal(onRequest({ messages: [user("fine")] }, ctxOf({ words: ["secret"], action: "mask" })), undefined)
})

test("mask: text parts are masked, image parts left", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "a secret" }, { type: "image_url", url: "secret" }] }] }
  onRequest(body, ctxOf({ words: ["secret"], action: "mask" }))
  assert.equal(body.messages[0].content[0].text, "a ***")
  assert.equal(body.messages[0].content[1].url, "secret")
})

test("responses: input string and input items", () => {
  const s = { input: "my secret" }
  assert.equal(onRequest(s, ctxOf({ words: ["secret"], action: "mask" }, "responses")), s)
  assert.equal(s.input, "my ***")
  const items = { input: [{ role: "user", content: [{ type: "input_text", text: "a secret" }, { type: "input_image" }] }, { role: "assistant", content: [{ type: "output_text", text: "secret" }] }] }
  onRequest(items, ctxOf({ words: ["secret"], action: "mask", check: "all" }, "responses"))
  assert.equal(items.input[0].content[0].text, "a ***")
  assert.equal(items.input[1].content[0].text, "secret")
  const rej = ctxOf({ words: ["secret"] }, "responses")
  onRequest({ input: "secret" }, rej)
  assert.ok(rej.rejected)
})

test("gemini: user contents, and a content without a role is the user's", () => {
  const body = { contents: [{ role: "model", parts: [{ text: "secret" }] }, { parts: [{ text: "a secret" }] }] }
  onRequest(body, ctxOf({ words: ["secret"], action: "mask", check: "all" }, "gemini"))
  assert.equal(body.contents[0].parts[0].text, "secret")
  assert.equal(body.contents[1].parts[0].text, "a ***")
})

test("malformed bodies don't throw", () => {
  for (const [body, protocol] of [[{}, "chat"], [{ messages: "x" }, "chat"], [{ messages: [null, 3] }, "chat"], [{ contents: null }, "gemini"], [{ input: 3 }, "responses"]]) {
    const ctx = ctxOf({ words: ["x"] }, protocol)
    assert.equal(onRequest(body, ctx), undefined)
    assert.equal(ctx.rejected, null)
  }
})

const masking = (extra) => ctxOf({ words: ["secret"], action: "mask", replies: true }, "chat", extra)

test("replies are left alone unless replies: true and action mask", () => {
  for (const options of [{ words: ["secret"], action: "mask" }, { words: ["secret"], replies: true }, { words: [], action: "mask", replies: true }, undefined]) {
    const ev = { type: "content_block_delta", delta: { text: "secret" } }
    assert.equal(onEvent(ev, ctxOf(options)), undefined)
    assert.equal(onResponse({ choices: [{ message: { content: "secret" } }] }, ctxOf(options)), undefined)
    assert.equal(ev.delta.text, "secret")
  }
})

test("onEvent masks each API's text deltas", () => {
  const cases = [
    [{ type: "content_block_delta", delta: { type: "text_delta", text: "a secret" } }, (e) => e.delta.text],
    [{ type: "response.output_text.delta", delta: "a secret" }, (e) => e.delta],
    [{ type: "response.output_text.done", text: "a secret" }, (e) => e.text],
    [{ choices: [{ delta: { content: "a secret" } }] }, (e) => e.choices[0].delta.content],
    [{ candidates: [{ content: { parts: [{ text: "a secret" }] } }] }, (e) => e.candidates[0].content.parts[0].text],
  ]
  for (const [ev, read] of cases) {
    assert.equal(onEvent(ev, masking()), ev)
    assert.equal(read(ev), "a ***")
  }
})

test("onEvent: nothing to mask, nothing returned", () => {
  assert.equal(onEvent({ type: "ping" }, masking()), undefined)
  assert.equal(onEvent({ choices: [{ delta: { role: "assistant" } }] }, masking()), undefined)
  assert.equal(onEvent({ choices: [{ delta: { content: "fine" } }] }, masking()), undefined)
  assert.equal(onEvent({ type: "content_block_delta", delta: { partial_json: "{}" } }, masking()), undefined)
  assert.equal(onEvent({ candidates: [{ finishReason: "STOP" }, null] }, masking()), undefined)
})

test("onResponse masks each API's whole reply", () => {
  const anthropic = { content: [{ type: "text", text: "a secret" }, { type: "tool_use", text: "secret" }] }
  assert.equal(onResponse(anthropic, masking()), anthropic)
  assert.equal(anthropic.content[0].text, "a ***")
  assert.equal(anthropic.content[1].text, "secret")
  const chat = { choices: [{ message: { content: "a secret" } }, { message: { content: null } }] }
  assert.equal(onResponse(chat, masking()), chat)
  assert.equal(chat.choices[0].message.content, "a ***")
  const responses = { output: [{ content: [{ type: "output_text", text: "a secret" }] }, { type: "function_call" }] }
  assert.equal(onResponse(responses, masking()), responses)
  assert.equal(responses.output[0].content[0].text, "a ***")
  const gemini = { candidates: [{ content: { parts: [{ text: "a secret" }] } }] }
  assert.equal(onResponse(gemini, masking()), gemini)
  assert.equal(gemini.candidates[0].content.parts[0].text, "a ***")
})

test("onResponse leaves errors and clean replies alone", () => {
  const err = { choices: [{ message: { content: "secret" } }] }
  assert.equal(onResponse(err, masking({ status: 500 })), undefined)
  assert.equal(err.choices[0].message.content, "secret")
  assert.equal(onResponse({ choices: [{ message: { content: "fine" } }] }, masking()), undefined)
})

// What Astra's Jint runner needs of the built file: nothing imported but relative files, and no node: modules.
test("the sources import only relative files", () => {
  const dir = new URL("../src/", import.meta.url)
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8").replace(/^\s*\/\/.*$/gm, "")
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+["']([^"']+)["']/gm)) assert.match(m[1], /^\.\.?\//, `${f} imports ${m[1]}`)
    assert.doesNotMatch(src, /\bnode:|\brequire\(|\bimport\(/, f)
  }
})
