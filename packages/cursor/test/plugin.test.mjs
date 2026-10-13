import test from "node:test"
import assert from "node:assert/strict"
import { CursorAuthPlugin } from "../src/index.mjs"
import { replyOf } from "../src/reply.mjs"
import { fakeFetch, jwt } from "./fake.mjs"

async function* events(...es) {
  yield* es
}
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }

test("replyOf: the pieces as one chat completion", async () => {
  const res = await replyOf(
    events({ reasoning: "think" }, { text: "Hel" }, { text: "lo" }, { tool: { index: 0, id: "c1", name: "read", args: "{}" } }, { stop: "tool_calls", usage }),
    "auto",
    false,
  )
  const j = await res.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.model, "auto")
  assert.match(j.id, /^chatcmpl-[0-9a-f]{24}$/)
  assert.deepEqual(j.choices[0], {
    index: 0,
    message: { role: "assistant", content: "Hello", reasoning_content: "think", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    finish_reason: "tool_calls",
  })
  assert.deepEqual(j.usage, usage)
})

test("replyOf: an error among the pieces is the answer's error", async () => {
  const res = await replyOf(events({ text: "x" }, { error: { status: 429, message: "usage limit reached: over" } }), "auto", false)
  assert.equal(res.status, 429)
  assert.equal((await res.json()).error.message, "usage limit reached: over")
})

test("replyOf: streamed as server-sent events, role first, the usage on the stop, then [DONE]", async () => {
  const res = await replyOf(events({ text: "Hi" }, { reasoning: "hm" }, { stop: "stop", usage }), "auto", true)
  assert.equal(res.headers.get("content-type"), "text/event-stream")
  const lines = (await res.text()).split("\n\n").filter(Boolean)
  assert.equal(lines.at(-1), "data: [DONE]")
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)))
  assert.deepEqual(chunks.map((c) => c.choices[0].delta), [{ role: "assistant", content: "" }, { content: "Hi" }, { reasoning_content: "hm" }, {}])
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
  assert.deepEqual(chunks.at(-1).usage, usage)
})

test("replyOf: a stream's error is said in the stream, which then ends", async () => {
  const res = await replyOf(events({ error: { status: 502, message: "broke" } }), "auto", true)
  const text = await res.text()
  assert.match(text, /data: \{"error":\{"message":"broke","code":502\}\}/)
  assert.ok(!text.includes("[DONE]"))
})

test("the plugin: a provider with a built-in Auto, three ways to sign in, and the hooks", async () => {
  const h = await CursorAuthPlugin()
  assert.equal(h.auth.provider, "cursor")
  assert.deepEqual(h.auth.methods.map((m) => m.type), ["oauth", "oauth", "api"])
  const config = {}
  await h.config(config)
  assert.equal(config.provider.cursor.models.auto.name, "Auto")
  assert.equal(config.provider.cursor.npm, "@ai-sdk/openai-compatible")
  const kept = { provider: { cursor: { name: "Mine", models: { x: { name: "X" } } } } }
  await h.config(kept)
  assert.equal(kept.provider.cursor.name, "Mine")
  assert.deepEqual(Object.keys(kept.provider.cursor.models), ["auto", "x"])
})

test("chat.headers puts the session on Cursor's requests alone", async () => {
  const h = await CursorAuthPlugin()
  const out = { headers: {} }
  await h["chat.headers"]({ model: { providerID: "cursor" }, sessionID: "s-1" }, out)
  assert.deepEqual(out.headers, { "x-magpie-cursor-session": "s-1" })
  const other = { headers: {} }
  await h["chat.headers"]({ model: { providerID: "openai" }, sessionID: "s-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("the loader: nothing without a sign-in; its fetch serves chat completions only, and only JSON", async () => {
  const h = await CursorAuthPlugin()
  assert.deepEqual(await h.auth.loader(async () => undefined), {})
  const loaded = await h.auth.loader(async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }))
  assert.equal(loaded.apiKey, "cursor")
  const wrong = await loaded.fetch("https://agentn.global.api5.cursor.sh/v1/models", { method: "POST", body: "{}" })
  assert.equal(wrong.status, 404)
  assert.equal(wrong.headers.get("x-magpie-sign-in"), "kept")
  const bad = await loaded.fetch("https://agentn.global.api5.cursor.sh/v1/chat/completions", { method: "POST", body: "not json" })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.message, "a request that isn't JSON")
})

test("the loader: a lapsed sign-in is answered 401, the account kept", async () => {
  const h = await CursorAuthPlugin()
  const loaded = await h.auth.loader(async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1000 }))
  const res = await loaded.fetch("https://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto", messages: [] }) })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
})

test("models: the configured list without a sign-in", async () => {
  const h = await CursorAuthPlugin()
  const provider = { models: { auto: { name: "Auto" } } }
  assert.equal(await h.provider.models(provider, {}), provider.models)
})

test("usage: the account's windows, Grok Bot before the total, the plan on the card, the sign-in kept", async () => {
  const tok = jwt({ sub: "auth0|user_1", exp: Date.now() / 1000 + 3600 })
  const f = fakeFetch((c) => {
    if (c.url.endsWith("GetCurrentPeriodUsage")) return { body: { planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } } }
    if (c.url.endsWith("GetHardLimit")) return { status: 500 }
    if (c.url.endsWith("GetPlanInfo")) return { body: { planInfo: { planName: "Ultra" } } }
    return { body: { includedLimitZero: false, usagePercent: 4 } }
  })
  try {
    const h = await CursorAuthPlugin()
    const card = await h.auth.usage(async () => ({ type: "oauth", access: tok, refresh: "r", expires: 0 }), { models: {} })
    assert.deepEqual(card.windows.map((w) => w.name), ["Cursor Models", "Other Models", "Grok Bot", "Total"])
    assert.equal(card.plan, "Ultra")
    assert.equal(card.signIn, "kept")
  } finally {
    f.restore()
  }
  const h = await CursorAuthPlugin()
  const lapsed = await h.auth.usage(async () => undefined, {})
  assert.deepEqual(lapsed, { error: "Cursor isn't signed in", windows: [], signIn: "kept" })
})
