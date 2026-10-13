import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { onRequest } from "../src/index.mjs"

const P = "Answer in English."
const run = (body, options, protocol, extra = {}) => {
  const out = onRequest(body, { options: { system_prompt: P, ...options }, protocol, ...extra })
  return { out, body }
}

test("no prompt, bad options or an unknown protocol: nothing happens", () => {
  assert.equal(onRequest({}, { options: {}, protocol: "chat" }), undefined)
  assert.equal(onRequest({}, { options: undefined, protocol: "chat" }), undefined)
  assert.equal(onRequest({}, { options: { system_prompt: 5 }, protocol: "chat" }), undefined)
  assert.equal(onRequest({}, { options: { system_prompt: "" }, protocol: "chat" }), undefined)
  assert.equal(run({}, {}, "other").out, undefined)
})

test("agents filter: only the listed agents", () => {
  assert.equal(run({ messages: [] }, { agents: ["claude-code"] }, "chat", { agent: "codex" }).out, undefined)
  assert.ok(run({ messages: [] }, { agents: ["claude-code"] }, "chat", { agent: "claude-code" }).out)
  assert.ok(run({ messages: [] }, { agents: [] }, "chat", { agent: "codex" }).out)
})

test("models filter: only model name prefixes, from the body or else the ctx", () => {
  assert.equal(run({ model: "gpt-4o", messages: [] }, { models: ["claude"] }, "chat").out, undefined)
  assert.ok(run({ model: "claude-3", messages: [] }, { models: ["claude"] }, "chat").out)
  assert.ok(run({ messages: [] }, { models: ["gem"] }, "chat", { model: "gemini-2" }).out)
  assert.equal(run({ messages: [] }, { models: [7] }, "chat").out, undefined)
  assert.equal(run({ messages: [] }, { models: ["x"] }, "chat").out, undefined)
})

test("anthropic: given when there is none, kept unless override", () => {
  for (const system of [undefined, null, "", []]) {
    const { out, body } = run({ system }, {}, "anthropic")
    assert.equal(out, body)
    assert.equal(body.system, P)
  }
  const own = { system: "mine" }
  assert.equal(run(own, {}, "anthropic").out, undefined)
  assert.equal(own.system, "mine")
})

test("anthropic: override appends or prepends, to a string or to blocks", () => {
  assert.equal(run({ system: "mine" }, { override: true }, "anthropic").body.system, "mine\n" + P)
  assert.equal(run({ system: "mine" }, { override: true, position: "prepend" }, "anthropic").body.system, P + "\nmine")
  const blocks = run({ system: [{ type: "text", text: "mine" }] }, { override: true }, "anthropic").body.system
  assert.deepEqual(blocks, [{ type: "text", text: "mine" }, { type: "text", text: P }])
  const front = run({ system: [{ type: "text", text: "mine" }] }, { override: true, position: "prepend" }, "anthropic").body.system
  assert.deepEqual(front, [{ type: "text", text: P }, { type: "text", text: "mine" }])
  // a system of some other shape is not ours to rewrite
  const odd = { system: 5 }
  assert.equal(run(odd, { override: true }, "anthropic").out, undefined)
  assert.equal(odd.system, 5)
})

test("chat: a system message is added in front when there is none", () => {
  const { out, body } = run({ messages: [{ role: "user", content: "hi" }] }, {}, "chat")
  assert.equal(out, body)
  assert.deepEqual(body.messages[0], { role: "system", content: P })
  assert.equal(body.messages.length, 2)
  assert.deepEqual(run({ messages: [] }, {}, "chat").body.messages, [{ role: "system", content: P }])
})

test("chat: the agent's own system or developer message is kept unless override", () => {
  for (const role of ["system", "developer"]) {
    const body = { messages: [{ role, content: "mine" }] }
    assert.equal(run(body, {}, "chat").out, undefined)
    assert.equal(body.messages[0].content, "mine")
    assert.equal(run({ messages: [{ role, content: "mine" }] }, { override: true }, "chat").body.messages[0].content, "mine\n" + P)
    assert.equal(run({ messages: [{ role, content: "mine" }] }, { override: true, position: "prepend" }, "chat").body.messages[0].content, P + "\nmine")
  }
})

test("chat: override into content parts, and into content of another shape", () => {
  const parts = run({ messages: [{ role: "system", content: [{ type: "text", text: "mine" }] }] }, { override: true }, "chat")
  assert.deepEqual(parts.body.messages[0].content, [{ type: "text", text: "mine" }, { type: "text", text: P }])
  const front = run({ messages: [{ role: "system", content: [{ type: "text", text: "mine" }] }] }, { override: true, position: "prepend" }, "chat")
  assert.deepEqual(front.body.messages[0].content[0], { type: "text", text: P })
  assert.equal(run({ messages: [{ role: "system", content: null }] }, { override: true }, "chat").out, undefined)
})

test("chat: a body without a messages array is left alone", () => {
  assert.equal(run({}, {}, "chat").out, undefined)
  assert.equal(run({ messages: "x" }, {}, "chat").out, undefined)
})

test("chat: only the first message counts as the system prompt", () => {
  const { body } = run({ messages: [{ role: "user", content: "hi" }, { role: "system", content: "late" }] }, { override: true }, "chat")
  assert.equal(body.messages[0].content, P)
  assert.equal(body.messages.length, 3)
})

test("responses: instructions are given, kept, or joined", () => {
  assert.equal(run({}, {}, "responses").body.instructions, P)
  assert.equal(run({ instructions: "" }, {}, "responses").body.instructions, P)
  assert.equal(run({ instructions: 5 }, {}, "responses").body.instructions, P)
  const own = { instructions: "mine" }
  assert.equal(run(own, {}, "responses").out, undefined)
  assert.equal(run({ instructions: "mine" }, { override: true }, "responses").body.instructions, "mine\n" + P)
  assert.equal(run({ instructions: "mine" }, { override: true, position: "prepend" }, "responses").body.instructions, P + "\nmine")
})

test("gemini: systemInstruction parts, and the snake_case spelling when that is what is there", () => {
  assert.deepEqual(run({}, {}, "gemini").body.systemInstruction, { parts: [{ text: P }] })
  assert.deepEqual(run({ systemInstruction: { parts: [] } }, {}, "gemini").body.systemInstruction, { parts: [{ text: P }] })
  const snake = run({ system_instruction: { parts: [] } }, {}, "gemini").body
  assert.deepEqual(snake.system_instruction, { parts: [{ text: P }] })
  assert.equal(snake.systemInstruction, undefined)
  const own = { systemInstruction: { parts: [{ text: "mine" }] } }
  assert.equal(run(own, {}, "gemini").out, undefined)
  assert.deepEqual(run({ systemInstruction: { parts: [{ text: "mine" }] } }, { override: true }, "gemini").body.systemInstruction.parts, [{ text: "mine" }, { text: P }])
  assert.deepEqual(run({ systemInstruction: { parts: [{ text: "mine" }] } }, { override: true, position: "prepend" }, "gemini").body.systemInstruction.parts, [{ text: P }, { text: "mine" }])
  // both spellings present: camelCase wins
  const both = run({ system_instruction: { parts: [{ text: "a" }] }, systemInstruction: { parts: [{ text: "b" }] } }, { override: true }, "gemini").body
  assert.equal(both.systemInstruction.parts.length, 2)
  assert.equal(both.system_instruction.parts.length, 1)
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
