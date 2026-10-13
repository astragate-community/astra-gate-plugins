import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { onRequest } from "../src/index.mjs"
import { split, resolve, getAt, setAt, delAt, lookup } from "../src/paths.mjs"
import { conditions, when, compare } from "../src/conditions.mjs"
import { prune, pruneRule } from "../src/prune.mjs"
import { join, returnError, goRegexp, goReplacement } from "../src/operations.mjs"

// runs the middleware on a body; `rejected` is what ctx.reject was told
function run(body, options, extra = {}) {
  const rejected = []
  const ctx = { options, model: body.model, path: "/v1/chat/completions", protocol: "chat", agent: "codex", stream: false, reject: (status, message) => rejected.push({ status, message }), ...extra }
  const out = onRequest(body, ctx)
  return { out, body, rejected }
}
const ops = (...operations) => ({ operations })

test("split: dots, escapes, empty", () => {
  assert.deepEqual(split("a.b.0"), ["a", "b", "0"])
  assert.deepEqual(split("a\\.b.c"), ["a.b", "c"])
  assert.deepEqual(split("a\\\\b"), ["a\\b"])
  assert.deepEqual(split("trailing\\"), ["trailing\\"])
  assert.deepEqual(split(""), [])
  assert.deepEqual(split(undefined), [])
  assert.deepEqual(split("a."), ["a", ""])
})

test("resolve: keys, indexes, negative, wildcards, missing", () => {
  const root = { a: [{ b: 1 }, { b: 2 }], o: { y: 1, x: 2 } }
  assert.deepEqual(resolve(root, split("a.0.b")), [["a", 0, "b"]])
  assert.deepEqual(resolve(root, split("a.-1.b")), [["a", 1, "b"]])
  assert.deepEqual(resolve(root, split("a.*.b")), [["a", 0, "b"], ["a", 1, "b"]])
  assert.deepEqual(resolve(root, split("o.*")), [["o", "x"], ["o", "y"]])
  assert.deepEqual(resolve(root, split("a.5")), [])
  assert.deepEqual(resolve(root, split("a.-9")), [])
  assert.deepEqual(resolve(root, split("a.x")), [])
  assert.deepEqual(resolve(root, split("nope.deeper")), [["nope", "deeper"]])
  assert.deepEqual(resolve(root, split("nope.*")), [])
  assert.deepEqual(resolve(root, []), [[]])
  assert.deepEqual(resolve({ s: "str" }, split("s.x")), [])
})

test("getAt / setAt / delAt / lookup", () => {
  const root = { a: { b: [1, 2, 3] }, n: null }
  assert.equal(getAt(root, ["a", "b", 1]), 2)
  assert.equal(getAt(root, ["n", "x"]), undefined)
  assert.equal(getAt(root, ["a", "q", "r"]), undefined)
  setAt(root, ["x", "y"], 5)
  assert.deepEqual(root.x, { y: 5 })
  setAt(root, ["n", "k"], 1)
  assert.deepEqual(root.n, { k: 1 })
  assert.equal(setAt(root, [], "new"), "new")
  delAt(root, ["a", "b", 1])
  assert.deepEqual(root.a.b, [1, 3])
  delAt(root, ["a", "b"])
  assert.equal("b" in root.a, false)
  assert.equal(lookup({ a: [1, 2] }, "a.*"), undefined)
  assert.equal(lookup({ a: [1, 2] }, "a.-1"), 2)
})

test("compare: every mode", () => {
  assert.equal(compare("a", "a", "full"), true)
  assert.equal(compare(1, "1", "full"), false)
  assert.equal(compare(null, null, "full"), true)
  assert.equal(compare({ a: 1 }, { a: 1 }, "full"), true)
  assert.equal(compare([1], [2], "full"), false)
  assert.equal(compare("abc", "ab", "prefix"), true)
  assert.equal(compare("abc", "bc", "suffix"), true)
  assert.equal(compare("abc", "x", "contains"), false)
  assert.equal(compare(123, 2, "contains"), true)
  assert.equal(compare(5, 3, "gt"), true)
  assert.equal(compare(3, 3, "gt"), false)
  assert.equal(compare(3, 3, "gte"), true)
  assert.equal(compare(2, 3, "lt"), true)
  assert.equal(compare(3, 3, "lte"), true)
  assert.equal(compare("5", 3, "gt"), false)
  assert.equal(compare(1, 1, "bogus"), false)
})

test("conditions: arrays keep objects, an object becomes full matches, anything else is none", () => {
  assert.deepEqual(conditions([{ path: "a" }, 5, null, [1]]), [{ path: "a" }])
  assert.deepEqual(conditions({ model: "x" }), [{ path: "model", mode: "full", value: "x" }])
  assert.deepEqual(conditions("x"), [])
  assert.deepEqual(conditions(undefined), [])
})

test("when: OR by default, AND on request, none always, invert, pass_missing_key, request facts", () => {
  const body = { a: 1, b: 2 }
  const req = { model: "m", agent: "codex" }
  const ca = { path: "a", value: 1 }
  const cb = { path: "b", value: 9 }
  assert.equal(when(body, req, undefined, "OR"), true)
  assert.equal(when(body, req, [], "OR"), true)
  assert.equal(when(body, req, [ca, cb], "OR"), true)
  assert.equal(when(body, req, [ca, cb], "and"), false)
  assert.equal(when(body, req, [{ ...cb, invert: true }], "AND"), true)
  assert.equal(when(body, req, [{ path: "zz", value: 1 }], "OR"), false)
  assert.equal(when(body, req, [{ path: "zz", value: 1, pass_missing_key: true }], "OR"), true)
  assert.equal(when(body, req, [{ path: "zz", value: 1, pass_missing_key: true, invert: true }], "OR"), true)
  assert.equal(when(body, req, [{ path: "agent", value: "codex" }], "OR"), true)
  // the body wins over the request's facts
  assert.equal(when({ model: "body" }, req, [{ path: "model", value: "body" }], "OR"), true)
  assert.equal(when(body, req, [{ path: "b", mode: "GT", value: 1 }], "OR"), true)
})

test("join: arrays, strings, objects, anything else", () => {
  assert.deepEqual(join([1], [2, 3], false), [1, 2, 3])
  assert.deepEqual(join([1], 2, true), [2, 1])
  assert.equal(join("a", "b", false), "ab")
  assert.equal(join("a", "b", true), "ba")
  assert.equal(join("a", { x: 1 }, false), 'a{"x":1}')
  assert.deepEqual(join({ a: 1 }, { a: 2, b: 3 }, false, false), { a: 2, b: 3 })
  assert.deepEqual(join({ a: 1 }, { a: 2, b: 3 }, false, true), { a: 1, b: 3 })
  assert.equal(join(5, 5, false), undefined)
  assert.equal(join({}, [1], false), undefined)
  assert.equal(join(undefined, "x", false), undefined)
})

test("returnError: status and message from a string or an object", () => {
  assert.deepEqual(returnError(" no "), { status: 400, message: "no" })
  assert.deepEqual(returnError({ message: "m", status_code: 403 }), { status: 403, message: "m" })
  assert.deepEqual(returnError({ msg: "m", status: 429 }), { status: 429, message: "m" })
  assert.deepEqual(returnError({ message: "m", status: "x" }), { status: 400, message: "m" })
  assert.deepEqual(returnError({ message: "m", status: 1.5 }), { status: 400, message: "m" })
  assert.deepEqual(returnError(undefined), { status: 400, message: "turned away by param-override" })
  assert.deepEqual(returnError("  "), { status: 400, message: "turned away by param-override" })
})

test("Go regexps and replacements become JavaScript's", () => {
  assert.equal("Foo foo".replace(goRegexp("(?i)foo"), "x"), "x x")
  assert.equal("a\nb".replace(goRegexp("(?s)a.b"), "x"), "x")
  assert.equal("aa".replace(goRegexp("(?U)a"), "b"), "bb")
  assert.equal("ab".replace(goRegexp("(?P<first>a)"), goReplacement("[${first}]")), "[a]b")
  assert.equal("ab".replace(goRegexp("(a)(b)"), goReplacement("${2}${1}")), "ba")
  assert.equal(goReplacement("$1 ${1} ${name}"), "$1 $1 $<name>")
  assert.throws(() => goRegexp("("))
})

test("pruneRule: a type string, an object's parts, and defaults", () => {
  assert.deepEqual(pruneRule(" thinking "), { conds: [{ path: "type", mode: "full", value: "thinking" }], logic: "AND", recursive: true })
  assert.deepEqual(pruneRule({ type: "t", where: { k: 1 }, conditions: [{ path: "z", value: 2 }], logic: "OR", recursive: false }), {
    conds: [{ path: "z", value: 2 }, { path: "k", mode: "full", value: 1 }, { path: "type", mode: "full", value: "t" }],
    logic: "OR",
    recursive: false,
  })
  assert.deepEqual(pruneRule(5).conds, [])
  assert.deepEqual(pruneRule("  ").conds, [])
})

test("prune: drops matching objects at any depth, returns the same value when nothing matched", () => {
  const rule = pruneRule("thinking")
  const tree = { m: [{ type: "thinking" }, { type: "text", sub: [{ type: "thinking" }, 1] }], keep: { type: "x" } }
  const out = prune(tree, rule, {})
  assert.deepEqual(out, { m: [{ type: "text", sub: [1] }], keep: { type: "x" } })
  assert.deepEqual(tree.m.length, 2, "the input is not mutated")
  const clean = { a: [{ type: "text" }] }
  assert.equal(prune(clean, rule, {}), clean)
  assert.equal(prune("str", rule, {}), "str")
  assert.equal(prune(clean, pruneRule(5), {}), clean)
  assert.deepEqual(prune({ a: { type: "thinking" }, b: 1 }, rule, {}), { b: 1 })
  // not recursive: only one level
  const flat = prune([{ type: "thinking" }, { c: [{ type: "thinking" }] }], pruneRule({ type: "thinking", recursive: false }), {})
  assert.deepEqual(flat, [{ c: [{ type: "thinking" }] }])
})

test("no options, non-object options: nothing happens", () => {
  for (const o of [undefined, null, "x", 5]) assert.equal(run({ a: 1 }, o).out, undefined)
})

test("simple form: each key set as it is", () => {
  const { out, body } = run({ model: "m", temperature: 1 }, { temperature: 0.2, max_tokens: 8000 })
  assert.equal(out, body)
  assert.deepEqual(body, { model: "m", temperature: 0.2, max_tokens: 8000 })
})

test("simple keys are set before operations, and options without any key change nothing", () => {
  const { body } = run({}, { a: 1, operations: [{ path: "a", mode: "set", value: 2 }] })
  assert.equal(body.a, 2)
  assert.equal(run({ a: 1 }, {}).out, undefined)
  assert.equal(run({ a: 1 }, { operations: [] }).out, undefined)
  assert.equal(run({ a: 1 }, { operations: "x" }).out, undefined)
})

test("set: sets, creates, keep_origin, copies its value", () => {
  assert.equal(run({}, ops({ path: "a.b", mode: "set", value: 1 })).body.a.b, 1)
  assert.equal(run({ a: 1 }, ops({ path: "a", mode: "set", value: 2, keep_origin: true })).out, undefined)
  assert.equal(run({}, ops({ path: "a", mode: "set", value: 2, keep_origin: true })).body.a, 2)
  assert.equal(run({ a: 1 }, ops({ path: "a", mode: "set", value: 1 })).out, undefined, "same value is no change")
  const value = { x: 1 }
  const { body } = run({}, ops({ path: "a", mode: "set", value }))
  value.x = 2
  assert.equal(body.a.x, 1)
})

test("set with no path replaces the body", () => {
  const { out } = run({ a: 1 }, ops({ mode: "set", value: { b: 2 } }))
  assert.deepEqual(out, { b: 2 })
})

test("set over wildcards and negative indexes", () => {
  const { body } = run({ messages: [{ role: "user" }, { role: "assistant" }] }, ops({ path: "messages.*.n", mode: "set", value: 1 }, { path: "messages.-1.last", mode: "set", value: true }))
  assert.deepEqual(body.messages, [{ role: "user", n: 1 }, { role: "assistant", n: 1, last: true }])
})

test("delete: keys, array elements from the end, nothing there", () => {
  assert.deepEqual(run({ a: 1, b: 2 }, ops({ path: "a", mode: "delete" })).body, { b: 2 })
  assert.deepEqual(run({ l: [1, 2, 3, 4] }, ops({ path: "l.*", mode: "delete" })).body, { l: [] })
  assert.deepEqual(run({ l: [{ t: 1 }, { t: 2 }] }, ops({ path: "l.*.t", mode: "delete" })).body, { l: [{}, {}] })
  assert.equal(run({ a: 1 }, ops({ path: "zzz", mode: "delete" })).out, undefined)
  assert.equal(run({ a: 1 }, ops({ path: "l.*", mode: "delete" })).out, undefined)
})

test("move and copy: one path to one path", () => {
  assert.deepEqual(run({ a: 1 }, ops({ mode: "move", from: "a", to: "b.c" })).body, { b: { c: 1 } })
  const copied = run({ a: { x: 1 } }, ops({ mode: "copy", from: "a", to: "b" })).body
  assert.deepEqual(copied, { a: { x: 1 }, b: { x: 1 } })
  assert.notEqual(copied.a, copied.b)
  assert.equal(run({ a: 1 }, ops({ mode: "move", from: "zz", to: "b" })).out, undefined)
  assert.equal(run({ l: [1, 2] }, ops({ mode: "move", from: "l.*", to: "b" })).out, undefined)
  assert.equal(run({ a: 1 }, ops({ mode: "move", from: "a", to: "l.*" })).out, undefined)
})

test("prepend and append", () => {
  assert.deepEqual(run({ l: [2] }, ops({ path: "l", mode: "prepend", value: 1 }, { path: "l", mode: "append", value: [3, 4] })).body.l, [1, 2, 3, 4])
  assert.equal(run({ s: "b" }, ops({ path: "s", mode: "prepend", value: "a" }, { path: "s", mode: "append", value: "c" })).body.s, "abc")
  assert.equal(run({ a: 1 }, ops({ path: "a", mode: "append", value: 2 })).out, undefined)
  assert.equal(run({}, ops({ path: "a", mode: "append", value: 2 })).out, undefined)
})

test("string modes", () => {
  const s = (mode, extra, from = "  Hello World  ") => run({ s: from }, ops({ path: "s", mode, ...extra })).body.s
  assert.equal(s("trim_space"), "Hello World")
  assert.equal(s("to_lower"), "  hello world  ")
  assert.equal(s("to_upper"), "  HELLO WORLD  ")
  assert.equal(s("trim_prefix", { value: "He" }, "Hello"), "llo")
  assert.equal(s("trim_prefix", { value: "x" }, "Hello"), "Hello")
  assert.equal(s("trim_suffix", { value: "lo" }, "Hello"), "Hel")
  assert.equal(s("trim_suffix", { value: "" }, "Hello"), "Hello")
  assert.equal(s("ensure_prefix", { value: "> " }, "Hello"), "> Hello")
  assert.equal(s("ensure_prefix", { value: "He" }, "Hello"), "Hello")
  assert.equal(s("ensure_suffix", { value: "!" }, "Hello"), "Hello!")
  assert.equal(s("ensure_suffix", { value: "lo" }, "Hello"), "Hello")
  assert.equal(s("replace", { from: "l", to: "L" }, "Hello"), "HeLLo")
  assert.equal(s("replace", { from: "l" }, "Hello"), "Heo")
  assert.equal(s("regex_replace", { from: "(?i)h(e)", to: "${1}-" }, "Hello"), "e-llo")
  assert.equal(s("regex_replace", { from: "l", to: "L" }, "Hello"), "HeLLo")
})

test("string modes skip non-strings and missing values", () => {
  for (const mode of ["trim_space", "to_lower", "to_upper", "trim_prefix", "trim_suffix", "ensure_prefix", "ensure_suffix", "replace", "regex_replace"]) {
    assert.equal(run({ n: 5 }, ops({ path: "n", mode, value: "x", from: "x", to: "y" })).out, undefined, mode)
  }
  assert.equal(run({ s: "a" }, ops({ path: "s", mode: "trim_prefix" })).out, undefined)
  assert.equal(run({ s: "a" }, ops({ path: "s", mode: "replace", from: "", to: "y" })).out, undefined)
  assert.equal(run({ s: "a" }, ops({ path: "s", mode: "regex_replace", to: "y" })).out, undefined)
  assert.equal(run({ s: "a" }, ops({ path: "s", mode: "to_lower" })).out, undefined, "already lower")
})

test("prune_objects: a type, a rule, and the whole body when there is no path", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text" }, { type: "thinking" }] }] }
  const out = run(body, ops({ path: "messages", mode: "prune_objects", value: "thinking" })).body
  assert.deepEqual(out.messages[0].content, [{ type: "text" }])
  const whole = run({ a: [{ type: "thinking" }, { type: "t" }] }, ops({ mode: "prune_objects", value: "thinking" })).out
  assert.deepEqual(whole, { a: [{ type: "t" }] })
  assert.equal(run({ a: [{ type: "t" }] }, ops({ mode: "prune_objects", value: "thinking" })).out, undefined)
  assert.equal(run({}, ops({ path: "zz", mode: "prune_objects", value: "thinking" })).out, undefined)
})

test("conditions gate an operation; request facts are visible", () => {
  const op = { path: "max_tokens", mode: "set", value: 32000, conditions: [{ path: "max_tokens", mode: "gt", value: 32000 }] }
  assert.equal(run({ max_tokens: 64000 }, ops(op)).body.max_tokens, 32000)
  assert.equal(run({ max_tokens: 100 }, ops(op)).out, undefined)
  const del = { path: "temperature", mode: "delete", conditions: [{ path: "model", mode: "contains", value: "reasoner" }] }
  assert.deepEqual(run({ model: "deepseek-reasoner", temperature: 1 }, ops(del)).body, { model: "deepseek-reasoner" })
  assert.equal(run({ model: "chat", temperature: 1 }, ops(del)).out, undefined)
  // facts the body doesn't have come from the request
  const byAgent = { path: "x", mode: "set", value: 1, conditions: [{ path: "agent", value: "codex" }, { path: "stream", value: false }], logic: "AND" }
  assert.equal(run({}, ops(byAgent)).body.x, 1)
  assert.equal(run({}, ops(byAgent), { agent: "other" }).out, undefined)
  assert.equal(run({}, ops({ path: "x", mode: "set", value: 1, conditions: [{ path: "protocol", value: "anthropic" }] })).out, undefined)
})

test("operations run in order, each seeing the last one's result", () => {
  const { body } = run({ a: 1 }, ops({ mode: "move", from: "a", to: "b" }, { path: "b", mode: "set", value: 5, conditions: [{ path: "b", value: 1 }] }))
  assert.deepEqual(body, { b: 5 })
})

test("return_error rejects and returns nothing, whatever was changed before", () => {
  const r = run({ a: 1 }, { z: 1, operations: [{ mode: "return_error", value: { message: "no", status_code: 403 } }, { path: "a", mode: "delete" }] })
  assert.equal(r.out, undefined)
  assert.deepEqual(r.rejected, [{ status: 403, message: "no" }])
  const gated = run({ model: "x" }, ops({ mode: "return_error", value: "stop", conditions: [{ path: "model", value: "y" }] }))
  assert.deepEqual(gated.rejected, [])
})

test("unknown modes, header modes and junk operations are ignored", () => {
  for (const op of [{ path: "a", mode: "set_header", value: "x" }, { path: "a", mode: "sync_fields" }, { path: "a", mode: "bogus" }, { path: "a" }, { path: "a", mode: "toString" }, null, "x", 5]) {
    assert.equal(run({ a: "A" }, ops(op)).out, undefined)
  }
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
