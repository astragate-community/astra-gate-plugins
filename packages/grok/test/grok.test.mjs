import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "../src/index.mjs"
import { objectRoot } from "../src/tools.mjs"
import { modelOf, outgoing, rewrite, bodyText } from "../src/request.mjs"
import { windowsOf, providerModels } from "../src/models.mjs"
import { cardsOf, usage, netError, jsonError } from "../src/usage.mjs"
import { HOLD_MS, limited, note, rateWindow, resetOf } from "../src/ratelimit.mjs"
import { refreshAuth, token } from "../src/session.mjs"
import { cpaAuth, linkIn } from "../src/signin.mjs"
import { credential } from "../src/cli.mjs"
import { newer } from "../src/identity.mjs"

// a home holding an auth.json with one sign-in
function homeWith(entry) {
  const home = mkdtempSync(join(tmpdir(), "grok-test-"))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ scope: entry }))
  return home
}
const inAnHour = () => new Date(Date.now() + 3600e3).toISOString()

function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = replies.shift()
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers })
  }
  return calls
}

test("the plugin has its hooks", async () => {
  const h = await GrokAuthPlugin({ client: {} })
  assert.equal(h.auth.provider, "grok")
  assert.equal(h.auth.methods.length, 3)
  for (const f of [h.auth.refresh, h.auth.loader, h.auth.usage, h.provider.models]) assert.equal(typeof f, "function")
  const cfg = {}
  await h.config(cfg)
  assert.ok(cfg.provider.grok.models["grok-4.7"])
})

test("rewrite drops tools Grok refuses and strips what it can't read", () => {
  const body = JSON.stringify({
    tools: [{ type: "function", name: "a" }, { type: "custom", name: "apply_patch" }, { type: "web_search", external_web_access: true }],
    tool_choice: { type: "custom" },
    input: [{ type: "reasoning", content: null, encrypted_content: "x" }],
  })
  const out = JSON.parse(rewrite(body))
  assert.deepEqual(out.tools, [{ type: "function", name: "a" }, { type: "web_search" }])
  assert.equal("tool_choice" in out, false)
  assert.equal("content" in out.input[0], false)
})

test("rewrite leaves a body it has nothing to change as it came", () => {
  const body = '{"tools":[{"type":"function","name":"a","parameters":{"type":"object"}}]}'
  assert.equal(rewrite(body), body)
  assert.equal(rewrite("not json but has \"tools\""), "not json but has \"tools\"")
  assert.equal(rewrite(undefined), undefined)
})

test("rewrite turns a plain agent_message into a user message", () => {
  const item = { type: "agent_message", author: "a", recipient: "b", content: [{ type: "input_text", text: "hi" }] }
  const out = JSON.parse(rewrite(JSON.stringify({ input: [item, { type: "agent_message", encrypted_content: "s", content: [] }] })))
  assert.deepEqual(out.input[0], {
    type: "message", role: "user", content: [{ type: "input_text", text: "From a to b\n\n" }, { type: "input_text", text: "hi" }],
  })
  assert.equal(out.input[1].type, "agent_message")
})

test("objectRoot folds a union at the root into one object", () => {
  const ps = {
    anyOf: [
      { type: "object", properties: { id: { type: "string" }, a: { type: "number" } }, required: ["id", "a"] },
      { $ref: "#/$defs/b" },
    ],
    $defs: { b: { type: "object", properties: { id: { type: "string" }, b: { type: "string" } }, required: ["id"] } },
  }
  const out = objectRoot(ps)
  assert.equal(out.type, "object")
  assert.deepEqual(Object.keys(out.properties).sort(), ["a", "b", "id"])
  assert.deepEqual(out.required, ["id"])
  assert.equal("anyOf" in out, false)
  assert.ok(ps.anyOf, "the caller's schema is untouched")
  const plain = { type: "object", properties: {} }
  assert.equal(objectRoot(plain), plain)
})

test("modelOf reads the window an id names", () => {
  assert.deepEqual(modelOf("grok-4.7"), { model: "grok-4.7", window: 0 })
  assert.deepEqual(modelOf("grok-4.7@500k"), { model: "grok-4.7", window: 500000 })
  assert.deepEqual(modelOf("grok-4.7@131072"), { model: "grok-4.7", window: 131072 })
  assert.deepEqual(modelOf(undefined), { model: undefined, window: 0 })
})

test("outgoing signs as the CLI and sends the plain model with its window", async () => {
  const req = new Request("https://x.test/v1/responses", { method: "POST", headers: { "content-length": "9" } })
  const raw = new TextEncoder().encode(JSON.stringify({ model: "grok-4.7@500k", prompt_cache_key: "conv1" }))
  assert.equal(bodyText(raw), '{"model":"grok-4.7@500k","prompt_cache_key":"conv1"}')
  const { headers, body } = await outgoing(req, raw, "KEY")
  assert.equal(headers.get("authorization"), "Bearer KEY")
  assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli")
  assert.equal(headers.get("x-grok-model-override"), "grok-4.7")
  assert.equal(headers.get("x-grok-context-window"), "500000")
  assert.equal(headers.get("x-grok-conv-id"), "conv1")
  assert.equal(headers.has("content-length"), false)
  assert.equal(JSON.parse(body).model, "grok-4.7")
})

test("newer compares versions", () => {
  assert.equal(newer("1.0.42", "1.0.41"), true)
  assert.equal(newer("1.0.41", "1.0.41"), false)
  assert.equal(newer("0.9.99", "1.0.0"), false)
})

test("windowsOf offers each listed context window beside the default", () => {
  const out = windowsOf({ id: "grok-4.7", name: "Grok 4.7", context_window: 256000, context_windows: [256000, 500000, 131072] }, ["high"])
  assert.deepEqual(out.map((m) => [m.id, m.name, m.context]), [
    ["grok-4.7", "Grok 4.7", 256000],
    ["grok-4.7@500k", "Grok 4.7 @ 500k", 500000],
    ["grok-4.7@131072", "Grok 4.7 @ 131072", 131072],
  ])
  assert.equal(windowsOf({ id: "m", context_window: 8000 }, []).length, 1)
})

test("models: lists the account's Responses models, easiest effort first", async () => {
  const home = homeWith({ key: "tok", email: "a@b.c", expires_at: inAnHour() })
  const calls = fake({
    status: 200,
    body: { data: [
      { id: "grok-4.7", name: "Grok 4.7", context_window: 256000, reasoning_efforts: [{ value: "high" }, { value: "low" }] },
      { id: "chatty", api_backend: "chat" },
    ] },
  })
  const out = await providerModels({ id: "grok", models: { "grok-4.7": { limit: { output: 64000 } } } }, { auth: { type: "oauth", refresh: home } })
  assert.equal(calls[0].url, "https://cli-chat-proxy.grok.com/v1/models")
  assert.deepEqual(Object.keys(out), ["grok-4.7"])
  assert.deepEqual(Object.keys(out["grok-4.7"].variants), ["low", "high"])
  assert.equal(out["grok-4.7"].limit.output, 64000)
  assert.equal(out["grok-4.7"].limit.context, 256000)
  // signed out: what is configured stays
  assert.deepEqual(await providerModels({ models: { a: 1 } }, {}), { a: 1 })
})

test("models: a 401 is a sign-in gone, not a list", async () => {
  const home = homeWith({ key: "tok", expires_at: inAnHour() })
  fake({ status: 401, body: {} })
  await assert.rejects(providerModels({ id: "grok" }, { auth: { type: "oauth", refresh: home } }), /sign-in has expired/)
})

test("usage: the weekly credits and the on-demand cap", () => {
  const end = "2030-01-08T00:00:00Z"
  const cards = cardsOf({ config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end },
    creditUsagePercent: 42,
    onDemandCap: { val: 200 },
    onDemandUsed: { val: 50 },
  } })
  assert.deepEqual(cards, [
    { name: "7 days", used: 42, span: 604800, resetsAt: end },
    { name: "On-demand", used: 25, resetsAt: end, aside: true },
  ])
  assert.deepEqual(cardsOf({}), [{ name: "Allowance", used: 0 }])
  assert.deepEqual(cardsOf({ config: { billingPeriodEnd: "garbage" } }), [{ name: "Allowance", used: 0 }])
})

test("usage: errors are worded as magpie words them", async () => {
  const calls = fake({ status: 200, body: { config: { creditUsagePercent: 3 } } })
  assert.deepEqual(await usage("K"), { windows: [{ name: "Allowance", used: 3 }] })
  assert.equal(calls[0].url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits")
  assert.equal(calls[0].init.headers.Authorization, "Bearer K")
  fake({ status: 503, body: {} })
  assert.deepEqual(await usage("K"), { error: "Service Unavailable", windows: [] })
  fake({ status: 200, body: "<html>" })
  assert.deepEqual(await usage("K"), { error: "invalid character '<' looking for beginning of value", windows: [] })
  assert.equal(jsonError(""), "unexpected end of JSON input")
  assert.equal(netError("u", Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } })), 'Get "u": dial tcp: lookup: no such host')
})

test("rate limit: a 429 makes a window until its reset, a good answer clears it", () => {
  limited.clear()
  const now = 1_000_000
  note("h", new Response("", { status: 429, headers: { "retry-after": "30" } }), now)
  const [w] = rateWindow("h", now + 1000)
  assert.equal(w.name, "Rate limit")
  assert.equal(w.resetsAt, new Date(now + 30_000).toISOString())
  assert.deepEqual(rateWindow("h", now + 31_000), [])
  note("h", new Response("", { status: 429 }), now)
  assert.equal(rateWindow("h", now + HOLD_MS - 1).length, 1)
  note("h", new Response("ok", { status: 200 }), now)
  assert.deepEqual(rateWindow("h", now), [])
})

test("rate limit: reset headers are epoch ms, epoch seconds or seconds from now", () => {
  const h = (v) => new Headers({ "x-ratelimit-reset-requests": v })
  assert.equal(resetOf(h("1700000000000"), 5), 1700000000000)
  assert.equal(resetOf(h("1700000000"), 5), 1700000000000)
  assert.equal(resetOf(h("10"), 1000), 11000)
  assert.equal(resetOf(new Headers(), 5), 0)
})

test("token: a good sign-in is returned, a lapsed or missing one is refused", async () => {
  const good = homeWith({ key: "tok", email: "a@b.c", expires_at: inAnHour() })
  assert.equal((await token(good, false)).key, "tok")
  const lapsed = homeWith({ key: "tok", expires_at: new Date(Date.now() - 1000).toISOString() })
  const old = process.env.PATH
  process.env.PATH = "" // no CLI to renew with
  try {
    await assert.rejects(token(lapsed, false), /has expired/)
  } finally {
    process.env.PATH = old
  }
  await assert.rejects(token(mkdtempSync(join(tmpdir(), "grok-test-")), false), /not signed in/)
})

test("refresh: hands on a token the CLI renewed, nothing when nothing changed", async () => {
  const exp = Date.now() + 3600e3
  const home = homeWith({ key: "new", email: "a@b.c", expires_at: new Date(exp).toISOString() })
  assert.deepEqual(await refreshAuth({ type: "oauth", refresh: home, access: "old", expires: 1, accountId: "x" }), {
    access: "new", expires: Date.parse(new Date(exp).toISOString()), accountId: "a@b.c",
  })
  assert.equal(await refreshAuth({ type: "oauth", refresh: home, access: "new", expires: exp, accountId: "a@b.c" }), undefined)
  assert.equal(await refreshAuth({ type: "apikey" }), undefined)
  const gone = mkdtempSync(join(tmpdir(), "grok-test-"))
  await assert.rejects(refreshAuth({ type: "oauth", refresh: gone, access: "a", expires: 1 }), (e) => e.signIn === "expired")
})

test("credential reads the first sign-in with a token, by key", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-test-"))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ b: { key: "kb" }, a: { nokey: 1 }, c: { key: "kc" } }))
  assert.deepEqual(credential(home), { key: "kb", email: "", expires: 0, issuer: "" })
})

test("the fetch signs, marks the sign-in kept and remembers a 429", async () => {
  limited.clear()
  const home = homeWith({ key: "tok", email: "a@b.c", expires_at: inAnHour() })
  const h = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const { fetch: grokFetch } = await h.auth.loader(async () => ({ type: "oauth", refresh: home, access: "tok", expires: 1 }))
  const calls = fake({ status: 429, body: {}, headers: { "retry-after": "60" } })
  const res = await grokFetch("https://cli-chat-proxy.grok.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "grok-4.7" }) })
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(res.status, 429)
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer tok")
  assert.equal(calls[0].init.headers.get("x-grok-model-override"), "grok-4.7")
  assert.equal(rateWindow(home).length, 1)
  limited.clear()
})

test("cpaAuth accepts only an enabled xAI OAuth account for Grok Build", () => {
  const claims = (c) => "h." + Buffer.from(JSON.stringify(c)).toString("base64url") + ".s"
  const ok = {
    type: "xai", auth_kind: "oauth", disabled: false, sub: "u", email: "a@b.c", refresh_token: "r",
    access_token: claims({ iss: "https://auth.x.ai", aud: ["b1a00492-073a-47ea-816f-4c329264a828"] }),
    last_refresh: "2030-01-01T00:00:00Z", expired: "2030-01-02T00:00:00Z",
  }
  const auth = cpaAuth(ok)
  assert.equal(auth.expires_at, "2030-01-02T00:00:00.000Z")
  assert.equal(auth.user_id, "u")
  assert.throws(() => cpaAuth({ ...ok, disabled: true }), /not an enabled/)
  assert.throws(() => cpaAuth({ ...ok, email: "" }), /missing its tokens/)
  assert.throws(() => cpaAuth({ ...ok, expired: "nope" }), /timestamps/)
  assert.throws(() => cpaAuth({ ...ok, access_token: claims({ iss: "other" }) }), /not for the Grok Build/)
})

test("linkIn finds the page to open and ignores a failure line", () => {
  assert.equal(linkIn("Open https://auth.x.ai/device?code=AB in your browser"), "https://auth.x.ai/device?code=AB")
  assert.equal(linkIn("Error: error sending request for url (https://auth.x.ai/oauth2/device/code): x"), "")
  assert.equal(linkIn("waiting"), "")
})
