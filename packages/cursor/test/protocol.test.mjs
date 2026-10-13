import test from "node:test"
import assert from "node:assert/strict"
import { pb, pbValue, pbAny, fields, pbStr, pbNum, frame, frames, mapOf } from "../src/protobuf.mjs"
import { decode, usageOf } from "../src/decode.mjs"
import { conversationID, sessionOf, buildRun, toolDef } from "../src/run-request.mjs"
import { h2Blocked } from "../src/transport.mjs"
import { addUsage, usageEvents } from "../src/step-usage.mjs"
import { fakeFetch } from "./fake.mjs"
import { createHash } from "node:crypto"

const collect = async (it) => {
  const out = []
  for await (const e of it) out.push(e)
  return out
}
async function* stream(...msgs) {
  for (const m of msgs) yield { end: false, data: m }
}
// an interaction_update carrying one update of the given number
const update = (num, body) => pb().bytes(1, pb().bytes(num, body)).done()
const text = (t) => update(1, pb().str(1, t))
const ended = (inp, out, cr, cw) => update(14, pb().varint(1, inp).varint(2, out).varint(3, cr).varint(4, cw).varint(5, 7))
// an exec_server_message asking for a call of the caller's tool
const mcpCall = (id, name, args, callId) =>
  pb()
    .bytes(2, pb().varint(1, id).str(15, "exec-" + id).bytes(11, pb().str(1, name).str(3, callId).bytes(2, pb().str(1, "path").bytes(2, pbValue(args.path)))))
    .done()

test("protobuf: a Value round-trips, maps sorted by key", () => {
  const v = { b: [1, "two", true, null], a: { n: 2.5 } }
  assert.deepEqual(pbAny(pbValue(v).done()), v)
  const struct = fields(pbValue(v).done())[0] // the Value's struct (field 5)
  assert.equal(struct.num, 5)
  assert.deepEqual(Object.keys(mapOf(fields(struct.data), 1)), ["a", "b"])
})

test("protobuf: fields keeps what it can read and drops a malformed tail", () => {
  const b = Buffer.concat([pb().str(1, "hi").varint(2, 300).done(), Buffer.from([0x0a, 0x09, 0x01])])
  const fs = fields(b)
  assert.equal(pbStr(fs, 1), "hi")
  assert.equal(pbNum(fs, 2), 300)
  assert.equal(fs.length, 2)
})

test("frames reads Connect frames, gzip aside, and refuses a truncated stream", async () => {
  const a = frame(Buffer.from("one"))
  const end = frame(Buffer.from("{}"))
  end[0] = 2
  const got = await collect(frames([Buffer.concat([a, end]).subarray(0, 4), Buffer.concat([a, end]).subarray(4)]))
  assert.deepEqual(got.map((f) => [f.end, f.data.toString()]), [[false, "one"], [true, "{}"]])
  await assert.rejects(collect(frames([a.subarray(0, 6)])), /unexpected EOF/)
})

test("usageOf: input is the prompt's uncached rest, the cache apart", () => {
  const uf = fields(pb().varint(1, 1000).varint(2, 50).varint(3, 700).varint(4, 100).varint(5, 9).done())
  assert.deepEqual(usageOf(uf), { input: 200, output: 50, cacheRead: 700, cacheWrite: 100, reasoning: 9 })
  assert.equal(usageOf(fields(pb().varint(1, 10).varint(3, 700).done())).input, 0)
})

test("decode: text, then the turn's end with its usage as a chat completion's", async () => {
  const out = await collect(decode(stream(text("Hel"), text("lo"), ended(1000, 50, 700, 100)), { send() {}, blobs: new Map(), tools: [], estimate: 5 }))
  assert.deepEqual(out.slice(0, 2), [{ text: "Hel" }, { text: "lo" }])
  const stop = out[2]
  assert.equal(stop.stop, "stop")
  assert.deepEqual(stop.usage, {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 7 },
  })
})

test("decode: with no usage said, the output is guessed from what was said and the input from the estimate", async () => {
  const out = await collect(decode(stream(text("abcdefgh"), ended(0, 0, 0, 0)), { send() {}, blobs: new Map(), tools: [], estimate: 42 }))
  assert.equal(out.at(-1).usage.completion_tokens, 2)
  assert.equal(out.at(-1).usage.prompt_tokens, 42)
})

test("decode: a turn that wrote nothing is an empty reply, which says what it saw", async () => {
  const out = await collect(decode(stream(update(4, pb().str(1, "thinking")), ended(1, 0, 0, 0)), { send() {}, blobs: new Map(), tools: [] }))
  assert.equal(out.at(-1).error.status, 502)
  assert.match(out.at(-1).error.message, /^an empty reply \(Cursor ended the turn; after 8 chars of thinking, no text and no tool call;/)
})

test("decode: a tool call of the caller's is handed back once the step's calls are all made", async () => {
  const sent = []
  const listed = update(27, pb().varint(1, 1))
  const call = mcpCall(3, "magpie-read", { path: "a.txt" }, "call_1\nfc_2")
  const out = await collect(decode(stream(listed, call, text("never read")), { send: (m) => sent.push(m), blobs: new Map(), tools: [], estimate: 1 }))
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { tool: { index: 0, id: "call_1__fc_2", name: "read", args: '{"path":"a.txt"}' } })
  assert.equal(out[1].stop, "tool_calls")
})

test("decode: anything of Cursor's own to run is refused, a blob is given when asked for", async () => {
  const sent = []
  const shell = pb().bytes(2, pb().varint(1, 9).str(15, "x").bytes(2, pb().str(1, "ls"))).done()
  const blob = Buffer.from("the blob")
  const id = createHash("sha256").update(blob).digest()
  const kv = pb().bytes(4, pb().varint(1, 5).bytes(2, pb().bytes(1, id))).done()
  const out = await collect(decode(stream(shell, kv, text("ok"), ended(1, 1, 0, 0)), { send: (m) => sent.push(m), blobs: new Map([[id.toString("hex"), blob]]), tools: [] }))
  assert.equal(out.at(-1).stop, "stop")
  assert.equal(sent.length, 3) // the refusal, its close, the blob
  assert.ok(sent[2].includes(blob))
})

test("decode: a stream that ends with an error says it in Cursor's words", async () => {
  async function* s() {
    yield { end: true, data: Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "over" } })) }
  }
  const out = await collect(decode(s(), { send() {}, blobs: new Map(), tools: [] }))
  assert.deepEqual(out, [{ error: { status: 429, message: "usage limit reached: over" } }])
})

test("conversationID is the same for one conversation and differs between them; none without a session", () => {
  const chat = (first) => ({ messages: [{ role: "user", content: first }, { role: "assistant", content: "x" }] })
  const a = conversationID(chat("hi"), "s1")
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(conversationID({ messages: [...chat("hi").messages, { role: "user", content: "more" }] }, "s1"), a)
  assert.notEqual(conversationID(chat("other"), "s1"), a)
  assert.notEqual(conversationID(chat("hi"), "s2"), a)
  assert.equal(conversationID(chat("hi"), ""), "")
  assert.equal(conversationID({ ...chat("hi"), prompt_cache_key: " k " }, "s1"), conversationID({ ...chat("hi"), prompt_cache_key: "k" }, ""))
})

test("sessionOf: a session the agent names, but not one magpie made up", () => {
  assert.equal(sessionOf({ sessionID: " abc " }), "abc")
  assert.equal(sessionOf({ sessionID: "magpie-0123456789abcdef01234567" }), "")
  assert.equal(sessionOf({}), "")
  assert.equal(sessionOf({ sessionID: "x".repeat(300) }).length, 128)
})

test("buildRun: the messages are blobs by their sha256, and the model goes with its variant's parameters", () => {
  const msg = Buffer.from(JSON.stringify({ role: "user", content: "hi" }))
  const tool = { name: "read", description: "d", schema: { type: "object" }, schemaText: '{"type":"object"}' }
  const { first, blobs } = buildRun([msg], "hi", [tool], "claude-x-high", "conv-1", { maxMode: true, params: [{ id: "effort", value: "high" }] })
  assert.ok(blobs.has(createHash("sha256").update(msg).digest("hex")))
  assert.equal(blobs.size, 3) // the message, the user turn, the turn
  const rr = fields(fields(first)[0].data)
  assert.equal(pbStr(rr, 5), "conv-1")
  const requested = fields(rr.find((f) => f.num === 9).data)
  assert.equal(pbStr(requested, 1), "claude-x-high")
  assert.equal(pbNum(requested, 2), 1)
  assert.equal(pbStr(fields(requested.find((f) => f.num === 3).data), 1), "effort")
  assert.ok(first.includes(toolDef(tool)))
})

test("h2Blocked: HTTP/2 itself can't be had, or only the connection failed", () => {
  assert.equal(h2Blocked(Object.assign(new Error("slow"), { h2Timeout: true })), true)
  assert.equal(h2Blocked(new Error("h2 is not supported")), true)
  assert.equal(h2Blocked(Object.assign(new Error("x"), { code: "ERR_HTTP2_ERROR" })), true)
  assert.equal(h2Blocked(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false)
  assert.equal(h2Blocked(Object.assign(new Error("reset"), { code: "ERR_HTTP2_STREAM_ERROR" })), false)
  assert.equal(h2Blocked(new Error("boom")), false)
})

test("addUsage sums into the first, and tolerates nothing", () => {
  assert.equal(addUsage(null, null), null)
  const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 }
  assert.deepEqual(addUsage(a, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, reasoning: 0 })
  assert.deepEqual(addUsage(null, a), a)
})

test("usageEvents: a conversation's events from the dashboard, each counted once", async () => {
  const now = Date.now()
  const ev = (conv, at, n) => ({ conversationId: conv, timestamp: String(at), tokenUsage: { inputTokens: n, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } })
  const f = fakeFetch(() => ({ body: { usageEventsDisplay: [ev("c1", now + 10, 100), ev("other", now + 20, 999), ev("c1", now + 30, 50)] } }))
  try {
    const first = await usageEvents("ev-tok", "c1", now, 1)
    assert.deepEqual(first.usage, { input: 100, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 })
    assert.equal(first.got, 1)
    const second = await usageEvents("ev-tok", "c1", now, 2)
    assert.equal(second.usage.input, 50)
    assert.equal(second.got, 1)
    assert.equal(JSON.parse(f.calls[0].body).pageSize, 50)
  } finally {
    f.restore()
  }
})

test("usageEvents: an account that may not read them is told so", async () => {
  const f = fakeFetch(() => ({ status: 403 }))
  try {
    const r = await usageEvents("denied-tok", "c1", Date.now(), 1)
    assert.equal(r.refused, true)
    assert.equal(r.usage, null)
  } finally {
    f.restore()
  }
})
