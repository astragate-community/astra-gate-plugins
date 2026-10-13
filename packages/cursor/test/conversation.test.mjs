import test from "node:test"
import assert from "node:assert/strict"
import { conversation, toolsOf, joinSplitCalls, catalog } from "../src/conversation.mjs"
import { NO_RESULT, CALL } from "../src/constants.mjs"

const fn = (name, parameters) => ({ type: "function", function: { name, description: name + " it", parameters } })
const parsed = (conv) => conv.msgs.map((b) => JSON.parse(b.toString()))

test("toolsOf: tool_choice none lists nothing, a named function lists just it", () => {
  const chat = { tools: [fn("read"), fn("write", { type: "object", properties: { a: {} } }), { type: "other" }] }
  assert.deepEqual(toolsOf(chat).map((t) => t.name), ["read", "write"])
  assert.deepEqual(toolsOf({ ...chat, tool_choice: "none" }), [])
  assert.deepEqual(toolsOf({ ...chat, tool_choice: { type: "function", function: { name: "write" } } }).map((t) => t.name), ["write"])
  assert.equal(toolsOf(chat)[0].schemaText, '{"type":"object","properties":{}}')
})

test("catalog writes each tool as the CallDynamicTool call itself", () => {
  assert.equal(catalog([]), "")
  const c = catalog(toolsOf({ tools: [fn("read")] }))
  assert.ok(c.includes(`<call>${CALL}({"namespace":"magpie","toolName":"read","arguments":{...}})`))
  assert.ok(c.endsWith("</dynamic_tool_catalog>"))
})

test("the system prompt and the catalog lead; the user's last words are kept", () => {
  const chat = { messages: [{ role: "system", content: "be brief" }, { role: "developer", content: [{ type: "text", text: "dev" }] }, { role: "user", content: "hello" }] }
  const conv = conversation(chat, toolsOf({ tools: [fn("read")] }))
  const [sys, user] = parsed(conv)
  assert.equal(sys.role, "system")
  assert.ok(sys.content.startsWith("be brief\n\ndev\n\n<dynamic_tool_catalog>") || sys.content.startsWith("be brief\n\ndev"))
  assert.deepEqual(user, { role: "user", content: [{ type: "text", text: "hello" }] })
  assert.equal(conv.last, "hello")
  assert.ok(conv.estimate > 0)
})

test("a tool result answers its call; a call left unanswered is answered as interrupted", () => {
  const call = (id, name) => ({ id, type: "function", function: { name, arguments: '{"x":1}' } })
  const chat = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [call("c1", "read"), call("c2", "write")] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "user", content: "and then?" },
    ],
  }
  const msgs = parsed(conversation(chat, []))
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "user"])
  assert.deepEqual(msgs[1].content[0], { type: "tool-call", toolCallId: "c1", toolName: CALL, args: { namespace: "magpie", toolName: "read", arguments: { x: 1 } } })
  const [r1, r2] = msgs[2].content
  assert.deepEqual(r1.result, { ok: true })
  assert.equal(r1.isError, undefined)
  assert.equal(r2.toolCallId, "c2")
  assert.equal(r2.isError, true)
  assert.equal(r2.result, NO_RESULT)
})

test("a call id with Cursor's line in it is restored, and reasoning is sent as a reasoning part", () => {
  const chat = {
    messages: [
      { role: "assistant", reasoning_content: "hmm", content: "ok", tool_calls: [{ id: "call_a__fc_b", type: "function", function: { name: "t", arguments: "{}" } }] },
    ],
  }
  const [a] = parsed(conversation(chat, []))
  assert.deepEqual(a.content.map((p) => p.type), ["reasoning", "text", "tool-call"])
  assert.equal(a.content[2].toolCallId, "call_a\nfc_b")
})

test("images go inline as hex, other images and files as a line of text", () => {
  const chat = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
          { type: "file", file: { filename: "a.txt" } },
        ],
      },
    ],
  }
  const [u] = parsed(conversation(chat, []))
  assert.deepEqual(u.content[1], { type: "image", mimeType: "image/png", image: { __type: "Uint8Array", hex: "010203" } })
  assert.equal(u.content[2].text, "[attachment image: https://x/y.png]")
  assert.equal(u.content[3].text, "[attachment a.txt]")
})

test("joinSplitCalls joins an assistant turn's calls split over two messages, leaving the input alone", () => {
  const a = { role: "assistant", content: "one", tool_calls: [{ id: "1" }] }
  const b = { role: "assistant", content: "two", tool_calls: [{ id: "2" }] }
  const msgs = [a, b]
  const out = joinSplitCalls(msgs)
  assert.equal(out.length, 1)
  assert.equal(out[0].content, "one\n\ntwo")
  assert.deepEqual(out[0].tool_calls.map((c) => c.id), ["1", "2"])
  assert.equal(msgs.length, 2)
  assert.equal(joinSplitCalls([{ role: "assistant", content: "x" }, b]).length, 2)
})
