import test from "node:test"
import assert from "node:assert/strict"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from "../src/index.mjs"
import { SITES } from "../src/sites.mjs"
import { meter, postMeter } from "../src/api.mjs"
import { checkinOf } from "../src/checkin.mjs"
import { configModels, modelOf } from "../src/models.mjs"
import { attend, messagesUrl } from "../src/request.mjs"

// a fetch that answers from a queue and remembers what it was asked
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r = replies.shift()
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
  return calls
}
const account = { type: "oauth", access: "tok", uid: "u1", refresh: "r", expires: Date.now() + 3600e3 }

test("both builds are plugins with a check-in", async () => {
  for (const P of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    const h = await P({ client: {} })
    assert.equal(typeof h.auth.checkin, "function")
    assert.equal(typeof h.auth.usage, "function")
  }
})

test("check-in: a first press is claimed, with credit and streak", async () => {
  const calls = fake({ status: 200, body: { code: 0, data: { credit: 100, streak_days: "15" } } })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "claimed", credit: 100, streak: 15 })
  assert.equal(calls[0].url, "https://copilot.tencent.com/billing/meter/daily-checkin")
  assert.equal(calls[0].headers.Authorization, "Bearer tok")
  assert.equal(calls[0].headers["X-User-Id"], "u1")
})

test("check-in: code 10001 is done today, and the streak is asked for", async () => {
  const calls = fake({ status: 400, body: { code: 10001 } }, { status: 200, body: { code: 0, data: { streak_days: 15, today_credit: 100 } } })
  assert.deepEqual(await checkinOf(SITES["workbuddy-ai"], account), { outcome: "done", credit: 100, streak: 15 })
  assert.equal(calls[1].url, "https://www.workbuddy.ai/billing/meter/checkin-activity-status")
})

test("check-in: done stands when the streak can't be read", async () => {
  fake({ status: 400, body: { code: 10001 } }, { status: 500, body: {} })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "done", credit: 0, streak: 0 })
})

test("check-in: a captcha and a failure say what WorkBuddy said", async () => {
  fake({ status: 400, body: { code: 20001, msg: "请完成验证码" } })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "captcha", message: "请完成验证码" })
  fake({ status: 503, body: {} })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "failed", message: "Service Unavailable" })
})

test("an enterprise account sends its enterprise on the meter", async () => {
  const calls = fake({ status: 200, body: { code: 0, data: null } })
  await postMeter(SITES.workbuddy, { ...account, enterpriseId: "e1" }, "/billing/meter/x")
  assert.equal(calls[0].headers["X-Enterprise-Id"], "e1")
  assert.equal(calls[0].headers["X-Tenant-Id"], "e1")
})

test("meter throws WorkBuddy's message, else its code, else the status", async () => {
  fake({ status: 200, body: { code: 0, data: { a: 1 } } })
  assert.deepEqual(await meter(SITES.workbuddy, account, "/p"), { a: 1 })
  fake({ status: 400, body: { code: 10001, msg: "uid or enterpriseID is empty" } })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /uid or enterpriseID is empty/)
  fake({ status: 400, body: { code: 7 } })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /error 7/)
  fake({ status: 502, body: {} })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /Bad Gateway/)
})

// ---- the Anthropic route ----------------------------------------------------

const HY = { id: "hy3", name: "Hy3", context: 192000, efforts: ["none", "low", "high"] }
const DS = { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", context: 1000000 }

test("hy3 and hy3-x of the China build are on the Anthropic route, with no reasoning levels", () => {
  const cfg = configModels(SITES.workbuddy)
  for (const id of ["hy3", "hy3-x"]) {
    assert.deepEqual(cfg[id].provider, { npm: "@ai-sdk/anthropic", api: "https://copilot.tencent.com/v1" })
    assert.equal(cfg[id].reasoning, true)
    assert.equal(cfg[id].variants, undefined)
  }
  const live = modelOf(SITES.workbuddy, { id: "workbuddy" }, HY)
  assert.deepEqual(live.api, { id: "hy3", url: "https://copilot.tencent.com/v1", npm: "@ai-sdk/anthropic" })
  assert.deepEqual(live.variants, {})
  assert.equal(live.capabilities.reasoning, true)
})

test("every other model, and the international build, stay on chat completions", () => {
  const cfg = configModels(SITES.workbuddy)
  for (const id of ["deepseek-v4.1-flash", "glm-5.3", "kimi-k2.6", "hy4-preview-f", "auto"]) assert.equal(cfg[id].provider, undefined, id)
  assert.deepEqual(Object.keys(cfg["glm-5.3"].variants), ["low", "high", "max"])
  const ds = modelOf(SITES.workbuddy, { id: "workbuddy" }, DS)
  assert.deepEqual(ds.api, { id: DS.id, url: "https://copilot.tencent.com/v2", npm: "@ai-sdk/openai-compatible" })
  // WorkBuddy AI has no Anthropic route: its hy3 is a chat completion model with its levels
  assert.equal(configModels(SITES["workbuddy-ai"]).hy3.provider, undefined)
  const ai = modelOf(SITES["workbuddy-ai"], { id: "workbuddy-ai" }, HY)
  assert.deepEqual(ai.api, { id: "hy3", url: "https://www.workbuddy.ai/v2", npm: "@ai-sdk/openai-compatible" })
  assert.deepEqual(Object.keys(ai.variants), ["none", "low", "high"])
})

test("messagesUrl moves the AI SDK's /v2/messages to WorkBuddy's /v1/messages, and nothing else", () => {
  const cn = SITES.workbuddy
  assert.equal(messagesUrl(cn, "https://copilot.tencent.com/v2/messages"), "https://copilot.tencent.com/v1/messages")
  assert.equal(messagesUrl(cn, new URL("https://copilot.tencent.com/v2/messages?beta=true")), "https://copilot.tencent.com/v1/messages?beta=true")
  assert.equal(messagesUrl(cn, "https://copilot.tencent.com/v2/chat/completions"), null)
  assert.equal(messagesUrl(cn, "https://copilot.tencent.com/v2/messages/count_tokens"), null)
  assert.equal(messagesUrl(cn, "https://example.com/v2/messages"), null)
  assert.equal(messagesUrl(cn, "not a url"), null)
})

// a fetch that answers one reply and keeps what it was sent, body included
function spy(reply = { status: 200, body: "{}" }) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body })
    return new Response(reply.body, { status: reply.status, headers: reply.headers })
  }
  return sent
}
async function loaderFetch(site = WorkBuddyAuthPlugin) {
  const h = await site({ client: {} })
  return (await h.auth.loader(async () => account)).fetch
}

test("an Anthropic request goes to /v1/messages with the account's headers and its body untouched", async () => {
  const sent = spy({ status: 200, body: "event: message_start\ndata: {}\n\n", headers: { "content-type": "text/event-stream" } })
  const f = await loaderFetch()
  // no system, a tool whose name and schema the chat route would have mended, an object tool_choice
  const body = JSON.stringify({
    model: "hy3",
    max_tokens: 64,
    stream: true,
    tools: [{ name: "mcp.weather:get", description: "d", input_schema: {} }],
    tool_choice: { type: "tool", name: "mcp.weather:get" },
    messages: [{ role: "user", content: "hi" }],
  })
  const res = await f("https://copilot.tencent.com/v2/messages?beta=true", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "x-api-key": "unused", authorization: "Bearer unused", "content-type": "application/json" },
    body,
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, "https://copilot.tencent.com/v1/messages?beta=true")
  assert.equal(sent[0].method, "POST")
  assert.equal(sent[0].body, body)
  assert.equal(sent[0].headers.get("authorization"), "Bearer tok")
  assert.equal(sent[0].headers.get("x-api-key"), null)
  assert.equal(sent[0].headers.get("x-user-id"), "u1")
  assert.equal(sent[0].headers.get("x-ide-type"), "WorkBuddy")
  assert.equal(sent[0].headers.get("anthropic-version"), "2023-06-01")
  assert.ok(sent[0].headers.get("x-conversation-id"))
  assert.ok(sent[0].headers.get("x-conversation-request-id"))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(await res.text(), "event: message_start\ndata: {}\n\n")
})

test("an Anthropic request's bytes are read as text, and a refusal of it is explained", async () => {
  const sent = spy({ status: 403, body: JSON.stringify({ error: { message: "Illegal API invocation from an unapproved channel" } }) })
  const f = await loaderFetch()
  const body = JSON.stringify({ model: "hy3", max_tokens: 8, messages: [{ role: "user", content: "hi" }] })
  const res = await f("https://copilot.tencent.com/v2/messages", { method: "POST", headers: {}, body: new TextEncoder().encode(body) })
  assert.equal(sent[0].body, body)
  assert.ok(sent[0].headers.get("x-conversation-id"))
  assert.equal(res.status, 403)
  assert.match((await res.json()).error.message, /WorkBuddy refuses chats from Codex and Claude Code/)
})

test("a chat completion still goes to /v2/chat/completions, with the chat route's mending", async () => {
  const sent = spy()
  const f = await loaderFetch()
  const body = JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
  await f("https://copilot.tencent.com/v2/chat/completions", { method: "POST", headers: {}, body })
  assert.equal(sent[0].url, "https://copilot.tencent.com/v2/chat/completions")
  assert.deepEqual(JSON.parse(sent[0].body).messages[0], { role: "system", content: "You are a helpful assistant." })
})

test("in Anthropic's shape a tool's result is not a new send: every step of one send has one request id", () => {
  const ask = (messages, session = "s1") => {
    const h = new Headers()
    attend(h, JSON.stringify({ messages }), session)
    return h.get("x-conversation-request-id")
  }
  const hi = { role: "user", content: "list the files" }
  const call = { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "ls", input: {} }] }
  const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a b" }] }
  const first = ask([hi])
  assert.equal(ask([hi, call, result]), first)
  // a result with a note of the client's beside it is still the answer to the call
  const noted = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a b" }, { type: "text", text: "<system-reminder>x</system-reminder>" }] }
  assert.equal(ask([hi, call, noted]), first)
  // the user's next message is another send
  assert.notEqual(ask([hi, call, result, { role: "assistant", content: "done" }, { role: "user", content: "and now?" }]), first)
})
