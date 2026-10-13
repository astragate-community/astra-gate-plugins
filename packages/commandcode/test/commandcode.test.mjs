import test from "node:test"
import assert from "node:assert/strict"
import { CommandCodePlugin } from "../src/index.mjs"
import { refuses, GO_REFUSED, GO_MODELS } from "../src/catalog.mjs"
import { failure, streamError, refusal } from "../src/refusals.mjs"
import { fitEffort, generateBody, workPlace } from "../src/request.mjs"
import { events } from "../src/response.mjs"
import { generate } from "../src/generate.mjs"
import { allowanceOf, limits } from "../src/usage.mjs"
import { money, when } from "../src/values.mjs"
import { planOf, subsSeen, extraSeen, waits } from "../src/account.mjs"
import { goModels, modelsOf, runtimeModel } from "../src/models.mjs"
import { markGo } from "../src/metadata.mjs"
import { liveKey } from "../src/signin.mjs"

const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
  subsSeen.clear()
  extraSeen.clear()
})

const lineBody = (...objs) => new Response(objs.map((o) => JSON.stringify(o)).join("\n") + "\n").body
const collect = async (it) => {
  const out = []
  for await (const e of it) out.push(e)
  return out
}

test("the plugin exports its hooks and nothing test-only", async () => {
  const mod = await import("../src/index.mjs")
  assert.deepEqual(Object.keys(mod), ["CommandCodePlugin"])
  const h = await CommandCodePlugin({})
  assert.equal(h.auth.provider, "commandcode-plan")
  assert.equal(h.auth.methods.length, 3)
  const cfg = {}
  await h.config(cfg)
  assert.equal(cfg.provider["commandcode-plan"].models["claude-sonnet-5"].provider.npm, "@ai-sdk/anthropic")
  assert.equal(cfg.provider["commandcode-plan"].models["gpt-6-sol"].provider?.npm, undefined)
})

test("plans refuse the models the CLI's table says", () => {
  assert.equal(refuses("Go", "claude-opus-5-5"), true) // premium, Go has the open models only
  assert.equal(refuses("Go", "deepseek/deepseek-v4-pro"), false)
  assert.equal(refuses("Pro", "claude-opus-5-5"), true) // blocked for Pro
  assert.equal(refuses("Pro", "claude-sonnet-5"), false)
  assert.equal(refuses("Max", "claude-opus-5-5"), false)
  assert.equal(refuses("No plan", "claude-opus-5-5"), false)
  assert.ok(GO_REFUSED.has("xai/grok-4.6"))
})

test("failure maps Command Code's refusals to a status and message", () => {
  assert.deepEqual(failure(400, JSON.stringify({ error: { message: "MODEL_NOT_IN_PLAN: Claude Opus 5.5" } })), { status: 403, message: "Model not in plan: Claude Opus 5.5" })
  assert.deepEqual(failure(400, "PREMIUM_CREDITS_EXHAUSTED: none left"), { status: 402, message: "out of credits: none left" })
  assert.equal(failure(500, "RATE_LIMITED").status, 429)
  assert.equal(failure(200, "weird").status, 502)
  assert.deepEqual(failure(429, ""), { status: 429, message: "Too Many Requests" })
})

test("streamError reads the status out of an embedded HTTP error", () => {
  assert.deepEqual(streamError("429 {\"error\":{\"message\":\"usage limit reached\"}}"), { status: 429, message: "usage limit reached" })
  assert.deepEqual(streamError({ message: "boom", statusCode: 503 }), { status: 503, message: "boom" })
  assert.equal(streamError("").message, "Stream error")
})

test("refusal answers in OpenAI's shape and keeps the sign-in", async () => {
  const res = refusal({ status: 403, message: "no" })
  assert.equal(res.status, 403)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await res.json(), { error: { message: "no", type: "commandcode_error", code: 403 } })
})

test("fitEffort picks the nearest level the model has, the higher on a tie", () => {
  assert.equal(fitEffort("high", ["low", "high", "max"]), "high")
  assert.equal(fitEffort("medium", ["low", "high", "max"]), "high")
  assert.equal(fitEffort("ultra", ["low", "high"]), "high")
  assert.equal(fitEffort("xhigh", []), "xhigh")
})

test("generateBody writes a chat completion in the CLI's format", () => {
  const body = generateBody(
    {
      model: "deepseek/deepseek-v4-pro",
      reasoning_effort: "medium",
      temperature: 0.5,
      messages: [
        { role: "system", content: "be brief" },
        { role: "developer", content: [{ type: "text", text: "and kind" }] },
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "ls", arguments: "{\"p\":1}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a b" },
      ],
      tools: [{ type: "function", function: { name: "ls", parameters: { type: "object" } } }, { type: "other" }],
    },
    { dir: "/work", git: "yes" },
  )
  assert.equal(body.config.workingDir, "/work")
  assert.equal(body.config.isGitRepo, true)
  assert.equal(body.params.system, "be brief\n\nand kind")
  assert.equal(body.params.max_tokens, 64000)
  assert.equal(body.params.reasoning_effort, "high") // deepseek-v4-pro has high, max: the higher of the tie
  assert.equal(body.params.temperature, 0.5)
  assert.deepEqual(body.params.tools, [{ name: "ls", description: "", input_schema: { type: "object" } }])
  assert.deepEqual(body.params.messages[0].content[1], { type: "image", image: "data:image/png;base64,AAA", mimeType: "image/png" })
  assert.deepEqual(body.params.messages[1].content, [{ type: "tool-call", toolCallId: "c1", toolName: "ls", input: { p: 1 } }])
  assert.deepEqual(body.params.messages[2], {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "ls", output: { type: "text", value: "a b" } }],
  })
})

test("workPlace takes magpie's work headers off the request", () => {
  const h = new Headers({ "x-magpie-work-dir": encodeURIComponent("/a b"), "x-magpie-work-git": "no", other: "1" })
  assert.deepEqual(workPlace(h), { dir: "/a b", git: "no" })
  assert.equal(h.has("x-magpie-work-dir"), false)
  assert.equal(h.get("other"), "1")
})

test("events turns the reply's lines into chat completion pieces", async () => {
  const out = await collect(
    events(
      lineBody(
        { type: "reasoning-delta", text: "hm" },
        { type: "text-delta", text: "hi" },
        { type: "tool-call", toolCallId: "t1", toolName: "ls", input: { a: 1 } },
        { type: "tool-call", toolCallId: "t2", toolName: "srv", providerExecuted: true },
        { type: "cache-write-tokens", cacheWriteTokens: 7 },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 }, outputTokenDetails: { reasoningTokens: 2 } } },
      ),
    ),
  )
  assert.deepEqual(out[0], { reasoning: "hm" })
  assert.deepEqual(out[2], { tool: { index: 0, id: "t1", name: "ls", args: "{\"a\":1}" } })
  assert.equal(out.length, 4)
  assert.equal(out[3].stop, "tool_calls") // a tool call turns a plain stop into one
  assert.deepEqual(out[3].usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 },
    completion_tokens_details: { reasoning_tokens: 2 },
  })
})

test("events: a reply with no finish is cut short when it said something, else an error", async () => {
  const cut = await collect(events(lineBody({ type: "text-delta", text: "x" })))
  assert.equal(cut[1].cut, "stop")
  assert.equal(cut[1].wrote, true)
  const none = await collect(events(lineBody()))
  assert.deepEqual(none, [{ error: { status: 502, message: "the reply ended before it was complete" } }])
  const err = await collect(events(lineBody({ type: "error", error: { message: "bad", statusCode: 402 } })))
  assert.deepEqual(err, [{ error: { status: 402, message: "bad" } }])
})

test("generate sends the CLI's request and answers a whole chat completion", async () => {
  let seen
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return new Response(
      [{ type: "text-delta", text: "hello" }, { type: "finish", finishReason: "length", totalUsage: { inputTokens: 1, outputTokens: 2 } }].map((o) => JSON.stringify(o)).join("\n"),
    )
  }
  const res = await generate("k1", { model: "m", messages: [{ role: "user", content: "hi" }] }, undefined, {})
  assert.equal(seen.url, "https://api.commandcode.ai/alpha/generate")
  assert.equal(seen.init.headers.Authorization, "Bearer k1")
  assert.equal(seen.init.headers["x-command-code-version"], "1.72.2")
  const j = await res.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, "hello")
  assert.equal(j.choices[0].finish_reason, "length")
  assert.equal(j.usage.total_tokens, 3)
})

test("generate streams chunks and ends a cut-short reply with a note", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ type: "text-delta", text: "part" }) + "\n")
  const res = await generate("k", { model: "m", stream: true, messages: [] }, undefined, {})
  const text = await res.text()
  assert.match(text, /"delta":\{"content":"part"\}/)
  assert.match(text, /The reply was cut short/)
  assert.ok(text.endsWith("data: [DONE]\n\n"))
})

test("generate keeps the status of a refusal", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "MODEL_NOT_IN_PLAN: X" } }), { status: 400 })
  const res = await generate("k", { model: "m", messages: [] }, undefined, {})
  assert.equal(res.status, 403)
})

test("usage maths: windows and the credits pool", () => {
  const c = {
    credits: { planId: "individual-pro", monthlyCredits: "20", purchasedCredits: 5, freeCredits: 0 },
    windowLimits: { fiveHour: { used: 50, cap: 200, resetAt: 1_700_000_000 }, weekly: { used: 500, cap: 100 } },
  }
  const out = allowanceOf(c)
  assert.equal(out.plan, "Pro")
  assert.deepEqual(out.windows[0], { name: "5 hours", used: 25, span: 18000, resetsAt: "2023-11-14T22:13:20.000Z" })
  assert.equal(out.windows[1].used, 100) // capped
  // pool = 30 + 25 - 20 = 35; left = 25; used 10
  assert.deepEqual(out.windows[2], { name: "Credits", used: (100 * 10) / 35, display: "$10.00 / $35.00" })
  assert.deepEqual(limits({ windowLimits: { weekly: { used: 1, cap: 0 } } }), [])
})

test("a reply with no plan and no windows is a balance", () => {
  assert.deepEqual(allowanceOf({ credits: { monthlyCredits: 1.005, purchasedCredits: 2 } }), { windows: [], balance: "$3.00" })
})

test("money rounds a half cent to the even cent; when reads seconds, ms and RFC 3339", () => {
  assert.equal(money(0.125), "$0.12")
  assert.equal(money(0.135), "$0.14")
  assert.equal(money(-2), "$-2.00")
  assert.equal(when(1_700_000_000), when(1_700_000_000_000))
  assert.equal(when("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z")
  assert.equal(when("nope"), undefined)
})

test("plan names are matched by prefix, the longest first", () => {
  assert.deepEqual(planOf("individual-pro-v1-x"), ["individual-pro-v1", "Pro", 80])
  assert.deepEqual(planOf("INDIVIDUAL_GO"), ["individual-go", "Go", 10])
  assert.deepEqual(planOf("zzz"), ["", "", 0])
})

test("goModels drops what Go is refused and fills in the CLI's table", async () => {
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "claude-opus-5-5" }, { id: "dall-e-9" }, { id: "text-embed-1" }, { id: "xiaomi/mimo-v2.5", context_length: 0 }, { id: "stealth/pixel-canary", display_name: "Canary", modalities: { input: ["text"] } }] })
  const out = await goModels()
  assert.deepEqual(out.map((m) => m.id), ["xiaomi/mimo-v2.5", "stealth/pixel-canary"])
  assert.equal(out[0].context, 1_000_000)
  assert.equal(out[0].images, true)
  assert.equal(out[1].name, "Canary")
  assert.equal(out[1].images, false) // the list says so
  assert.deepEqual(out[1].efforts, ["low", "medium", "xhigh"])
  assert.equal((await goModels(true)).length, 3) // an account with extra credits is let every text model
})

test("goModels errors say the url, status and the reply's message", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 418 })
  await assert.rejects(goModels(), /\/provider\/v1\/models: 418 I'm a teapot \(nope\)/)
  globalThis.fetch = async () => new Response("[]")
  await assert.rejects(goModels(), /not a model list/)
})

test("runtimeModel says pictures only when known", () => {
  assert.equal("image" in runtimeModel({ id: "a" }).capabilities.input, false)
  assert.equal(runtimeModel({ id: "a", images: false }).capabilities.input.image, false)
  assert.equal(runtimeModel({ id: "claude-x" }).api.npm, "@ai-sdk/anthropic")
})

test("models: a Go plan lists Go's models, falling back to the table when the list fails", async () => {
  const auth = { type: "api", key: "k", metadata: { plan: "Go" } }
  globalThis.fetch = async (url) => {
    if (String(url).includes("/billing/")) return new Response("{}", { status: 500 })
    return new Response("x", { status: 500 })
  }
  const out = await modelsOf({ models: {} }, { auth })
  assert.equal(Object.keys(out).length, GO_MODELS.length)
  assert.equal(out[Symbol.for("magpie.fellBack")], true)
})

test("models: the Provider API's list is cut by what the plan refuses", async () => {
  subsSeen.set("k", { sub: { id: "individual-pro", plan: "Pro" }, at: Date.now() })
  globalThis.fetch = async (url) => {
    if (String(url).includes("/billing/credits")) return Response.json({ credits: {} })
    return Response.json({
      data: [
        { id: "claude-opus-5-5", supported_endpoints: ["/v1/messages"] },
        { id: "claude-sonnet-5", supported_endpoints: ["/v1/messages"] },
        { id: "gpt-x", supported_endpoints: ["/v1/responses"] },
      ],
    })
  }
  const out = await modelsOf({ models: {} }, { auth: { type: "api", key: "k" } })
  assert.deepEqual(Object.keys(out), ["claude-sonnet-5", "gpt-x"])
  assert.equal(out["gpt-x"].api.npm, "@ai-sdk/openai")
  assert.equal(out["claude-sonnet-5"].api.npm, "@ai-sdk/anthropic")
})

test("markGo remembers a key as Go's and saves the plan once", async () => {
  const sets = []
  const client = { auth: { set: async (a) => sets.push(a) } }
  await markGo(client, "k", { type: "api", key: "k", metadata: { email: "e" } })
  assert.equal(subsSeen.get("k").sub.plan, "Go")
  assert.deepEqual(sets[0].body.metadata, { email: "e", plan: "Go" })
  await markGo(client, "k", { type: "api", key: "k", metadata: { plan: "Go" } })
  assert.equal(sets.length, 1)
})

test("the loader's fetch signs requests and sends a Go key's chat to /alpha/generate", async () => {
  waits.subWait = 50
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers })
    if (String(url).endsWith("/alpha/generate")) return new Response(JSON.stringify({ type: "text-delta", text: "ok" }) + "\n" + JSON.stringify({ type: "finish" }))
    return new Response("{}", { status: 500 })
  }
  const h = await CommandCodePlugin({})
  const auth = { type: "api", key: "k", metadata: { plan: "Go" } }
  const o = await h.auth.loader(async () => auth)
  assert.equal(o.headers["x-api-key"], "k")
  const res = await o.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal((await res.json()).choices[0].message.content, "ok")
  assert.ok(calls.some((c) => c.url.endsWith("/alpha/generate")))
  waits.subWait = 9_000
})

test("a Go key refused by the Provider API is Go from then on, and a chat is asked again on /alpha/generate", async () => {
  subsSeen.set("k", { sub: { id: "", plan: "Provider" }, at: Date.now() })
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/alpha/generate")) return new Response(JSON.stringify({ type: "text-delta", text: "go" }) + "\n" + JSON.stringify({ type: "finish" }))
    return new Response("Your Go plan doesn't include API access", { status: 403 })
  }
  const h = await CommandCodePlugin({})
  const o = await h.auth.loader(async () => ({ type: "api", key: "k" }))
  const res = await o.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: "{\"model\":\"m\"}" })
  assert.equal((await res.json()).choices[0].message.content, "go")
  assert.equal(subsSeen.get("k").sub.plan, "Go")
  // a non-chat call just gets the refusal, kept
  const other = await o.fetch("https://api.commandcode.ai/provider/v1/models")
  assert.equal(other.status, 403)
  assert.equal(other.headers.get("x-magpie-sign-in"), "kept")
  assert.match(await other.text(), /Go plan/)
})

test("a request that isn't JSON is a 400", async () => {
  const h = await CommandCodePlugin({})
  const o = await h.auth.loader(async () => ({ type: "api", key: "k" }))
  const res = await o.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: "not json" })
  assert.equal(res.status, 400)
})

test("liveKey is the saved key unless the account came from the CLI", async () => {
  assert.equal(await liveKey({ key: "saved" }), "saved")
  assert.equal(await liveKey(undefined), undefined)
})
