import test from "node:test"
import assert from "node:assert/strict"
import { ZenFreePlugin } from "../src/index.mjs"
import { SDK } from "../src/constants.mjs"
import { buildModels, isFree, parseProtocolDocs, configModels, bootstrapProvider } from "../src/models.mjs"
import { normalizeTools, sessionID, upstreamHeaders, httpURL, requirePublic } from "../src/request.mjs"
import { nameGuard } from "../src/tool-names.mjs"
import { collapseResponse } from "../src/collapse.mjs"
import { guardToolResponse } from "../src/guard.mjs"

const sse = (events, headers = {}) =>
  new Response(events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  })

test("free and retired models", () => {
  assert.equal(isFree("big-pickle", { cost: { input: 0, output: 0 } }), true)
  assert.equal(isFree("x-free"), true)
  assert.equal(isFree("paid", { cost: { input: 1, output: 2 } }), false)
  assert.equal(isFree("x-free", { status: "retired" }), false)
  assert.equal(isFree("x-free", { deprecated: true }), false)
})

test("the docs table gives each model's protocol", () => {
  const docs = "| Big Pickle | big-pickle | `https://opencode.ai/zen/v1/chat/completions` |\n| S | `muse` | `https://opencode.ai/zen/v1/responses` |"
  assert.deepEqual(parseProtocolDocs(docs), { "big-pickle": "chat", muse: "responses" })
})

test("buildModels keeps free models of a known protocol, with limits and variants", () => {
  const models = buildModels(Object.keys(bootstrapProvider.models).concat("__proto__", "nope"), bootstrapProvider, {}, "http://z/v1")
  assert.deepEqual(Object.keys(models), ["big-pickle", "space-bunny-free", "muse-spark-1.3-contributor-free"])
  const muse = models["muse-spark-1.3-contributor-free"]
  assert.equal(muse.api.npm, SDK.responses)
  assert.deepEqual(Object.keys(muse.variants), ["minimal", "low", "medium", "high", "xhigh"])
  assert.equal(muse.capabilities.input.pdf, true)
  assert.equal(models["big-pickle"].capabilities.input.image, false)
  assert.equal(models["big-pickle"].limit.input, 160000)
  const config = configModels(models)
  assert.deepEqual(config["muse-spark-1.3-contributor-free"].modalities.input, ["text", "image", "audio", "video", "pdf"])
})

test("httpURL and the public credential", () => {
  assert.equal(httpURL("https://a.b/zen/v1//"), "https://a.b/zen/v1")
  assert.throws(() => httpURL("https://u:p@a.b/"))
  assert.throws(() => httpURL("ftp://a.b/"))
  requirePublic({ type: "api", key: "public" })
  assert.throws(() => requirePublic({ type: "api", key: "other" }))
})

test("normalizeTools stubs the core tools the agent did not declare", () => {
  const body = { tools: [{ type: "function", function: { name: "bash" } }] }
  const { declared, injected } = normalizeTools(body, "chat")
  assert.deepEqual([...declared], ["bash"])
  assert.deepEqual([...injected], ["edit", "glob", "grep", "read"])
  assert.equal(body.tools.length, 5)
  assert.equal(body.tools[1].function.parameters.additionalProperties, false)
  const anthropic = { tools: [] }
  normalizeTools(anthropic, "anthropic")
  assert.ok(anthropic.tools[0].input_schema)
  assert.throws(() => normalizeTools({ tools: {} }, "chat"), /array/)
})

test("sessionID: a canonical id is kept, anything else is hashed stably", () => {
  const canonical = "ses_0123456789abABCDEFGHIJKLMN"
  assert.equal(sessionID(new Headers({ "x-session-id": canonical }), {}), canonical)
  const a = sessionID(new Headers(), { messages: [{ role: "user", content: "hi" }] })
  assert.match(a, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(a, sessionID(new Headers(), { messages: [{ role: "user", content: "hi" }] }))
  assert.notEqual(a, sessionID(new Headers(), { messages: [{ role: "user", content: "ho" }] }))
})

test("upstreamHeaders drops the caller's credentials and adds OpenCode's identity", () => {
  const request = new Request("http://z/v1/messages", { method: "POST", headers: { authorization: "Bearer mine", cookie: "c" } })
  const headers = upstreamHeaders(request, {}, "anthropic", { vcs: "git", id: "p1" })
  assert.equal(headers.get("x-api-key"), "public")
  assert.equal(headers.get("authorization"), null)
  assert.equal(headers.get("cookie"), null)
  assert.equal(headers.get("anthropic-version"), "2023-06-01")
  assert.equal(headers.get("x-opencode-project"), "p1")
  assert.equal(headers.get("x-session-id"), headers.get("x-opencode-session"))
  assert.equal(upstreamHeaders(request, {}, "chat").get("authorization"), "Bearer public")
  assert.equal(upstreamHeaders(request, {}, "chat").get("x-opencode-project"), "global")
})

test("tool names fold by case, then by separators, never between two", () => {
  const check = nameGuard({ declared: ["Bash", "todo_write", "a_b", "a-b"] })
  assert.equal(check("bash"), "Bash")
  assert.equal(check("todowrite"), "todo_write")
  assert.equal(check("todo_write"), "todo_write")
  assert.throws(() => check("ab"), /not declared/)
  assert.throws(() => check("unknown"), /not declared/)
})

test("collapse: a chat stream becomes one completion", async () => {
  const res = await collapseResponse(
    sse([
      { id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo", tool_calls: [{ index: 0, id: "t", function: { name: "ba", arguments: "{" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "sh", arguments: "}" } }] }, finish_reason: "tool_calls" }], usage: { total_tokens: 3 } },
      "data: [DONE]\n\n",
    ]),
    "chat",
  )
  const body = await res.json()
  assert.equal(res.headers.get("content-type"), "application/json")
  assert.equal(body.choices[0].message.content, "Hello")
  assert.deepEqual(body.choices[0].message.tool_calls, [{ type: "function", id: "t", function: { name: "bash", arguments: "{}" } }])
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.equal(body.usage.total_tokens, 3)
})

test("collapse: anthropic tool input is assembled and an unfinished stream is a 502", async () => {
  const ok = await collapseResponse(
    sse([
      { type: "message_start", message: { id: "m1", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "x" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]),
    "anthropic",
  )
  const body = await ok.json()
  assert.deepEqual(body.content[0].input, { a: 1 })
  assert.equal(body.stop_reason, "tool_use")
  const cut = await collapseResponse(sse([{ type: "message_start", message: {} }]), "anthropic")
  assert.equal(cut.status, 502)
  assert.equal((await cut.json()).error.message, "Upstream SSE ended without a completion marker")
})

test("collapse: an error event is refused in the protocol's shape; a JSON reply passes through", async () => {
  const bad = await collapseResponse(sse(["event: error\ndata: boom\n\n"]), "responses")
  assert.equal(bad.status, 502)
  assert.deepEqual((await bad.json()).error, { type: "upstream_error", message: "boom", param: null, code: null })
  const json = new Response("{}", { headers: { "content-type": "application/json" } })
  assert.equal(await collapseResponse(json, "chat"), json)
})

test("guard: a JSON reply calling an undeclared tool is a 502; a case variant is renamed", async () => {
  const reply = (name) =>
    new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: "{}" } }] } }] }), {
      headers: { "content-type": "application/json", "content-length": "1" },
    })
  const policy = { declared: new Set(["Read"]) }
  const renamed = await guardToolResponse(reply("read"), "chat", policy)
  assert.equal((await renamed.json()).choices[0].message.tool_calls[0].function.name, "Read")
  const refused = await guardToolResponse(reply("rm"), "chat", policy)
  assert.equal(refused.status, 502)
  assert.match((await refused.json()).error.message, /not declared/)
})

test("guard: a chat stream's tool call is held until finished, renamed and released", async () => {
  const res = await guardToolResponse(
    sse([
      { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t", function: { name: "tod", arguments: "{" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "owrite", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
      "data: [DONE]\n\n",
    ]),
    "chat",
    { declared: new Set(["todo_write"]) },
  )
  const text = await res.text()
  const events = text.split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)))
  assert.equal(events.length, 1)
  assert.equal(events[0].choices[0].delta.tool_calls[0].function.name, "todo_write")
  assert.equal(events[0].choices[0].delta.tool_calls[0].function.arguments, "{}")
  assert.ok(text.endsWith("data: [DONE]\n\n"))
})

test("guard: an undeclared tool in a stream ends it with an error event", async () => {
  const res = await guardToolResponse(
    sse([{ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "rm" } }]),
    "anthropic",
    { declared: new Set(["Read"]) },
  )
  const text = await res.text()
  assert.match(text, /^event: error\ndata: /)
  assert.match(text, /not declared by the client/)
})

test("the plugin: config, sign-in and a streamed request collapsed to JSON with Zen's headers", async () => {
  const hooks = await ZenFreePlugin({ project: { vcs: "git", id: "proj" } })
  const cfg = {}
  await hooks.config(cfg)
  assert.ok(cfg.provider["opencode-zen-free"].models["big-pickle"])
  assert.deepEqual(await hooks.auth.methods[0].authorize(), { type: "success", key: "public" })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return sse([{ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "data: [DONE]\n\n"])
  }
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "public" }))
  const res = await loaded.fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal((await res.json()).choices[0].message.content, "ok")
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.stream_options, { include_usage: true })
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer public")
  assert.equal(calls[0].init.headers.get("x-opencode-project"), "proj")
  await assert.rejects(() => loaded.fetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "nope" }) }).catch((e) => {
    throw e
  }))
  await assert.rejects(() => hooks.auth.loader(async () => ({ type: "api", key: "mine" })), /public credential/)
})
