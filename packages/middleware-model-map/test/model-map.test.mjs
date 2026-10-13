import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { onRequest, onEvent, onResponse } from "../src/index.mjs"
import { compileRules, resolveModel } from "../src/rules.mjs"

const ctxOf = (options, extra = {}) => ({ options, state: {}, status: 200, ...extra })
const mapped = (name, mapping) => resolveModel(name, compileRules({ mapping }))

test("exact names map, and an unlisted name is left alone", () => {
  assert.equal(mapped("fast", { fast: "deepseek-chat" }), "deepseek-chat")
  assert.equal(mapped("slow", { fast: "deepseek-chat" }), "slow")
})

test("the flat form works, and keep_upstream_name is not a mapping", () => {
  const rules = compileRules({ fast: "deepseek-chat", keep_upstream_name: "true" })
  assert.deepEqual(rules.exact, { fast: "deepseek-chat" })
  assert.equal(resolveModel("keep_upstream_name", rules), "keep_upstream_name")
})

test("names chain until nothing more maps", () => {
  assert.equal(mapped("a", { a: "b", b: "c" }), "c")
})

test("a cycle stops where it would repeat", () => {
  assert.equal(mapped("a", { a: "b", b: "a" }), "b")
  assert.equal(mapped("a", { a: "a" }), "a")
})

test("a chain longer than 16 steps is cut", () => {
  const mapping = {}
  for (let i = 0; i < 40; i++) mapping["m" + i] = "m" + (i + 1)
  assert.equal(mapped("m0", mapping), "m16")
})

test("patterns: regexp keys, $1, flags, and exact names win over them", () => {
  const mapping = { "/^claude-(.*)$/": "glm-$1", "claude-special": "kept", "/^GPT-4$/i": "gpt-x" }
  assert.equal(mapped("claude-sonnet", mapping), "glm-sonnet")
  assert.equal(mapped("claude-special", mapping), "kept")
  assert.equal(mapped("gpt-4", mapping), "gpt-x")
})

test("a g flag is dropped so a pattern keeps matching call after call", () => {
  const rules = compileRules({ mapping: { "/^a$/g": "b" } })
  assert.equal(resolveModel("a", rules), "b")
  assert.equal(resolveModel("a", rules), "b")
})

test("entries with an empty or non-string target are ignored", () => {
  const rules = compileRules({ mapping: { a: "", b: 3, c: null, d: "e" } })
  assert.deepEqual(rules.exact, { d: "e" })
})

test("Object.prototype's names are not mappings", () => {
  assert.equal(mapped("constructor", { fast: "x" }), "constructor")
  assert.equal(mapped("toString", {}), "toString")
})

test("bad options give no rules", () => {
  for (const o of [undefined, null, "x", 3]) assert.deepEqual(compileRules(o), { exact: {}, patterns: [] })
})

test("onRequest rewrites the model and remembers the asked one", () => {
  const ctx = ctxOf({ mapping: { fast: "deepseek-chat" } })
  const body = { model: "fast", messages: [] }
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.model, "deepseek-chat")
  assert.equal(ctx.state.asked, "fast")
})

test("onRequest is a no-op without a string model or a mapping", () => {
  for (const body of [{}, { model: null }, { model: 7 }]) {
    const ctx = ctxOf({ mapping: { fast: "x" } })
    assert.equal(onRequest(body, ctx), undefined)
    assert.equal(ctx.state.asked, undefined)
  }
  const ctx = ctxOf({ mapping: { fast: "x" } })
  assert.equal(onRequest({ model: "other" }, ctx), undefined)
  assert.equal(ctx.state.asked, undefined)
  assert.equal(onRequest({ model: "fast" }, ctxOf(undefined)), undefined)
})

test("onEvent names the asked model in each API's stream", () => {
  const ctx = ctxOf({}, { state: { asked: "fast" } })
  const anthropic = { type: "message_start", message: { model: "deepseek-chat" } }
  assert.equal(onEvent(anthropic, ctx), anthropic)
  assert.equal(anthropic.message.model, "fast")
  const chat = { model: "deepseek-chat", choices: [] }
  assert.equal(onEvent(chat, ctx), chat)
  assert.equal(chat.model, "fast")
  const responses = { type: "response.completed", response: { model: "deepseek-chat" } }
  assert.equal(onEvent(responses, ctx), responses)
  assert.equal(responses.response.model, "fast")
  const gemini = { candidates: [], modelVersion: "deepseek-chat" }
  assert.equal(onEvent(gemini, ctx), gemini)
  assert.equal(gemini.modelVersion, "fast")
})

test("onEvent leaves an event that already says the asked name, or none", () => {
  const ctx = ctxOf({}, { state: { asked: "fast" } })
  assert.equal(onEvent({ model: "fast" }, ctx), undefined)
  assert.equal(onEvent({ modelVersion: "fast" }, ctx), undefined)
  assert.equal(onEvent({ type: "ping" }, ctx), undefined)
})

test("onEvent and onResponse do nothing when nothing was asked or keep_upstream_name is set", () => {
  const ev = { model: "deepseek-chat" }
  assert.equal(onEvent(ev, ctxOf({})), undefined)
  assert.equal(onEvent(ev, ctxOf({ keep_upstream_name: true }, { state: { asked: "fast" } })), undefined)
  assert.equal(onResponse({ model: "deepseek-chat" }, ctxOf({})), undefined)
  assert.equal(onResponse({ model: "deepseek-chat" }, ctxOf({ keep_upstream_name: true }, { state: { asked: "fast" } })), undefined)
  assert.equal(ev.model, "deepseek-chat")
})

test("onResponse names the asked model, but not in an error", () => {
  const state = { asked: "fast" }
  const chat = { model: "deepseek-chat" }
  assert.equal(onResponse(chat, ctxOf({}, { state })), chat)
  assert.equal(chat.model, "fast")
  const responses = { response: { model: "deepseek-chat" } }
  assert.equal(onResponse(responses, ctxOf({}, { state })), responses)
  assert.equal(responses.response.model, "fast")
  const gemini = { modelVersion: "deepseek-chat" }
  assert.equal(onResponse(gemini, ctxOf({}, { state })), gemini)
  assert.equal(gemini.modelVersion, "fast")
  const failed = { model: "deepseek-chat" }
  assert.equal(onResponse(failed, ctxOf({}, { state, status: 500 })), undefined)
  assert.equal(failed.model, "deepseek-chat")
  assert.equal(onResponse({ other: 1 }, ctxOf({}, { state })), undefined)
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
