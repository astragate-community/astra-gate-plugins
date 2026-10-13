import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import PROMPT from "../src/prompt.mjs"
import { dress, environment, modelOf, startHeaders, today, workPlace } from "../src/start.mjs"

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16)

test("ZCode's prompt texts are byte for byte what the Start Plan looks for", () => {
  assert.equal(hash(PROMPT.cliPrefix), "46dd360a22c87a92")
  assert.equal(hash(PROMPT.stableSections[0]), "3f21ff9a88a03a76")
  assert.equal(hash(PROMPT.stableSections[1]), "39a1e86c93452c01")
  assert.equal(hash(PROMPT.beforeEnvironment), "bbdc66b399d297ff")
  assert.equal(hash(PROMPT.afterEnvironment), "1732b7f098a925d7")
})

test("modelOf reads the model of a Messages body, and nothing from other text", () => {
  assert.equal(modelOf('{"model":"GLM-5.3"}'), "GLM-5.3")
  assert.equal(modelOf('{"model":3}'), "")
  assert.equal(modelOf("nope"), "")
})

test("startHeaders swaps the key for ZCode's token and adds ZCode's headers", () => {
  const h = new Headers({ "x-api-key": "k", authorization: "Bearer k", "X-Device-Mid": "d", "x-keep": "1" })
  startHeaders(h, "jwt")
  assert.equal(h.get("authorization"), "Bearer jwt")
  assert.equal(h.get("x-api-key"), null)
  assert.equal(h.get("x-device-mid"), null)
  assert.equal(h.get("x-keep"), "1")
  assert.equal(h.get("x-zcode-app-version"), "3.14.3")
  assert.equal(h.get("user-agent"), "ZCode/3.14.3 ai-sdk/anthropic/3.0.81")
  assert.equal(h.get("x-title"), "Z Code@cli")
  assert.notEqual(h.get("x-request-id"), h.get("x-zcode-trace-id"))
})

test("workPlace takes magpie's work headers off and keeps git only with a folder", () => {
  const h = new Headers({ "x-magpie-work-dir": encodeURIComponent("/a b/c"), "x-magpie-work-git": "yes" })
  assert.deepEqual(workPlace(h), { dir: "/a b/c", git: "yes" })
  assert.equal(h.get("x-magpie-work-dir"), null)
  assert.deepEqual(workPlace(new Headers({ "x-magpie-work-git": "yes" })), {})
})

test("environment says what is told and leaves out what is not", () => {
  const text = environment("zai-api", "GLM-5.3", { dir: "/w", git: "no" })
  assert.match(text, /- Primary working directory: \/w/)
  assert.match(text, /- Is a git repository: no/)
  assert.match(text, /powered by the model named zai-api\/GLM-5.3\./)
  const bare = environment("zai-api", "")
  assert.doesNotMatch(bare, /working directory|powered by/)
})

test("today is the local date", () => {
  assert.equal(today(new Date(2026, 0, 5)), "2026-01-05")
})

test("dress puts ZCode's cached system blocks first, the agent's own after, and marks the last turn", () => {
  const body = JSON.stringify({
    model: "GLM-5.3",
    system: [{ type: "text", text: "be brief" }, { type: "image" }],
    messages: [{ role: "user", content: "hi", cache_control: 1 }],
    tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
    metadata: { a: 1 },
  })
  const b = JSON.parse(dress(body, "bigmodel", "dev-1", { dir: "/w" }))
  assert.equal(b.system.length, 4)
  assert.equal(b.system[0].text, PROMPT.cliPrefix)
  assert.deepEqual(b.system[0].cache_control, { type: "ephemeral" })
  assert.match(b.system[2].text, /bigmodel-api\/GLM-5.3/)
  assert.deepEqual(b.system[3], { type: "text", text: "be brief" })
  assert.equal(b.messages.length, 2)
  assert.match(b.messages[0].content[0].text, /^<system-reminder>/)
  assert.equal(b.messages[0].content[0].cache_control, undefined)
  assert.deepEqual(b.messages[1].content, [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }])
  assert.equal(b.tools[0].cache_control, undefined)
  assert.equal(b.metadata.a, 1)
  assert.deepEqual(JSON.parse(b.metadata.user_id), { device_id: "dev-1", account_uuid: "", session_id: "" })
})

test("dress leaves a body that is not a Messages request alone", () => {
  assert.equal(dress("not json messages", "zai", "d", {}), "not json messages")
  assert.equal(dress('{"x":1}', "zai", "d", {}), '{"x":1}')
  assert.equal(dress('{"messages":"no"}', "zai", "d", {}), '{"messages":"no"}')
})
