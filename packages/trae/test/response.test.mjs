import test from "node:test"
import assert from "node:assert/strict"
import { eventName, sse } from "../src/sse.mjs"
import { Thoughts, chain, finishOf, first, parts, tokensOf } from "../src/parts.mjs"
import { completion } from "../src/reply.mjs"
import { errorOf, failure, statusLine, wrongFunction } from "../src/errors.mjs"
import { SITES } from "../src/sites.mjs"
import { collect, ev, sseBody } from "./fake.mjs"

const cn = SITES["trae-cn"]
const global = SITES["trae-global"]
const eventsOf = (...chunks) => sse(sseBody(...chunks).body)
async function* from(list) {
  yield* list
}

test("sse: events with their data, comments and CRLF, a final event with no blank line", async () => {
  const got = await collect(eventsOf(": ping\r\nevent: output\r\ndata: {\"a\":1}\r\n\r\n", "data: [DONE]\n\nevent: x\ndata: part", "ial\n"))
  assert.deepEqual(got, [{ event: "output", data: { a: 1 } }, { event: "", data: "[DONE]" }, { event: "x", data: "partial" }])
  const named = await collect(eventsOf('data: {"event":"done"}\n\n'))
  assert.equal(named[0].event, "done")
})

test("eventName: normalised", () => {
  assert.equal(eventName("TokenUsage"), "token_usage")
  assert.equal(eventName("token-usage"), "token_usage")
  assert.equal(eventName(undefined), "")
})

test("tokensOf / finishOf", () => {
  assert.deepEqual(tokensOf({ input_tokens: 3, outputTokens: 4 }), { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
  assert.deepEqual(tokensOf({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 10 }), { prompt_tokens: 3, completion_tokens: 4, total_tokens: 10 })
  assert.equal(tokensOf({}), null)
  assert.equal(tokensOf(null), null)
  assert.equal(finishOf({ finish_reason: "MAX_TOKENS" }), "length")
  assert.equal(finishOf({ stop_reason: "sensitive" }), "content_filter")
  assert.equal(finishOf({ finish_reason: "stop" }), "")
})

test("Thoughts: a piece sent again sends only what is new", () => {
  const th = new Thoughts()
  assert.equal(th.add("thinking about it"), "thinking about it")
  assert.equal(th.add("thinking about it"), "") // the same twice in a row
  assert.equal(th.add("thinking about it, then more"), ", then more") // the reasoning so far, with more
  assert.equal(th.add("short"), "short")
})

test("parts: text, reasoning, usage and finish, the IDE's progress notes left out, queue events ignored", async () => {
  const got = await collect(parts(eventsOf(
    ev("queue", { position: 2 }),
    ev("output", { response: "Building prompt: x" }),
    ev("output", { response: "Hello ", reasoning_content: "hm" }),
    ev("output", { delta: { content: "world" } }),
    ev("token_usage", { usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ev("done", { finish_reason: "length" }),
  )))
  assert.deepEqual(got, [
    { reasoning: "hm" },
    { text: "Hello " },
    { text: "world" },
    { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ].concat([{ finish: "length" }]))
})

test("parts: a call written as text, and a native one, both come out named as the request names the tool", async () => {
  const tools = [{ type: "function", function: { name: "read", parameters: { properties: { path: {} } } } }]
  const got = await collect(parts(eventsOf(
    ev("output", { content: '<tool_call>{"name":"Read","arguments":{"arguments":{"path":"a"}}}</tool_call>' }),
    ev("output", { tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"b"}' } }] }),
    ev("done", {}),
  ), tools))
  assert.deepEqual(got.map((p) => p.call && [p.call.name, p.call.arguments]), [["read", '{"path":"a"}'], ["read", '{"path":"b"}']])
  assert.equal(got[1].call.id, "c1")
})

test("parts: an error event, or a bare code and message, is the error", async () => {
  assert.deepEqual(await collect(parts(eventsOf(ev("error", { code: 1001, message: "not logged in" })))), [{ error: "not logged in", code: 1001 }])
  assert.deepEqual(await collect(parts(eventsOf(ev("message", { code: 4008, message: "quota" })))), [{ error: "quota", code: 4008 }])
  assert.equal((await collect(parts(eventsOf(ev("error", {})))))[0].error, "Trae CN returned an error")
})

test("parts: a call cut short ends the answer with an error", async () => {
  const got = await collect(parts(eventsOf(ev("output", { content: 'ok <tool_call>{"name":"bash","argu' }), ev("done", {}))))
  assert.equal(got.at(-1).code, null)
  assert.match(got.at(-1).error, /cut short/)
})

test("first / chain: the first event that is not usage is held, then the rest follow", async () => {
  const it = from([{ usage: 1 }, { text: "a" }, { text: "b" }])[Symbol.asyncIterator]()
  const { held, done } = await first(it)
  assert.deepEqual(held, [{ usage: 1 }, { text: "a" }])
  assert.equal(done, false)
  assert.deepEqual(await collect(chain(held, it)), [{ usage: 1 }, { text: "a" }, { text: "b" }])
  assert.deepEqual(await first(from([{ usage: 1 }])[Symbol.asyncIterator]()), { held: [{ usage: 1 }], done: true })
})

test("completion: one body, with reasoning, tool calls, usage and finish", async () => {
  const res = await completion({ model: "m" }, from([{ reasoning: "r" }, { text: "hi" }, { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, { finish: "length" }]), undefined, cn)
  const body = await res.json()
  assert.equal(body.object, "chat.completion")
  assert.deepEqual(body.choices[0].message, { role: "assistant", content: "hi", reasoning_content: "r" })
  assert.equal(body.choices[0].finish_reason, "length")
  assert.equal(body.usage.total_tokens, 3)
  const calls = await (await completion({ model: "m" }, from([{ call: { id: "c", name: "bash", arguments: "{}" } }]), undefined, cn)).json()
  assert.equal(calls.choices[0].message.content, null)
  assert.equal(calls.choices[0].message.tool_calls[0].function.name, "bash")
  assert.equal(calls.choices[0].finish_reason, "tool_calls")
})

test("completion: an error in a body is a failure response", async () => {
  const res = await completion({ model: "m" }, from([{ error: "no quota", code: 4008 }]), undefined, cn)
  assert.equal(res.status, 429)
})

test("completion: a stream — role first, deltas, usage, [DONE]; an error ends it without a finish", async () => {
  const text = await (await completion({ model: "m", stream: true }, from([{ text: "a" }, { call: { id: "c", name: "bash", arguments: "{}" } }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]), undefined, cn)).text()
  const frames = text.split("\n\n").filter(Boolean).map((f) => f.slice(6))
  assert.equal(frames.at(-1), "[DONE]")
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f))
  assert.equal(chunks[0].choices[0].delta.role, "assistant")
  assert.equal(chunks[1].choices[0].delta.content, "a")
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].index, 0)
  assert.equal(chunks[3].choices[0].finish_reason, "tool_calls")
  assert.equal(chunks[4].usage.total_tokens, 2)
  const failed = await (await completion({ model: "m", stream: true }, from([{ text: "a" }, { error: "boom", code: 5 }]), undefined, cn)).text()
  assert.match(failed, /"message":"Trae CN: boom"/)
  assert.doesNotMatch(failed, /finish_reason":"stop/)
  assert.match(failed, /data: \[DONE\]/)
})

test("completion: cancelling the stream aborts Trae's fetch (a generator's return can't break a read that is waiting)", async () => {
  let aborted = false
  async function* slow() {
    yield { text: "a" }
    await new Promise(() => {})
  }
  const it = slow()
  const res = await completion({ model: "m", stream: true }, it, () => (aborted = true), cn)
  const reader = res.body.getReader()
  await reader.read()
  await reader.read()
  await reader.cancel()
  assert.equal(aborted, true)
})

test("errorOf: Trae's several shapes", () => {
  assert.deepEqual(errorOf({ code: 1001, message: "not logged in" }), { code: 1001, message: "not logged in" })
  assert.deepEqual(errorOf('{"error":{"code":5,"message":"x"}}'), { code: 5, message: "x" })
  assert.deepEqual(errorOf({ ResponseMetadata: { Error: { Code: "Denied", Message: "no" } } }), { code: "Denied", message: "no" })
  assert.deepEqual(errorOf({ error: "plain" }), { code: "", message: "plain" })
  assert.deepEqual(errorOf("not json"), { code: "", message: "" })
})

test("failure: a lapsed token is 401 expired, a quota 429, the rest as Trae's", async () => {
  const lapsed = failure(cn, 200, 1001, "x")
  assert.equal(lapsed.status, 401)
  assert.equal(lapsed.headers.get("x-magpie-sign-in"), "expired")
  assert.match((await lapsed.json()).error.message, /^Trae CN's sign-in has expired \(x\); sign in again$/)
  assert.equal(failure(cn, 403, "", "token is expired").status, 401)
  assert.equal(failure(cn, 502, 4008, "q").status, 429)
  assert.equal(failure(cn, 403, "", "额度用完").status, 429)
  assert.equal(failure(cn, 502, 20101, "x").status, 502) // 20101 lapses Trae Global alone
  assert.equal(failure(global, 502, 20101, "x").status, 401)
  assert.equal(failure(global, 502, 4011, "x").status, 429)
  const other = failure(cn, 200, 77, "odd")
  assert.equal(other.status, 502)
  assert.equal(other.headers.get("x-magpie-sign-in"), null)
  assert.deepEqual((await other.json()).error, { message: "Trae CN: odd (code 77)", type: "api_error", code: null })
  assert.equal((await failure(cn, 429, "", "").json()).error.type, "rate_limit_error")
})

test("statusLine / wrongFunction", () => {
  assert.equal(statusLine(502), "502 Bad Gateway")
  assert.equal(statusLine(599), "599")
  assert.equal(wrongFunction(4001), true)
  assert.equal(wrongFunction("1005"), true)
  assert.equal(wrongFunction(4008), false)
})
