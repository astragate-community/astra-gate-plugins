import test from "node:test"
import assert from "node:assert/strict"
import { QoderAuthPlugin, QoderCNAuthPlugin } from "../src/index.mjs"
import { SITES, siteOf, vpcInstance, vpcSite } from "../src/sites.mjs"
import { decodeBody, encodeBody } from "../src/codec.mjs"
import { cosyHeaders } from "../src/cosy.mjs"
import { effortFor, fitEffort, qoderBody, qoderMessages, windowFor } from "../src/request.mjs"
import { freeOf, modelInfo, modelInfos, rateOf, sceneModels, windowsOf } from "../src/models.mjs"
import { errorResponse, failure, signed } from "../src/refusals.mjs"
import { Splitter, parseCall } from "../src/toolcalls.mjs"
import { answer, events } from "../src/response.mjs"
import { gfmt, parseUsage, when } from "../src/usage.mjs"
import { campaignPage, campaignRuntime, campaignTarget } from "../src/campaigns.mjs"
import { changed } from "../src/session.mjs"

const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})

// a fetch that answers by a function and remembers what it was asked
function fake(answerFor) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof URL ? url.href : url)
    calls.push({ url: u, init })
    const r = await answerFor(u, init, calls.length)
    return r instanceof Response ? r : new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
  }
  return calls
}
const sse = (...bodies) =>
  new Response(bodies.map((b) => `data: ${JSON.stringify({ statusCodeValue: 200, body: typeof b === "string" ? b : JSON.stringify(b) })}\n\n`).join(""), { status: 200 })
const delta = (d, extra = {}) => ({ choices: [{ delta: d, ...extra }] })
const text = (res) => res.text()

const account = { type: "oauth", access: "job", refresh: "r1", expires: Date.now() + 3600e3, uid: "u1", machineId: "m1", deviceToken: "dev", deviceRefresh: "dr", email: "a@b.c" }
const thinker = { key: "k", source: "s", thinks: true, alwaysThinks: false, efforts: ["low", "high", "max"], defaultEffort: "high", windows: [], context: 180_000, config: { key: "k" } }

test("both sites are plugins with the usual hooks", async () => {
  for (const P of [QoderAuthPlugin, QoderCNAuthPlugin]) {
    const h = await P({ client: {} })
    assert.equal(typeof h.auth.usage, "function")
    assert.equal(typeof h.auth.refresh, "function")
    assert.equal(typeof h.provider.models, "function")
  }
  assert.equal((await QoderAuthPlugin({ client: {} })).auth.methods.length, 1)
  assert.equal((await QoderCNAuthPlugin({ client: {} })).auth.methods.length, 2)
})

test("body codec round-trips text, including multi-byte", () => {
  for (const s of ["", "a", "ab", "abc", "hello, world", "你好 — Qoder ✓", JSON.stringify({ a: [1, 2, 3] })]) {
    assert.equal(decodeBody(encodeBody(s)), s)
  }
  assert.ok(!/[+/=]/.test(encodeBody("hello world")))
})

test("COSY headers carry the machine and a signature over the body and path", () => {
  const h = cosyHeaders("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1", account, "BODY", 1700000000)
  assert.equal(h["Cosy-Date"], "1700000000")
  assert.equal(h["Cosy-MachineId"], "m1")
  assert.equal(h["Cosy-User"], "u1")
  assert.match(h.Authorization, /^Bearer COSY\.[^.]+\.[0-9a-f]{32}$/)
  assert.throws(() => cosyHeaders("https://x/y", { ...account, machineId: "" }, ""), /machine id/)
})

test("vpc instances: names and hosts are read, anything else is none", () => {
  const d = "vpc.qoder.com.cn"
  assert.equal(vpcInstance("acme", d), "acme")
  assert.equal(vpcInstance("ACME.vpc.qoder.com.cn", d), "acme")
  assert.equal(vpcInstance("acme-openapi.vpc.qoder.com.cn", d), "acme")
  assert.equal(vpcInstance("https://acme-gateway.vpc.qoder.com.cn/", d), "acme")
  for (const bad of ["http://acme.vpc.qoder.com.cn", "10.0.0.1", "evil.example.com", "https://acme.vpc.qoder.com.cn/x", "-acme", "", "acme.vpc.qoder.com.cn:8443"]) {
    assert.equal(vpcInstance(bad, d), undefined, bad)
  }
  assert.equal(vpcInstance("acme", undefined), undefined)
  const s = vpcSite(SITES["qoder-cn"], "acme")
  assert.deepEqual([s.web, s.openapi, s.api, s.vpc], ["https://acme.vpc.qoder.com.cn", "https://acme-openapi.vpc.qoder.com.cn", "https://acme-gateway.vpc.qoder.com.cn", "acme"])
})

test("siteOf serves the public site, a VPC's, and refuses an instance that names none", () => {
  assert.equal(siteOf(SITES.qoder, {}), SITES.qoder)
  assert.equal(siteOf(SITES["qoder-cn"], { vpc: "acme" }).api, "https://acme-gateway.vpc.qoder.com.cn")
  assert.throws(() => siteOf(SITES["qoder-cn"], { vpc: "not an instance" }), (e) => e.expired === false && /sign in again/.test(e.message))
  assert.throws(() => siteOf(SITES.qoder, { vpc: "acme" }), /isn't one/) // qoder has no VPC
})

test("model price: free only at 0x, a discount is not free, and the strike-through price", () => {
  assert.equal(freeOf({ price_factor: 0 }), true)
  assert.equal(freeOf({ price_factor: 0.5, is_free: true }), false)
  assert.equal(freeOf({ price_factor: 0, promotion: { active: true, before_promotion_price_factor: 1.1 } }), false)
  assert.equal(freeOf({ is_free: true }), true)
  assert.deepEqual(rateOf({ price_factor: 0, original_price_factor: 0.1 }), { rate: 0, rateWas: 0.1 })
  assert.deepEqual(rateOf({ price_factor: 0, promotion: { active: true, before_promotion_price_factor: 1, discount_factor: 0.4 } }), { rate: 0.4, rateWas: 1 })
  assert.deepEqual(rateOf({ price_factor: 2, original_price_factor: 1 }), { rate: 2, rateWas: 0 })
  assert.deepEqual(rateOf({}), { rate: 0, rateWas: 0 })
})

test("context windows come from context_config, else the available list", () => {
  assert.deepEqual(windowsOf({ context_config: { "1m": { token_count: 1_000_000 }, "200k": { token_count: 200_000, is_default: true } } }), { windows: [200_000, 1_000_000], defaultWindow: 200_000 })
  assert.deepEqual(windowsOf({ available_context_windows: [400_000, 200_000], default_context_window: 200_000 }), { windows: [200_000, 400_000], defaultWindow: 200_000 })
  assert.deepEqual(windowsOf({}), { windows: [], defaultWindow: 0 })
})

test("modelInfo reads efforts in rank order, the default and always-thinking", () => {
  const m = modelInfo({
    key: "k",
    display_name: "K",
    is_vl: true,
    max_input_tokens: 180_000,
    thinking_config: { enabled: { efforts: { max: {}, low: {}, high: { is_default: true } } } },
  })
  assert.deepEqual([m.name, m.images, m.context, m.thinks, m.alwaysThinks, m.efforts, m.defaultEffort], ["K", true, 180_000, true, true, ["low", "high", "max"], "high"])
  assert.equal(modelInfo({ key: "j", thinking_config: { enabled: {}, disabled: {} } }).alwaysThinks, false)
})

test("the listing: the app's models in order, a chat-only one kept after its neighbour, auto and disabled dropped", () => {
  const l = { app: [{ key: "fast", enable: true }, { key: "auto", enable: true }, { key: "x", enable: true }], chat: [{ key: "fast", enable: true }, { key: "performance", enable: true }, { key: "x" }] }
  assert.deepEqual(sceneModels(l).map((m) => m.key), ["fast", "performance", "auto", "x"])
  assert.deepEqual(modelInfos(l).map((m) => m.key), ["fast", "performance", "x"])
  assert.deepEqual(modelInfos({ chat: [{ key: "a", enable: false }, { key: "b", enable: true }] }).map((m) => m.key), ["b"])
})

test("effort: none, default, always-thinking and the nearest level", () => {
  assert.deepEqual(effortFor("none", thinker), [false, ""])
  assert.deepEqual(effortFor(undefined, thinker), [true, "high"])
  assert.deepEqual(effortFor("none", { ...thinker, alwaysThinks: true }), [true, "low"])
  assert.deepEqual(effortFor("bogus", thinker), [true, "high"])
  assert.deepEqual(effortFor("xhigh", thinker), [true, "max"])
  assert.deepEqual(effortFor("low", { ...thinker, thinks: false }), [false, ""])
  assert.deepEqual(effortFor("high", { ...thinker, efforts: [] }), [true, ""])
  assert.equal(fitEffort("ultra", ["low", "max"]), "max")
  assert.equal(fitEffort("medium", ["low", "high"]), "high") // a tie goes up
})

test("messages: tool images follow in a user turn, an assistant's tool calls are kept", () => {
  const out = qoderMessages([
    { role: "system", content: "ignored" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "shot", arguments: { a: 1 } } }] },
    { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "done" }, { type: "image_url", image_url: { url: "data:x" } }] },
    { role: "user", content: "and?" },
  ])
  assert.deepEqual(out[1], { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: '{"a":1}' } }] })
  assert.equal(out[2].content, "done\n\n[The tool returned an image; it follows in the next message.]")
  assert.deepEqual(out[3].content.map((b) => b.type), ["text", "image_url", "text"])
  assert.equal(out[3].content[0].text, "[From the result of shot (tool call c1):]")
})

test("the window grows only when the conversation needs it, the reply counted in", () => {
  const m = { ...thinker, context: 1_000_000, windows: [200_000, 400_000, 1_000_000], defaultWindow: 200_000 }
  assert.equal(windowFor({ messages: [{ role: "user", content: "hi" }] }, m, 1000), 200_000)
  const big = { messages: [{ role: "user", content: "x".repeat(540_000) }] } // ≈180K tokens
  assert.equal(windowFor(big, m, 0), 200_000)
  assert.equal(windowFor(big, m, 32_000), 400_000)
  assert.equal(windowFor({ messages: [] }, { ...m, windows: [] }, 0), 1_000_000)
})

test("the request body: system text, tools, tool_choice and thinking", () => {
  const chat = {
    reasoning_effort: "low",
    max_tokens: 100,
    tool_choice: "required",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }, { type: "other" }],
  }
  const b = qoderBody(chat, thinker)
  assert.match(b.system[0].text, /^You are a Qoder agent\..*\n\nBe brief\.\nYou must call an available function in this response\.$/s)
  assert.deepEqual(b.parameters, { enable_thinking: true, max_tokens: 100, reasoning_effort: "low", context_length: 180_000 })
  assert.deepEqual(b.tools, [{ type: "function", function: { name: "t", description: "", parameters: { type: "object" } } }])
  assert.deepEqual(b.messages.map((m) => m.role), ["system", "user"])
  assert.equal(qoderBody({ ...chat, tool_choice: "none" }, thinker).tools, undefined)
  assert.equal(qoderBody({ messages: [] }, thinker).parameters.max_tokens, 32000)
})

test("failures: queue, quota, refused request, lapsed sign-in and plain statuses", () => {
  const q = failure(403, JSON.stringify({ code: 10605, message: "queued", queue: { isQueued: true, retryAfterSeconds: 7.2, modelKey: "perf", queueType: "free" } }))
  assert.deepEqual(q, { status: 503, message: "Qoder queued the request for perf (this plan's queue: free); try again in 8s", retryAfter: 8, signIn: "" })
  assert.equal(failure(500, JSON.stringify({ message: "{\"serviceAvailable\":false}" })).retryAfter, 30)
  assert.deepEqual(failure(403, JSON.stringify({ code: 112, message: "out" })), { status: 429, message: "usage limit reached: out", signIn: "" })
  assert.equal(failure(500, JSON.stringify({ code: "406", message: "no" })).status, 400)
  const lapsed = failure(401, JSON.stringify({ message: "token bad" }))
  assert.equal(lapsed.status, 401)
  assert.equal(lapsed.message, "the sign-in lapsed — sign in again (Qoder said 401: token bad)")
  assert.equal(failure(500, "your quota is gone").status, 429)
  assert.deepEqual(failure(200, ""), { status: 502, message: "Bad Gateway" })
  assert.equal(failure(418, JSON.stringify({ details: { error: { message: "inner" } }, message: "m" })).message, "m: inner")
})

test("error responses: OpenAI shape, the sign-in mark only on a 401, Retry-After", async () => {
  const a = errorResponse({ status: 401, message: "no" })
  assert.equal(a.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await a.json(), { error: { message: "no", type: "qoder_error", code: 401 } })
  assert.equal(errorResponse({ status: 401, message: "no", signIn: "expired" }).headers.get("x-magpie-sign-in"), "expired")
  const b = errorResponse({ status: 503, message: "busy", signIn: "", retryAfter: 8 })
  assert.equal(b.headers.get("x-magpie-sign-in"), null)
  assert.equal(b.headers.get("retry-after"), "8")
  assert.equal(errorResponse({ status: 502, message: "x" }).headers.get("x-magpie-sign-in"), null)
})

test("an answer is marked renewed, kept on a success, and left alone on a failure", () => {
  assert.equal(signed(new Response("x", { status: 500 }), true).headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(signed(new Response("x"), false).headers.get("x-magpie-sign-in"), "kept")
  assert.equal(signed(new Response("x", { status: 500 }), false).headers.get("x-magpie-sign-in"), null)
})

test("tool calls are lifted out of text, whole or in pieces", () => {
  assert.deepEqual(parseCall('{"name":" f ","arguments":{"a":1}}'), { name: "f", args: '{"a":1}' })
  assert.deepEqual(parseCall("<function=g><parameter=n>3</parameter><parameter=s>hi</parameter></function>"), { name: "g", args: '{"n":3,"s":"hi"}' })
  assert.equal(parseCall("nonsense"), null)
  const s = new Splitter()
  const out = [...s.feed("before <tool_"), ...s.feed('call>{"name":"f","arguments":{}}</tool'), ...s.feed("_call> after"), ...s.flush()]
  assert.deepEqual(out, [{ text: "before " }, { call: { name: "f", args: "{}" } }, { text: " after" }])
  assert.equal(s.sawTool, true)
  const bad = new Splitter()
  assert.deepEqual([...bad.feed("<tool_call>junk</tool_call>")], [{ text: "<tool_call>junk</tool_call>" }])
  assert.deepEqual([...bad.feed("<tool_call>open"), ...bad.flush()], [{ text: "<tool_call>open" }])
})

const streamOf = (res) => res.body
test("events: text, reasoning, tool calls, finish and a usage chunk of its own", async () => {
  const res = sse(
    delta({ reasoning_content: "hm" }),
    delta({ content: "hello <tool_call>{\"name\":\"f\",\"arguments\":{\"a\":1}}</tool_call>" }),
    delta({ tool_calls: [{ index: 0, id: "n1", function: { name: "g", arguments: "{\"b\"" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: ":2}" } }] }),
    delta({}, { finish_reason: "stop" }),
    { usage: { prompt_tokens: 5, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } } },
    "[DONE]",
  )
  const got = []
  for await (const e of events(streamOf(res))) got.push(e)
  assert.deepEqual(got[0], { reasoning: "hm" })
  assert.deepEqual(got[1], { text: "hello " })
  assert.equal(got[2].tool.name, "f")
  assert.match(got[2].tool.id, /^call_[0-9a-f]{32}$/)
  assert.deepEqual(got[3], { tool: { index: 1, id: "n1", name: "g", args: '{"b"' } })
  assert.deepEqual(got[4], { args: { index: 1, text: ":2}" } })
  assert.deepEqual(got[5], {
    stop: "tool_calls",
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } },
  })
})

test("events: an error envelope ends the reading with Qoder's failure", async () => {
  const res = new Response(`data: ${JSON.stringify({ statusCodeValue: 429, body: "slow down" })}\n\n`)
  const got = []
  for await (const e of events(res.body)) got.push(e)
  assert.deepEqual(got, [{ error: { status: 429, message: "usage limit reached: slow down" } }])
})

test("answer: a whole completion with tool calls and usage", async () => {
  const res = sse(delta({ content: "hi" }), delta({ tool_calls: [{ index: 0, id: "n1", function: { name: "g", arguments: "{" } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }), delta({}, { finish_reason: "stop" }), { usage: { prompt_tokens: 1, completion_tokens: 2 } })
  const j = await (await answer(res, { model: "m", stream: false })).json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.model, "m")
  assert.equal(j.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(j.choices[0].message, { role: "assistant", content: "hi", tool_calls: [{ id: "n1", type: "function", function: { name: "g", arguments: "{}" } }] })
  assert.deepEqual(j.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
})

test("answer: a stream is chunks then [DONE]; a failure first keeps its status; an empty reply is an empty completion", async () => {
  const r = await answer(sse(delta({ content: "a" }), delta({}, { finish_reason: "length" })), { model: "m", stream: true })
  assert.equal(r.headers.get("content-type"), "text/event-stream")
  const lines = (await text(r)).trim().split("\n\n")
  assert.equal(lines.at(-1), "data: [DONE]")
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)))
  assert.deepEqual(chunks.map((c) => c.choices[0].delta), [{ role: "assistant", content: "" }, { content: "a" }, {}])
  assert.equal(chunks.at(-1).choices[0].finish_reason, "length")
  const refused = await answer(new Response(`data: ${JSON.stringify({ statusCodeValue: 400, body: "bad" })}\n\n`), { stream: true })
  assert.equal(refused.status, 400)
  const empty = await (await answer(new Response(""), { stream: false })).json()
  assert.deepEqual(empty.choices[0], { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" })
})

test("usage: pools as percentages with Go-style numbers, plan and end date", () => {
  assert.equal(gfmt(1500000), "1.5e+06")
  assert.equal(gfmt(2500), "2500")
  assert.equal(gfmt(0.00001), "1e-05")
  assert.equal(when("2026-10-12T00:00:00Z"), "2026-10-12T00:00:00.000Z")
  assert.equal(when(1_760_000_000), new Date(1_760_000_000_000).toISOString())
  assert.equal(when("0"), undefined)
  const u = parseUsage({
    displayMode: "qoder",
    qoderUsage: { userType: "Pro", expires_at: 1_760_000_000, userQuota: { total: 200, used: 50, unit: "credits" }, add_on_quota: { cap: 10, remaining: 4, name: "Boost" }, dedicatedResourcePackages: [{ total: 1, used: 5 }, { total: 0, used: 0 }] },
  })
  assert.equal(u.plan, "Pro")
  assert.equal(u.until, new Date(1_760_000_000_000).toISOString())
  assert.deepEqual(u.windows, [
    { name: "Credits", used: 25, display: "50 / 200 credits" },
    { name: "Boost", used: 60, display: "6 / 10 credits" },
    { name: "Dedicated credits", used: 100, display: "5 / 1 credits" },
  ])
  assert.deepEqual(parseUsage({ displayMode: "enterprise" }), { plan: "Enterprise" })
  assert.deepEqual(parseUsage({ displayMode: "qoder", qoderUsage: [] }), { error: "Qoder: missing quota data" })
})

test("campaign pages: the account host's list and claims only; a VPC account gets the instance's host", () => {
  const cn = SITES["qoder-cn"]
  const vpc = vpcSite(cn, "acme")
  const list = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns"
  assert.equal(campaignPage(cn, list), true)
  assert.equal(campaignPage(cn, list + "/abc/claim"), true)
  assert.equal(campaignPage(cn, list + "/abc/other"), false)
  assert.equal(campaignPage(cn, "https://evil.example/sash/api/v1/me/campaigns"), false)
  assert.equal(campaignPage(cn, "not a url"), false)
  assert.equal(campaignTarget(cn, cn, list), list)
  assert.equal(campaignTarget(cn, vpc, list), "https://acme-openapi.vpc.qoder.com.cn/sash/api/v1/me/campaigns")
  assert.equal(campaignTarget(cn, vpc, "https://openapi.qoder.com.cn/other"), null)
})

test("the device identity helper is found by QODER_RUNTIME_INFO, and its absence is said", async () => {
  assert.match(await campaignRuntime({ env: { QODER_RUNTIME_INFO: "/x/runtime-info" } }), /runtime-info$/)
  await assert.rejects(campaignRuntime({ env: { QODER_CONFIG_DIR: "/nonexistent-qoder" }, home: "/nonexistent", platform: "linux", opt: "/nonexistent-opt" }), /device identity runtime not found/)
})

test("auth.refresh: the job token pair is spent once, and what it gave is remembered", async () => {
  const calls = fake(() => ({ body: { token: "job2", refresh_token: "r2", expires_in: 3600e3 } }))
  const h = await QoderAuthPlugin({ client: {} })
  const old = { ...account, expires: Date.now() + 1000 }
  const got = await h.auth.refresh(old)
  assert.deepEqual(Object.keys(got).sort(), ["access", "expires", "refresh"])
  assert.equal(got.access, "job2")
  assert.equal(calls[0].url, "https://openapi.qoder.sh/api/v1/jobToken/refresh")
  assert.deepEqual(JSON.parse(calls[0].init.body), { refresh_token: "r1" })
  // handed the stale account again before magpie saved it: no second spend
  const again = await h.auth.refresh(old)
  assert.equal(again.access, "job2")
  assert.equal(calls.length, 1)
})

test("auth.refresh: a refused refresh token marks the account expired; none given does nothing", async () => {
  fake(() => ({ status: 401, body: {} }))
  const h = await QoderAuthPlugin({ client: {} })
  await assert.rejects(h.auth.refresh({ ...account, expires: 0 }), (e) => e.signIn === "expired" && /sign-in has expired/.test(e.message))
  assert.equal(await h.auth.refresh({ type: "api" }), undefined)
  assert.equal(await h.auth.refresh({ ...account, refresh: " " }), undefined)
})

test("changed gives only the token fields that differ", () => {
  assert.deepEqual(changed({ access: "a", refresh: "r", expires: 1, uid: "u" }, { access: "b", refresh: "r", expires: 2, uid: "v" }), { access: "b", expires: 2 })
})

// the models listing and a chat on it, end to end through the loader's fetch
const listing = { chat: [{ key: "perf", enable: true, source: "qoder", display_name: "Performance", max_input_tokens: 180_000, price_factor: 1.1 }] }
test("a chat completion is written as Qoder's request, signed, and answered in OpenAI's shape", async () => {
  const saved = []
  const calls = fake((url) => {
    if (url.includes("/model/list")) return { body: listing }
    if (url.includes("agent_chat_generation")) return sse(delta({ content: "pong" }), delta({}, { finish_reason: "stop" }), { usage: { prompt_tokens: 3, completion_tokens: 1 } })
    throw new Error("unexpected " + url)
  })
  const h = await QoderAuthPlugin({ client: { auth: { set: async (a) => saved.push(a) } } })
  const { fetch: chatFetch, baseURL } = await h.auth.loader(async () => account)
  assert.equal(baseURL, "https://api3.qoder.sh")
  const res = await chatFetch("https://api3.qoder.sh/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "perf", messages: [{ role: "user", content: "ping" }] }) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const j = await res.json()
  assert.equal(j.choices[0].message.content, "pong")
  assert.equal(j.usage.total_tokens, 4)
  const chat = calls.find((c) => c.url.includes("agent_chat_generation"))
  assert.equal(chat.init.headers["X-Model-Key"], "perf")
  assert.equal(chat.init.headers["X-Model-Source"], "qoder")
  assert.equal(chat.init.headers.Accept, "text/event-stream")
  const sent = JSON.parse(decodeBody(chat.init.body))
  assert.equal(sent.model_config.key, "perf")
  assert.equal(sent.session_type, "app")
  assert.equal(sent.messages.at(-1).content[0].text, "ping")
  assert.deepEqual(saved, []) // the token was fresh: nothing renewed, nothing saved
})

test("an unknown model is a 400 after the list was asked again; a non-chat path a 404; bad JSON a 400", async () => {
  const calls = fake(() => ({ body: listing }))
  const h = await QoderAuthPlugin({ client: {} })
  const { fetch: chatFetch } = await h.auth.loader(async () => account)
  const res = await chatFetch("https://api3.qoder.sh/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "nope", messages: [] }) })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /unknown or disabled model "nope"/)
  assert.equal(calls.length, 2)
  assert.equal((await chatFetch("https://api3.qoder.sh/v1/embeddings", { method: "POST", body: "{}" })).status, 404)
  assert.equal((await chatFetch("https://api3.qoder.sh/v1/chat/completions", { method: "POST", body: "nope" })).status, 400)
})

test("a near-expired job token is renewed and saved before the request, and the answer says renewed", async () => {
  const saved = []
  fake((url) => {
    if (url.includes("jobToken/refresh")) return { body: { token: "job2", refresh_token: "r2", expires_in: 3600e3 } }
    if (url.includes("/model/list")) return { body: listing }
    return sse(delta({ content: "ok" }), delta({}, { finish_reason: "stop" }))
  })
  const h = await QoderAuthPlugin({ client: { auth: { set: async (a) => saved.push(a) } } })
  const { fetch: chatFetch } = await h.auth.loader(async () => ({ ...account, expires: Date.now() + 1000 }))
  const res = await chatFetch("https://api3.qoder.sh/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "perf", messages: [] }) })
  assert.equal(res.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(saved.length, 1)
  assert.deepEqual([saved[0].path, saved[0].body.access, saved[0].body.refresh], [{ id: "qoder" }, "job2", "r2"])
})

test("usage: a refused device token is rotated once and asked again", async () => {
  const saved = []
  const calls = fake((url, init) => {
    if (url.includes("deviceToken/refresh")) return { body: { token: "dev2", refresh_token: "dr2" } }
    if (init.headers.Authorization === "Bearer dev") return { status: 401, body: {} }
    return { body: { displayMode: "qoder", qoderUsage: { userType: "Pro", userQuota: { total: 10, used: 5 } } } }
  })
  const h = await QoderAuthPlugin({ client: { auth: { set: async (a) => saved.push(a) } } })
  const u = await h.auth.usage(async () => account)
  assert.equal(u.plan, "Pro")
  assert.equal(u.signIn, "kept")
  assert.deepEqual(u.windows, [{ name: "Credits", used: 50, display: "5 / 10 credits" }])
  assert.equal(calls.length, 3)
  assert.equal(calls[0].init.headers["Cosy-ClientType"], "10")
  assert.deepEqual([saved[0].body.deviceToken, saved[0].body.deviceRefresh], ["dev2", "dr2"])
})

test("usage: not signed in is an error that leaves the sign-in alone", async () => {
  const h = await QoderAuthPlugin({ client: {} })
  assert.deepEqual(await h.auth.usage(async () => undefined), { error: "Qoder: not signed in", signIn: "kept" })
})

test("sign-in: the device flow polls, trades for a job token and reads the profile", async () => {
  const calls = fake((url) => {
    if (url.includes("deviceToken/poll")) return { body: { token: "dt", refresh_token: "dr", user_id: "u9", user_name: "N" } }
    if (url.includes("me/jobToken")) return { body: { token: "jt", refresh_token: "jr", expires_in: 1000 } }
    if (url.includes("userinfo")) return { body: { email: "e@x.y", name: "Name" } }
    throw new Error(url)
  })
  const h = await QoderAuthPlugin({ client: {} })
  const flow = await h.auth.methods[0].authorize()
  const u = new URL(flow.url)
  assert.equal(u.origin + u.pathname, "https://qoder.com/device/selectAccounts")
  assert.equal(u.searchParams.get("challenge_method"), "S256")
  assert.equal(u.searchParams.get("redirect_uri"), "qoder-app://")
  const r = await flow.callback()
  assert.deepEqual([r.type, r.access, r.refresh, r.accountId, r.uid, r.email, r.name, r.deviceToken, r.deviceRefresh], ["success", "jt", "jr", "e@x.y", "u9", "e@x.y", "Name", "dt", "dr"])
  assert.equal(r.vpc, undefined)
  assert.equal(new URL(calls[0].url).searchParams.get("verifier").length, 86) // 64 bytes, base64url
})

test("sign-in on Qoder CN: a refused job token falls back to chatting on the device token", async () => {
  fake((url) => {
    if (url.includes("deviceToken/poll")) return { body: { token: "dt", refresh_token: "dr", user_id: "u9", expires_in: 100 } }
    if (url.includes("me/jobToken")) return { status: 403, body: {} }
    return { status: 500, body: {} }
  })
  const h = await QoderCNAuthPlugin({ client: {} })
  const r = await (await h.auth.methods[0].authorize()).callback()
  assert.deepEqual([r.access, r.refresh, r.deviceChat, r.accountId], ["dt", "dr", true, "u9"])
  assert.ok(r.expires > Date.now() + 99_000 && r.expires < Date.now() + 101_000)
})

test("the enterprise VPC method validates the instance and signs in on its hosts", async () => {
  const h = await QoderCNAuthPlugin({ client: {} })
  const m = h.auth.methods[1]
  assert.equal(m.prompts[0].validate("acme"), undefined)
  assert.match(m.prompts[0].validate("http://x"), /Not a VPC instance/)
  assert.throws(() => m.authorize({ vpc: "bad host" }), /Not a VPC instance/)
  const flow = await m.authorize({ vpc: "acme" })
  assert.equal(new URL(flow.url).origin, "https://acme.vpc.qoder.com.cn")
  fake((url) => {
    if (url.includes("deviceToken/poll")) return { body: { token: "dt", refresh_token: "dr" } }
    if (url.includes("me/jobToken")) return { body: { token: "jt", refresh_token: "jr" } }
    return { body: { id: 42, email: "e@x.y" } }
  })
  const r = await flow.callback()
  assert.deepEqual([r.vpc, r.uid, r.accountId], ["acme", "42", "e@x.y (acme)"])
})

test("config gives the built-in models without overriding the user's; models hook lists the account's", async () => {
  const h = await QoderCNAuthPlugin({ client: {} })
  const config = { provider: { "qoder-cn": { models: { lite: { name: "Mine" } } } } }
  await h.config(config)
  const p = config.provider["qoder-cn"]
  assert.deepEqual(Object.keys(p.models), ["ultimate", "performance", "efficient", "lite"])
  assert.equal(p.models.lite.name, "Mine")
  assert.deepEqual(p.models.efficient.limit, { context: 200_000, output: 0 })
  assert.equal(p.models.ultimate.variants.max.reasoningEffort, "max")

  fake(() => ({ body: listing }))
  const own = await h.provider.models({ models: { fallback: 1 } }, { auth: { ...account, vpc: undefined } })
  assert.deepEqual(Object.keys(own), ["perf"])
  assert.equal(own.perf.rate, 1.1)
  assert.equal(own.perf.api.url, "https://gateway.qoder.com.cn")
  assert.deepEqual(await h.provider.models({ models: { fallback: 1 } }, {}), { fallback: 1 })
})
