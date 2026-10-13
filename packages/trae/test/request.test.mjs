import test from "node:test"
import assert from "node:assert/strict"
import { chatBody, conversationID, partText, sessionOf, traeMessages, uuidOf } from "../src/request.mjs"
import { nativeTools, toolNamed, toolPrompt, unwrapped } from "../src/tools.mjs"
import { ideHeaders } from "../src/api.mjs"
import { ugHeaders, ugPage, ugUA } from "../src/checkin.mjs"
import { SITES } from "../src/sites.mjs"
import { authorizationUrl } from "../src/signin.mjs"

const site = SITES["trae-cn"]
const bash = { type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } }

test("partText: strings, text parts, images named, anything else empty", () => {
  assert.equal(partText("hi"), "hi")
  assert.equal(partText(null), "")
  assert.equal(partText([{ type: "text", text: "a" }, { type: "input_text", text: "b" }, { type: "image_url" }, { type: "audio" }]), "a\nb\n[an image, which this model can't see]")
})

test("traeMessages: developer is system, empty messages drop, same roles merge, tools go in as text", () => {
  const msgs = traeMessages({
    messages: [
      { role: "developer", content: "be brief" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "", tool_calls: [{ id: "k1", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "k1", content: "file.txt" },
      { role: "assistant", content: "" },
    ],
  })
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.equal(msgs[1].content[0].text, "a\n\nb")
  assert.equal(msgs[2].content[0].text, '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>')
  assert.equal(msgs[3].content[0].text, "Result of bash (call k1):\nfile.txt")
})

test("traeMessages: the tool prompt leads when tools are given, and not for tool_choice none", () => {
  const withTools = traeMessages({ messages: [{ role: "user", content: "x" }], tools: [bash], tool_choice: "required", parallel_tool_calls: false })
  assert.equal(withTools[0].role, "system")
  const prompt = withTools[0].content[0].text
  assert.match(prompt, /Call at most one tool at a time\./)
  assert.match(prompt, /Call a tool before answering\./)
  assert.match(prompt, /"name":"bash"/)
  const none = traeMessages({ messages: [{ role: "user", content: "x" }], tools: [bash], tool_choice: "none" })
  assert.equal(none.length, 1)
  assert.match(toolPrompt([bash], { function: { name: "bash" } }), /Call the tool bash before answering\./)
})

test("nativeTools: parameters go as a JSON string", () => {
  const [t] = nativeTools([bash, { name: "flat", parameters: "{}" }])
  assert.equal(t.function.parameters, JSON.stringify(bash.function.parameters))
  assert.equal(nativeTools([{ name: "flat", parameters: "{}" }])[0].function.parameters, "{}")
})

test("chatBody: model, function, model_name, session and the reply limit", () => {
  const req = { model: "glm-5", messages: [{ role: "user", content: "hi" }], max_tokens: 5000, temperature: 0.3 }
  const body = chatBody(req, "chat_v3", "glm-5__dev", 4000, null, "SESSION")
  assert.equal(body.function, "chat_v3")
  assert.equal(body.config_name, "glm-5")
  assert.equal(body.model, "glm-5")
  assert.equal(body.model_name, "glm-5__dev")
  assert.equal(body.max_tokens, 4000) // held to the model's own limit
  assert.equal(body.temperature, 0.3)
  assert.equal(body.session_id, "SESSION")
  assert.notEqual(body.request_id, body.session_id)
  assert.equal(body.stream, true)
  assert.equal(chatBody({ ...req, max_tokens: 100.7 }, "chat_v3", "", 0).max_tokens, 100)
  assert.equal("model_name" in chatBody(req, "chat_v3", "", 0), false)
})

test("chatBody: a Max model asks its base, with the window less the reply as the prompt room", () => {
  const body = chatBody({ model: "m-max", messages: [] }, "solo_agent", "m__max", 64000, { base: "m", window: 500000 }, "")
  assert.equal(body.config_name, "m")
  assert.equal(body.max_tokens, 64000)
  assert.deepEqual(body.user_message_context, { model_info: { prompt_max_tokens: 436000 } })
  assert.match(body.session_id, /^[0-9a-f-]{36}$/)
})

test("chatBody: tools go natively, tool_choice by name", () => {
  const body = chatBody({ model: "m", messages: [], tools: [bash], tool_choice: { function: { name: "bash" } }, parallel_tool_calls: false }, "chat_v3", "")
  assert.equal(body.tools[0].function.name, "bash")
  assert.equal(body.tool_choice, "bash")
  assert.equal(body.parallel_tool_calls, false)
  assert.equal("tools" in chatBody({ model: "m", messages: [], tools: [bash], tool_choice: "none" }, "chat_v3", ""), false)
})

test("conversationID: the session or the first user message, per account; empty when neither", () => {
  const chat = { messages: [{ role: "system", content: "s" }, { role: "user", content: "first" }, { role: "user", content: "second" }] }
  const a = conversationID(chat, "", "u1")
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(a, conversationID({ messages: [...chat.messages, { role: "assistant", content: "x" }] }, "", "u1"))
  assert.notEqual(a, conversationID(chat, "", "u2"))
  assert.equal(conversationID(chat, "S", "u1"), conversationID({ messages: [] }, "S", "u1"))
  assert.notEqual(conversationID(chat, "S", "u1"), a)
  assert.equal(conversationID({ messages: [{ role: "assistant", content: "x" }] }, "", "u1"), "")
  assert.equal(conversationID(null, "", ""), "")
  assert.equal(uuidOf("x"), uuidOf("x"))
})

test("sessionOf: takes the header off and caps it", () => {
  const h = new Headers({ "x-magpie-trae-session": " " + "a".repeat(200) + " " })
  assert.equal(sessionOf(h).length, 128)
  assert.equal(h.has("x-magpie-trae-session"), false)
  assert.equal(sessionOf(new Headers()), "")
})

test("toolNamed and unwrapped: a name matched loosely, a layer taken off", () => {
  const tools = [{ type: "function", function: { name: "list_files", parameters: { properties: { path: {} } } } }, { name: "args", parameters: { properties: { args: {} } } }]
  assert.equal(toolNamed("List-Files", tools), "list_files")
  assert.equal(toolNamed("nothing", tools), "nothing")
  assert.equal(toolNamed("x", []), "x")
  assert.equal(unwrapped('{"arguments":{"path":"a"}}', "list_files", tools), '{"path":"a"}')
  assert.equal(unwrapped('{"arguments":"{\\"path\\":\\"a\\"}"}', "list_files", tools), '{"path":"a"}')
  assert.equal(unwrapped('{"args":{"x":1}}', "args", tools), '{"args":{"x":1}}') // the tool has a parameter of that name
  assert.equal(unwrapped('{"a":1}', "unknown", tools), '{"a":1}')
})

test("ideHeaders: the JWT three ways, the device and the client's version", () => {
  const h = ideHeaders({ token: "T", uid: "u", deviceId: "d", machineId: "m" }, site, { Accept: "x" })
  assert.equal(h.Authorization, "Cloud-IDE-JWT T")
  assert.equal(h["X-Cloudide-Token"], "T")
  assert.equal(h["x-ide-token"], "T")
  assert.equal(h["x-device-id"], "d")
  assert.equal(h["x-app-version"], "0.1.69")
  assert.equal(h["x-app-version-code"], "20260917")
  assert.equal(h.Accept, "x")
  assert.match(h["x-request-id"], /^[0-9a-f-]{36}$/)
})

test("ugHeaders: only the IDE's growth-page headers, with a client's User-Agent", () => {
  const h = ugHeaders({ token: "T", deviceId: "d" }, site)
  assert.match(h["User-Agent"], /TRAE-SOLO-CN\/0\.1\.69 .*Electron/)
  assert.equal(h["User-Agent"], ugUA(site))
  assert.equal("x-ide-token" in h, false)
  assert.equal(ugPage("https://api.trae.cn/trae/api/v2/ug/checkin_credits/status"), true)
  assert.equal(ugPage("https://api.trae.cn/trae/api/v2/pay/x"), false)
  assert.equal(ugPage("not a url"), false)
})

test("authorizationUrl: the realm's page, the device named, the callback and enterprise sign-in on", () => {
  const url = new URL(authorizationUrl(site, { deviceId: "D", machineId: "M" }, "TRACE", "http://127.0.0.1:1/authorize"))
  assert.equal(url.origin + url.pathname, "https://www.trae.cn/authorization")
  assert.equal(url.searchParams.get("device_id"), "D")
  assert.equal(url.searchParams.get("x_machine_id"), "M")
  assert.equal(url.searchParams.get("login_trace_id"), "TRACE")
  assert.equal(url.searchParams.get("auth_callback_url"), "http://127.0.0.1:1/authorize")
  assert.equal(url.searchParams.get("hide_saas_login"), "false")
  assert.equal(url.searchParams.get("x_app_version"), "3.3.65")
  assert.equal(new URL(authorizationUrl(SITES["trae-global"], { deviceId: "D", machineId: "M" }, "T", "http://x")).origin, "https://www.trae.ai")
})
