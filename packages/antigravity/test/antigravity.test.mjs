import test from "node:test"
import assert from "node:assert/strict"
import { get } from "node:http"

// Antigravity's OAuth client values are baked into the shipped bundle at build time (scripts/build.mjs);
// the tests run the source, so they say their own before anything of the plugin is imported.
process.env.ANTIGRAVITY_CLIENT_ID ||= "test.apps.googleusercontent.com"
process.env.ANTIGRAVITY_CLIENT_SECRET ||= "not-a-secret"
const { AntigravityAuthPlugin } = await import("../src/index.mjs")
const { forgetVersion, userAgent } = await import("../src/client.mjs")
const { CodeAssistError, describe, durationMs, gone } = await import("../src/errors.mjs")
const { plainSchema } = await import("../src/schema.mjs")
const { history } = await import("../src/history.mjs")
const { generation, geminiGeneration, levelOf } = await import("../src/generation.mjs")
const { cloak, envelope, sessionOf, shape } = await import("../src/request.mjs")
const { collect, failed, merge, splitEvents, streamOf, unwrap } = await import("../src/response.mjs")
const { MODELS, familyOf, forgetLists, levelOfId, listModels, parseModels, resolveModel, runtimeModel, thinks } = await import("../src/models.mjs")
const { account, fresh, hasSignIn, refresh } = await import("../src/session.mjs")
const { authorizeURL, browserSignIn, pasteSignIn, readCode } = await import("../src/signin.mjs")
const { balanceOf, planName, usageOf } = await import("../src/usage.mjs")
const { chatFetch } = await import("../src/fetch.mjs")
const { defaultTier, projectOf, setup } = await import("../src/api.mjs")
const { CALLBACK_PORTS, DAILY, PROD, SKIP_SIGNATURE } = await import("../src/constants.mjs")

const realFetch = globalThis.fetch
test.beforeEach(() => {
  forgetVersion()
  forgetLists()
})
test.afterEach(() => {
  globalThis.fetch = realFetch
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const sse = (...chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
// a faked fetch answering by url (a function) or from a queue; the updater's page is answered whatever the test says
function fake(route) {
  const calls = []
  const queue = Array.isArray(route) ? [...route] : null
  globalThis.fetch = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.includes("antigravity-hub-auto-updater")) return new Response("version: 2.24.0\nfiles:\n", { status: 200 })
    calls.push({ url: u, init })
    return queue ? queue.shift() : route(u, init)
  }
  return calls
}
const hours = (n) => Date.now() + n * 3600_000
const AUTH = { type: "oauth", access: "AT", refresh: "RT", expires: hours(1), project: "proj-1" }
const geminiBody = (extra = {}) => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }], ...extra })
const reply = (text, extra = {}) => ({ response: { candidates: [{ content: { role: "model", parts: [{ text }] }, ...extra }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }, traceId: "t" })
const request = (model, action, body) => [`https://x/v1beta/models/${model}:${action}`, { method: "POST", body: JSON.stringify(body) }]

// ---- the plugin ------------------------------------------------------------------------

test("the plugin: Gemini's API, two ways to sign in, a refresh lead", async () => {
  const h = await AntigravityAuthPlugin({ client: {} })
  assert.equal(h.auth.provider, "antigravity")
  assert.equal(h.auth.refreshLead, 600000)
  assert.deepEqual(h.auth.methods.map((m) => m.type), ["oauth", "oauth"])
  const cfg = { provider: { antigravity: { models: { mine: { name: "mine" } } } } }
  await h.config(cfg)
  const p = cfg.provider.antigravity
  assert.equal(p.npm, "@ai-sdk/google")
  assert.ok(p.models.mine && p.models[MODELS[0].id])
})

test("the loader gives nothing without a sign-in, a fetch with one", async () => {
  const h = await AntigravityAuthPlugin({ client: {} })
  assert.deepEqual(await h.auth.loader(async () => undefined), {})
  const l = await h.auth.loader(async () => AUTH)
  assert.equal(l.apiKey, "antigravity")
  assert.equal(typeof l.fetch, "function")
})

test("models: the account's own list, the built-in ones without a sign-in", async () => {
  const h = await AntigravityAuthPlugin({ client: {} })
  const own = { a: 1 }
  assert.equal(await h.provider.models({ models: own }, { auth: undefined }), own)
  fake((u) => (u.includes("fetchAvailableModels") ? json({ models: { "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1048576, maxOutputTokens: 65535 } } }) : json({})))
  const m = await h.provider.models({ models: own }, { auth: AUTH })
  assert.deepEqual(Object.keys(m), ["gemini-3-flash"])
  assert.equal(m["gemini-3-flash"].api.npm, "@ai-sdk/google")
  assert.equal(m["gemini-3-flash"].limit.context, 1048576)
  fake(() => json({ error: { message: "no" } }, 500))
  assert.equal(await h.provider.models({ models: own }, { auth: { ...AUTH, project: "other" } }), own)
})

// ---- reading what Code Assist refuses with ------------------------------------------------

test("durations as Google says them", () => {
  assert.equal(durationMs("0.5s"), 500)
  assert.equal(durationMs("4m50s"), 290000)
  assert.equal(durationMs("200ms"), 200)
  assert.equal(durationMs("soon"), 0)
})

test("a rate limit with its delay, a host's busy words, a model out of room", () => {
  const limit = describe(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "You have exhausted your capacity on this model. Your quota will reset after 3s.",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { model: "gemini-3-flash" } }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.5s" }] } }))
  assert.equal(limit.kind, "limit")
  assert.equal(limit.waitMs, 3500)
  assert.equal(limit.model, "gemini-3-flash")
  assert.equal(describe(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } })).kind, "busy")
  const cap = describe(503, JSON.stringify({ error: { status: "UNAVAILABLE", message: "No capacity available", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_CAPACITY_EXHAUSTED" }] } }))
  assert.equal(cap.kind, "capacity")
})

test("a 403 that wants the account verified, one that says it broke the terms", () => {
  const v = describe(403, JSON.stringify({ error: { message: "Verify your account to continue.", details: [{ metadata: { validation_url: "https://accounts.google.com/verify" } }] } }))
  assert.equal(v.kind, "validation")
  assert.match(v.message, /https:\/\/accounts\.google\.com\/verify/)
  assert.equal(describe(403, JSON.stringify({ error: { message: "This account has violated the Terms of Service" } })).kind, "violation")
  assert.equal(describe(403, JSON.stringify({ error: { message: "nope" } })).kind, "forbidden")
  assert.equal(describe(401, "").kind, "auth")
  assert.equal(describe(502, "<html>bad gateway</html>").message, "<html>bad gateway</html>")
})

test("a CodeAssistError says the method and the status", () => {
  const e = new CodeAssistError(400, JSON.stringify({ error: { message: "bad project" } }), "loadCodeAssist")
  assert.equal(e.message, "Antigravity loadCodeAssist: bad project (400)")
  assert.equal(e.status, 400)
  assert.equal(gone("x").signIn, "expired")
})

// ---- schemas ----------------------------------------------------------------------------

test("a schema is cut down to the subset Antigravity takes", () => {
  const out = plainSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    $defs: { Mode: { type: "string", enum: ["a", "b"], default: "a" } },
    properties: {
      mode: { $ref: "#/$defs/Mode" },
      n: { anyOf: [{ type: "integer" }, { type: "null" }], description: "count" },
      list: { type: "array", items: { type: ["string", "null"], format: "uri" } },
      tag: { const: "x" },
      lo: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["mode", "ghost"],
  })
  assert.deepEqual(out, {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["a", "b"] },
      n: { type: "integer", nullable: true, description: "count" },
      list: { type: "array", items: { type: "string", nullable: true } },
      tag: { enum: ["x"] },
      lo: { type: "number", minimum: 0 },
    },
    required: ["mode"],
  })
})

test("allOf is one schema; a missing or empty schema is an object with no properties", () => {
  assert.deepEqual(plainSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] }),
    { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] })
  assert.deepEqual(plainSchema(undefined), { type: "object", properties: {} })
  assert.deepEqual(plainSchema({}), { type: "object", properties: {} })
})

// ---- conversations -----------------------------------------------------------------------

const call = (name, extra = {}) => ({ functionCall: { name, args: {} }, ...extra })
const answer = (name, extra = {}) => ({ functionResponse: { name, response: { result: "ok" } , ...extra } })

test("a Claude model's calls get ids, and the answers after them take the same", () => {
  const out = history([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a"), call("b"), call("a")] },
    { role: "user", parts: [answer("b"), answer("a"), answer("a")] },
  ], { claude: true })
  const calls = out[1].parts.map((p) => p.functionCall.id)
  assert.deepEqual(calls, ["call_1", "call_2", "call_3"])
  assert.deepEqual(out[2].parts.map((p) => p.functionResponse.id), ["call_2", "call_1", "call_3"])
  assert.ok(out[1].parts.every((p) => p.thoughtSignature === SKIP_SIGNATURE))
})

test("a Gemini call the model signed keeps its signature; one it didn't is told to skip the check", () => {
  const out = history([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a", { thoughtSignature: "SIG" }), call("b")] },
    { role: "user", parts: [answer("a"), answer("b")] },
    { role: "model", parts: [call("c")] },
    { role: "user", parts: [answer("c")] },
  ])
  assert.equal(out[1].parts[0].thoughtSignature, "SIG")
  assert.equal(out[1].parts[1].thoughtSignature, undefined)
  assert.equal(out[3].parts[0].thoughtSignature, SKIP_SIGNATURE)
  assert.equal(out[1].parts[0].functionCall.id, undefined, "Gemini's calls are paired by name")
})

test("a call nobody answered is answered with a note; a history may not open or end with the model's turn", () => {
  const out = history([
    { role: "model", parts: [{ text: "earlier" }] },
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a")] },
    { role: "user", parts: [{ text: "never mind" }] },
    { role: "model", parts: [{ text: "ok" }] },
  ])
  assert.equal(out[0].role, "user")
  assert.match(out[0].parts[0].text, /Continuing/)
  const i = out.findIndex((c) => c.parts.some((p) => p.functionResponse))
  assert.match(out[i].parts[0].functionResponse.response.result, /interrupted/)
  assert.equal(out[i + 1].parts[0].text, "never mind", "Gemini keeps what the user said in a turn of its own")
  assert.equal(out.at(-1).role, "user")
})

test("a Claude model keeps the answers and what the user said in one turn", () => {
  const out = history([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a")] },
    { role: "user", parts: [answer("a"), { text: "and also" }] },
  ], { claude: true })
  assert.equal(out.length, 3)
  assert.equal(out[2].parts.length, 2)
  const gem = history([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a")] },
    { role: "user", parts: [answer("a"), { text: "and also" }] },
  ])
  assert.equal(gem.length, 4)
})

// ---- thinking ---------------------------------------------------------------------------

test("Gemini 3 and later are told a level; Astra's budgets are the sizes of low, medium, high", () => {
  assert.equal(geminiGeneration("gemini-3.8-flash-high"), 3)
  assert.equal(geminiGeneration("gemini-2.5-flash"), 2)
  assert.equal(levelOf({ thinkingBudget: 0 }), "low")
  assert.equal(levelOf({ thinkingBudget: 1024 }), "low")
  assert.equal(levelOf({ thinkingBudget: 4096 }), "medium")
  assert.equal(levelOf({ thinkingBudget: 16384 }), "high")
  assert.equal(levelOf({ thinkingLevel: "MEDIUM" }), "medium")
  assert.deepEqual(generation({ thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } }, "gemini-3-flash").thinkingConfig, { includeThoughts: true, thinkingLevel: "medium" })
  // a Pro takes low and high, so a medium goes up
  assert.equal(generation({ thinkingConfig: { thinkingBudget: 4096 } }, "gemini-3-pro-high").thinkingConfig.thinkingLevel, "high")
  // an id that names its level is told that level and no other
  assert.equal(generation({ thinkingConfig: { thinkingBudget: 16384 } }, "gemini-3.7-flash-low").thinkingConfig.thinkingLevel, "low")
  // nothing asked, nothing sent
  assert.equal(generation({ temperature: 1 }, "gemini-3-flash").thinkingConfig, undefined)
})

test("Gemini 2.5 keeps its budget (a Flash's is capped); Claude thinks only where the id says; GPT-OSS never", () => {
  assert.deepEqual(generation({ thinkingConfig: { thinkingBudget: 30000 } }, "gemini-2.5-flash").thinkingConfig, { includeThoughts: true, thinkingBudget: 24576 })
  assert.equal(generation({ thinkingConfig: { thinkingBudget: 4096 } }, "claude-sonnet-4-6")?.thinkingConfig, undefined)
  const c = generation({ thinkingConfig: { thinkingBudget: 4096 }, maxOutputTokens: 2000 }, "claude-opus-4-6-thinking")
  assert.equal(c.thinkingConfig.thinkingBudget, 1999, "the answer has room past its thinking")
  assert.equal(generation({ thinkingConfig: { thinkingBudget: 4096 } }, "claude-opus-4-6-thinking").maxOutputTokens, 4096 + 32000)
  assert.equal(generation({ thinkingConfig: { thinkingBudget: 4096 } }, "gpt-oss-120b-medium")?.thinkingConfig, undefined)
  assert.equal(generation({ maxOutputTokens: 200000 }, "claude-sonnet-4-6").maxOutputTokens, 64000)
  assert.deepEqual(generation({}, "gemini-3.1-flash-image").responseModalities, ["TEXT", "IMAGE"])
})

// ---- the request -------------------------------------------------------------------------

test("Claude Code's words in the system prompt are broken, in the system prompt only", () => {
  assert.equal(cloak("x-anthropic-billing-header: cc"), "x​-anthropic-billing-header: cc")
  assert.equal(cloak("built on Anthropic's Claude Agent SDK."), "built on Anthropic's C\u200blaude Agent SDK.")
  const out = shape(geminiBody({ systemInstruction: { parts: [{ text: "x-anthropic-billing-header: a" }] }, contents: [{ role: "user", parts: [{ text: "x-anthropic-billing-header:" }] }] }), "gemini-3-flash")
  assert.equal(out.request.systemInstruction.parts[0].text, "x​-anthropic-billing-header: a")
  assert.equal(out.request.contents[0].parts[0].text, "x-anthropic-billing-header:")
})

test("tools: schemas flattened, Gemini's own tools dropped when functions are declared, a Claude config validated", () => {
  const body = geminiBody({
    tools: [{ functionDeclarations: [{ name: "ls", description: "d", parametersJsonSchema: { type: "object", properties: { p: { type: "string", format: "uri" } }, additionalProperties: false } }] }, { googleSearch: {} }],
  })
  const g = shape(body, "gemini-3-flash")
  assert.deepEqual(g.request.tools, [{ functionDeclarations: [{ name: "ls", description: "d", parameters: { type: "object", properties: { p: { type: "string" } } } }] }])
  assert.equal(g.request.toolConfig, undefined)
  const c = shape(body, "claude-sonnet-4-6")
  assert.equal(c.request.toolConfig.functionCallingConfig.mode, "VALIDATED")
  assert.equal(shape(geminiBody({ tools: [{ googleSearch: {} }] }), "gemini-3-flash").request.tools[0].googleSearch !== undefined, true)
  assert.equal(shape(geminiBody({ toolConfig: { functionCallingConfig: { mode: "ANY" } }, tools: body.tools }), "claude-sonnet-4-6").request.toolConfig.functionCallingConfig.mode, "ANY")
})

test("a bare family goes out as the variant of the level asked for", () => {
  const known = new Set(["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high", "gemini-3-flash"])
  assert.equal(resolveModel("gemini-3.7-flash", known, "medium"), "gemini-3.7-flash-medium")
  assert.equal(resolveModel("gemini-3.7-flash", known), "gemini-3.7-flash-high")
  assert.equal(resolveModel("gemini-3-flash", known, "low"), "gemini-3-flash")
  assert.equal(resolveModel("something-else", known), "something-else")
  assert.equal(resolveModel("x", undefined), "x")
  const out = shape(geminiBody({ generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }), "gemini-3.7-flash", { known })
  assert.equal(out.model, "gemini-3.7-flash-medium")
  assert.equal(out.request.generationConfig.thinkingConfig.thinkingLevel, "medium")
})

test("the envelope names the project and the app, and a conversation has one session", () => {
  const s = shape(geminiBody(), "gemini-3-flash")
  const env = envelope(s, "proj-1")
  assert.equal(env.project, "proj-1")
  assert.equal(env.userAgent, "antigravity")
  assert.equal(env.requestType, "agent")
  assert.match(env.requestId, /^agent-[0-9a-f-]{36}$/)
  assert.equal(env.model, "gemini-3-flash")
  assert.equal(env.request.sessionId, sessionOf([{ role: "user", parts: [{ text: "hi" }] }]))
  assert.match(env.request.sessionId, /^-\d+$/)
  assert.notEqual(sessionOf([{ role: "user", parts: [{ text: "other" }] }]), env.request.sessionId)
})

test("the User-Agent: version, platform, architecture", () => {
  assert.equal(userAgent("2.24.0", "darwin", "arm64"), "antigravity/hub/2.24.0 darwin/arm64")
  assert.equal(userAgent("2.24.0", "win32", "x64"), "antigravity/hub/2.24.0 windows/amd64")
})

// ---- the answer --------------------------------------------------------------------------

test("a stream is cut into events, a chunk unwrapped", () => {
  const got = splitEvents('data: {"a":1}\r\n\r\ndata: {"b":2}\n\ndata: {"c"')
  assert.deepEqual(got.events, ['{"a":1}', '{"b":2}'])
  assert.equal(got.rest, 'data: {"c"')
  assert.deepEqual(unwrap('{"response":{"candidates":[]},"traceId":"t"}'), { candidates: [] })
  assert.deepEqual(unwrap('{"error":{"message":"m"}}'), { error: { message: "m" } })
  assert.equal(unwrap("[DONE]"), null)
})

test("the stream goes out as Gemini's own, whatever way the bytes were cut", async () => {
  const body = reply("Hel").response
  const text = `data: ${JSON.stringify({ response: body, traceId: "t" })}\r\n\r\ndata: ${JSON.stringify(reply("lo", { finishReason: "STOP" }))}\r\n\r\n`
  const bytes = new TextEncoder().encode(text)
  const res = streamOf(new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close() } })))
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const events = splitEvents((await res.text()) + "\n\n").events.map((e) => JSON.parse(e))
  assert.equal(events.length, 2)
  assert.equal(events[0].candidates[0].content.parts[0].text, "Hel")
  assert.equal(events[1].candidates[0].finishReason, "STOP")
  assert.equal(events[0].traceId, undefined)
})

test("a reply that isn't streamed is the stream collected: text goes on text of its kind, a call stays whole", async () => {
  const chunks = [
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "think ", thought: true }] } }], modelVersion: "m1", responseId: "r1" } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "more", thought: true }, { text: "Hel" }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo", thoughtSignature: "SIG" }, { functionCall: { name: "ls", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4 } } },
  ]
  const res = await collect(sse(...chunks))
  const out = await res.json()
  assert.deepEqual(out.candidates[0].content.parts, [{ text: "think more", thought: true }, { text: "Hello", thoughtSignature: "SIG" }, { functionCall: { name: "ls", args: {} } }])
  assert.equal(out.candidates[0].finishReason, "STOP")
  assert.equal(out.modelVersion, "m1")
  assert.equal(out.usageMetadata.promptTokenCount, 4)
  assert.deepEqual(merge([]).candidates[0].content.parts, [])
})

test("a stream that says it failed is the failure", async () => {
  const res = await collect(sse({ error: { code: 503, message: "overloaded" } }))
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error.message, "overloaded")
})

test("a refusal is Gemini's error, with Retry-After for a limit that has a length", async () => {
  const res = failed(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } }))
  assert.equal(res.status, 429)
  assert.equal(res.headers.get("retry-after"), "12")
  const e = (await res.json()).error
  assert.equal(e.status, "RESOURCE_EXHAUSTED")
  assert.equal(e.message, "slow down")
})

// ---- a request, end to end ------------------------------------------------------------------

test("a streamed request goes to the daily host wrapped, and the answer comes back unwrapped", async () => {
  const calls = fake(() => sse(reply("Hi", { finishReason: "STOP" })))
  const creds = account({})
  const res = await chatFetch(creds, async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(res.status, 200)
  const [call] = calls
  assert.equal(call.url, `${DAILY}/v1internal:streamGenerateContent?alt=sse`)
  assert.equal(call.init.headers.Authorization, "Bearer AT")
  assert.match(call.init.headers["User-Agent"], /^antigravity\/hub\/2\.24\.0 /)
  const sent = JSON.parse(call.init.body)
  assert.equal(sent.project, "proj-1")
  assert.equal(sent.model, "gemini-3-flash")
  assert.equal(sent.request.contents[0].parts[0].text, "hi")
  const got = splitEvents((await res.text()) + "\n\n").events.map((e) => JSON.parse(e))
  assert.equal(got[0].candidates[0].content.parts[0].text, "Hi")
})

test("a request that isn't streamed asks for the stream and gives one reply", async () => {
  const calls = fake(() => sse(reply("Hel"), reply("lo", { finishReason: "STOP" })))
  const res = await chatFetch(account({}), async () => AUTH, AUTH, ...request("gemini-3-flash", "generateContent", geminiBody()))
  assert.match(calls[0].url, /streamGenerateContent\?alt=sse$/)
  const out = await res.json()
  assert.equal(out.candidates[0].content.parts[0].text, "Hello")
})

test("a host that is busy or down passes the request to the next, and is not asked first again once the other answered", async () => {
  let n = 0
  const calls = fake((u) => (u.startsWith(DAILY) ? json({ error: { message: "down" } }, 503) : (n++, sse(reply("ok")))))
  const creds = account({})
  const a = await chatFetch(creds, async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(a.status, 200)
  assert.deepEqual(calls.map((c) => c.url.split("/v1internal")[0]), [DAILY, PROD])
  const b = await chatFetch(creds, async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(b.status, 200)
  assert.equal(calls[2].url.split("/v1internal")[0], PROD)
  // restored for the tests that follow
  fake((u) => (u.startsWith(PROD) ? json({ error: { message: "down" } }, 503) : sse(reply("ok"))))
  await chatFetch(creds, async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(n, 2)
})

test("a token Google turns down is refreshed once, and the request asked again", async () => {
  const saved = []
  const client = { auth: { set: async (x) => saved.push(x.body) } }
  const calls = fake((u, init) => {
    if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "AT2", expires_in: 3600 })
    return init.headers.Authorization === "Bearer AT2" ? sse(reply("ok")) : json({ error: { status: "UNAUTHENTICATED", message: "expired" } }, 401)
  })
  const res = await chatFetch(account(client), async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(res.status, 200)
  assert.deepEqual(calls.map((c) => c.url.split("?")[0].replace(/^https:\/\/[^/]+/, "")), ["/v1internal:streamGenerateContent", "/token", "/v1internal:streamGenerateContent"])
  assert.equal(saved.at(-1).access, "AT2")
  assert.equal(saved.at(-1).refresh, "RT")
})

test("a short limit is waited out once; a long one is the caller's, with its length in Retry-After", async () => {
  const limit = (delay) => json({ error: { status: "RESOURCE_EXHAUSTED", message: "exhausted your capacity on this model", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } }, 429)
  const calls = fake([limit("0.2s"), sse(reply("ok"))])
  const a = await chatFetch(account({}), async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(a.status, 200)
  assert.equal(calls.length, 2)
  fake([limit("90s")])
  const b = await chatFetch(account({}), async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(b.status, 429)
  assert.equal(b.headers.get("retry-after"), "90")
})

test("a refusal that is the account's is answered as it is, with no second host asked", async () => {
  const calls = fake(() => json({ error: { message: "Verify your account", details: [{ metadata: { validation_url: "https://v.example/x" } }] } }, 403))
  const res = await chatFetch(account({}), async () => AUTH, AUTH, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(res.status, 403)
  assert.equal(calls.length, 1)
  assert.match((await res.json()).error.message, /https:\/\/v\.example\/x/)
})

test("what the plugin doesn't answer is said so; a sign-in Google turned down marks the account", async () => {
  const creds = account({})
  const nope = await chatFetch(creds, async () => AUTH, AUTH, "https://x/v1beta/models", { method: "GET" })
  assert.equal(nope.status, 404)
  const bad = await chatFetch(creds, async () => AUTH, AUTH, "https://x/v1beta/models/m:generateContent", { method: "POST", body: "not json" })
  assert.equal(bad.status, 400)
  const count = await chatFetch(creds, async () => AUTH, AUTH, ...request("gemini-3-flash", "countTokens", { contents: [{ role: "user", parts: [{ text: "x".repeat(40) }] }] }))
  assert.equal((await count.json()).totalTokens, 10)
  fake((u) => (u.includes("oauth2.googleapis.com/token") ? json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) : json({})))
  const expired = await chatFetch(account({}), async () => ({ ...AUTH, expires: 1 }), { ...AUTH, expires: 1 }, ...request("gemini-3-flash", "streamGenerateContent", geminiBody()))
  assert.equal(expired.status, 401)
  assert.equal(expired.headers.get("x-magpie-sign-in"), "expired")
})

// ---- the account ---------------------------------------------------------------------------

test("a sign-in is fresh until it is near its end", () => {
  assert.equal(fresh({ access: "a", expires: hours(1) }), true)
  assert.equal(fresh({ access: "a", expires: Date.now() + 60_000 }), false)
  assert.equal(fresh({ access: "", expires: hours(1) }), false)
  assert.equal(hasSignIn(AUTH), true)
  assert.equal(hasSignIn({ type: "api", key: "k" }), false)
})

test("refreshing keeps the refresh token Google doesn't send again; a refusal is the sign-in gone, a network failure is not", async () => {
  fake(() => json({ access_token: "AT2", expires_in: 1800 }))
  const c = await refresh({ access: "old", refresh: "RT", expires: 1 })
  assert.equal(c.access, "AT2")
  assert.equal(c.refresh, "RT")
  assert.ok(c.expires > Date.now() + 1700_000)
  fake(() => json({ error: "invalid_grant" }, 400))
  await assert.rejects(refresh({ refresh: "RT" }), (e) => e.signIn === "expired")
  globalThis.fetch = async () => {
    throw new Error("offline")
  }
  await assert.rejects(refresh({ refresh: "RT" }), (e) => e.signIn === undefined && /offline/.test(e.message))
})

test("the project is found once and kept: asked of Code Assist, the account set up when it has none", async () => {
  const calls = fake((u, init) => {
    if (u.includes("loadCodeAssist")) return json({ currentTier: { id: "free-tier", name: "Antigravity" }, allowedTiers: [{ id: "free-tier", isDefault: true }] })
    if (u.includes("onboardUser")) return json({ done: true, response: { cloudaicompanionProject: { id: "new-proj" } } })
    return json({})
  })
  const saved = []
  const creds = account({ auth: { set: async (x) => saved.push(x.body) } })
  const a = { ...AUTH, project: undefined }
  const got = await creds(a)
  assert.equal(got.project, "new-proj")
  assert.deepEqual(calls.map((c) => c.url.match(/:(\w+)$/)[1]), ["loadCodeAssist", "onboardUser"])
  assert.equal(JSON.parse(calls[1].init.body).tier_id, "free-tier")
  assert.equal(saved.at(-1).project, "new-proj")
  await creds(a)
  assert.equal(calls.length, 2, "asked once")
  assert.equal(defaultTier({ allowedTiers: [{ id: "legacy-tier", isDefault: true }] }), "free-tier")
  assert.equal(projectOf({ id: " p " }), "p")
  assert.equal(projectOf("q"), "q")
})

test("an account Code Assist has a project for isn't onboarded; one it won't serve says why", async () => {
  const calls = fake(() => json({ cloudaicompanionProject: "has-one", paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }))
  const s = await setup("AT")
  assert.equal(s.project, "has-one")
  assert.equal(s.plan, "Google AI Pro")
  assert.equal(calls.length, 1)
  fake((u) => (u.includes("onboardUser") ? json({ done: true, response: {} }) : json({ ineligibleTiers: [{ reasonMessage: "not available in your region" }] })))
  await assert.rejects(setup("AT"), /won't serve this Google account: not available in your region/)
})

test("renew gives only what changed, and nothing for a sign-in near its end that is still good", async () => {
  const creds = account({})
  assert.equal(await creds.renew({ type: "api" }), undefined)
  const good = await creds.renew(AUTH)
  assert.deepEqual(good, { access: "AT", expires: AUTH.expires })
  fake(() => json({ access_token: "AT2", expires_in: 3600 }))
  const near = await account({}).renew({ ...AUTH, access: "AT", expires: Date.now() + 5 * 60_000 })
  assert.equal(near.access, "AT2")
  assert.equal(near.project, undefined)
})

// ---- signing in -----------------------------------------------------------------------------

test("the sign-in page is Antigravity's client, offline, with PKCE", () => {
  const u = new URL(authorizeURL("http://localhost:51121/oauth-callback", "S", "V"))
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth")
  assert.equal(u.searchParams.get("client_id"), "test.apps.googleusercontent.com")
  assert.equal(u.searchParams.get("access_type"), "offline")
  assert.equal(u.searchParams.get("prompt"), "consent")
  assert.equal(u.searchParams.get("code_challenge_method"), "S256")
  assert.match(u.searchParams.get("scope"), /cclog/)
  assert.equal(u.searchParams.get("state"), "S")
})

test("a pasted address, query or code is read; another sign-in's, or Google's refusal, is not taken", () => {
  assert.deepEqual(readCode("4/0AbC-d", "S"), { code: "4/0AbC-d" })
  assert.deepEqual(readCode("http://localhost:51121/oauth-callback?state=S&code=4%2F0AbC&scope=x", "S"), { code: "4/0AbC" })
  assert.deepEqual(readCode("?code=c1&state=S", "S"), { code: "c1" })
  assert.match(readCode("http://localhost:51121/oauth-callback?state=OTHER&code=c", "S").error, /another sign-in/)
  assert.match(readCode("http://localhost:51121/oauth-callback?error=access_denied&state=S", "S").error, /access_denied/)
  assert.match(readCode("http://localhost:51121/oauth-callback?state=S", "S").error, /no code/)
  assert.match(readCode("", "S").error, /no code/)
})

// what Google's pages answer for a sign-in that succeeds
const googleAnswers = (u) => {
  if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
  if (u.includes("userinfo")) return json({ email: "me@example.com" })
  if (u.includes("loadCodeAssist")) return json({ cloudaicompanionProject: "proj-9", currentTier: { id: "free-tier", name: "Free" } })
  return json({})
}

test("the paste sign-in trades the code, names the account and finds its project", async () => {
  const calls = fake(googleAnswers)
  const a = await pasteSignIn()
  assert.equal(a.method, "code")
  const state = new URL(a.url).searchParams.get("state")
  const bad = await a.callback("http://localhost:51121/oauth-callback?state=nope&code=c")
  assert.equal(bad.type, "failed")
  const r = await a.callback(`http://localhost:51121/oauth-callback?state=${state}&code=abc`)
  assert.equal(r.type, "success")
  assert.equal(r.provider, "antigravity")
  assert.equal(r.accountId, "me@example.com")
  assert.equal(r.refresh, "RT")
  assert.equal(r.project, "proj-9")
  const form = new URLSearchParams(calls.find((c) => c.url.includes("/token")).init.body)
  assert.equal(form.get("code"), "abc")
  assert.equal(form.get("grant_type"), "authorization_code")
  assert.ok(form.get("code_verifier"))
  assert.equal(form.get("redirect_uri"), `http://localhost:${CALLBACK_PORTS[0]}/oauth-callback`)
})

test("a sign-in Google gave no refresh token for says what to do about it", async () => {
  fake((u) => (u.includes("/token") ? json({ access_token: "AT", expires_in: 3600 }) : json({})))
  const a = await pasteSignIn()
  const r = await a.callback("plain-code")
  assert.equal(r.type, "failed")
  assert.match(r.error, /refresh token/)
})

test("the browser sign-in listens for the redirect, and finishes when it comes", async () => {
  fake(googleAnswers)
  const a = await browserSignIn()
  const u = new URL(a.url)
  const redirect = new URL(u.searchParams.get("redirect_uri"))
  const hit = (path) => new Promise((resolve, reject) => get({ host: "127.0.0.1", port: redirect.port, path }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)) }).on("error", reject))
  assert.equal(await hit("/elsewhere"), 404)
  await hit(`/oauth-callback?state=wrong&code=zzz`)
  await hit(`/oauth-callback?state=${u.searchParams.get("state")}&code=abc`)
  const r = await a.callback()
  assert.equal(r.type, "success")
  assert.equal(r.accountId, "me@example.com")
})

// ---- models and the card --------------------------------------------------------------------

test("the list is Antigravity's own without what isn't for chat, in its picker's order", () => {
  const list = parseModels({
    models: {
      "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1000000, maxOutputTokens: 65535, supportsImages: true, quotaInfo: { remainingFraction: 0.4, resetTime: "2026-10-22T00:00:00Z" } },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", maxTokens: 250000, quotaInfo: { resetTime: "2026-10-22T05:00:00Z" } },
      chat_20706: { displayName: "internal" },
      tab_flash_lite_preview: { displayName: "tab" },
      "gemini-2.5-pro": { displayName: "moved" },
      "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["claude-sonnet-4-6", "gemini-3-flash"] }] }],
  })
  assert.deepEqual(list.map((m) => m.id), ["claude-sonnet-4-6", "gemini-3-flash", "gemini-3.1-flash-image"])
  assert.equal(list[0].remaining, 0, "a model with none of its allowance left has no fraction")
  assert.equal(list[0].reasoning, false)
  assert.equal(list[1].images, true)
  assert.equal(list[1].reasoning, true)
  assert.equal(list[2].remaining, -1)
})

test("ids that are levels of one model", () => {
  assert.equal(levelOfId("gemini-3.7-flash-low"), "low")
  assert.equal(levelOfId("gemini-3.5-flash-extra-low"), "minimal")
  assert.equal(levelOfId("gemini-3-flash"), "")
  assert.equal(familyOf("claude-opus-5-5-high"), "claude-opus-5-5")
  assert.equal(thinks("claude-opus-5-5-high"), true)
  assert.equal(thinks("claude-sonnet-4-6"), false)
  assert.equal(thinks("gemini-3.1-flash-image"), false)
  assert.equal(runtimeModel({ id: "x", name: "X", reasoning: true }).capabilities.reasoning, true)
})

test("the card is a window for each family of models, as full as the fullest of them is", () => {
  const models = parseModels({ models: {
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-22T05:00:00Z" } },
    "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-22T05:00:00Z" } },
    "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 1, resetTime: "2026-10-22T00:00:00Z" } },
    "gemini-3-pro-high": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-22T01:00:00Z" } },
  } })
  const load = { paidTier: { id: "g1-pro-tier", name: "Google AI Pro", availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "1000" }] } }
  const card = usageOf(models, load, "me@example.com")
  assert.equal(card.plan, "Google AI Pro")
  assert.equal(card.user, "me@example.com")
  assert.equal(card.balance, "1,000 AI credits")
  const by = Object.fromEntries(card.windows.map((w) => [w.name, w]))
  assert.equal(by["Claude and GPT-OSS"].used, 75)
  assert.equal(by["Claude and GPT-OSS"].display, "25% left")
  assert.deepEqual(by["Claude and GPT-OSS"].models.sort(), ["claude-opus-4-6-thinking", "claude-sonnet-4-6"])
  assert.equal(by["Gemini Flash"].used, 0)
  assert.equal(by["Gemini Pro"].resetsAt, "2026-10-22T01:00:00Z")
  assert.equal(planName({ paidTier: { id: "g1-ultra-lite-tier" } }), "Ultra")
  assert.equal(planName({ currentTier: { id: "free-tier" } }), "Free")
  assert.equal(planName(null), "")
  assert.equal(balanceOf({ paidTier: { availableCredits: [{ creditType: "X", creditAmount: "0" }] } }), "")
})

test("usage reads the models and the plan, and says the sign-in is gone when it is", async () => {
  const h = await AntigravityAuthPlugin({ client: {} })
  fake((u) => (u.includes("fetchAvailableModels") ? json({ models: { "gemini-3-flash": { displayName: "F", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-22T00:00:00Z" } } } }) : json({ currentTier: { id: "free-tier" } })))
  const u = await h.auth.usage(async () => ({ ...AUTH, accountId: "me@example.com" }))
  assert.equal(u.plan, "Free")
  assert.equal(u.windows[0].used, 50)
  assert.equal(u.signIn, "kept")
  fake(() => json({ error: "invalid_grant" }, 400))
  const gone = await h.auth.usage(async () => ({ ...AUTH, refresh: "RT-gone", expires: 1 }))
  assert.equal(gone.signIn, "expired")
  assert.equal((await h.auth.usage(async () => undefined)).error, "not signed in")
})

test("a tool's answer is read from result: Gemini CLI's output and an error's words are moved there", () => {
  const out = history([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [call("a"), call("b"), call("c")] },
    { role: "user", parts: [{ functionResponse: { name: "a", response: { output: "fine" } } }, { functionResponse: { name: "b", response: { error: "boom" } } }, { functionResponse: { name: "c", response: { result: "kept", extra: 1 } } }] },
  ])
  const r = out[2].parts.map((p) => p.functionResponse.response)
  assert.deepEqual(r, [{ result: "fine" }, { result: "boom" }, { result: "kept", extra: 1 }])
})

test("an account's list is asked for once in a while, however often the host wants it", async () => {
  const calls = fake(() => json({ models: { "gemini-3-flash": { displayName: "F" } } }))
  const c = { token: "AT", project: "p-list", tier: "", paid: "" }
  const [a, b] = await Promise.all([listModels(c), listModels(c)])
  assert.equal(a, b)
  await listModels(c)
  assert.equal(calls.length, 1)
  await listModels({ ...c, project: "other" })
  assert.equal(calls.length, 2)
  fake(() => json({ models: {} }))
  await assert.rejects(listModels({ ...c, project: "empty" }), /listed no models/)
  await assert.rejects(listModels({ ...c, project: "empty" }), /listed no models/, "a failure isn't kept")
})
