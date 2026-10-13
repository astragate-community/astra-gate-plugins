import test from "node:test"
import assert from "node:assert/strict"
import { FactoryAuthPlugin } from "../src/index.mjs"
import { applyTokens, createSession } from "../src/session.mjs"
import { isKey, keyAccount } from "../src/keys.mjs"
import { claims, expiry } from "../src/jwt.mjs"
import { deviceSignIn } from "../src/signin.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.sig`
const secs = (fromNow) => Math.floor(Date.now() / 1000) + fromNow
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) })

// a fetch that answers from a queue and remembers what it was asked
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = replies.shift() ?? json({})
    return new Response(r.body, { status: r.status, headers: r.headers })
  }
  return calls
}

// a client that keeps what is saved, as the store would
function store(initial) {
  const state = { auth: initial, saved: [] }
  const client = { auth: { set: async ({ body }) => { state.saved.push(body); state.auth = body } } }
  return { state, client, getAuth: async () => state.auth }
}

const oauth = (over = {}) => ({ type: "oauth", access: jwt({ exp: secs(3600) }), refresh: "r1", expires: Date.now() + 3600e3, accountId: "a@b.c", activeOrganizationId: "org_1", orgId: "org_1", region: "", premBaseHost: "", ...over })
const nearEnd = () => oauth({ access: jwt({ exp: secs(30) }), expires: Date.now() + 30e3 })

test("jwt: claims and expiry", () => {
  const t = jwt({ exp: 1767225600, email: "a@b.c" })
  assert.equal(claims(t).email, "a@b.c")
  assert.equal(expiry(t), 1767225600000)
  assert.equal(expiry("not.a.jwt"), 0)
  assert.deepEqual(claims(undefined), {})
})

test("applyTokens keeps the old refresh token when none rotated", () => {
  const c = { refresh: "old" }
  applyTokens(c, { access_token: jwt({ exp: 10 }) })
  assert.equal(c.refresh, "old")
  assert.equal(c.expires, 10000)
  applyTokens(c, { access_token: jwt({ exp: 20 }), refresh_token: "new" })
  assert.equal(c.refresh, "new")
})

test("keys: an api entry is an account that is never renewed and sends no org", () => {
  assert.equal(isKey({ type: "api", key: " fk-1 " }), true)
  assert.equal(isKey({ type: "api", key: " " }), false)
  assert.equal(isKey({ type: "oauth", key: "x" }), false)
  const a = keyAccount({ type: "api", key: " fk-1 ", metadata: { email: "k@x.y", region: "eu" } })
  assert.deepEqual([a.key, a.access, a.refresh, a.accountId, a.activeOrganizationId, a.region, a.whoKnown], [true, "fk-1", "", "k@x.y", "", "eu", true])
  assert.equal(keyAccount({ type: "api", key: "fk-2" }).whoKnown, false)
})

test("fresh: a token with time left is used as it is, and asks whoami only when the org is unknown", async () => {
  const calls = fake()
  const held = store(oauth())
  const c = await createSession(held.client).account(held.getAuth).fresh()
  assert.equal(c.access, held.state.auth.access)
  assert.equal(calls.length, 0)

  const asked = fake(json({ orgId: "org_9", region: "eu" }))
  const noOrg = store(oauth({ activeOrganizationId: "" }))
  const d = await createSession(noOrg.client).account(noOrg.getAuth).fresh()
  assert.equal(asked.length, 1)
  assert.equal(asked[0].url, "https://api.factory.ai/api/cli/whoami")
  assert.equal(d.activeOrganizationId, "org_9")
  assert.equal(noOrg.state.saved.length, 1, "the org it learned is saved")
})

test("fresh: a token near its end is renewed under the lock, kept, saved and announced", async () => {
  const next = jwt({ exp: secs(7200) })
  const calls = fake(json({ access_token: next, refresh_token: "r2" }), json({ orgId: "org_1", region: "" }))
  const { state, client, getAuth } = store(nearEnd())
  const session = createSession(client)
  let announced = 0
  const [a, b] = await Promise.all([session.account(getAuth).fresh(() => announced++), session.account(getAuth).fresh(() => announced++)])
  assert.equal(a.access, next)
  assert.equal(b.access, next)
  assert.equal(announced, 1, "the second caller finds the token already fresh")
  assert.equal(calls.filter((x) => x.url.endsWith("/authenticate")).length, 1, "the refresh token was spent once")
  assert.equal(new URLSearchParams(calls[0].init.body).get("refresh_token"), "r1")
  assert.equal(state.saved[0].refresh, "r2")
  assert.equal(state.saved[0].type, "oauth")
})

test("fresh: WorkOS refusing the refresh token for good lapses the account; a rate limit goes on with the live token", async () => {
  fake(json({ error: "invalid_grant", error_description: "gone" }, 400))
  const dead = store(nearEnd())
  await assert.rejects(createSession(dead.client).account(dead.getAuth).fresh(), (e) => e.lapsed === true && e.signIn === "expired" && /sign in again/.test(e.message))

  fake(json({}, 429))
  const live = store(nearEnd())
  const c = await createSession(live.client).account(live.getAuth).fresh()
  assert.equal(c.access, live.state.auth.access)

  fake(json({}, 429))
  const over = store(oauth({ access: jwt({ exp: secs(-30) }), expires: Date.now() - 30e3 }))
  await assert.rejects(createSession(over.client).account(over.getAuth).fresh(), /Factory sign-in: 429|Too Many Requests/)
})

test("fresh: a signed-out store is an error", async () => {
  const { client, getAuth } = store({ type: "wellknown" })
  await assert.rejects(createSession(client).account(getAuth).fresh(), /not signed in/)
})

test("refresh (magpie's hook): rotates once, then answers from what it remembers", async () => {
  const next = jwt({ exp: secs(7200) })
  const calls = fake(json({ access_token: next, refresh_token: "r2" }), json({ orgId: "o", region: "eu" }))
  const session = createSession({ auth: { set: async () => {} } })
  const auth = nearEnd()
  const first = await session.refresh(auth)
  assert.equal(first.access, next)
  assert.equal(first.refresh, "r2")
  assert.equal(first.region, "eu")
  const again = await session.refresh(auth)
  assert.deepEqual(again, first)
  assert.equal(calls.filter((x) => x.url.endsWith("/authenticate")).length, 1)
})

test("mendOrg: an org Factory refused is dropped and whoami asked again; other 403s are not ours", async () => {
  const calls = fake(json({ orgId: "org_new" }))
  const { state, client, getAuth } = store(oauth())
  const { mendOrg } = createSession(client).account(getAuth)
  const msg = "Requested active organization is not accessible by this user"
  assert.equal(await mendOrg(401, msg), false)
  assert.equal(await mendOrg(403, "something else"), false)
  assert.equal(calls.length, 0)
  assert.equal(await mendOrg(403, msg), true)
  assert.equal(state.saved.at(-1).activeOrganizationId, "org_new")
})

test("plugin: a model request that meets an org refusal is sent again once the org is mended", async () => {
  const msg = JSON.stringify({ error: { message: "Requested active organization is not accessible by this user" } })
  const calls = fake({ status: 403, body: msg }, json({ orgId: "org_2" }), { status: 200, body: "{}", headers: { "content-type": "application/json" } })
  const { client, getAuth } = store(oauth())
  const hooks = await FactoryAuthPlugin({ client })
  const loader = await hooks.auth.loader(getAuth)
  const res = await loader.fetch("https://api.factory.ai/api/llm/o/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3", messages: [] }) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(calls[0].init.headers.get("x-factory-org-id"), "org_1")
  assert.equal(calls[2].init.headers.get("x-factory-org-id"), "org_2")
})

test("plugin: a 403 that stays is explained in the API's own error shape", async () => {
  fake({ status: 403, body: JSON.stringify({ error: "nope" }) })
  const { client, getAuth } = store(oauth())
  const hooks = await FactoryAuthPlugin({ client })
  const loader = await hooks.auth.loader(getAuth)
  const res = await loader.fetch("https://api.factory.ai/api/llm/a/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-5", messages: [] }) })
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.type, "error")
  assert.equal(body.error.type, "permission_error")
  assert.match(body.error.message, /^nope — Factory refused the request/)
})

test("plugin: a lapsed sign-in fails the request as a 502 and marks the account expired", async () => {
  fake(json({ error: "invalid_grant" }, 400))
  const { client, getAuth } = store(nearEnd())
  const hooks = await FactoryAuthPlugin({ client })
  const loader = await hooks.auth.loader(getAuth)
  const res = await loader.fetch("https://api.factory.ai/api/llm/o/v1/chat/completions", { method: "POST", body: "{}" })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
})

test("plugin: the config hook adds the provider and keeps what the user set", async () => {
  const hooks = await FactoryAuthPlugin({ client: {} })
  const config = { provider: { factory: { name: "Mine", models: { "glm-5.3": { name: "x" } } } } }
  await hooks.config(config)
  assert.equal(config.provider.factory.name, "Mine")
  assert.deepEqual(config.provider.factory.models["glm-5.3"], { name: "x" })
  assert.ok(config.provider.factory.models["claude-opus-5"])
  assert.equal(hooks.auth.refreshLead, 180000)
  assert.equal(await hooks.auth.refresh({ type: "api" }), undefined)
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "wellknown" })), {})
})

test("device sign-in: polls until the code is confirmed, then keeps the org and region whoami names", async () => {
  const calls = fake(
    json({ device_code: "dc", user_code: "ABCD", verification_uri: "https://v", verification_uri_complete: "https://v?c=ABCD", interval: 1 }),
    json({ error: "authorization_pending" }, 400),
    json({ access_token: jwt({ exp: secs(3600), org_id: "wo_1", email: "e@x.y" }), refresh_token: "rt" }),
    json({ orgId: "org_f", region: "eu", premBaseHostV2: "", userId: "u1" }),
  )
  const a = await deviceSignIn()
  assert.equal(a.url, "https://v?c=ABCD")
  assert.match(a.instructions, /ABCD/)
  const r = await a.callback()
  assert.equal(r.type, "success")
  assert.equal(r.accountId, "e@x.y")
  assert.equal(r.activeOrganizationId, "org_f")
  assert.equal(r.region, "eu")
  assert.equal(r.refresh, "rt")
  assert.equal(calls.length, 4)
})

test("device sign-in: a declined code is an error", async () => {
  fake(json({ device_code: "dc", user_code: "A", verification_uri: "v", interval: 1 }), json({ error: "access_denied" }, 400))
  const a = await deviceSignIn()
  await assert.rejects(a.callback(), /declined/)
})
