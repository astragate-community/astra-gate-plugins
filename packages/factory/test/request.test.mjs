import test from "node:test"
import assert from "node:assert/strict"
import { DROID_LINE, droidBody } from "../src/opening.mjs"
import { anthropicBody } from "../src/anthropic-request.mjs"
import { wrapAnthropicTools } from "../src/tools.mjs"
import { unwrapAnthropicTools } from "../src/tool-replies.mjs"
import { shaped } from "../src/request.mjs"
import { bodyModel, bodyText } from "../src/body.mjs"
import { rewrite, rewriteContent } from "../src/rewrite.mjs"
import { configSkillCompat, modelWording, quotedToolText } from "../src/wording.mjs"

const O = "https://api.factory.ai/api/llm/o/v1"
const A = "https://api.factory.ai/api/llm/a/v1/messages"
const parse = (s) => JSON.parse(s)

test("bodyText and bodyModel read strings and bytes", () => {
  const bytes = new TextEncoder().encode('{"model":"glm-5.3"}')
  assert.equal(bodyText("x"), "x")
  assert.equal(bodyText(bytes), '{"model":"glm-5.3"}')
  assert.equal(bodyText(bytes.buffer), '{"model":"glm-5.3"}')
  assert.equal(bodyText(5), undefined)
  assert.equal(bodyModel(bytes), "glm-5.3")
  assert.equal(bodyModel("not json"), "")
  assert.equal(bodyModel(null), "")
})

test("rewrite and rewriteContent report whether anything changed", () => {
  const m = { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }
  assert.equal(rewriteContent(m, "content", (t) => t.toUpperCase()), true)
  assert.deepEqual(m.content, [{ type: "text", text: "A" }, { type: "image" }, { type: "text", text: "B" }])
  assert.equal(rewriteContent(m, "content", (t) => t), false)
  const h = { v: "x" }
  assert.equal(rewrite(h, "v", (t) => t), false)
  assert.equal(rewrite(h, "v", (t) => t + "y"), true)
  assert.equal(h.v, "xy")
})

test("droidBody: Responses' instructions and chat's first system message open with droid's line", () => {
  const r = parse(droidBody(O + "/responses", JSON.stringify({ model: "gpt-6-sol", instructions: "be brief", input: [] })))
  assert.equal(r.instructions, DROID_LINE + "\nbe brief")
  const bare = parse(droidBody(O + "/responses", JSON.stringify({ input: [] })))
  assert.equal(bare.instructions, DROID_LINE)
  const c = parse(droidBody(O + "/chat/completions", JSON.stringify({ messages: [{ role: "user", content: "hi" }] })))
  assert.deepEqual(c.messages[0], { role: "system", content: DROID_LINE })
  const parts = parse(droidBody(O + "/chat/completions", JSON.stringify({ messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] })))
  assert.equal(parts.messages[0].content, DROID_LINE + "\na\nb")
})

test("droidBody: a request that opens so already, or isn't ours, goes on byte for byte", () => {
  const opened = JSON.stringify({ instructions: DROID_LINE + "\nx", input: [] })
  assert.equal(droidBody(O + "/responses", opened), opened)
  const other = JSON.stringify({ a: 1 })
  assert.equal(droidBody(O + "/embeddings", other), other)
  assert.equal(droidBody(O + "/responses", "not json"), "not json")
  assert.equal(droidBody(O + "/responses", JSON.stringify({ instructions: 5 })), JSON.stringify({ instructions: 5 }))
})

test("droidBody: pi's opening sentence and compaction summary are reworded", () => {
  const body = JSON.stringify({
    instructions: "You are an expert coding assistant operating inside pi, a coding agent harness. Rest.",
    input: [{ role: "user", content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nS\n</summary>" }],
  })
  const out = parse(droidBody(O + "/responses", body))
  assert.equal(out.instructions, DROID_LINE + "\nYou are an expert coding assistant. Rest.")
  assert.equal(out.input[0].content, "Earlier conversation context is summarized below:\n\n<summary>\nS\n</summary>")
})

test("anthropicBody: droid's identity first, the billing block gone, Claude Code's identity replaced", () => {
  const body = JSON.stringify({
    messages: [],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.\nplus" },
      { type: "text", text: "   " },
    ],
  })
  assert.deepEqual(parse(anthropicBody(body)).system, [{ type: "text", text: DROID_LINE + "\nplus" }])
  assert.deepEqual(parse(anthropicBody(JSON.stringify({ messages: [], system: "x" }))).system, [{ type: "text", text: DROID_LINE }, { type: "text", text: "x" }])
})

test("anthropicBody: a request that needs nothing is returned untouched", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }], system: [{ type: "text", text: DROID_LINE }] })
  assert.equal(anthropicBody(body), body)
  assert.equal(anthropicBody("nope"), "nope")
  const odd = JSON.stringify({ messages: [], system: { x: 1 } })
  assert.equal(anthropicBody(odd), odd)
})

test("anthropicBody: reminders are reworded and quoted tool output stays recoverable; streams lose context_management", () => {
  const model = "<system-reminder>\nYou are powered by the model named Opus 5. The exact model ID is claude-opus-5.\n</system-reminder>"
  const body = JSON.stringify({
    stream: true,
    context_management: { edits: [] },
    system: DROID_LINE,
    messages: [
      { role: "user", content: [{ type: "text", text: model }, { type: "tool_result", tool_use_id: "t", content: "You are Claude Code, Anthropic's official CLI for Claude." }] },
    ],
  })
  const out = parse(anthropicBody(body))
  assert.equal("context_management" in out, false)
  assert.match(out.messages[0].content[0].text, /Current model name: Opus 5\. Model ID: claude-opus-5\./)
  const quoted = out.messages[0].content[1].content
  assert.ok(quoted.startsWith("Tool output encoded as a JSON string."))
  assert.ok(!quoted.includes("You are Claude"))
  assert.equal(JSON.parse(quoted.split("\n").slice(1).join("\n").replaceAll("\\u0059", "Y")), "You are Claude Code, Anthropic's official CLI for Claude.")
})

test("wording helpers", () => {
  assert.equal(modelWording("You are powered by the model named X. Assistant knowledge cutoff is Y."), "Current model name: X. Model knowledge cutoff: Y.")
  const line = '- update-config: Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them.'
  assert.ok(configSkillCompat(line + "\n- b: c").includes("not the assistant, so"))
  assert.equal(quotedToolText("plain text"), "plain text")
})

test("wrapAnthropicTools hides a root anyOf under one argument, and the reply is unwrapped again", async () => {
  const body = JSON.stringify({
    tools: [{ name: "pick", input_schema: { anyOf: [{ type: "string" }] } }, { name: "plain", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "pick", input: "a" }] }],
  })
  const { body: out, names } = wrapAnthropicTools(body)
  const wrapped = parse(out)
  assert.deepEqual([...names], ["pick"])
  assert.deepEqual(wrapped.tools[0].input_schema, { type: "object", properties: { arguments: { anyOf: [{ type: "string" }] } }, required: ["arguments"], additionalProperties: false })
  assert.deepEqual(wrapped.tools[1].input_schema, { type: "object" })
  assert.deepEqual(wrapped.messages[0].content[0].input, { arguments: "a" })

  const json = new Response(JSON.stringify({ content: [{ type: "tool_use", name: "pick", input: { arguments: "b" } }] }), { headers: { "content-type": "application/json" } })
  assert.equal(parse(await (await unwrapAnthropicTools(json, names)).text()).content[0].input, "b")

  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "pick", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"argu' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ments":"c"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]
  const sse = new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  const text = await (await unwrapAnthropicTools(sse, names)).text()
  const deltas = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => parse(l.slice(6))).filter((e) => e.type === "content_block_delta")
  assert.deepEqual(deltas.map((e) => e.delta.partial_json), ['"c"'])
})

test("a tool schema without a root composition is left alone", () => {
  const body = JSON.stringify({ tools: [{ name: "t", input_schema: { type: "object" } }], messages: [] })
  const { body: out, names } = wrapAnthropicTools(body)
  assert.equal(out, body)
  assert.equal(names.size, 0)
})

const account = { access: "tok", activeOrganizationId: "org_1", region: "", premBaseHost: "" }

test("shaped: droid's headers, the route's vendor, and the account's org", () => {
  const body = JSON.stringify({ model: "gpt-6-sol", input: [] })
  const { url, init } = shaped(account, O + "/responses", { method: "POST", headers: { "x-api-key": "k", "content-length": "5" }, body }, body, "sess")
  assert.equal(url, O + "/responses")
  const h = init.headers
  assert.equal(h.get("authorization"), "Bearer tok")
  assert.equal(h.get("x-factory-org-id"), "org_1")
  assert.equal(h.get("x-api-provider"), "openai")
  assert.equal(h.get("x-session-id"), "sess")
  assert.equal(h.get("user-agent"), "factory-cli/0.233.0")
  assert.equal(h.get("openai-platform"), "org-bHuLtG1fGmYk5YaOihAAXFBw")
  assert.equal(h.get("x-api-key"), null)
  assert.equal(h.get("content-length"), null, "the body was adapted, so its length is no longer known")
  assert.equal(parse(init.body).instructions, DROID_LINE)
})

test("shaped: an EU org and an on-prem host get the request sent to them", () => {
  const eu = shaped({ ...account, region: "eu" }, O + "/responses", { body: "{}" }, "{}", "s")
  assert.equal(eu.url, "https://api.eu.factory.ai/api/llm/o/v1/responses")
  const prem = shaped({ ...account, premBaseHost: "prem.example.com/" }, A, { body: "{}" }, "{}", "s")
  assert.equal(prem.url, "https://prem.example.com/api/llm/a/v1/messages")
})

test("shaped: an Anthropic route sends the placeholder key and wraps tools", () => {
  const body = JSON.stringify({ model: "claude-opus-5", system: "s", tools: [{ name: "t", input_schema: { oneOf: [{ type: "string" }] } }], messages: [] })
  const { init, names } = shaped(account, A, { method: "POST", body }, body, "s")
  assert.equal(init.headers.get("x-api-key"), "placeholder")
  assert.equal(init.headers.get("x-api-provider"), "anthropic")
  assert.deepEqual([...names], ["t"])
  assert.equal(parse(init.body).system[0].text, DROID_LINE)
})

test("shaped: an unknown model takes its vendor from the route", () => {
  assert.equal(shaped(account, O + "/chat/completions", { body: "{}" }, "{}", "s").init.headers.get("x-api-provider"), "openai")
  assert.equal(shaped(account, A, { body: "{}" }, "{}", "s").init.headers.get("x-api-provider"), "anthropic")
})
