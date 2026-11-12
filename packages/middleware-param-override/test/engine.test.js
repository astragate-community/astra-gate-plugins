import { expect, it } from "vitest"
import { onRequest } from "../src/gateway.js"
import { split, resolve, getAt, setAt, delAt, lookup } from "../src/paths.js"
import { conditions, when, compare } from "../src/conditions.js"
import { prune, pruneRule } from "../src/prune.js"
import { join, returnError, goRegexp, goReplacement } from "../src/operations.js"

// runs the hook on a body; `options` is the override JSON the settings hold, `rejected` is what ctx.reject was told
function run(body, options, extra = {}) {
  const rejected = []
  const ctx = { shared: { settings: { config: options } }, model: body.model, path: "/v1/chat/completions", protocol: "chat", client: "codex", stream: false, reject: (status, message) => rejected.push({ status, message }), ...extra }
  const out = onRequest(body, ctx)
  return { out, body, rejected }
}
const ops = (...operations) => ({ operations })

it("split: dots, escapes, empty", () => {
  expect(split("a.b.0")).toEqual(["a", "b", "0"])
  expect(split("a\\.b.c")).toEqual(["a.b", "c"])
  expect(split("a\\\\b")).toEqual(["a\\b"])
  expect(split("trailing\\")).toEqual(["trailing\\"])
  expect(split("")).toEqual([])
  expect(split(undefined)).toEqual([])
  expect(split("a.")).toEqual(["a", ""])
})

it("resolve: keys, indexes, negative, wildcards, missing", () => {
  const root = { a: [{ b: 1 }, { b: 2 }], o: { y: 1, x: 2 } }
  expect(resolve(root, split("a.0.b"))).toEqual([["a", 0, "b"]])
  expect(resolve(root, split("a.-1.b"))).toEqual([["a", 1, "b"]])
  expect(resolve(root, split("a.*.b"))).toEqual([["a", 0, "b"], ["a", 1, "b"]])
  expect(resolve(root, split("o.*"))).toEqual([["o", "x"], ["o", "y"]])
  expect(resolve(root, split("a.5"))).toEqual([])
  expect(resolve(root, split("a.-9"))).toEqual([])
  expect(resolve(root, split("a.x"))).toEqual([])
  expect(resolve(root, split("nope.deeper"))).toEqual([["nope", "deeper"]])
  expect(resolve(root, split("nope.*"))).toEqual([])
  expect(resolve(root, [])).toEqual([[]])
  expect(resolve({ s: "str" }, split("s.x"))).toEqual([])
})

it("getAt / setAt / delAt / lookup", () => {
  const root = { a: { b: [1, 2, 3] }, n: null }
  expect(getAt(root, ["a", "b", 1])).toBe(2)
  expect(getAt(root, ["n", "x"])).toBe(undefined)
  expect(getAt(root, ["a", "q", "r"])).toBe(undefined)
  setAt(root, ["x", "y"], 5)
  expect(root.x).toEqual({ y: 5 })
  setAt(root, ["n", "k"], 1)
  expect(root.n).toEqual({ k: 1 })
  expect(setAt(root, [], "new")).toBe("new")
  delAt(root, ["a", "b", 1])
  expect(root.a.b).toEqual([1, 3])
  delAt(root, ["a", "b"])
  expect("b" in root.a).toBe(false)
  expect(lookup({ a: [1, 2] }, "a.*")).toBe(undefined)
  expect(lookup({ a: [1, 2] }, "a.-1")).toBe(2)
})

it("compare: every mode", () => {
  expect(compare("a", "a", "full")).toBe(true)
  expect(compare(1, "1", "full")).toBe(false)
  expect(compare(null, null, "full")).toBe(true)
  expect(compare({ a: 1 }, { a: 1 }, "full")).toBe(true)
  expect(compare([1], [2], "full")).toBe(false)
  expect(compare("abc", "ab", "prefix")).toBe(true)
  expect(compare("abc", "bc", "suffix")).toBe(true)
  expect(compare("abc", "x", "contains")).toBe(false)
  expect(compare(123, 2, "contains")).toBe(true)
  expect(compare(5, 3, "gt")).toBe(true)
  expect(compare(3, 3, "gt")).toBe(false)
  expect(compare(3, 3, "gte")).toBe(true)
  expect(compare(2, 3, "lt")).toBe(true)
  expect(compare(3, 3, "lte")).toBe(true)
  expect(compare("5", 3, "gt")).toBe(false)
  expect(compare(1, 1, "bogus")).toBe(false)
})

it("conditions: arrays keep objects, an object becomes full matches, anything else is none", () => {
  expect(conditions([{ path: "a" }, 5, null, [1]])).toEqual([{ path: "a" }])
  expect(conditions({ model: "x" })).toEqual([{ path: "model", mode: "full", value: "x" }])
  expect(conditions("x")).toEqual([])
  expect(conditions(undefined)).toEqual([])
})

it("when: OR by default, AND on request, none always, invert, pass_missing_key, request facts", () => {
  const body = { a: 1, b: 2 }
  const req = { model: "m", agent: "codex" }
  const ca = { path: "a", value: 1 }
  const cb = { path: "b", value: 9 }
  expect(when(body, req, undefined, "OR")).toBe(true)
  expect(when(body, req, [], "OR")).toBe(true)
  expect(when(body, req, [ca, cb], "OR")).toBe(true)
  expect(when(body, req, [ca, cb], "and")).toBe(false)
  expect(when(body, req, [{ ...cb, invert: true }], "AND")).toBe(true)
  expect(when(body, req, [{ path: "zz", value: 1 }], "OR")).toBe(false)
  expect(when(body, req, [{ path: "zz", value: 1, pass_missing_key: true }], "OR")).toBe(true)
  expect(when(body, req, [{ path: "zz", value: 1, pass_missing_key: true, invert: true }], "OR")).toBe(true)
  expect(when(body, req, [{ path: "agent", value: "codex" }], "OR")).toBe(true)
  // the body wins over the request's facts
  expect(when({ model: "body" }, req, [{ path: "model", value: "body" }], "OR")).toBe(true)
  expect(when(body, req, [{ path: "b", mode: "GT", value: 1 }], "OR")).toBe(true)
})

it("join: arrays, strings, objects, anything else", () => {
  expect(join([1], [2, 3], false)).toEqual([1, 2, 3])
  expect(join([1], 2, true)).toEqual([2, 1])
  expect(join("a", "b", false)).toBe("ab")
  expect(join("a", "b", true)).toBe("ba")
  expect(join("a", { x: 1 }, false)).toBe('a{"x":1}')
  expect(join({ a: 1 }, { a: 2, b: 3 }, false, false)).toEqual({ a: 2, b: 3 })
  expect(join({ a: 1 }, { a: 2, b: 3 }, false, true)).toEqual({ a: 1, b: 3 })
  expect(join(5, 5, false)).toBe(undefined)
  expect(join({}, [1], false)).toBe(undefined)
  expect(join(undefined, "x", false)).toBe(undefined)
})

it("returnError: status and message from a string or an object", () => {
  expect(returnError(" no ")).toEqual({ status: 400, message: "no" })
  expect(returnError({ message: "m", status_code: 403 })).toEqual({ status: 403, message: "m" })
  expect(returnError({ msg: "m", status: 429 })).toEqual({ status: 429, message: "m" })
  expect(returnError({ message: "m", status: "x" })).toEqual({ status: 400, message: "m" })
  expect(returnError({ message: "m", status: 1.5 })).toEqual({ status: 400, message: "m" })
  expect(returnError(undefined)).toEqual({ status: 400, message: "turned away by param-override" })
  expect(returnError("  ")).toEqual({ status: 400, message: "turned away by param-override" })
})

it("Go regexps and replacements become JavaScript's", () => {
  expect("Foo foo".replace(goRegexp("(?i)foo"), "x")).toBe("x x")
  expect("a\nb".replace(goRegexp("(?s)a.b"), "x")).toBe("x")
  expect("aa".replace(goRegexp("(?U)a"), "b")).toBe("bb")
  expect("ab".replace(goRegexp("(?P<first>a)"), goReplacement("[${first}]"))).toBe("[a]b")
  expect("ab".replace(goRegexp("(a)(b)"), goReplacement("${2}${1}"))).toBe("ba")
  expect(goReplacement("$1 ${1} ${name}")).toBe("$1 $1 $<name>")
  expect(() => goRegexp("(")).toThrow()
})

it("pruneRule: a type string, an object's parts, and defaults", () => {
  expect(pruneRule(" thinking ")).toEqual({ conds: [{ path: "type", mode: "full", value: "thinking" }], logic: "AND", recursive: true })
  expect(pruneRule({ type: "t", where: { k: 1 }, conditions: [{ path: "z", value: 2 }], logic: "OR", recursive: false })).toEqual({
    conds: [{ path: "z", value: 2 }, { path: "k", mode: "full", value: 1 }, { path: "type", mode: "full", value: "t" }],
    logic: "OR",
    recursive: false,
  })
  expect(pruneRule(5).conds).toEqual([])
  expect(pruneRule("  ").conds).toEqual([])
})

it("prune: drops matching objects at any depth, returns the same value when nothing matched", () => {
  const rule = pruneRule("thinking")
  const tree = { m: [{ type: "thinking" }, { type: "text", sub: [{ type: "thinking" }, 1] }], keep: { type: "x" } }
  const out = prune(tree, rule, {})
  expect(out).toEqual({ m: [{ type: "text", sub: [1] }], keep: { type: "x" } })
  expect(tree.m.length).toEqual(2)
  const clean = { a: [{ type: "text" }] }
  expect(prune(clean, rule, {})).toBe(clean)
  expect(prune("str", rule, {})).toBe("str")
  expect(prune(clean, pruneRule(5), {})).toBe(clean)
  expect(prune({ a: { type: "thinking" }, b: 1 }, rule, {})).toEqual({ b: 1 })
  // not recursive: only one level
  const flat = prune([{ type: "thinking" }, { c: [{ type: "thinking" }] }], pruneRule({ type: "thinking", recursive: false }), {})
  expect(flat).toEqual([{ c: [{ type: "thinking" }] }])
})

it("no options, non-object options: nothing happens", () => {
  for (const o of [undefined, null, "x", 5]) expect(run({ a: 1 }, o).out).toBe(undefined)
})

it("simple form: each key set as it is", () => {
  const { out, body } = run({ model: "m", temperature: 1 }, { temperature: 0.2, max_tokens: 8000 })
  expect(out).toBe(body)
  expect(body).toEqual({ model: "m", temperature: 0.2, max_tokens: 8000 })
})

it("simple keys are set before operations, and options without any key change nothing", () => {
  const { body } = run({}, { a: 1, operations: [{ path: "a", mode: "set", value: 2 }] })
  expect(body.a).toBe(2)
  expect(run({ a: 1 }, {}).out).toBe(undefined)
  expect(run({ a: 1 }, { operations: [] }).out).toBe(undefined)
  expect(run({ a: 1 }, { operations: "x" }).out).toBe(undefined)
})

it("set: sets, creates, keep_origin, copies its value", () => {
  expect(run({}, ops({ path: "a.b", mode: "set", value: 1 })).body.a.b).toBe(1)
  expect(run({ a: 1 }, ops({ path: "a", mode: "set", value: 2, keep_origin: true })).out).toBe(undefined)
  expect(run({}, ops({ path: "a", mode: "set", value: 2, keep_origin: true })).body.a).toBe(2)
  expect(run({ a: 1 }, ops({ path: "a", mode: "set", value: 1 })).out).toBe(undefined)
  const value = { x: 1 }
  const { body } = run({}, ops({ path: "a", mode: "set", value }))
  value.x = 2
  expect(body.a.x).toBe(1)
})

it("set with no path replaces the body", () => {
  const { out } = run({ a: 1 }, ops({ mode: "set", value: { b: 2 } }))
  expect(out).toEqual({ b: 2 })
})

it("set over wildcards and negative indexes", () => {
  const { body } = run({ messages: [{ role: "user" }, { role: "assistant" }] }, ops({ path: "messages.*.n", mode: "set", value: 1 }, { path: "messages.-1.last", mode: "set", value: true }))
  expect(body.messages).toEqual([{ role: "user", n: 1 }, { role: "assistant", n: 1, last: true }])
})

it("delete: keys, array elements from the end, nothing there", () => {
  expect(run({ a: 1, b: 2 }, ops({ path: "a", mode: "delete" })).body).toEqual({ b: 2 })
  expect(run({ l: [1, 2, 3, 4] }, ops({ path: "l.*", mode: "delete" })).body).toEqual({ l: [] })
  expect(run({ l: [{ t: 1 }, { t: 2 }] }, ops({ path: "l.*.t", mode: "delete" })).body).toEqual({ l: [{}, {}] })
  expect(run({ a: 1 }, ops({ path: "zzz", mode: "delete" })).out).toBe(undefined)
  expect(run({ a: 1 }, ops({ path: "l.*", mode: "delete" })).out).toBe(undefined)
})

it("move and copy: one path to one path", () => {
  expect(run({ a: 1 }, ops({ mode: "move", from: "a", to: "b.c" })).body).toEqual({ b: { c: 1 } })
  const copied = run({ a: { x: 1 } }, ops({ mode: "copy", from: "a", to: "b" })).body
  expect(copied).toEqual({ a: { x: 1 }, b: { x: 1 } })
  expect(copied.a).not.toBe(copied.b)
  expect(run({ a: 1 }, ops({ mode: "move", from: "zz", to: "b" })).out).toBe(undefined)
  expect(run({ l: [1, 2] }, ops({ mode: "move", from: "l.*", to: "b" })).out).toBe(undefined)
  expect(run({ a: 1 }, ops({ mode: "move", from: "a", to: "l.*" })).out).toBe(undefined)
})

it("prepend and append", () => {
  expect(run({ l: [2] }, ops({ path: "l", mode: "prepend", value: 1 }, { path: "l", mode: "append", value: [3, 4] })).body.l).toEqual([1, 2, 3, 4])
  expect(run({ s: "b" }, ops({ path: "s", mode: "prepend", value: "a" }, { path: "s", mode: "append", value: "c" })).body.s).toBe("abc")
  expect(run({ a: 1 }, ops({ path: "a", mode: "append", value: 2 })).out).toBe(undefined)
  expect(run({}, ops({ path: "a", mode: "append", value: 2 })).out).toBe(undefined)
})

it("string modes", () => {
  const s = (mode, extra, from = "  Hello World  ") => run({ s: from }, ops({ path: "s", mode, ...extra })).body.s
  expect(s("trim_space")).toBe("Hello World")
  expect(s("to_lower")).toBe("  hello world  ")
  expect(s("to_upper")).toBe("  HELLO WORLD  ")
  expect(s("trim_prefix", { value: "He" }, "Hello")).toBe("llo")
  expect(s("trim_prefix", { value: "x" }, "Hello")).toBe("Hello")
  expect(s("trim_suffix", { value: "lo" }, "Hello")).toBe("Hel")
  expect(s("trim_suffix", { value: "" }, "Hello")).toBe("Hello")
  expect(s("ensure_prefix", { value: "> " }, "Hello")).toBe("> Hello")
  expect(s("ensure_prefix", { value: "He" }, "Hello")).toBe("Hello")
  expect(s("ensure_suffix", { value: "!" }, "Hello")).toBe("Hello!")
  expect(s("ensure_suffix", { value: "lo" }, "Hello")).toBe("Hello")
  expect(s("replace", { from: "l", to: "L" }, "Hello")).toBe("HeLLo")
  expect(s("replace", { from: "l" }, "Hello")).toBe("Heo")
  expect(s("regex_replace", { from: "(?i)h(e)", to: "${1}-" }, "Hello")).toBe("e-llo")
  expect(s("regex_replace", { from: "l", to: "L" }, "Hello")).toBe("HeLLo")
})

it("string modes skip non-strings and missing values", () => {
  for (const mode of ["trim_space", "to_lower", "to_upper", "trim_prefix", "trim_suffix", "ensure_prefix", "ensure_suffix", "replace", "regex_replace"]) {
    expect(run({ n: 5 }, ops({ path: "n", mode, value: "x", from: "x", to: "y" })).out).toBe(undefined)
  }
  expect(run({ s: "a" }, ops({ path: "s", mode: "trim_prefix" })).out).toBe(undefined)
  expect(run({ s: "a" }, ops({ path: "s", mode: "replace", from: "", to: "y" })).out).toBe(undefined)
  expect(run({ s: "a" }, ops({ path: "s", mode: "regex_replace", to: "y" })).out).toBe(undefined)
  expect(run({ s: "a" }, ops({ path: "s", mode: "to_lower" })).out).toBe(undefined)
})

it("prune_objects: a type, a rule, and the whole body when there is no path", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text" }, { type: "thinking" }] }] }
  const out = run(body, ops({ path: "messages", mode: "prune_objects", value: "thinking" })).body
  expect(out.messages[0].content).toEqual([{ type: "text" }])
  const whole = run({ a: [{ type: "thinking" }, { type: "t" }] }, ops({ mode: "prune_objects", value: "thinking" })).out
  expect(whole).toEqual({ a: [{ type: "t" }] })
  expect(run({ a: [{ type: "t" }] }, ops({ mode: "prune_objects", value: "thinking" })).out).toBe(undefined)
  expect(run({}, ops({ path: "zz", mode: "prune_objects", value: "thinking" })).out).toBe(undefined)
})

it("conditions gate an operation; request facts are visible", () => {
  const op = { path: "max_tokens", mode: "set", value: 32000, conditions: [{ path: "max_tokens", mode: "gt", value: 32000 }] }
  expect(run({ max_tokens: 64000 }, ops(op)).body.max_tokens).toBe(32000)
  expect(run({ max_tokens: 100 }, ops(op)).out).toBe(undefined)
  const del = { path: "temperature", mode: "delete", conditions: [{ path: "model", mode: "contains", value: "reasoner" }] }
  expect(run({ model: "deepseek-reasoner", temperature: 1 }, ops(del)).body).toEqual({ model: "deepseek-reasoner" })
  expect(run({ model: "chat", temperature: 1 }, ops(del)).out).toBe(undefined)
  // facts the body doesn't have come from the request
  const byAgent = { path: "x", mode: "set", value: 1, conditions: [{ path: "agent", value: "codex" }, { path: "stream", value: false }], logic: "AND" }
  expect(run({}, ops(byAgent)).body.x).toBe(1)
  expect(run({}, ops(byAgent), { client: "other" }).out).toBe(undefined)
  expect(run({}, ops({ path: "x", mode: "set", value: 1, conditions: [{ path: "protocol", value: "anthropic" }] })).out).toBe(undefined)
})

it("operations run in order, each seeing the last one's result", () => {
  const { body } = run({ a: 1 }, ops({ mode: "move", from: "a", to: "b" }, { path: "b", mode: "set", value: 5, conditions: [{ path: "b", value: 1 }] }))
  expect(body).toEqual({ b: 5 })
})

it("return_error rejects and returns nothing, whatever was changed before", () => {
  const r = run({ a: 1 }, { z: 1, operations: [{ mode: "return_error", value: { message: "no", status_code: 403 } }, { path: "a", mode: "delete" }] })
  expect(r.out).toBe(undefined)
  expect(r.rejected).toEqual([{ status: 403, message: "no" }])
  const gated = run({ model: "x" }, ops({ mode: "return_error", value: "stop", conditions: [{ path: "model", value: "y" }] }))
  expect(gated.rejected).toEqual([])
})

it("unknown modes, header modes and junk operations are ignored", () => {
  for (const op of [{ path: "a", mode: "set_header", value: "x" }, { path: "a", mode: "sync_fields" }, { path: "a", mode: "bogus" }, { path: "a" }, { path: "a", mode: "toString" }, null, "x", 5]) {
    expect(run({ a: "A" }, ops(op)).out).toBe(undefined)
  }
})

