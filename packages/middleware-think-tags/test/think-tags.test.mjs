import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { onEvent, onResponse } from "../src/index.mjs"
import { stripWhole, streamStripper, tail } from "../src/think.mjs"
import { reasoningToText, reasoningIntoReply } from "../src/reasoning.mjs"

const ctxOf = (options, extra = {}) => ({ options, state: {}, status: 200, ...extra })

test("stripWhole takes a leading block and the whitespace after it", () => {
  assert.equal(stripWhole("<think>hmm</think>\n\nanswer"), "answer")
  assert.equal(stripWhole("  \n<think>a\nb</think>answer"), "answer")
  assert.equal(stripWhole("<think></think>x"), "x")
})

test("stripWhole leaves a block that doesn't open the text, or isn't closed", () => {
  assert.equal(stripWhole("answer <think>x</think>"), "answer <think>x</think>")
  assert.equal(stripWhole("<think>never closed"), "<think>never closed")
  assert.equal(stripWhole("plain"), "plain")
  assert.equal(stripWhole(""), "")
})

test("stripWhole takes only the first block", () => {
  assert.equal(stripWhole("<think>a</think>b<think>c</think>d"), "b<think>c</think>d")
})

test("tail is the longest end of s that begins the tag", () => {
  assert.equal(tail("abc</thi", "</think>"), "</thi")
  assert.equal(tail("abc<", "</think>"), "<")
  assert.equal(tail("abc", "</think>"), "")
  assert.equal(tail("", "</think>"), "")
  assert.equal(tail("</think>", "</think>"), "")
  assert.equal(tail("xx</think", "</think>"), "</think")
})

// feed pieces through a stripper, as a stream does
const streamed = (pieces) => {
  const strip = streamStripper({}, "k")
  return pieces.map(strip)
}

test("a stream without a block passes straight through", () => {
  assert.deepEqual(streamed(["Hello", " world"]), ["Hello", " world"])
})

test("a stream's block is dropped, however its pieces fall", () => {
  const whole = "<think>reasoning</think>\n\nAnswer here"
  for (let n = 1; n <= whole.length; n++) {
    const pieces = []
    for (let i = 0; i < whole.length; i += n) pieces.push(whole.slice(i, i + n))
    const out = streamed(pieces).join("")
    assert.equal(out, "Answer here", `pieces of ${n}`)
  }
})

test("a partial open tag is held back, then given back when it isn't one", () => {
  assert.deepEqual(streamed(["<thi", "nk>x</think>y"]), ["", "y"])
  assert.deepEqual(streamed(["<th", "ought"]), ["", "<thought"])
  assert.deepEqual(streamed(["  ", "hi"]), ["", "  hi"])
})

test("after the text has begun, <think> is just text", () => {
  assert.deepEqual(streamed(["hello", "<think>x</think>"]), ["hello", "<think>x</think>"])
})

test("stripper state is per key", () => {
  const state = {}
  const a = streamStripper(state, "a0")
  const b = streamStripper(state, "a1")
  assert.equal(a("<think>x"), "")
  assert.equal(b("plain"), "plain")
  assert.equal(a("</think>done"), "done")
})

test("onEvent strips Anthropic text deltas across events, by block index", () => {
  const ctx = ctxOf(undefined)
  const send = (index, text) => {
    const ev = { type: "content_block_delta", index, delta: { type: "text_delta", text } }
    return onEvent(ev, ctx) ? ev.delta.text : text
  }
  assert.equal(send(0, "<think>a"), "")
  assert.equal(send(0, "b</think>\n"), "")
  assert.equal(send(0, "Hi"), "Hi")
  assert.equal(send(1, "plain"), "plain")
})

test("onEvent returns nothing for events it doesn't touch", () => {
  const ctx = ctxOf({ mode: "strip" })
  assert.equal(onEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } }, ctx), undefined)
  assert.equal(onEvent({ type: "ping" }, ctx), undefined)
  assert.equal(onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, ctx), undefined)
})

test("onEvent strips Responses deltas and whole-text events", () => {
  const ctx = ctxOf(undefined)
  const d1 = { type: "response.output_text.delta", item_id: "i", content_index: 0, delta: "<think>x</think>A" }
  assert.equal(onEvent(d1, ctx), d1)
  assert.equal(d1.delta, "A")
  const done = { type: "response.output_text.done", text: "<think>x</think>\nA" }
  assert.equal(onEvent(done, ctx), done)
  assert.equal(done.text, "A")
  const part = { type: "response.content_part.done", part: { text: "<think>x</think>A" } }
  assert.equal(onEvent(part, ctx), part)
  assert.equal(part.part.text, "A")
  const item = { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "<think>x</think>A" }] } }
  assert.equal(onEvent(item, ctx), item)
  assert.equal(item.item.content[0].text, "A")
  const completed = { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "<think>x</think>A" }] }, { type: "reasoning" }] } }
  assert.equal(onEvent(completed, ctx), completed)
  assert.equal(completed.response.output[0].content[0].text, "A")
  assert.equal(onEvent({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "A" }] }] } }, ctx), undefined)
})

test("onEvent strips Chat chunks per choice and gives back text held at the end", () => {
  const ctx = ctxOf(undefined)
  const chunk = (content, finish) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] })
  const c1 = chunk("<think>r</think>Hello")
  assert.equal(onEvent(c1, ctx), c1)
  assert.equal(c1.choices[0].delta.content, "Hello")
  const c2 = chunk(" there")
  assert.equal(onEvent(c2, ctx), undefined)
  // ends while "<thi" is held back: it comes out with the finish
  const ctx2 = ctxOf(undefined)
  const h1 = chunk("<thi")
  assert.equal(onEvent(h1, ctx2), h1)
  assert.equal(h1.choices[0].delta.content, "")
  const h2 = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  assert.equal(onEvent(h2, ctx2), h2)
  assert.equal(h2.choices[0].delta.content, "<thi")
  assert.equal(ctx2.state.c0.carry, "")
  // a choice without a delta is skipped
  assert.equal(onEvent({ choices: [null, {}, { index: 1, delta: { content: "ok" } }] }, ctxOf(undefined)), undefined)
})

test("onResponse strips Anthropic, Chat and Responses replies", () => {
  const anthropic = { content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "<think>x</think>A" }, { type: "text", text: "<think>y</think>B" }] }
  assert.equal(onResponse(anthropic, ctxOf(undefined)), anthropic)
  assert.equal(anthropic.content[1].text, "A")
  // only the first text block can open with the thinking
  assert.equal(anthropic.content[2].text, "<think>y</think>B")
  const chat = { choices: [{ message: { content: "<think>x</think>\nA" } }, { message: { content: null } }, null] }
  assert.equal(onResponse(chat, ctxOf({ mode: "strip" })), chat)
  assert.equal(chat.choices[0].message.content, "A")
  const responses = { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "<think>x</think>A" }] }] }
  assert.equal(onResponse(responses, ctxOf(undefined)), responses)
  assert.equal(responses.output[1].content[0].text, "A")
})

test("onResponse leaves errors, clean replies and unknown shapes alone", () => {
  const err = { choices: [{ message: { content: "<think>x</think>A" } }] }
  assert.equal(onResponse(err, ctxOf(undefined, { status: 500 })), undefined)
  assert.equal(err.choices[0].message.content, "<think>x</think>A")
  assert.equal(onResponse({ choices: [{ message: { content: "A" } }] }, ctxOf(undefined)), undefined)
  assert.equal(onResponse({}, ctxOf(undefined)), undefined)
})

test("to_content: a Chat stream's reasoning becomes <think> text, closed when the answer starts", () => {
  const ctx = ctxOf({ mode: "to_content" })
  const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })
  const a = chunk({ reasoning_content: "think " })
  assert.equal(onEvent(a, ctx), a)
  assert.deepEqual(a.choices[0].delta, { content: "<think>\nthink " })
  const b = chunk({ reasoning_content: "more" })
  onEvent(b, ctx)
  assert.deepEqual(b.choices[0].delta, { content: "more" })
  const c = chunk({ content: "Answer" })
  assert.equal(onEvent(c, ctx), c)
  assert.equal(c.choices[0].delta.content, "\n</think>\n\nAnswer")
  const d = chunk({ content: " more" })
  assert.equal(onEvent(d, ctx), undefined)
  assert.equal(d.choices[0].delta.content, " more")
})

test("to_content: the reasoning alias, an empty reasoning, and an end of stream that closes the block", () => {
  const ctx = ctxOf({ mode: "to_content" })
  const a = { choices: [{ index: 0, delta: { reasoning: "r" } }] }
  onEvent(a, ctx)
  assert.equal(a.choices[0].delta.content, "<think>\nr")
  const empty = { choices: [{ index: 0, delta: { reasoning_content: "", content: "" } }] }
  assert.equal(onEvent(empty, ctx), empty)
  assert.equal(empty.choices[0].delta.reasoning_content, undefined)
  const end = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  assert.equal(onEvent(end, ctx), end)
  assert.equal(end.choices[0].delta.content, "\n</think>\n\n")
  assert.equal(ctx.state.t0, "closed")
})

test("to_content: an empty reasoning alone never opens a block; non-Chat events are left alone", () => {
  const state = {}
  const ev = { choices: [{ index: 0, delta: { reasoning_content: "", content: "Hi" } }] }
  assert.equal(reasoningToText(ev, state), ev)
  assert.equal(ev.choices[0].delta.content, "Hi")
  assert.equal(state.t0, undefined)
  assert.equal(onEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "<think>x</think>y" } }, ctxOf({ mode: "to_content" })), undefined)
  assert.equal(reasoningToText({ choices: [null, {}] }, {}), undefined)
})

test("to_content: a whole Chat reply gets its reasoning in front", () => {
  const body = { choices: [{ message: { reasoning_content: "why", content: "Answer" } }, { message: { reasoning: "r2" } }, { message: { content: "none" } }, null] }
  assert.equal(onResponse(body, ctxOf({ mode: "to_content" })), body)
  assert.deepEqual(body.choices[0].message, { content: "<think>\nwhy\n</think>\n\nAnswer" })
  assert.deepEqual(body.choices[1].message, { content: "<think>\nr2\n</think>\n\n" })
  assert.deepEqual(body.choices[2].message, { content: "none" })
})

test("to_content: no reasoning, no choices, or an error: unchanged", () => {
  assert.equal(reasoningIntoReply({ choices: [{ message: { content: "x", reasoning_content: "" } }] }), undefined)
  assert.equal(onResponse({ content: [] }, ctxOf({ mode: "to_content" })), undefined)
  assert.equal(onResponse({ choices: [{ message: { reasoning_content: "r" } }] }, ctxOf({ mode: "to_content" }, { status: 400 })), undefined)
  // to_content never strips
  assert.equal(onResponse({ choices: [{ message: { content: "<think>x</think>A" } }] }, ctxOf({ mode: "to_content" })), undefined)
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
