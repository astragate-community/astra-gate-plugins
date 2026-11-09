import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { onUpstream } from "../src/index.mjs"
import { IDENTITY, fingerprint, sessionUuid } from "../src/identity.mjs"

// Astra's ctx.sha256: a string hashes as UTF-8, an array as raw bytes.
const sha256 = (v) => createHash("sha256").update(Array.isArray(v) ? Buffer.from(v) : Buffer.from(String(v), "utf8")).digest("hex")

const upstream = (protocol = "anthropic", id = "prov_1", name = "Relay") => ({ protocol, provider: { id, name }, model: "claude-sonnet-4-5", stream: true })

function run(body, options, up = upstream()) {
  const headers = {}
  const ctx = { options, upstream: up, sha256, setHeader: (n, v) => { headers[n] = v } }
  return { out: onUpstream(body, ctx), headers, body }
}

const request = () => ({ model: "claude-sonnet-4-5", system: "Be brief.", messages: [{ role: "user", content: "Hello, world!" }] })

test("no providers, another channel or another API: nothing happens", () => {
  for (const options of [undefined, {}, { providers: [] }, { providers: ["prov_2"] }, { providers: ["prov_1"], protocol: "chat" }]) {
    const { out, headers } = run(request(), options)
    assert.equal(out, undefined)
    assert.deepEqual(headers, {})
  }
  assert.equal(run(request(), { providers: ["prov_1"] }, upstream("chat")).out, undefined)
})

test("the channel is named by id or by name", () => {
  assert.ok(run(request(), { providers: ["prov_1"] }).out)
  assert.ok(run(request(), { providers: ["Relay"] }).out)
})

test("anthropic: the CLI's headers, billing and identity blocks before the caller's system, and a user_id", () => {
  const { out, headers, body } = run(request(), { providers: ["prov_1"] })
  assert.equal(out, body)
  assert.equal(headers["User-Agent"], "claude-cli/2.1.281 (external, cli)")
  assert.equal(headers["X-App"], "cli")
  assert.equal(headers["anthropic-version"], "2023-06-01")
  assert.match(headers["anthropic-beta"], /^claude-code-20250219,/)
  assert.doesNotMatch(headers["anthropic-beta"], /oauth/)
  assert.equal(headers.Authorization, undefined)
  assert.deepEqual(body.system, [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.281.a99; cc_entrypoint=cli;" },
    { type: "text", text: IDENTITY },
    { type: "text", text: "Be brief." },
  ])
  const user = JSON.parse(body.metadata.user_id)
  assert.equal(user.device_id, sha256("astra-claude-device::prov_1"))
  assert.equal(user.account_uuid, "")
  assert.match(user.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("the fingerprint matches Astra's C# one, also when the picked bytes cut a multi-byte character", () => {
  assert.equal(fingerprint("Hello, world!", "2.1.281", sha256), "a99")
  assert.equal(fingerprint("hi", "2.1.281", sha256), "d4a")
  const bytes = Buffer.from("帮我看看这段代码哪里有问题", "utf8")
  const raw = createHash("sha256").update(Buffer.concat([Buffer.from("59cf53e54c78"), Buffer.from([bytes[4], bytes[7], bytes[20]]), Buffer.from("2.1.281")])).digest("hex").slice(0, 3)
  assert.equal(fingerprint("帮我看看这段代码哪里有问题", "2.1.281", sha256), raw)
})

test("one conversation keeps one session id; another gets another", () => {
  const a = JSON.parse(run(request(), { providers: ["prov_1"] }).body.metadata.user_id).session_id
  const b = JSON.parse(run(request(), { providers: ["prov_1"] }).body.metadata.user_id).session_id
  const other = request()
  other.messages[0].content = "Something else"
  const c = JSON.parse(run(other, { providers: ["prov_1"] }).body.metadata.user_id).session_id
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(sessionUuid("seed", sha256).length, 36)
})

test("a request that is already Claude Code's keeps its own system and metadata", () => {
  const own = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.300.abc; cc_entrypoint=cli;" },
    { type: "text", text: IDENTITY },
    { type: "text", text: "the rest", cache_control: { type: "ephemeral" } },
  ]
  const body = { model: "m", system: structuredClone(own), metadata: { user_id: "theirs" }, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
  run(body, { providers: ["prov_1"] })
  assert.deepEqual(body.system, own)
  assert.equal(body.metadata.user_id, "theirs")
})

test("no system at all gets one; a missing billing block alone is added in front", () => {
  const bare = { model: "m", messages: [{ role: "user", content: "hi" }] }
  run(bare, { providers: ["prov_1"] })
  assert.deepEqual(bare.system.map((b) => b.text), ["x-anthropic-billing-header: cc_version=2.1.281.d4a; cc_entrypoint=cli;", IDENTITY])
  const identityOnly = { model: "m", system: [{ type: "text", text: IDENTITY }], messages: [{ role: "user", content: "hi" }] }
  run(identityOnly, { providers: ["prov_1"] })
  assert.deepEqual(identityOnly.system.map((b) => b.text), ["x-anthropic-billing-header: cc_version=2.1.281.d4a; cc_entrypoint=cli;", IDENTITY])
})

test("version and betas options", () => {
  const { headers, body } = run(request(), { providers: ["prov_1"], version: "2.2.0", betas: "claude-code-20250219" })
  assert.equal(headers["User-Agent"], "claude-cli/2.2.0 (external, cli)")
  assert.equal(headers["anthropic-beta"], "claude-code-20250219")
  assert.match(body.system[0].text, /cc_version=2\.2\.0\./)
  assert.equal(run(request(), { providers: ["prov_1"], version: "bad" }).headers["User-Agent"], "claude-cli/2.1.281 (external, cli)")
})

test("chat: the identity as the first system message, once; no Anthropic headers", () => {
  const body = { model: "m", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] }
  const { out, headers } = run(body, { providers: ["prov_1"], protocol: "chat" }, upstream("chat"))
  assert.equal(out, body)
  assert.deepEqual(body.messages[0], { role: "system", content: IDENTITY })
  assert.equal(body.messages[1].content, "Be brief.")
  assert.equal(headers["anthropic-version"], undefined)
  assert.equal(headers["User-Agent"], "claude-cli/2.1.281 (external, cli)")
  assert.equal(run(body, { providers: ["prov_1"], protocol: "chat" }, upstream("chat")).out, undefined)
})

test("the host profile is stable per channel", () => {
  const a = run(request(), { providers: ["prov_1"] }).headers
  const b = run(request(), { providers: ["prov_1"] }).headers
  assert.equal(a["X-Stainless-OS"], b["X-Stainless-OS"])
  assert.equal(a["X-Stainless-Runtime-Version"], b["X-Stainless-Runtime-Version"])
})
