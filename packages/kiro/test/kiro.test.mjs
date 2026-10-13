import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KiroAuthPlugin } from "../src/index.mjs"
import { buildKiro, thinking, imageFormat } from "../src/request.mjs"
import { toolID, toolName, toolNames } from "../src/tools.mjs"
import { frames, frameHeaders } from "../src/eventstream.mjs"
import { events, stopReason, settleUsage } from "../src/events.mjs"
import { reply } from "../src/response.mjs"
import { failure } from "../src/refusals.mjs"
import { usageOf, planName, goG } from "../src/usage.mjs"
import { regionOf } from "../src/api.mjs"
import { account, fresh, refresh } from "../src/session.mjs"
import { readIDE, saveBack } from "../src/stores.mjs"
import { generate } from "../src/chat.mjs"
import { ThinkParser } from "../src/think.mjs"
import { windows } from "../src/models.mjs"

// ---- helpers ----

// an AWS event-stream message with string headers (type 7) and a JSON payload
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k), val = enc.encode(v)
    hs.push(Uint8Array.of(name.length), name, Uint8Array.of(7, val.length >> 8, val.length & 255), val)
  }
  const h = Buffer.concat(hs)
  const p = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))
  const total = 16 + h.length + p.length
  const out = Buffer.alloc(total)
  out.writeUInt32BE(total, 0)
  out.writeUInt32BE(h.length, 4)
  h.copy(out, 12)
  p.copy(out, 12 + h.length)
  return out
}
const ev = (type, payload) => frame({ ":message-type": "event", ":event-type": type }, payload)
const streamOf = (...bufs) => new Response(Buffer.concat(bufs)).body
const collect = async (it) => {
  const out = []
  for await (const e of it) out.push(e)
  return out
}
const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})

// ---- the request ----

test("buildKiro: a plain turn, the system prompt at the head, thinking announced", () => {
  const body = JSON.parse(buildKiro({ system: "Be brief.", messages: [{ role: "user", content: "hi" }] }, "auto", "arn:p", 20000))
  const cur = body.conversationState.currentMessage.userInputMessage
  assert.equal(cur.content, "<thinking_mode>enabled</thinking_mode><max_thinking_length>20000</max_thinking_length>\nBe brief.\n\nhi")
  assert.equal(cur.modelId, "auto")
  assert.equal(cur.origin, "KIRO_CLI")
  assert.equal(body.profileArn, "arn:p")
  assert.equal(body.agentMode, "vibe")
  assert.equal(body.conversationState.history, undefined)
  assert.equal(cur.images, undefined)
})

test("buildKiro: consecutive turns merge, history is the rest, the last is the user's", () => {
  const body = JSON.parse(
    buildKiro({ messages: [
      { role: "user", content: "a" }, { role: "user", content: "b" },
      { role: "assistant", content: [{ type: "text", text: "x" }] }, { role: "assistant", content: "y" },
    ] }, "m", "", 0),
  )
  const s = body.conversationState
  assert.equal(s.history.length, 2)
  assert.equal(s.history[0].userInputMessage.content, "a\n\nb")
  assert.equal(s.history[1].assistantResponseMessage.content, "x\n\ny")
  assert.equal(s.currentMessage.userInputMessage.content, "Please proceed with the task.")
  assert.equal(body.profileArn, undefined)
})

test("buildKiro: tool calls are paired with results, an unanswered call is an error result", () => {
  const body = JSON.parse(
    buildKiro({ messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: { a: 1 } }, { type: "tool_use", id: "c2", name: "ls", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }, { type: "tool_result", tool_use_id: "stray", content: "no" }] },
    ], tools: [{ name: "read", description: "Reads", input_schema: { type: "object", properties: { a: {} } } }] }, "m", "", 0),
  )
  const cur = body.conversationState.currentMessage.userInputMessage
  assert.deepEqual(cur.userInputMessageContext.toolResults, [
    { toolUseId: "c1", status: "success", content: [{ text: "ok" }] },
    { toolUseId: "c2", status: "error", content: [{ text: "Tool use was interrupted and did not produce a result." }] },
  ])
  // "ls" is no longer offered but the history names it, so it is declared bare
  const tools = cur.userInputMessageContext.tools.map((t) => [t.toolSpecification.name, t.toolSpecification.description])
  assert.deepEqual(tools, [["read", "Reads"], ["ls", "Tool"]])
})

test("buildKiro: only the latest images are sent, as Kiro's bytes", () => {
  const img = (data, t = "image/jpg") => ({ type: "image", source: { type: "base64", media_type: t, data } })
  const body = JSON.parse(buildKiro({ messages: [
    { role: "user", content: [{ type: "text", text: "1" }, img("AAA")] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "2" }, img("BBB", "image/webp"), { type: "image", source: { type: "url", url: "u" } }] },
  ] }, "m", "", 0))
  assert.equal(body.conversationState.history[0].userInputMessage.images, undefined)
  assert.deepEqual(body.conversationState.currentMessage.userInputMessage.images, [{ format: "webp", source: { bytes: "BBB" } }])
  assert.equal(imageFormat("image/jpg"), "jpeg")
  assert.equal(imageFormat(undefined), "png")
})

test("buildKiro: a conversation that opens with a stray tool result drops it", () => {
  const body = JSON.parse(buildKiro({ messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
    { role: "user", content: "real" },
  ] }, "m", "", 0))
  const cur = body.conversationState.currentMessage.userInputMessage
  assert.equal(cur.content, "real")
  assert.equal(cur.userInputMessageContext, undefined)
})

test("tool names and ids are made acceptable, stably, and mapped back", () => {
  const long = "mcp__plugin_" + "x".repeat(80) + "__tool"
  const n = toolName(long)
  assert.ok(n.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(n))
  assert.equal(toolName(long), n)
  assert.equal(toolName("read_file"), "read_file")
  assert.equal(toolID("call_1"), "call_1")
  assert.match(toolID("bad id!"), /^t_[A-Za-z0-9_-]{32}$/)
  assert.deepEqual([...toolNames({ tools: [{ name: long }, { name: "ok" }], messages: [] })], [[n, long]])
})

test("thinking: only for models that think, the budget from effort or the request", () => {
  assert.equal(thinking({}, "claude-sonnet"), 0)
  assert.equal(thinking({ thinking: { type: "enabled", budget_tokens: 7000 } }, "claude-sonnet"), 7000)
  assert.equal(thinking({ thinking: { type: "adaptive" } }, "auto"), 20000)
  assert.equal(thinking({ output_config: { effort: "high" } }, "claude-x"), 30000)
  assert.equal(thinking({ output_config: { effort: "low" } }, "claude-x"), 0)
  assert.equal(thinking({ thinking: { type: "enabled" } }, "qwen3"), 0)
})

// ---- the reply ----

test("frames: reads messages however the bytes are cut, and rejects a broken stream", async () => {
  const bytes = Buffer.concat([ev("assistantResponseEvent", { content: "hi" }), ev("metadataEvent", {})])
  const pieces = [bytes.subarray(0, 7), bytes.subarray(7, 40), bytes.subarray(40)]
  const body = new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new Uint8Array(p)); c.close() } })
  const got = await collect(frames(body))
  assert.deepEqual(got.map((f) => f.headers[":event-type"]), ["assistantResponseEvent", "metadataEvent"])
  assert.equal(JSON.parse(new TextDecoder().decode(got[0].payload)).content, "hi")
  await assert.rejects(collect(frames(streamOf(bytes.subarray(0, 20)))), /unexpected EOF/)
  await assert.rejects(collect(frames(streamOf(Buffer.alloc(16)))), /malformed/)
  assert.deepEqual(frameHeaders(new Uint8Array(0)), {})
})

test("events: text, a tool call with its arguments, usage and the stop reason", async () => {
  windows.set("m", 1000)
  const out = await collect(events(streamOf(
    ev("assistantResponseEvent", { content: "Hello" }),
    ev("toolUseEvent", { toolUseId: "t1", name: "read", input: '{"a":' }),
    ev("toolUseEvent", { toolUseId: "t1", input: "1}" }),
    ev("toolUseEvent", { toolUseId: "t1", input: {} }),
    ev("contextUsageEvent", { contextUsagePercentage: 10 }),
  ), "m", 0))
  assert.deepEqual(out.map((e) => e.kind), ["text", "toolStart", "toolArgs", "toolArgs", "stop"])
  const stop = out.at(-1)
  assert.equal(stop.reason, "tool_use")
  assert.equal(stop.usage.input, 100) // 10% of the 1000 window
  assert.equal(stop.usage.output, Math.floor((5 + 5 + 1 + 2 + 3) / 4))
})

test("events: an error in the stream is an error event, a throttle reads as rate limited", async () => {
  const out = await collect(events(streamOf(frame({ ":message-type": "exception", ":exception-type": "throttlingException" }, { message: "slow" })), "m", 0))
  assert.deepEqual(out, [{ kind: "error", text: "rate limited: slow" }])
})

test("settleUsage and stopReason", () => {
  assert.deepEqual(settleUsage({ input: 0, output: 0 }, 50, 200, 9), { input: 100, output: 3 })
  assert.deepEqual(settleUsage({ input: 7, output: 2 }, 50, 200, 9), { input: 7, output: 2 })
  assert.equal(stopReason(0, "MAX_TOKENS"), "max_tokens")
  assert.equal(stopReason(0, "content_filtered"), "refusal")
  assert.equal(stopReason(2, "max_tokens"), "tool_use")
  assert.equal(stopReason(0, ""), "end_turn")
})

test("ThinkParser: thinking then text, with a tag split across pieces", () => {
  const p = new ThinkParser()
  const out = [...p.feed("<thin"), ...p.feed("king>\nhmm</thin"), ...p.feed("king>\nanswer"), ...p.end()]
  assert.deepEqual(out, [{ kind: "think", text: "hmm" }, { kind: "text", text: "answer" }])
  assert.deepEqual([...new ThinkParser().feed("plain")], [{ kind: "text", text: "plain" }])
})

test("reply: one message gathers blocks and restores the caller's tool name", async () => {
  async function* it() {
    yield { kind: "think", text: "t" }
    yield { kind: "sig", text: "s" }
    yield { kind: "text", text: "a" }
    yield { kind: "text", text: "b" }
    yield { kind: "toolStart", id: "t1", name: "short_abc" }
    yield { kind: "toolArgs", text: '{"x":' }
    yield { kind: "toolArgs", text: "1}" }
    yield { kind: "stop", reason: "tool_use", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }
  }
  const res = await reply(it(), "m", false, new Map([["short_abc", "long name"]]))
  const m = await res.json()
  assert.deepEqual(m.content, [
    { type: "thinking", thinking: "t", signature: "s" },
    { type: "text", text: "ab" },
    { type: "tool_use", id: "t1", name: "long name", input: { x: 1 } },
  ])
  assert.equal(m.stop_reason, "tool_use")
  assert.deepEqual(m.usage, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
})

test("reply: an error before any answer is a status (429 for a quota), else 502", async () => {
  async function* quota() { yield { kind: "error", text: "monthly quota exceeded" } }
  async function* other() { yield { kind: "error", text: "boom" } }
  for (const [g, status] of [[quota, 429], [other, 502]]) {
    for (const stream of [false, true]) {
      const res = await reply(g(), "m", stream)
      assert.equal(res.status, status)
      assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
    }
  }
})

test("reply: a stream is Messages' events in order", async () => {
  async function* it() {
    yield { kind: "text", text: "hi" }
    yield { kind: "toolStart", id: "t1", name: "n" }
    yield { kind: "toolArgs", text: "{}" }
    yield { kind: "stop", reason: "tool_use", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
  }
  const res = await reply(it(), "m", true)
  const types = [...(await res.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start",
    "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
})

test("failure: Kiro's error words become a status and a message", () => {
  assert.deepEqual(failure(400, JSON.stringify({ message: "Input is too long", reason: "X" })),
    { status: 400, message: "input is too long for the model's context: Input is too long (X)" })
  assert.equal(failure(500, JSON.stringify({ message: "x", reason: "MONTHLY_REQUEST_COUNT" })).status, 429)
  assert.equal(failure(500, "INSUFFICIENT_MODEL_CAPACITY").status, 503)
  assert.deepEqual(failure(502, ""), { status: 502, message: "Bad Gateway" })
})

// ---- usage ----

test("usageOf: credits, a running free trial, the plan and the email", () => {
  const u = usageOf({
    subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
    userInfo: { email: "a@b.c" },
    nextDateReset: 1800000000,
    usageBreakdownList: [{
      displayNamePlural: "Credits", currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 1000,
      freeTrialInfo: { freeTrialStatus: "active", currentUsageWithPrecision: 5, usageLimitWithPrecision: 500, freeTrialExpiry: 1700000000 },
    }],
  })
  assert.equal(u.plan, "Kiro Pro")
  assert.equal(u.user, "a@b.c")
  assert.deepEqual(u.windows[0], { name: "Free trial", used: 1, resetsAt: new Date(1700000000e3).toISOString(), display: "5 / 500" })
  assert.deepEqual(u.windows[1], { name: "Credits", used: 1.25, resetsAt: new Date(1800000000e3).toISOString(), display: "12.5 / 1000", span: 2592000 })
  assert.deepEqual(usageOf({ usageBreakdownList: [{ usageLimitWithPrecision: 0 }] }).windows, [])
  assert.equal(planName("kiro free"), "Kiro Free")
  assert.equal(goG(1e6), "1e+06")
  assert.equal(goG(1000), "1000")
})

test("regionOf: the profile's region, else the nearer of Kiro's two", () => {
  assert.equal(regionOf("arn:aws:codewhisperer:eu-central-1:1:profile/x", "us-east-1"), "eu-central-1")
  assert.equal(regionOf("", "eu-west-1"), "eu-central-1")
  assert.equal(regionOf(undefined, "ap-south-1"), "us-east-1")
})

// ---- tokens ----

test("fresh: keys never expire, an unknown end is fresh, a near end is not", () => {
  assert.ok(fresh({ method: "apikey", expires: 1 }))
  assert.ok(fresh({ expires: 0 }))
  assert.ok(fresh({ expires: Date.now() + 3600e3 }))
  assert.ok(!fresh({ expires: Date.now() + 60e3 }))
  assert.ok(!fresh({ expires: Date.now() + 5 * 60e3 }, 10 * 60e3))
})

// fetch answering each call from a queue, remembering it
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body })
    const r = replies.shift()
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  return calls
}

test("refresh: a social sign-in goes to Kiro's auth service and keeps the new refresh token", async () => {
  const calls = fake({ body: { accessToken: "new", refreshToken: "r2", expiresIn: 100, profileArn: "arn:p" } })
  const before = Date.now()
  const n = await refresh({ method: "social", region: "eu-central-1", access: "old", refresh: "r1", expires: 1 })
  assert.equal(calls[0].url, "https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken")
  assert.deepEqual(JSON.parse(calls[0].body), { refreshToken: "r1" })
  assert.equal(calls[0].init.headers["User-Agent"], "Kiro-Desktop/0.2.13 (darwin; arm64)")
  assert.equal(n.access, "new")
  assert.equal(n.refresh, "r2")
  assert.equal(n.profile, "arn:p")
  assert.ok(n.expires >= before + 100e3 && n.expires < before + 110e3)
})

test("refresh: AWS (idc) and a company's identity provider each use their own endpoint", async () => {
  let calls = fake({ body: { accessToken: "a", expiresIn: 0 } })
  const n = await refresh({ method: "idc", region: "us-east-1", clientId: "ci", clientSecret: "cs", access: "o", refresh: "r" })
  assert.equal(calls[0].url, "https://oidc.us-east-1.amazonaws.com/token")
  assert.deepEqual(JSON.parse(calls[0].body), { clientId: "ci", clientSecret: "cs", refreshToken: "r", grantType: "refresh_token" })
  assert.equal(n.refresh, "r") // none given back: the old one stays
  assert.ok(n.expires > Date.now() + 3500e3) // expiresIn 0: an hour
  calls = fake({ body: { access_token: "b", refresh_token: "r9", expires_in: 60 } })
  const e = await refresh({ method: "external-idp", tokenURL: "https://idp/v1/token", clientId: "cid", access: "o", refresh: "r" })
  assert.equal(calls[0].url, "https://idp/v1/token")
  assert.equal(calls[0].body, "grant_type=refresh_token&client_id=cid&refresh_token=r")
  assert.equal(e.refresh, "r9")
})

test("refresh: a refusal is a sign-in that is gone, other failures are not", async () => {
  fake({ status: 401, body: {} })
  await assert.rejects(refresh({ method: "social", access: "o", refresh: "r" }), (e) => e.gone === true && /sign in again with `kiro-cli login`/.test(e.message))
  fake({ status: 503, body: {} })
  await assert.rejects(refresh({ method: "social", access: "o", refresh: "r" }), (e) => !e.gone && e.message === "refreshing Kiro's sign-in: 503 Service Unavailable")
  await assert.rejects(refresh({ method: "social", access: "o", refresh: "" }), (e) => e.gone)
  await assert.rejects(refresh({ method: "mystery", access: "o", refresh: "r" }), (e) => e.gone && e.message === "Kiro's sign-in has expired")
})

test("account: a fresh own token is used as is, an expiring one is refreshed once and saved", async () => {
  const saved = []
  const client = { auth: { set: async (x) => saved.push(x) } }
  const creds = account(client)
  const good = { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 3600e3, method: "social", region: "us-east-1", profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/x" }
  assert.deepEqual(await creds(good), { token: "A", tokenType: "", profile: good.profileArn, region: "eu-central-1" })
  assert.equal(saved.length, 0)

  const calls = fake({ body: { accessToken: "B", refreshToken: "R2", expiresIn: 3600 } })
  const stale = { ...good, access: "A2", expires: Date.now() + 30e3 }
  assert.equal((await creds(stale)).token, "B")
  assert.equal(calls.length, 1)
  assert.equal(saved[0].path.id, "kiro")
  assert.equal(saved[0].body.access, "B")
  assert.equal(saved[0].body.refresh, "R2")
  // the store still says the old token: the newer one is used rather than spending R again
  assert.equal((await creds(stale)).token, "B")
  assert.equal(calls.length, 1)
})

test("account: an API key names its profile, once; no sign-in is gone", async () => {
  const creds = account({})
  const calls = fake({ body: { profile: { arn: "arn:aws:codewhisperer:us-east-1:1:profile/k" } } })
  const a = await creds({ type: "api", key: "ksk_1" })
  assert.equal(a.tokenType, "API_KEY")
  assert.equal(a.profile, "arn:aws:codewhisperer:us-east-1:1:profile/k")
  assert.equal(calls[0].init.headers["X-Amz-Target"], "AmazonCodeWhispererService.GetProfile")
  assert.equal(calls[0].init.headers.tokentype, "API_KEY")
  await creds({ type: "api", key: "ksk_1" })
  assert.equal(calls.length, 1)
  await assert.rejects(creds({ type: "oauth" }), (e) => e.gone && /sign-in is gone/.test(e.message))
  await assert.rejects(creds({ type: "api", key: "ksk_1" }, true), (e) => e.gone && /turned down the API key/.test(e.message))
})

test("renew: gives only what changed, and not for kiro-cli's or the IDE's sign-in", async () => {
  const creds = account({})
  assert.equal(await creds.renew({ type: "oauth", source: "kiro-ide", access: "a", refresh: "r" }), undefined)
  fake({ body: { accessToken: "B", refreshToken: "r", expiresIn: 3600 } })
  const auth = { type: "oauth", access: "A", refresh: "r", expires: Date.now() + 60e3, method: "social", profileArn: "arn:p" }
  const out = await creds.renew(auth)
  assert.deepEqual(Object.keys(out).sort(), ["access", "expires"])
  assert.equal(out.access, "B")
})

// ---- the IDE's own sign-in, in a fake home ----

test("readIDE reads the IDE's token and its client registration; saveBack writes a refreshed token back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-home-"))
  const cache = join(dir, ".aws", "sso", "cache")
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, "kiro-auth-token.json"), JSON.stringify({ accessToken: "A", refreshToken: "R", expiresAt: "2030-01-01T00:00:00Z",
    region: "eu-central-1", authMethod: "IdC", provider: "BuilderId", clientIdHash: "h" }))
  writeFileSync(join(cache, "h.json"), JSON.stringify({ clientId: "ci", clientSecret: "cs" }))
  const oldHome = process.env.HOME
  process.env.HOME = dir
  try {
    const c = await readIDE()
    assert.equal(c.access, "A")
    assert.equal(c.method, "idc")
    assert.equal(c.builderID, true)
    assert.equal(c.clientId, "ci")
    assert.equal(c.region, "eu-central-1")
    assert.equal(c.expires, Date.parse("2030-01-01T00:00:00Z"))
    await saveBack({ ...c, access: "B", refresh: "R2", expires: Date.parse("2031-01-01T00:00:00Z") })
    const t = JSON.parse(readFileSync(join(cache, "kiro-auth-token.json"), "utf8"))
    assert.equal(t.accessToken, "B")
    assert.equal(t.refreshToken, "R2")
    assert.equal(t.expiresAt, "2031-01-01T00:00:00.000Z")
    assert.equal(t.clientIdHash, "h") // the rest is kept
    // without a client registration it is a social sign-in
    writeFileSync(join(cache, "kiro-auth-token.json"), JSON.stringify({ accessToken: "S", authMethod: "social" }))
    assert.equal((await readIDE()).method, "social")
    writeFileSync(join(cache, "kiro-auth-token.json"), "not json")
    assert.equal(await readIDE(), null)
  } finally {
    process.env.HOME = oldHome
  }
})

// ---- the whole call ----

test("generate: a 403 is retried once with a refreshed sign-in, and the answer marks the sign-in kept", async () => {
  const seen = []
  let n = 0
  const creds = async (_auth, stale) => {
    seen.push(!!stale)
    return { token: "T" + ++n, tokenType: "", profile: "arn:p", region: "us-east-1" }
  }
  const text = Buffer.concat([ev("assistantResponseEvent", { content: "yo" }), ev("metadataEvent", { stopReason: "end_turn", tokenUsage: { inputTokens: 3, outputTokens: 1 } })])
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return calls.length === 1 ? new Response("{}", { status: 403 }) : new Response(text, { status: 200 })
  }
  const res = await generate(creds, {}, { model: "claude-x", messages: [{ role: "user", content: "hi" }] })
  assert.deepEqual(seen, [false, true])
  assert.equal(calls[0].url, "https://runtime.us-east-1.kiro.dev/generateAssistantResponse")
  assert.equal(calls[0].headers.Authorization, "Bearer T1")
  assert.equal(calls[1].headers.Authorization, "Bearer T2")
  assert.equal(calls[1].headers.Accept, "application/vnd.amazon.eventstream")
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const m = await res.json()
  assert.equal(m.content[0].text, "yo")
  assert.equal(m.usage.input_tokens, 3)
})

test("generate: no credentials is a 401, Kiro's refusal keeps its words, a network failure is a 502", async () => {
  let res = await generate(async () => { throw new Error("no sign-in") }, {}, { messages: [] })
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { type: "error", error: { type: "authentication_error", message: "no sign-in" } })
  const creds = async () => ({ token: "T", profile: "p", region: "us-east-1" })
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Too many", reason: "MONTHLY_REQUEST_COUNT" }), { status: 429 })
  res = await generate(creds, {}, { messages: [{ role: "user", content: "x" }] })
  assert.equal(res.status, 429)
  assert.match((await res.json()).error.message, /^usage limit reached: Too many/)
  globalThis.fetch = async () => { throw new Error("offline") }
  res = await generate(creds, {}, { messages: [{ role: "user", content: "x" }] })
  assert.equal(res.status, 502)
})

test("the plugin's fetch only answers Messages, and its models are declared", async () => {
  const h = await KiroAuthPlugin({ client: {} })
  const { fetch: kiroFetch, baseURL } = await h.auth.loader(async () => ({ type: "api", key: "ksk_x" }))
  assert.equal(baseURL, "https://runtime.us-east-1.kiro.dev")
  const notMessages = await kiroFetch("https://runtime.us-east-1.kiro.dev/v1/models", {})
  assert.equal(notMessages.status, 404)
  const notJson = await kiroFetch("https://x/v1/messages", { body: "nope" })
  assert.equal(notJson.status, 400)
  assert.deepEqual(await h.auth.loader(async () => null), {})
  const config = {}
  await h.config(config)
  assert.equal(config.provider.kiro.models.auto.reasoning, true)
  assert.equal(config.provider.kiro.models.auto.variants.high.thinking.budgetTokens, 30000)
  assert.deepEqual(await h.auth.usage(async () => null), { error: "not signed in", signIn: "kept" })
})
