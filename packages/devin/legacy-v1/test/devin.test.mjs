import test from "node:test"
import assert from "node:assert/strict"
import { DevinAuthPlugin } from "../src/index.mjs"
import { PB, dec, fields, frame } from "../src/protobuf.mjs"
import { build, conversationOf, joinSplitCalls, argsOf } from "../src/request.mjs"
import { complete, events } from "../src/response.mjs"
import { failure } from "../src/refusals.mjs"
import { inID, outID, objectRoot } from "../src/tools.mjs"
import { SNAPSHOT, SNAPSHOT_IMAGES } from "../src/snapshot.mjs"
import { effortOf, familiesOf, listed, parseFamilies, variantFor } from "../src/variants.mjs"
import { usageOf } from "../src/usage.mjs"
import { entryOf, refreshed } from "../src/cache.mjs"
import { credentials, parseStatus, readCredentials } from "../src/cli.mjs"
import { tierName, whoByKey } from "../src/identity.mjs"
import { forgetSaid, imagesFor, parseModelConfigs, withImages } from "../src/images.mjs"
import { configModel, runtimeModel } from "../src/models.mjs"
import { serverOf } from "../src/session.mjs"

// a fetch that answers from a queue and remembers what it was asked
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const r = replies.shift()
    if (r instanceof Error) throw r
    return typeof r === "function" ? r() : r
  }
  return calls
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

// the request's messages (field 3) as { role, text, calls, callID }
const sent = (bytes) => {
  const top = fields(bytes)
  const text = (b) => dec.decode(b)
  return {
    msgs: top
      .filter((f) => f.num === 3)
      .map((f) => {
        const m = { calls: [] }
        for (const g of fields(f.data)) {
          if (g.num === 2) m.role = g.n
          else if (g.num === 3) m.text = text(g.data)
          else if (g.num === 7) m.callID = text(g.data)
          else if (g.num === 6) m.calls.push(Object.fromEntries(fields(g.data).map((h) => [["", "id", "name", "args"][h.num], text(h.data)])))
        }
        return m
      }),
    tools: top.filter((f) => f.num === 10).map((f) => Object.fromEntries(fields(f.data).map((h) => [["", "name", "desc", "schema"][h.num], text(h.data)]))),
    model: text(top.find((f) => f.num === 21).data),
    sampling: fields(top.find((f) => f.num === 8).data),
  }
}

// a GetChatMessage reply: pieces, then optionally the stream's end
const reply = (pieces, end) =>
  new Response(Buffer.concat([...pieces.map((p) => frame(p.done())), ...(end === undefined ? [] : [Buffer.concat([Buffer.from([2, 0, 0, 0, end.length]), Buffer.from(end)])])]), { status: 200 })

test("the system prompt and tool descriptions go in the first user message; tools carry a pointer", () => {
  const chat = {
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "Bash", description: " run it ", parameters: { type: "object", properties: {} } } }, { type: "function", function: { name: "Quiet" } }],
  }
  const r = sent(build(chat, "swe-2-high", "KEY"))
  assert.equal(r.model, "swe-2-high")
  assert.equal(r.msgs.length, 1)
  assert.ok(r.msgs[0].text.startsWith("be brief\n\n<tool_descriptions>\n<tool name=\"Bash\">\nrun it\n</tool>"))
  assert.ok(r.msgs[0].text.endsWith("hi"))
  assert.match(r.tools[0].desc, /Described under <tool name="Bash">/)
  assert.equal(r.tools[1].desc, "Quiet")
  assert.equal(r.tools[1].schema, '{"type":"object","properties":{}}')
})

test("tool_choice none offers no tools, and a call the conversation used is still declared", () => {
  const chat = {
    tool_choice: "none",
    tools: [{ function: { name: "a" } }],
    messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "" }],
  }
  const r = sent(build(chat, "m", "K"))
  assert.deepEqual(r.tools.map((t) => [t.name, t.desc]), [["Read", "Tool"]])
  assert.equal(r.msgs.at(-1).text, "(no output)")
})

test("a temperature or top_p of 0 goes as 1e-6, and the defaults when missing", () => {
  const double = (v) => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(v)
    return b
  }
  const raw = (chat) => Buffer.from(build({ messages: [{ role: "user", content: "x" }], ...chat }, "m", "K"))
  assert.ok(raw({ temperature: 0 }).includes(double(1e-6)))
  assert.ok(raw({ top_p: 0 }).includes(double(1e-6)))
  assert.ok(raw({ temperature: 0.5 }).includes(double(0.5)))
  assert.equal(raw({}).includes(double(1e-6)), false)
  assert.ok(raw({}).includes(double(0.95)))
  const max = (chat) => sent(build({ messages: [{ role: "user", content: "x" }], ...chat }, "m", "K")).sampling.find((f) => f.num === 2).n
  assert.equal(max({ max_tokens: 9 }), 9)
  assert.equal(max({ max_completion_tokens: 7, max_tokens: 9 }), 7)
  assert.equal(max({}), 128000)
})

test("an unanswered call is marked interrupted; a split turn's calls are joined and answered together", () => {
  const open = conversationOf([{ role: "user", content: "a" }, { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "T", arguments: "{}" } }] }, { role: "user", content: "b" }])
  assert.equal(open.msgs[2].text, "Tool use was interrupted and did not produce a result.")
  const split = [
    { role: "assistant", content: "one", tool_calls: [{ id: "a", function: { name: "T" } }] },
    { role: "assistant", content: "two", tool_calls: [{ id: "b", function: { name: "T" } }] },
  ]
  const joined = joinSplitCalls(split)
  assert.equal(joined.length, 1)
  assert.equal(joined[0].content, "one\n\ntwo")
  assert.deepEqual(joined[0].tool_calls.map((c) => c.id), ["a", "b"])
  assert.equal(split.length, 2)
})

test("a conversation that ends on the assistant is told to proceed; images come from data URLs", () => {
  assert.equal(conversationOf([{ role: "assistant", content: "done" }]).msgs.at(-1).text, "Please proceed with the task.")
  const { msgs } = conversationOf([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }, { type: "image_url", image_url: "https://x/y.png" }] }])
  assert.deepEqual(msgs[0].images, [{ data: "QUJD", type: "image/jpeg" }])
})

test("arguments are always a JSON object", () => {
  assert.equal(argsOf('{"a":1}'), '{"a":1}')
  assert.equal(argsOf({ b: 2 }), '{"b":2}')
  assert.equal(argsOf("5"), "{}")
  assert.equal(argsOf("nope"), "{}")
  assert.equal(argsOf(undefined), "{}")
})

test("a call id Claude Code would drop is wrapped, and unwrapped on the way back", () => {
  const id = "Bash:0#a65b6a5e"
  const out = outID(id)
  assert.match(out, /^dv_[A-Za-z0-9_-]+$/)
  assert.equal(inID(out), id)
  assert.equal(outID("call_abc"), "call_abc")
  assert.ok(outID("dv_x").startsWith("dv_") && outID("dv_x") !== "dv_x")
  assert.equal(inID("dv_!!"), "dv_!!")
})

test("a tool schema with a root union is folded into one object", () => {
  const plain = { type: "object", properties: { a: {} } }
  assert.equal(objectRoot(plain), plain)
  const folded = objectRoot({
    oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["id", "a"] }, { type: "object", properties: { b: {} }, required: ["id"] }],
  })
  assert.equal(folded.type, "object")
  assert.deepEqual(Object.keys(folded.properties), ["a", "b"])
  assert.deepEqual(folded.required, ["id"])
  assert.equal(folded.oneOf, undefined)
})

test("failures: Connect codes and messages map to statuses", () => {
  assert.deepEqual(failure(200, '{"code":"unauthenticated","message":"no"}'), { status: 401, message: "no — sign in to Devin again" })
  assert.equal(failure(200, '{"error":{"code":"resource_exhausted","message":"x"}}').status, 429)
  assert.equal(failure(500, "daily quota used").message, "usage limit reached: daily quota used")
  assert.equal(failure(500, "prompt is too long").status, 400)
  assert.equal(failure(200, '{"code":"unavailable","message":"x"}').status, 503)
  assert.equal(failure(200, '{"code":"internal","message":"x"}').status, 502)
  assert.deepEqual(failure(404, ""), { status: 404, message: "Not Found" })
  assert.equal(failure(509, "").message, "HTTP 509")
})

test("events: text, a tool call with its arguments, and usage", async () => {
  const frames = [
    { end: false, data: new PB().str(3, "hello").done() },
    { end: false, data: new PB().bytes(6, new PB().str(1, "Bash:0#x").str(2, "Bash").bytes(3, '{"a"')).done() },
    { end: false, data: new PB().bytes(6, new PB().bytes(3, ":1}")).bytes(7, new PB().varint(2, 10).varint(3, 4).varint(4, 1).varint(5, 2)).done() },
  ]
  const out = []
  for await (const e of events(frames[Symbol.iterator]()[Symbol.iterator] ? (async function* () { yield* frames })() : null)) out.push(e)
  assert.deepEqual(out[0], { text: "hello" })
  assert.equal(out[1].tool.name, "Bash")
  assert.equal(out[1].tool.id, outID("Bash:0#x"))
  assert.deepEqual(out[2], { args: { index: 0, text: '{"a"' } })
  assert.deepEqual(out[3], { args: { index: 0, text: ":1}" } })
  const last = out.at(-1)
  assert.equal(last.stop, "tool_calls")
  assert.deepEqual(last.usage, { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } })
})

test("events: an unreported output is estimated from what was said; finish reasons follow Devin's stop", async () => {
  const run = async (stop) => {
    const it = (async function* () {
      yield { end: false, data: new PB().str(3, "abcdefgh").varint(5, stop).done() }
    })()
    const out = []
    for await (const e of events(it)) out.push(e)
    return out.at(-1)
  }
  const stopped = await run(1)
  assert.equal(stopped.stop, "stop")
  assert.equal(stopped.usage.completion_tokens, 2)
  assert.equal((await run(3)).stop, "length")
  assert.equal((await run(10)).stop, "tool_calls")
})

test("complete: a whole reply, with the request Devin is sent", async () => {
  const calls = fake(
    reply([new PB().str(3, "Hi ").str(9, "think"), new PB().str(3, "there").varint(5, 1).bytes(7, new PB().varint(2, 5).varint(3, 2))]),
  )
  const families = familiesOf(SNAPSHOT)
  const res = await complete({ key: "KEY", server: "https://s.test", families }, { model: "swe-2", reasoning_effort: "max", messages: [{ role: "user", content: "yo" }] })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const body = await res.json()
  assert.equal(body.choices[0].message.content, "Hi there")
  assert.equal(body.choices[0].message.reasoning_content, "think")
  assert.equal(body.choices[0].finish_reason, "stop")
  assert.equal(body.usage.total_tokens, 7)
  assert.match(body.id, /^chatcmpl-[0-9a-f]{24}$/)
  assert.equal(calls[0].url, "https://s.test/exa.api_server_pb.ApiServerService/GetChatMessage")
  assert.equal(calls[0].init.headers.Authorization, "Basic KEY")
  assert.equal(calls[0].init.headers["Content-Type"], "application/connect+proto")
  assert.equal(sent(calls[0].init.body.subarray(5)).model, "swe-2-max")
})

test("complete: a stream is chunks, then [DONE]", async () => {
  fake(reply([new PB().str(3, "a"), new PB().str(3, "b").varint(5, 1)]))
  const res = await complete({ key: "K", server: "https://s", families: [] }, { model: "m", stream: true, messages: [{ role: "user", content: "x" }] })
  assert.equal(res.headers.get("content-type"), "text/event-stream")
  const events = (await res.text()).trim().split("\n\n")
  assert.equal(events.at(-1), "data: [DONE]")
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.slice(6)))
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" })
  assert.deepEqual(chunks.slice(1, 3).map((c) => c.choices[0].delta.content), ["a", "b"])
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
  assert.ok(chunks.at(-1).usage)
})

test("complete: refusals keep the sign-in and say what Devin said", async () => {
  fake(new Response('{"code":"resource_exhausted","message":"slow down"}', { status: 429 }))
  const res = await complete({ key: "K", server: "https://s", families: [] }, { model: "m", messages: [] })
  assert.equal(res.status, 429)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await res.json(), { error: { message: "usage limit reached: slow down", type: "devin_error", code: 429 } })

  fake(new Error("socket hang up"))
  assert.equal((await complete({ key: "K", server: "https://s", families: [] }, { model: "m", messages: [] })).status, 502)

  // an error as the stream's end comes with its own status
  fake(reply([], '{"error":{"code":"unauthenticated","message":"bad key"}}'))
  const ended = await complete({ key: "K", server: "https://s", families: [] }, { model: "m", messages: [] })
  assert.equal(ended.status, 401)
  assert.match((await ended.json()).error.message, /bad key/)
})

test("effort words and the variant a family's id turns into", () => {
  assert.equal(effortOf(" HIGH "), "high")
  assert.equal(effortOf("ultra"), "max")
  assert.equal(effortOf("turbo"), "")
  const families = familiesOf(SNAPSHOT)
  assert.equal(variantFor(families, "swe-2", "max"), "swe-2-max")
  assert.equal(variantFor(families, "swe", "low"), "swe-2-medium") // swe-2 has no low: the nearest, a tie going up
  assert.equal(variantFor(families, "swe-2", ""), "swe-2-high")
  assert.equal(variantFor(families, "claude-opus-5-fast", "low"), "claude-opus-5-low-fast")
  assert.equal(variantFor(families, "swe-2-medium", "max"), "swe-2-medium") // a variant's own id goes as it is
  assert.equal(variantFor(families, "unknown", "high"), "unknown")
})

test("the offered list has one model per family, its efforts, and its fast run", () => {
  const list = listed(familiesOf(SNAPSHOT), [], SNAPSHOT_IMAGES)
  const swe = list.find((m) => m.id === "swe-2")
  assert.deepEqual(swe.efforts, ["medium", "high", "max"])
  assert.equal(list.some((m) => m.id === "swe-2-high"), false)
  const fast = list.find((m) => m.id === "claude-opus-5-fast")
  assert.equal(fast.name, "Claude Opus 5 Fast")
  assert.ok(list.find((m) => m.id === "glm-5-2-1m")) // no effort: offered as its own model
  assert.equal(list.find((m) => m.id === "glm-5-2").image, false)
  assert.equal(list.find((m) => m.id === "swe-2").image, true)
  // a variant the user picked stays, at its one effort
  const kept = listed(familiesOf(SNAPSHOT), ["swe-2-medium"], {}).find((m) => m.id === "swe-2-medium")
  assert.deepEqual(kept.efforts, ["medium"])
})

test("the CLI's list drops Adaptive and Fusion, and variants without an id", () => {
  const text = JSON.stringify({ families: [{ family_uid: "Adaptive" }, { family_uid: "fusion" }, { family_label: "no uid" }, { family_uid: "x", variants: [{ model_uid: "x-high", max_context_tokens: 5 }, { label: "nope" }] }] })
  assert.deepEqual(parseFamilies(text), [{ uid: "x", label: "x", aliases: [], models: [{ id: "x-high", name: "x-high", context: 5, output: 0 }] }])
  assert.deepEqual(parseFamilies("not json"), [])
})

test("model entries for config and runtime say what the list does", () => {
  const m = { id: "a", name: "A", context: 10, output: 5, efforts: ["low", "high"], image: true }
  const c = configModel(m)
  assert.deepEqual(c.modalities.input, ["text", "image"])
  assert.deepEqual(c.variants, { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } })
  assert.equal(configModel({ ...m, efforts: [] }).variants, undefined)
  const r = runtimeModel({ ...m, efforts: [], image: false })
  assert.equal(r.capabilities.reasoning, false)
  assert.equal(r.capabilities.input.image, false)
  assert.deepEqual(r.variants, {})
})

test("withImages changes only the models the list says of", () => {
  const out = withImages({ a: { capabilities: { input: { text: true } } }, b: { x: 1 } }, [{ id: "a", image: true }, { id: "b" }])
  assert.deepEqual(out.a.capabilities, { attachment: true, input: { text: true, image: true } })
  assert.deepEqual(out.b, { x: 1 })
})

test("usage: daily and weekly shares, ACUs and the extra balance", () => {
  const card = usageOf({
    planEnd: "2026-11-01T00:00:00Z",
    planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA" },
    dailyQuotaRemainingPercent: 40,
    dailyQuotaResetAtUnix: "1790000000",
    weeklyQuotaResetAtUnix: 1790500000,
    acuLimit: 8,
    acuConsumed: "2",
    overageBalanceMicros: "1234567",
  })
  assert.equal(card.until, "2026-11-01T00:00:00Z")
  assert.deepEqual(card.windows[0], { name: "1 day", used: 60, span: 86400, resetsAt: 1790000000 })
  // JSON leaves a 0 out: a quota plan's week with a reset and no share left is used up
  assert.deepEqual(card.windows[1], { name: "7 days", used: 100, span: 604800, resetsAt: 1790500000 })
  assert.deepEqual(card.windows[2], { name: "ACUs", used: 25, display: "2 / 8 ACUs", resetsAt: "2026-11-01T00:00:00Z", aside: true })
  assert.equal(card.balance, "$1.23")
})

test("usage: off a quota plan a missing share is no quota, and hidden quotas stay hidden", () => {
  assert.deepEqual(usageOf({ weeklyQuotaResetAtUnix: 5 }).windows, [])
  const hidden = usageOf({ planInfo: { hideDailyQuota: true }, dailyQuotaRemainingPercent: 10 })
  assert.deepEqual(hidden.windows, [])
  assert.equal(usageOf({}).balance, undefined)
  assert.equal(usageOf({ dailyQuotaRemainingPercent: 150 }).windows[0].used, 0)
})

test("the usage hook reads GetUserStatus, and a refused key says to sign in again without clearing it", async () => {
  const hooks = await DevinAuthPlugin()
  const auth = async () => ({ type: "api", key: "KEY" })
  const calls = fake(json({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 70 } } }))
  const card = await hooks.auth.usage(auth)
  assert.equal(card.signIn, "kept")
  assert.equal(card.windows[0].used, 30)
  assert.equal(JSON.parse(calls[0].init.body).metadata.apiKey, "KEY")
  assert.ok(calls[0].url.endsWith("/exa.seat_management_pb.SeatManagementService/GetUserStatus"))
  fake(json({ code: "unauthenticated" }, 401))
  assert.deepEqual(await hooks.auth.usage(auth), { error: "Devin's sign-in has expired — sign in again", windows: [], signIn: "kept" })
  assert.deepEqual(await hooks.auth.usage(async () => undefined), { error: "Devin isn't signed in", signIn: "kept" })
})

test("whoByKey: the account Devin names, null for a refused key, undefined when it can't tell", async () => {
  fake(json({ userStatus: { email: "a@b.c", teamsTier: "TEAMS_TIER_DEVIN_TEAMS_V2" } }))
  assert.deepEqual(await whoByKey("k", "https://s"), { user: "a@b.c", plan: "Devin Teams" })
  fake(json({ userStatus: { name: "Ann", planStatus: { planInfo: { planName: "Pro" } } } }))
  assert.deepEqual(await whoByKey("k", "https://s"), { user: "Ann", plan: "Pro" })
  fake(json({ code: "unauthenticated" }, 401))
  assert.equal(await whoByKey("k", "https://s"), null)
  fake(json({}, 500))
  assert.equal(await whoByKey("k", "https://s"), undefined)
  fake(new Error("offline"))
  assert.equal(await whoByKey("k", "https://s"), undefined)
  fake(json({ userStatus: {} }))
  assert.equal(await whoByKey("k", "https://s"), undefined)
})

test("tier names drop the prefix, the version and UNSPECIFIED", () => {
  assert.equal(tierName("TEAMS_TIER_DEVIN_PRO"), "Devin Pro")
  assert.equal(tierName("TEAMS_TIER_UNSPECIFIED"), "")
  assert.equal(tierName(undefined), "")
})

test("the CLI's report and credentials are read as it writes them", () => {
  assert.equal(parseStatus("Not logged in"), null)
  assert.deepEqual(parseStatus("Logged in\n  Name: Ann\n  Tier: Devin Pro\n"), { user: "Ann", plan: "Devin Pro" })
  assert.deepEqual(parseStatus("Logged in\nEmail: a@b.c\nName: Ann\nPlan: Pro"), { user: "a@b.c", plan: "Pro" })
  const toml = credentials('k"ey\\', "", "", "")
  assert.match(toml, /^windsurf_api_key = "k\\"ey\\\\"\n/)
  const read = readCredentials(toml + "# comment\nother = 'raw'\n")
  assert.equal(read.windsurf_api_key, 'k"ey\\')
  assert.equal(read.api_server_url, "https://server.codeium.com")
  assert.equal(read.other, "raw")
})

test("the server an account goes to: the environment, the saved one, or Devin's, without trailing slashes", () => {
  const was = process.env.WINDSURF_API_SERVER_URL
  delete process.env.WINDSURF_API_SERVER_URL
  try {
    assert.equal(serverOf({ metadata: { server: "https://x.test//" } }), "https://x.test")
    assert.equal(serverOf({}), "https://server.codeium.com")
    process.env.WINDSURF_API_SERVER_URL = "https://env.test/"
    assert.equal(serverOf({ metadata: { server: "https://x.test" } }), "https://env.test")
  } finally {
    if (was === undefined) delete process.env.WINDSURF_API_SERVER_URL
    else process.env.WINDSURF_API_SERVER_URL = was
  }
})

test("a cache entry is served stale while read again, and a failed read waits before the next", async () => {
  const c = entryOf()
  let loads = 0
  let next = () => ["v1"]
  const load = async () => {
    loads++
    const v = next()
    if (v instanceof Error) throw v
    return v
  }
  await refreshed(c, { load })
  assert.deepEqual([c.value, loads], [["v1"], 1])
  await refreshed(c, { load }) // fresh: not read again
  assert.equal(loads, 1)
  c.at -= 6 * 60 * 1000
  next = () => ["v2"]
  let open
  const gate = new Promise((r) => (open = r))
  await refreshed(c, { load: () => gate.then(load) }) // stale: served at once, read in the background
  assert.deepEqual(c.value, ["v1"])
  open()
  await c.asking
  assert.deepEqual(c.value, ["v2"])
  c.at -= 6 * 60 * 1000
  next = () => new Error("down")
  await refreshed(c, { load })
  await c.asking
  assert.ok(c.failed > 0)
  assert.deepEqual(c.value, ["v2"]) // a failure keeps what there was
  c.at -= 6 * 60 * 1000
  await refreshed(c, { load }) // failed a moment ago: not asked again yet
  assert.equal(loads, 3)
})

test("a cache entry that isn't allowed to ask is never read, and undefined leaves it as it is", async () => {
  const c = entryOf()
  let loads = 0
  await refreshed(c, { load: async () => loads++, allowed: () => false })
  assert.equal(loads, 0)
  await refreshed(c, { load: async () => undefined })
  assert.equal(c.value, null)
  assert.equal(c.failed, 0)
})

test("which models take images: the proto reply, over the SNAPSHOT's word", async () => {
  const model = (uid, images) => {
    const m = new PB().str(22, uid)
    if (images) m.varint(5, 1)
    return m
  }
  const bytes = new PB().bytes(1, model("swe-2-high", false)).bytes(1, model("brand-new", true)).done()
  assert.deepEqual(parseModelConfigs(bytes), { "swe-2-high": false, "brand-new": true })
  assert.equal(parseModelConfigs(new Uint8Array()), null)

  forgetSaid()
  const calls = fake(() => new Response(bytes, { status: 200 }))
  const images = await imagesFor("key-1", "https://s.test")
  assert.equal(images["swe-2-high"], false)
  assert.equal(images["brand-new"], true)
  assert.equal(images["swe-2-medium"], true) // from the SNAPSHOT
  assert.equal(calls[0].url, "https://s.test/exa.api_server_pb.ApiServerService/GetCliModelConfigs")
  await imagesFor("key-1", "https://s.test") // kept: not asked again
  assert.equal(calls.length, 1)

  forgetSaid()
  fake(new Response("", { status: 500 }))
  assert.deepEqual(await imagesFor("key-2", "https://s.test"), SNAPSHOT_IMAGES)
})

test("the loader answers only a signed-in account's chat completions", async () => {
  const hooks = await DevinAuthPlugin()
  assert.equal(hooks.auth.provider, "devin")
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {})
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "KEY" }))
  assert.equal(loaded.baseURL, "https://server.codeium.com/devin/v1")

  const other = await loaded.fetch("https://server.codeium.com/devin/v1/models", {})
  assert.equal(other.status, 404)
  const bad = await loaded.fetch("https://server.codeium.com/devin/v1/chat/completions", { body: "not json" })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.type, "devin_error")

  // an account signed out since the loader ran is answered 401
  let signedIn = true
  const later = await hooks.auth.loader(async () => (signedIn ? { type: "api", key: "KEY" } : undefined))
  signedIn = false
  assert.equal((await later.fetch("https://server.codeium.com/devin/v1/chat/completions", { body: "{}" })).status, 401)
})

test("the config hook adds Devin's models without overriding the user's", async () => {
  const hooks = await DevinAuthPlugin()
  const config = { provider: { devin: { name: "Mine", models: { "swe-2": { name: "custom" } } } } }
  await hooks.config(config)
  assert.equal(config.provider.devin.name, "Mine")
  assert.equal(config.provider.devin.models["swe-2"].name, "custom")
  assert.equal(config.provider.devin.models["claude-opus-5"].reasoning, true)
  assert.equal(config.provider.devin.api, "https://server.codeium.com/devin/v1")
})
