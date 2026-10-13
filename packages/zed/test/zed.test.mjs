import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, publicEncrypt, constants } from "node:crypto"
import { ZedAuthPlugin } from "../src/index.mjs"
import { complete } from "../src/complete.mjs"
import { providerRequest, wireOf } from "../src/request.mjs"
import { said, eventError } from "../src/wire.mjs"
import { failedStatus, refusal, errorStatusOf } from "../src/refusals.mjs"
import { stateOf, orgOf, planName, who } from "../src/account.mjs"
import { parseModels, entry, vendors } from "../src/models.mjs"
import { modelToken, tokens } from "../src/token.mjs"
import { decrypt, padded } from "../src/signin.mjs"
import { usage } from "../src/usage.mjs"

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const ndjson = (lines, headers = { "x-zed-server-supports-status-messages": "1" }) =>
  new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers })

// a fetch that answers from a queue (a function gets the call) and remembers what it was asked
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const r = replies.shift()
    return typeof r === "function" ? r(url, init) : r
  }
  return calls
}
const S = { userId: "7", access: "acc", systemId: "sys", org: "o1", plan: "zed_pro", who: "me" }
const auth = (over = {}) => ({ type: "oauth", access: "acc", accountId: "me", refresh: JSON.stringify({ userId: 7, systemId: "sys", org: "o1", plan: "zed_pro" }), ...over })
const reset = () => {
  tokens.clear()
  vendors.clear()
}
const read = (res) => res.text()

test("the plugin exposes its hooks", async () => {
  const h = await ZedAuthPlugin({})
  assert.equal(h.auth.provider, "zed")
  assert.equal(typeof h.auth.usage, "function")
  const cfg = {}
  await h.config(cfg)
  assert.equal(cfg.provider.zed.models["claude-sonnet-5"].provider.npm, "@ai-sdk/anthropic")
  assert.equal(cfg.provider.zed.api, "https://cloud.zed.dev/v1")
})

test("wireOf reads the API and the Gemini model from the path", () => {
  assert.deepEqual(wireOf("https://cloud.zed.dev/v1/messages"), { wire: "anthropic" })
  assert.deepEqual(wireOf("https://x/v1/responses"), { wire: "responses" })
  assert.deepEqual(wireOf("https://x/v1/chat/completions"), { wire: "chat" })
  assert.deepEqual(wireOf("https://x/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse"), { wire: "gemini", model: "gemini-3.5-flash", stream: true })
  assert.equal(wireOf("https://x/v1/other"), null)
})

test("providerRequest writes each provider's request as Zed takes it", () => {
  const a = providerRequest("anthropic", { stream: true, messages: [{ content: [{ type: "tool_result" }, { type: "tool_result", is_error: true }, { type: "text" }] }] })
  assert.equal(a.stream, true)
  assert.equal("stream" in a.req, false)
  assert.deepEqual(a.req.messages[0].content.map((b) => b.is_error), [false, true, undefined])
  assert.deepEqual(providerRequest("responses", { stream: false }), { req: { stream: true }, stream: false })
  assert.deepEqual(providerRequest("chat", { max_tokens: 5 }), { req: { stream: true, max_completion_tokens: 5 }, stream: false })
  const g = providerRequest("gemini", { session_id: "x", sessionId: "y" }, "gemini-3.5-flash")
  assert.deepEqual(g, { req: { model: "models/gemini-3.5-flash" } })
})

test("failure codes map to statuses, and a refusal keeps what Zed said", () => {
  assert.equal(failedStatus("upstream_http_429"), 429)
  assert.equal(failedStatus("rate_limit_exceeded"), 429)
  assert.equal(failedStatus("provider_overloaded"), 529)
  assert.equal(failedStatus("billing_issue"), 402)
  assert.equal(failedStatus("nothing"), 502)
  assert.equal(errorStatusOf("http_200"), 502)
  assert.deepEqual(refusal(500, JSON.stringify({ code: "x", message: "boom", upstream_status: 503, retry_after: 7 })), [503, "boom (retry after 7s)"])
  assert.equal(refusal(402, "")[0], 402)
  assert.deepEqual(refusal(401, ""), [401, "the sign-in was refused — sign in again"])
  assert.deepEqual(refusal(500, "plain words"), [500, "plain words"])
})

test("said tells framing events from content", () => {
  assert.equal(said("anthropic", { type: "message_start" }), false)
  assert.equal(said("anthropic", { type: "content_block_delta", delta: { text: "" } }), false)
  assert.equal(said("anthropic", { type: "content_block_delta", delta: { text: "hi" } }), true)
  assert.equal(said("responses", { type: "response.created" }), false)
  assert.equal(said("chat", { choices: [{ delta: { role: "assistant" } }] }), false)
  assert.equal(said("chat", { choices: [{ delta: { content: "x" } }] }), true)
  assert.equal(said("gemini", { candidates: [{ content: { parts: [{ text: "x" }] } }] }), true)
})

test("eventError finds the provider's own error", () => {
  assert.equal(eventError("anthropic", { type: "error", error: { message: "overloaded" } }), "overloaded")
  assert.equal(eventError("responses", { type: "response.failed", response: { error: { message: "bad" } } }), "bad")
  assert.equal(eventError("chat", { error: { message: "no" } }), "no")
  assert.equal(eventError("chat", { choices: [] }), undefined)
})

test("account helpers: organization, name, plan, saved state", () => {
  const me = { default_organization_id: "b", organizations: [{ id: "a" }, { id: "b" }], user: { github_login: " octo ", name: "N" } }
  assert.equal(orgOf(me), "b")
  assert.equal(orgOf({ organizations: [{ id: "z" }], default_organization_id: "gone" }), "z")
  assert.equal(who(me), "octo")
  assert.equal(who({ user: { legacy_user_id: 5 } }), 5 + "")
  assert.equal(who({}), "Zed account")
  assert.equal(planName("zed_pro_trial"), "Pro Trial")
  assert.equal(planName(""), "Free")
  assert.equal(planName("zed_x"), "x")
  assert.deepEqual(stateOf(auth()), { access: "acc", userId: "7", systemId: "sys", org: "o1", plan: "zed_pro", who: "me" })
  assert.equal(stateOf({ type: "api" }), null)
  assert.equal(stateOf(auth({ refresh: "{}" })), null)
})

test("parseModels drops disabled and unknown-provider models and remembers vendors", () => {
  reset()
  const out = parseModels(JSON.stringify({ models: [{ id: "a", provider: "anthropic" }, { id: "b", provider: "open_ai", is_disabled: true }, { id: "c", provider: "nope" }, { id: "g", provider: "google" }] }))
  assert.deepEqual(out.map((m) => m.id), ["a", "g"])
  assert.equal(vendors.get("g"), "google")
  assert.throws(() => parseModels("{}"), /lists no models/)
})

test("a model's entry carries its efforts as the provider's own variants", () => {
  const e = entry({ id: "m", provider: "google", supports_images: true, max_token_count: 10, supported_effort_levels: [{ value: "low" }, { value: "high" }] })
  assert.equal(e.name, "m")
  assert.equal(e.reasoning, true)
  assert.deepEqual(e.modalities.input, ["text", "image"])
  assert.deepEqual(e.variants.low, { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } })
  assert.deepEqual(entry({ id: "a", provider: "anthropic", supported_effort_levels: [{ value: "x" }] }).variants.x, { effort: "x" })
  assert.deepEqual(entry({ id: "o", provider: "open_ai", supported_effort_levels: [{ value: "x" }] }).variants.x, { reasoningEffort: "x" })
})

test("the model token is minted once for concurrent asks and again on renew", async () => {
  reset()
  const calls = fake(json({ token: "t1" }), json({ token: "t2" }))
  const [a, b] = await Promise.all([modelToken(S), modelToken(S)])
  assert.equal(a, "t1")
  assert.equal(b, "t1")
  assert.equal(await modelToken(S), "t1")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, "7 acc")
  assert.deepEqual(JSON.parse(calls[0].init.body), { organization_id: "o1" })
  assert.equal(await modelToken(S, true), "t2")
})

test("a 401 for the model token is the sign-in expired", async () => {
  reset()
  fake(json({ message: "no" }, 401))
  await assert.rejects(modelToken(S), /me: the Zed sign-in has expired/)
})

test("decrypt reads an OAEP token the browser brought", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const ct = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from("secret"))
  assert.equal(decrypt(privateKey, padded(ct)), "secret")
  assert.throws(() => decrypt(privateKey, "AAAA"), /couldn't be decrypted/)
})

test("complete: an Anthropic request is wrapped for /completions and its stream turned back", async () => {
  reset()
  const calls = fake(
    json({ token: "mt" }),
    ndjson([{ status: "started" }, { event: { type: "message_start", message: { id: "m" } } }, { event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }, { status: "stream_ended" }]),
  )
  const body = JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] })
  const res = await complete(S, "https://cloud.zed.dev/v1/messages", { method: "POST", body })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const text = await read(res)
  assert.match(text, /^event: message_start\ndata: /)
  assert.match(text, /"text":"hi"/)
  const c = calls[1]
  assert.equal(c.url, "https://cloud.zed.dev/completions")
  assert.equal(c.init.headers.Authorization, "Bearer mt")
  assert.equal(c.init.headers["x-zed-version"], "1.23.0")
  assert.deepEqual(JSON.parse(c.init.body), { provider: "anthropic", model: "claude-sonnet-5", provider_request: { model: "claude-sonnet-5", messages: [] } })
})

test("complete: a caller that didn't ask for a stream gets one whole reply", async () => {
  reset()
  fake(
    json({ token: "mt" }),
    ndjson([{ event: { id: "c1", model: "grok", choices: [{ index: 0, delta: { content: "he" } }] } }, { event: { choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }], usage: { total_tokens: 3 } } }, { status: "stream_ended" }]),
  )
  const res = await complete(S, "https://x/v1/chat/completions", { body: JSON.stringify({ model: "grok-4.7", max_tokens: 9 }) })
  const out = JSON.parse(await read(res))
  assert.equal(out.choices[0].message.content, "hello")
  assert.equal(out.choices[0].finish_reason, "stop")
  assert.deepEqual(out.usage, { total_tokens: 3 })
})

test("complete: a stale model token is minted again once", async () => {
  reset()
  const calls = fake(json({ token: "old" }), new Response("", { status: 401 }), json({ token: "new" }), ndjson([{ event: { id: "x", choices: [{ index: 0, delta: { content: "ok" } }] } }, { status: "stream_ended" }]))
  const res = await complete(S, "https://x/v1/chat/completions", { body: JSON.stringify({ model: "gpt", stream: false }) })
  assert.equal(JSON.parse(await read(res)).choices[0].message.content, "ok")
  assert.equal(calls[3].init.headers.Authorization, "Bearer new")
})

test("complete: Zed's refusal comes back in the caller's error shape", async () => {
  reset()
  fake(json({ token: "mt" }), json({ code: "rate_limit", message: "slow down", retry_after: 3 }, 429))
  const res = await complete(S, "https://x/v1/messages", { body: JSON.stringify({ model: "claude-sonnet-5" }) })
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { type: "error", error: { type: "rate_limit_error", message: "slow down (retry after 3s)" } })
})

test("complete: a failed status before the reply is a refused request; an expired sign-in marks the account", async () => {
  reset()
  fake(json({ token: "mt" }), ndjson([{ status: { failed: { code: "upstream_http_529", message: "busy" } } }]))
  const res = await complete(S, "https://x/v1/messages", { body: JSON.stringify({ stream: true }) })
  assert.equal(res.status, 529)
  reset()
  fake(json({}, 401))
  const gone = await complete(S, "https://x/v1/messages", { body: "{}" })
  assert.equal(gone.status, 401)
  assert.equal(gone.headers.get("x-magpie-sign-in"), "expired")
})

test("complete: a reply that stops before stream_ended fails; unknown paths and bodies are refused", async () => {
  reset()
  fake(json({ token: "mt" }), ndjson([{ event: { choices: [{ delta: { content: "x" } }] } }]))
  const res = await complete(S, "https://x/v1/chat/completions", { body: "{}", method: "POST" })
  assert.match(await read(res), /the reply ended before it was complete/)
  assert.equal((await complete(S, "https://x/nothing", {})).status, 404)
  assert.equal((await complete(S, "https://x/v1/messages", { body: "nope" })).status, 400)
})

test("usage: the plan, when its period ends, and an overdue invoice", async () => {
  fake(json({ plan: { plan_v3: "zed_pro_trial", subscription_period: { ended_at: "2026-11-01T00:00:00Z" }, has_overdue_invoices: true } }))
  const saved = []
  const out = await usage(auth(), async (b) => saved.push(b))
  assert.equal(out.plan, "Pro Trial")
  assert.equal(out.until, "2026-11-01T00:00:00Z")
  assert.match(out.error, /overdue invoice/)
  assert.equal(out.signIn, "kept")
  assert.equal(JSON.parse(saved[0].refresh).plan, "zed_pro_trial")
})

test("usage: a 401 is expired, an unreadable reply is kept, no account is an error", async () => {
  fake(json({}, 401))
  assert.deepEqual(await usage(auth()), { error: "me: the Zed sign-in has expired — sign in again", signIn: "expired" })
  fake(new Response("[1]"))
  assert.match((await usage(auth())).error, /unreadable account: json: cannot unmarshal array/)
  assert.deepEqual(await usage(null), { error: "no such Zed account", signIn: "kept" })
})

test("the provider's models come from the account's list", async () => {
  reset()
  const h = await ZedAuthPlugin({})
  const calls = fake(json({ token: "mt" }), json({ models: [{ id: "claude-x", provider: "anthropic", display_name: "X" }] }))
  const out = await h.provider.models({ models: {} }, { auth: { ...auth(), refresh: JSON.stringify({ userId: 99, org: "o" }) } })
  assert.equal(out["claude-x"].name, "X")
  assert.equal(out["claude-x"].providerID, "zed")
  assert.equal(calls[1].init.headers["x-zed-client-supports-x-ai"], "true")
})
