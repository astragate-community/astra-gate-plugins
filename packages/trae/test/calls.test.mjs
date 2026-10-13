import test from "node:test"
import assert from "node:assert/strict"
import { TextTools } from "../src/text-tools.mjs"
import { NativeCalls } from "../src/native-calls.mjs"
import { looseJSON, objectEnd, repairedJSON } from "../src/json-repair.mjs"
import { callArgs, dsmlArgs, glmCall, paramArgs } from "../src/call-syntax.mjs"

const tools = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" }, n: { type: "number" } } } } },
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { content: { type: "string" } } } } },
]

// what a whole text comes to when fed in the given pieces: { text, calls, reasoning, error }
function run(text, cuts = [], toolList = tools) {
  const tt = new TextTools(toolList)
  const got = { text: "", calls: [], reasoning: "", error: undefined }
  const take = (r) => {
    got.text += r.text
    got.calls.push(...r.calls)
    got.reasoning += r.reasoning
    got.error ??= r.error
  }
  let at = 0
  for (const cut of [...cuts, text.length]) {
    take(tt.push(text.slice(at, cut)))
    at = cut
  }
  take(tt.push("", true))
  return got
}
// every place the text can be split in two gives the same answer as the whole
function sameWhenSplit(text) {
  const whole = run(text)
  for (let i = 1; i < text.length; i++) assert.deepEqual(run(text, [i]), whole, `split at ${i}`)
  return whole
}

test("TextTools: our own block is a call, the text around it stays, whatever the chunking", () => {
  const r = sameWhenSplit('Let me look. <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call> Done.')
  assert.equal(r.text, "Let me look. Done.") // the blanks after a call go with it
  assert.deepEqual(r.calls, [{ name: "bash", arguments: '{"command":"ls"}' }])
})

test("TextTools: a block written with every quote escaped, or raw newlines in a string, is read", () => {
  const escaped = sameWhenSplit('<tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"ls\\"}}</tool_call>')
  assert.equal(escaped.calls[0].name, "bash")
  const raw = sameWhenSplit('<tool_call>{"name":"write","arguments":{"content":"a\nb"}}</tool_call>')
  assert.deepEqual(JSON.parse(raw.calls[0].arguments), { content: "a\nb" })
})

test("TextTools: GLM's template and the attribute form, a string kept as written", () => {
  const glm = sameWhenSplit("<tool_call>bash<arg_key>command</arg_key><arg_value>echo 1</arg_value><arg_key>n</arg_key><arg_value>3</arg_value></tool_call>")
  assert.deepEqual(glm.calls, [{ name: "bash", arguments: '{"command":"echo 1","n":3}' }])
  const attr = sameWhenSplit('<tool_call name="bash"><parameter name="command">ls -la</parameter></tool_call>')
  assert.deepEqual(attr.calls, [{ name: "bash", arguments: '{"command":"ls -la"}' }])
})

test("TextTools: DeepSeek's DSML invoke", () => {
  const r = sameWhenSplit('<｜DSML｜function_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter><｜DSML｜parameter name="n" string="false">3</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls> after')
  assert.deepEqual(r.calls, [{ name: "bash", arguments: '{"command":"ls","n":3}' }])
  assert.equal(r.text.trim(), "after")
})

test("TextTools: a block in backticks or a code fence is prose; a reasoning object is reasoning", () => {
  const fenced = sameWhenSplit('Write `<tool_call>` to call. ```\n<tool_call>{"name":"bash"}</tool_call>\n```')
  assert.deepEqual(fenced.calls, [])
  assert.match(fenced.text, /<tool_call>\{"name":"bash"\}/)
  const thought = run('{"reasoning_content":"hmm"}The answer')
  assert.equal(thought.reasoning, "hmm")
  assert.equal(thought.text, "The answer")
})

test("TextTools: GLM's leftover before a stray close is dropped, a close named in passing stays", () => {
  assert.equal(run("Answer.}}</tool_call>").text, "Answer.")
  assert.equal(run("Close it with </tool_call> as said.").text, "Close it with </tool_call> as said.")
})

test("TextTools: a call cut short or unreadable ends as an error, never as the answer", () => {
  const cut = run('ok <tool_call>{"name":"bash","argu')
  assert.match(cut.error, /was cut short/)
  assert.equal(cut.text, "ok ")
  const bad = run('<tool_call>{"name": nonsense}</tool_call>')
  assert.match(bad.error, /can't be read/)
  // JSON that is whole when the stream ends without the close is the call
  assert.equal(run('<tool_call>{"name":"bash","arguments":{"command":"ls"}}').calls[0].name, "bash")
})

test("TextTools: plain text passes through, held back only while it may start a block", () => {
  const tt = new TextTools(tools)
  assert.equal(tt.push("hello <tool_c").text, "hello ")
  assert.equal(tt.push("at is not one").text, "<tool_cat is not one")
  assert.equal(run("no calls here").text, "no calls here")
})

test("NativeCalls: pieces and snapshots of one call become one, once the answer is whole", () => {
  const pieces = new NativeCalls()
  pieces.push({ index: 0, id: "a", function: { name: "bash", arguments: '{"command":' } })
  pieces.push({ index: 0, function: { arguments: '"ls"}' } })
  const snapshots = new NativeCalls()
  snapshots.push({ id: "b", function: { name: "bash", arguments: '{"command":"l' } })
  snapshots.push({ id: "b", function: { name: "bash", arguments: '{"command":"ls"}' } })
  for (const nc of [pieces, snapshots]) {
    const [c] = nc.take(tools)
    assert.equal(c.name, "bash")
    assert.equal(c.arguments, '{"command":"ls"}')
    assert.match(c.id, /^a$|^b$/)
  }
})

test("NativeCalls: a whole call sent again with other punctuation replaces, a name holding the call is unpacked, ids are made", () => {
  const nc = new NativeCalls()
  nc.push({ id: "z", function: { name: "bash", arguments: '{"command":"-ls' } })
  nc.push({ id: "z", function: { name: "bash", arguments: '{"command":"−ls"}' } })
  const [c] = nc.take(tools)
  assert.equal(c.arguments, '{"command":"−ls"}')
  assert.equal(c.id, "z")
  const named = new NativeCalls()
  named.push({ function: { name: '{"name":"read","arguments":{"path":"a"}}', arguments: "" } })
  const [n] = named.take(tools)
  assert.deepEqual({ name: n.name, a: n.arguments }, { name: "read", a: '{"path":"a"}' })
  assert.match(n.id, /^call_[0-9a-f]{24}/) // made when Trae gave none
  assert.deepEqual(new NativeCalls().take(tools), [])
})

test("looseJSON / repairedJSON / objectEnd", () => {
  assert.deepEqual(looseJSON('{"a":"x\ny"}'), { a: "x\ny" })
  assert.equal(looseJSON("[1]"), null)
  assert.deepEqual(repairedJSON('{"p":"C:\\Users\\x"}'), { p: "C:\\Users\\x" })
  assert.deepEqual(repairedJSON('{"c":"he said "hi" ok"}'), { c: 'he said "hi" ok' })
  assert.equal(repairedJSON("nonsense"), null)
  assert.equal(objectEnd('  {"a":{"b":"}"}} tail', 0), 17)
  assert.equal(objectEnd('{"a":', 0), -1)
  assert.equal(objectEnd("abc", 0), -2)
})

test("callArgs / paramArgs / glmCall / dsmlArgs", () => {
  assert.equal(callArgs({ name: "x", arguments: { a: 1 } }), '{"a":1}')
  assert.equal(callArgs({ name: "x", arguments: '{"a":\n1}' }), '{"a":1}')
  assert.equal(callArgs({ name: "x", arguments: " " }), "{}")
  assert.equal(callArgs({ name: "x", id: "i", path: "p" }), '{"path":"p"}') // the keys beside the name
  assert.deepEqual(paramArgs('<parameter name="command">ls</parameter><parameter=n>5</parameter>', "bash", tools), { args: { command: "ls", n: 5 }, closed: true })
  assert.equal(paramArgs('<parameter name="command">ls', "bash", tools).closed, false)
  assert.equal(glmCall("nothing", tools), null) // a name alone is a call only to a tool the request has
  assert.deepEqual(glmCall("bash", tools), { name: "bash", arguments: {} })
  assert.equal(dsmlArgs(""), "{}")
})
