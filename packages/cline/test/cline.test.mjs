import test from "node:test"
import assert from "node:assert/strict"
import { ClinePlugin } from "../src/index.mjs"
import * as entry from "../src/index.mjs"
import { CLIENT, API } from "../src/constants.mjs"
import { clientHeaders, clineApi, Lapsed } from "../src/api.mjs"
import { authOf, bearerOf, parseAuth, toMs, refresh, createSession } from "../src/session.mjs"
import { deviceAuthorize, pollDevice, deviceSignIn } from "../src/signin.mjs"
import { sessionOf, taskIdOf, pinned, pinBody, bodyText, chatBody, chatHeaders } from "../src/request.mjs"
import { failure, refusal, signed, unwrapped, signedInError } from "../src/response.mjs"
import { balanceUSD, compactNumber, creditsOf, limitWindows, timeOf, usd, usageOf, accountUsage } from "../src/usage.mjs"
import { DEFAULT_MODELS, fetchFeed, parseFeed, prettify, tokens } from "../src/models.mjs"

const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})

const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
// fakes fetch: a function (url, init) → Response, recording the calls
function fake(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  return calls
}
const inMin = (m) => Date.now() + m * 60_000

test("the module exports only the plugin and its default", () => {
  assert.deepEqual(Object.keys(entry).sort(), ["ClinePlugin", "default"])
  assert.deepEqual(entry.default, { id: "cline", server: ClinePlugin })
})

test("the plugin has its hooks, methods and default models", async () => {
  const h = await ClinePlugin({ client: {} })
  assert.equal(h.auth.provider, "cline")
  assert.equal(h.auth.refreshLead, 10 * 60 * 1000)
  assert.deepEqual(h.auth.methods.map((m) => m.type), ["oauth", "api"])
  for (const f of [h.auth.refresh, h.auth.loader, h.auth.usage, h.provider.models, h["chat.headers"], h.config]) assert.equal(typeof f, "function")
  const cfg = {}
  await h.config(cfg)
  assert.equal(cfg.provider.cline.api, API)
  assert.equal(Object.keys(cfg.provider.cline.models).length, DEFAULT_MODELS.length)
  // a model the user configured stays
  const cfg2 = { provider: { cline: { models: { "x/y": { name: "mine" } } } } }
  await h.config(cfg2)
  assert.equal(cfg2.provider.cline.models["x/y"].name, "mine")
})

test("clientHeaders carries Cline's identity, and a task id only when given", () => {
  const h = clientHeaders()
  assert.equal(h["User-Agent"], `Cline/${CLIENT.version}`)
  assert.equal(h["X-CLIENT-TYPE"], "cline-cli")
  assert.equal(h["X-IS-MULTIROOT"], "false")
  assert.equal("X-Task-ID" in h, false)
  assert.equal(clientHeaders("t")["X-Task-ID"], "t")
})

test("sessions: magpie's synthetic id names no task, a named one gets a stable uuid", () => {
  assert.equal(sessionOf({ sessionID: "magpie-0123456789abcdef01234567" }), "")
  assert.equal(sessionOf({ sessionID: "  " }), "")
  assert.equal(sessionOf({}), "")
  assert.equal(sessionOf({ sessionID: "ses_1" }), "ses_1")
  assert.equal(sessionOf({ sessionID: "a".repeat(200) }).length, 128)
  const id = taskIdOf("ses_1")
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(taskIdOf("ses_1"), id)
  assert.notEqual(taskIdOf("ses_2"), id)
})

test("the chat.headers hook passes the session for this provider only", async () => {
  const h = await ClinePlugin({})
  const out = { headers: {} }
  await h["chat.headers"]({ model: { providerID: "cline" }, sessionID: "s1" }, out)
  assert.equal(out.headers["x-magpie-cline-session"], "s1")
  const other = { headers: {} }
  await h["chat.headers"]({ model: { providerID: "other" }, sessionID: "s1" }, other)
  assert.deepEqual(other.headers, {})
})

test("authOf / bearerOf: prefix added once whatever its case, an API key is bare", () => {
  assert.equal(authOf({ type: "api", key: "k" }).type, "api")
  assert.equal(authOf(null).type, "oauth")
  assert.equal(authOf({ expires: "x" }).expires, 0)
  assert.equal(bearerOf({ type: "api", key: "sk-1" }), "sk-1")
  assert.equal(bearerOf({ type: "oauth", access: "jwt" }), "workos:jwt")
  assert.equal(bearerOf({ type: "oauth", access: "WorkOS:jwt" }), "WorkOS:jwt")
  assert.equal(bearerOf({ type: "oauth", access: "" }), "")
})

test("parseAuth reads Cline's token answer, falling back to the old refresh token", () => {
  const exp = new Date(inMin(60)).toISOString()
  const p = parseAuth({ accessToken: "a", refreshToken: "r2", expiresAt: exp, userInfo: { clineUserId: "u1", email: " me@x.io ", name: "Me" } }, "r1")
  assert.deepEqual({ ...p, expires: undefined }, { access: "a", refresh: "r2", expires: undefined, uid: "u1", email: "me@x.io", name: "Me", accountId: "me@x.io" })
  assert.equal(p.expires, Date.parse(exp))
  assert.equal(parseAuth({ accessToken: "a" }, "r1").refresh, "r1")
  assert.equal(parseAuth({ accessToken: "a", userInfo: { subject: "s" } }, "r1").accountId, "s")
  assert.match(parseAuth({}).error, /no access token/)
  assert.match(parseAuth({ accessToken: "a" }).error, /no refresh token/)
})

test("toMs takes a missing or past expiry as an hour out", () => {
  const hour = 3600_000
  assert.ok(Math.abs(toMs(undefined) - (Date.now() + hour)) < 1000)
  assert.ok(Math.abs(toMs("1999-01-01") - (Date.now() + hour)) < 1000)
  const t = Date.now() + 5 * hour
  assert.equal(toMs(new Date(t).toISOString()), t)
})

test("clineApi unwraps the envelope and tells a lapsed sign-in from a failure", async () => {
  fake(() => json({ success: true, data: { a: 1 } }))
  assert.deepEqual(await clineApi(`${API}/x`), { a: 1 })
  fake(() => json({ success: false, error: "nope" }))
  await assert.rejects(clineApi(`${API}/x`), /Cline request failed: nope/)
  fake(() => json("denied", 403))
  await assert.rejects(clineApi(`${API}/x`), (e) => e instanceof Lapsed && e.expired === true)
  fake(() => json("boom", 500))
  await assert.rejects(clineApi(`${API}/x`), (e) => e.status === 500 && !e.expired)
  // an endpoint that knows 403 isn't the sign-in
  fake(() => json("denied", 403))
  await assert.rejects(clineApi(`${API}/x`, { lapsed: () => false }), (e) => e.status === 403 && !e.expired)
})

test("clineApi sends the identity, JSON content type only with a body", async () => {
  const calls = fake(() => json({ ok: 1 }))
  await clineApi(`${API}/x`, { method: "POST", body: { a: 1 }, headers: { Authorization: "Bearer t" } })
  const h = calls[0].init.headers
  assert.equal(h["Content-Type"], "application/json")
  assert.equal(h["X-CLIENT-TYPE"], "cline-cli")
  assert.equal(h.Authorization, "Bearer t")
  assert.equal(calls[0].init.body, '{"a":1}')
  await clineApi(`${API}/y`)
  assert.equal("Content-Type" in calls[1].init.headers, false)
})

test("refresh: a dead token is the sign-in gone, other failures are not", async () => {
  const calls = fake(() => json({ success: true, data: { accessToken: "n", refreshToken: "rn", expiresAt: new Date(inMin(60)).toISOString() } }))
  const p = await refresh({ refresh: "r" })
  assert.equal(p.access, "n")
  assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: "r", grantType: "refresh_token" })
  fake(() => json({ error: "invalid_grant" }, 400))
  await assert.rejects(refresh({ refresh: "r" }), (e) => e.expired === true)
  fake(() => json("html", 400))
  await assert.rejects(refresh({ refresh: "r" }), (e) => !e.expired)
  fake(() => json("down", 503))
  await assert.rejects(refresh({ refresh: "r" }), (e) => !e.expired)
  await assert.rejects(refresh({ refresh: "" }), (e) => e.expired === true)
})

const refreshed = (n = "n1", r = "r1") => json({ success: true, data: { accessToken: n, refreshToken: r, expiresAt: new Date(inMin(60)).toISOString(), userInfo: { email: "e@x.io" } } })

test("session.fresh: a good token is used as is; an API key is bare", async () => {
  const calls = fake(() => refreshed())
  const s = createSession({})
  const good = { type: "oauth", access: "a", refresh: "r", expires: inMin(30) }
  const c = await s.fresh(async () => good)
  assert.equal(c.bearer, "workos:a")
  assert.equal(c.renewed, false)
  const k = await s.fresh(async () => ({ type: "api", key: "sk" }))
  assert.equal(k.bearer, "sk")
  await assert.rejects(s.fresh(async () => ({ type: "api" })), (e) => e.expired)
  await assert.rejects(s.fresh(async () => ({ type: "oauth" })), /not signed in/)
  assert.equal(calls.length, 0)
})

test("session.fresh: a token near its end is renewed, saved, and remembered against the spent one", async () => {
  const calls = fake(() => refreshed("n1", "r1"))
  const saved = []
  const s = createSession({ auth: { set: async (x) => saved.push(x) } })
  const old = { type: "oauth", access: "a", refresh: "r0", expires: inMin(1) }
  const c = await s.fresh(async () => old)
  assert.equal(c.renewed, true)
  assert.equal(c.bearer, "workos:n1")
  assert.equal(saved.length, 1)
  assert.equal(saved[0].path.id, "cline")
  assert.equal(saved[0].body.refresh, "r1")
  assert.equal(saved[0].body.email, "e@x.io")
  // the store still hands back the spent pair: the rotated one is used, nothing is spent again
  const again = await s.fresh(async () => old)
  assert.equal(again.bearer, "workos:n1")
  assert.equal(again.renewed, false)
  assert.equal(calls.length, 1)
})

test("session.fresh: a failed save doesn't lose the rotated pair", async () => {
  const calls = fake(() => refreshed())
  const s = createSession({ auth: { set: async () => { throw new Error("disk") } } })
  const old = { type: "oauth", access: "a", refresh: "r0", expires: inMin(1) }
  await s.fresh(async () => old)
  await s.fresh(async () => old)
  assert.equal(calls.length, 1)
})

test("session.fresh: a transient refresh failure keeps a token that is still good, an expired one is the sign-in gone", async () => {
  fake(() => json("down", 503))
  const s = createSession({})
  const c = await s.fresh(async () => ({ type: "oauth", access: "a", refresh: "r", expires: inMin(1) }))
  assert.equal(c.bearer, "workos:a")
  await assert.rejects(s.fresh(async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 5000 })), /Cline request failed/)
  // a refused refresh is the sign-in gone even with a token in hand
  fake(() => json({ error: "invalid_grant" }, 400))
  await assert.rejects(s.fresh(async () => ({ type: "oauth", access: "a", refresh: "r2", expires: inMin(1) })), (e) => e.expired)
  await assert.rejects(s.fresh(async () => ({ type: "oauth", access: "a", refresh: "", expires: 1 })), /no refresh token/)
})

test("session.fresh: concurrent callers spend one refresh token once", async () => {
  const calls = fake(async () => {
    await new Promise((r) => setTimeout(r, 10))
    return refreshed()
  })
  const s = createSession({})
  const old = { type: "oauth", access: "a", refresh: "r0", expires: inMin(1) }
  const [x, y] = await Promise.all([s.fresh(async () => old), s.fresh(async () => old)])
  assert.equal(x.bearer, "workos:n1")
  assert.equal(y.bearer, "workos:n1")
  assert.equal(calls.length, 1)
})

test("session.renew (magpie's auth.refresh): skips keys, returns only what changed, shares the held pair", async () => {
  const calls = fake(() => refreshed("n1", "r1"))
  const s = createSession({})
  assert.equal(await s.renew({ type: "api", key: "k" }), undefined)
  assert.equal(await s.renew({ type: "oauth", access: "a", refresh: "" }), undefined)
  const auth = { type: "oauth", access: "a", refresh: "r0", expires: inMin(1), email: "e@x.io" }
  const out = await s.renew(auth)
  assert.equal(out.access, "n1")
  assert.equal(out.refresh, "r1")
  assert.equal("email" in out, false)
  assert.equal(out.accountId, "e@x.io")
  // asked again with the store not yet updated: the held pair, no second spend
  const again = await s.renew(auth)
  assert.equal(again.access, "n1")
  assert.equal(calls.length, 1)
  fake(() => json({ error: "revoked" }, 401))
  await assert.rejects(s.renew({ type: "oauth", access: "a", refresh: "rz", expires: 1 }), (e) => e.signIn === "expired")
})

test("pollDevice: pending and slow_down keep polling, the interval only grows", async () => {
  const replies = [{ error: "authorization_pending" }, { error: "slow_down" }, { error: "authorization_pending" }, { access_token: "t", refresh_token: "r" }]
  const sleeps = []
  const got = await pollDevice({ device_code: "d", interval: 2 }, {
    fetchImpl: async () => json(replies.shift()),
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(got.access_token, "t")
  assert.deepEqual(sleeps, [2000, 2000, 3000, 3000])
})

test("pollDevice: 5xx and network errors retry; a refusal, an HTML 400 and the deadline end it", async () => {
  let n = 0
  const got = await pollDevice({ device_code: "d", interval: 1 }, {
    fetchImpl: async () => {
      n++
      if (n === 1) throw new Error("net")
      if (n === 2) return new Response("oops", { status: 502 })
      if (n === 3) return new Response("ok but not json", { status: 200 })
      return json({ access_token: "t" })
    },
    sleep: async () => {},
  })
  assert.equal(got.access_token, "t")
  await assert.rejects(pollDevice({ device_code: "d" }, { fetchImpl: async () => json({ error: "access_denied", error_description: "no" }), sleep: async () => {} }), /access_denied \(no\)/)
  await assert.rejects(pollDevice({ device_code: "d" }, { fetchImpl: async () => new Response("<html>", { status: 400 }), sleep: async () => {} }), /token poll was refused \(HTTP 400\)/)
  await assert.rejects(pollDevice({ device_code: "d" }, { fetchImpl: async () => json({}), sleep: async () => {} }), /no access token/)
  let t = 0
  await assert.rejects(
    pollDevice({ device_code: "d", expires_in: 10 }, { fetchImpl: async () => json({ error: "authorization_pending" }), sleep: async () => { t += 4000 }, now: () => t }),
    /wasn't finished in time/,
  )
})

test("deviceAuthorize / deviceSignIn: the code page, then WorkOS tokens traded at register", async () => {
  fake((url) => {
    if (url.includes("authorize/device")) return json({ device_code: "dc", user_code: "ABCD", verification_uri: "https://v", verification_uri_complete: "https://v?c=ABCD", interval: 1 })
    if (url.includes("/authenticate")) return json({ access_token: "wa", refresh_token: "wr" })
    if (url.endsWith("/auth/register")) return refreshed("ca", "cr")
    throw new Error("unexpected " + url)
  })
  const flow = await deviceSignIn()
  assert.equal(flow.url, "https://v?c=ABCD")
  assert.match(flow.instructions, /ABCD/)
  assert.equal(flow.method, "auto")
  // the poll waits its one-second interval, then the WorkOS tokens are traded at register
  const done = await flow.callback()
  assert.equal(done.type, "success")
  assert.equal(done.access, "ca")
  assert.equal(done.refresh, "cr")
  assert.equal(done.accountId, "e@x.io")
})

test("deviceAuthorize: a failed or incomplete answer is an error", async () => {
  fake(() => json({}, 500))
  await assert.rejects(deviceAuthorize(), /device code request failed \(HTTP 500\)/)
  fake(() => json({ device_code: "x" }))
  await assert.rejects(deviceAuthorize(), /incomplete/)
  globalThis.fetch = async () => {
    throw new Error("offline")
  }
  await assert.rejects(deviceAuthorize(), /Cline sign-in: offline/)
})

test("request: DeepSeek pinning writes providerOptions at the end, byte-for-byte otherwise", () => {
  assert.equal(pinned(true, "cline-pass/deepseek-v4-pro"), "deepseek")
  assert.equal(pinned(true, "deepseek/deepseek-chat"), "deepseek")
  assert.equal(pinned(true, "cline-free/deepseek-v4.1-flash"), "")
  assert.equal(pinned(true, "anthropic/claude-sonnet-5"), "")
  assert.equal(pinned(false, "cline-pass/deepseek-v4-pro"), "")
  const body = '{"model":"cline-pass/deepseek-v4-pro", "messages":[]}'
  const out = pinBody(body, JSON.parse(body), true)
  assert.equal(out.startsWith(body.slice(0, -1)), true)
  assert.deepEqual(JSON.parse(out).providerOptions, { gateway: { only: ["deepseek"] } })
  // the client's own providerOptions stay
  const own = '{"model":"cline-pass/deepseek-v4-pro","providerOptions":{"a":1}}'
  assert.equal(pinBody(own, JSON.parse(own), true), own)
  // an empty object takes no comma
  const empty = pinBody('{"model":"x/deepseek-r"}', { model: "x/deepseek-r" }, true)
  assert.doesNotThrow(() => JSON.parse(empty))
  assert.equal(pinBody("{}", { model: "deepseek" }, true), '{"providerOptions":{"gateway":{"only":["deepseek"]}}}')
})

test("request: bodies are read whatever way they are given; non-chat bodies throw", async () => {
  assert.equal(await bodyText("u", { body: "s" }), "s")
  assert.equal(await bodyText("u", { body: new TextEncoder().encode("bytes") }), "bytes")
  assert.equal(await bodyText("u", { body: new URLSearchParams({ a: "1" }) }), "a=1")
  assert.equal(await bodyText(new Request("http://x/", { method: "POST", body: "from request" }), {}), "from request")
  assert.equal(await bodyText("u", {}), "")
  await assert.rejects(chatBody("u", { body: "[]" }, false), /not a chat completion/)
  await assert.rejects(chatBody("u", { body: "nope" }, false))
  assert.equal(await chatBody("u", { body: '{"model":"a/b"}' }, false), '{"model":"a/b"}')
})

test("request: the headers drop the private session, set the token and Cline's identity", () => {
  const h = chatHeaders("u", { headers: { "x-magpie-cline-session": "s1", "x-task-id": "stale", "content-length": "9", host: "h", "x-keep": "1" } }, "workos:t")
  assert.equal(h.get("x-magpie-cline-session"), null)
  assert.equal(h.get("authorization"), "Bearer workos:t")
  assert.equal(h.get("x-task-id"), taskIdOf("s1"))
  assert.equal(h.get("x-client-type"), "cline-cli")
  assert.equal(h.get("content-length"), null)
  assert.equal(h.get("host"), null)
  assert.equal(h.get("x-keep"), "1")
  // no session, no task id
  assert.equal(chatHeaders("u", { headers: { "x-task-id": "stale" } }, "k").get("x-task-id"), null)
})

test("response.failure: the gates Cline puts in front of a model", () => {
  assert.equal(failure(403, JSON.stringify({ error: { code: "ENTITLEMENT_ERROR", message: "Error 403: no" } })).status, 403)
  assert.match(failure(403, "the user is not subscribed to required model plan").message, /ClinePass/)
  const credits = failure(402, JSON.stringify({ error: { code: "insufficient_credits", current_balance: 0.5, buy_credits_url: "https://buy" } }))
  assert.equal(credits.status, 429)
  assert.equal(credits.message, "out of credits ($0.50) — top up at https://buy")
  assert.match(failure(402, "").message, /\$0\.00\) — top up at https:\/\/app\.cline\.bot\/credits/)
  assert.deepEqual(failure(401, "x"), { status: 401, message: "the sign-in lapsed — sign in again" })
  assert.equal(failure(403, '{"message":"Unauthorized"}').status, 401)
  // a 403 that merely mentions tokens is not a lapsed sign-in
  assert.equal(failure(403, "too many tokens in the request").status, 403)
  assert.equal(failure(429, "slow").message, "usage limit reached: slow")
  assert.equal(failure(400, '{"error":{"message":"rate limit hit"}}').status, 429)
  assert.equal(failure(500, "").message, "Internal Server Error")
  assert.equal(failure(200, "").status, 502)
  assert.equal(failure(500, "x".repeat(5000)).message.length, 2000)
})

test("response: refusals are cline_error in OpenAI's shape and carry a mark only when given", async () => {
  const r = refusal({ status: 400, message: "bad" })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: { message: "bad", type: "cline_error", code: 400 } })
  assert.equal(r.headers.get("x-magpie-sign-in"), null)
  assert.equal(refusal({ status: 401, message: "x", signIn: "expired" }).headers.get("x-magpie-sign-in"), "expired")
  const lapsed = signedInError(new Lapsed("the sign-in lapsed"))
  assert.equal(lapsed.status, 401)
  assert.equal(lapsed.headers.get("x-magpie-sign-in"), "expired")
  const other = signedInError(new Error("Cline: offline"))
  assert.equal(other.status, 502)
  assert.equal((await other.json()).error.message, "offline")
  assert.equal(other.headers.get("x-magpie-sign-in"), null)
})

test("response.signed: renewed marks renewed, a good answer is kept, a refusal stays unmarked", async () => {
  const ok = signed(new Response("body", { status: 200, headers: { "content-length": "4" } }), false)
  assert.equal(ok.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(ok.headers.get("content-length"), null)
  assert.equal(await ok.text(), "body")
  assert.equal(signed(new Response("x", { status: 200 }), true).headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(signed(new Response("x", { status: 500 }), true).headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(signed(new Response("x", { status: 500 }), false).headers.get("x-magpie-sign-in"), null)
})

test("response.unwrapped: a {data} completion loses its envelope, streams and other JSON pass", async () => {
  const wrapped = { data: { choices: [{ message: { content: "hi" } }] } }
  assert.deepEqual(await (await unwrapped(json(wrapped))).json(), wrapped.data)
  const sse = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } })
  assert.equal(await unwrapped(sse), sse)
  assert.equal(await (await unwrapped(json({ choices: [] }))).text(), '{"choices":[]}')
  assert.equal(await (await unwrapped(json("not json at all"))).text(), 'not json at all')
  const bad = new Response("<<", { headers: { "content-type": "application/json" } })
  assert.equal(await (await unwrapped(bad)).text(), "<<")
})

test("usage maths: dollars, balances, credits shapes, limits", () => {
  assert.equal(usd(0), "$0.00")
  assert.equal(usd(1.5), "$1.50")
  assert.equal(usd(0.005), "$0.005")
  assert.equal(balanceUSD({ balance: 2_500_000 }), "$2.50")
  assert.equal(balanceUSD({ balance: "500000" }), "$0.50")
  assert.equal(balanceUSD({ balance: -1 }), null)
  assert.equal(balanceUSD({}), null)
  assert.equal(compactNumber(3), "3")
  assert.equal(compactNumber(3.456), "3.46")
  assert.equal(compactNumber(2.5), "2.5")
  assert.equal(compactNumber(NaN), "0")
  assert.equal(timeOf({ a: 1_700_000_000 }, ["a"]), new Date(1_700_000_000_000).toISOString())
  assert.equal(timeOf({ a: 1_700_000_000_000 }, ["a"]), new Date(1_700_000_000_000).toISOString())
  assert.equal(timeOf({ a: "2030-01-01T00:00:00Z" }, ["b", "a"]), "2030-01-01T00:00:00.000Z")
  assert.equal(timeOf({}, ["a"]), "")

  assert.deepEqual(creditsOf({ total: 100, used: 25 }).window, { name: "Credits", used: 25, limit: 100, amount: 25, display: "25 / 100" })
  assert.deepEqual(creditsOf({ data: { total: 200, remaining: 150 } }).window, { name: "Credits", used: 25, limit: 200, amount: 50, display: "50 / 200" })
  assert.deepEqual(creditsOf({ total: 10, remaining: 20 }), {})
  assert.deepEqual(creditsOf({ credits: 12 }), { balance: "12 credits" })
  assert.deepEqual(creditsOf({ used: "4" }), { window: { name: "Credits", used: 0, aside: true, display: "4 credits used" } })
  assert.deepEqual(creditsOf(null), {})
  assert.equal(creditsOf({ total: 10, used: 1, resetAt: "2030-01-01T00:00:00Z" }).window.resetsAt, "2030-01-01T00:00:00.000Z")

  const w = limitWindows({ limits: [{ type: "monthly", percentUsed: 150, resetsAt: "2030-01-01T00:00:00Z" }, { type: "five_hour", percentUsed: "12" }, { type: "bogus", percentUsed: 1 }, { type: "weekly", percentUsed: "x" }] })
  assert.deepEqual(w.map((x) => [x.name, x.used]), [["5 hours", 12], ["Weekly", 0], ["Month", 100]])
  assert.equal(w[0].span, 5 * 3600)
  assert.equal(w[2].resetsAt, "2030-01-01T00:00:00.000Z")

  const u = usageOf({ planName: "Pro" }, { balance: 1_000_000 }, { limits: [{ type: "weekly", percentUsed: 5 }] })
  assert.equal(u.plan, "Pro")
  assert.equal(u.balance, "$1.00")
  assert.equal(u.windows.length, 1)
  // a count alone with no dollars falls to creditsOf
  assert.equal(usageOf(null, { credits: 7 }, null).balance, "7 credits")
})

test("accountUsage: balance and limits read together; no ClinePass (404) is quiet, other limit failures say so", async () => {
  const cred = async () => ({ bearer: "workos:t", renewed: false, accountId: "acc", uid: "u1" })
  const routes = { "/users/me": { clineUserId: "u9", plan: "Free" }, "/users/u9/balance": { balance: 3_000_000 }, "/users/me/plan/usage-limits": { limits: [{ type: "five_hour", percentUsed: 10 }] } }
  const calls = fake((url) => {
    const k = Object.keys(routes).find((p) => url.endsWith(p))
    return k ? json({ success: true, data: routes[k] }) : json("no", 404)
  })
  let out = await accountUsage(cred, null)
  assert.equal(out.balance, "$3.00")
  assert.equal(out.plan, "Free")
  assert.equal(out.windows[0].name, "5 hours")
  assert.equal(out.user, "acc")
  assert.equal(out.signIn, "kept")
  assert.ok(calls.every((c) => c.init.headers.Authorization === "Bearer workos:t"))

  delete routes["/users/me/plan/usage-limits"]
  out = await accountUsage(cred, null)
  assert.equal(out.error, undefined)
  assert.deepEqual(out.windows, [])

  fake((url) => (url.endsWith("usage-limits") ? json("boom", 500) : json({ success: true, data: url.endsWith("/users/me") ? { clineUserId: "u9" } : { balance: 1_000_000 } })))
  out = await accountUsage(cred, null)
  assert.match(out.error, /^ClinePass limits couldn't be read \(HTTP 500: boom\)$/)
  assert.equal(out.balance, "$1.00")
})

test("accountUsage: a lapsed sign-in or a failed token step says so on the card", async () => {
  fake(() => json("denied", 401))
  let out = await accountUsage(async () => ({ bearer: "b", renewed: true, uid: "u" }), null)
  assert.equal(out.signIn, "expired")
  assert.deepEqual(out.windows, [])
  out = await accountUsage(async () => {
    throw new Lapsed("gone")
  }, null)
  assert.equal(out.signIn, "expired")
  assert.equal(out.error, "gone")
  // renewed on this read: the mark says so
  fake((url) => json({ success: true, data: url.endsWith("/users/me") ? { clineUserId: "u" } : { balance: 1_000_000 } }))
  out = await accountUsage(async () => ({ bearer: "b", renewed: true, uid: "u" }), null)
  assert.equal(out.signIn, "renewed")
})

test("models: prettify and the bundled list", () => {
  assert.equal(prettify("anthropic/claude-sonnet-5.5"), "Claude Sonnet 5.5")
  assert.equal(prettify("openai/gpt-6-astra"), "GPT 6 Astra")
  assert.equal(prettify("cline-free/mimo-v2.6-flash"), "MiMo V2.6 Flash")
  assert.equal(DEFAULT_MODELS[0].id, "anthropic/claude-sonnet-5.5")
  assert.equal(DEFAULT_MODELS.find((m) => m.id === "cline-free/mimo-v2.6-flash").name, "MiMo V2.6 Flash (free)")
  assert.equal(DEFAULT_MODELS.find((m) => m.id === "cline-pass/glm-5.3").name, "GLM 5.3 (ClinePass)")
  assert.equal(tokens("x", 0, "1000.7"), 1000)
  assert.equal(tokens(null), undefined)
})

test("models.parseFeed: the three groups, a model in two keeps the stronger gate, bad ids are dropped", () => {
  const ms = parseFeed({
    recommended: ["anthropic/claude-sonnet-5", { id: "cline-free/a-b", name: "A B" }, "bare", 5, { id: "x/y", display_name: "y" }],
    free: [{ id: "cline-free/a-b", displayName: "Free A B" }],
    clinePass: ["cline-pass/z"],
    clineCloud: ["left/out"],
    description: "not a model",
  })
  const by = Object.fromEntries(ms.map((m) => [m.id, m]))
  assert.deepEqual(Object.keys(by), ["anthropic/claude-sonnet-5", "cline-free/a-b", "x/y", "cline-pass/z"])
  assert.equal(by["cline-free/a-b"].name, "Free A B (free)")
  assert.equal(by["cline-pass/z"].name, "Z (ClinePass)")
  assert.equal(by["x/y"].name, "Y")
  assert.deepEqual(parseFeed(null), [])
})

test("models.fetchFeed merges the catalog's windows, recommended first; the catalog is optional, the feed is not", async () => {
  fake((url) => {
    if (url.endsWith("/recommended-models")) return json({ success: true, data: { recommended: ["anthropic/claude-sonnet-5"], free: ["cline-free/m"] } })
    return json({ data: [{ id: "anthropic/claude-sonnet-5", context_length: 200000, max_completion_tokens: 64000 }, { id: "bare-id", name: "Bare", top_provider: { context_length: "8000" } }, { id: "" }] })
  })
  const ms = await fetchFeed()
  assert.deepEqual(ms.map((m) => m.id), ["anthropic/claude-sonnet-5", "cline-free/m", "bare-id"])
  assert.equal(ms[0].context, 200000)
  assert.equal(ms[1].context, undefined)
  assert.equal(ms[2].name, "Bare")
  assert.equal(ms[2].context, 8000)
  assert.equal("output" in ms[0], false)

  fake((url) => (url.endsWith("/recommended-models") ? json({ data: { recommended: ["a/b"] } }) : json("x", 500)))
  assert.deepEqual((await fetchFeed()).map((m) => m.id), ["a/b"])
  fake((url) => (url.endsWith("/recommended-models") ? json("x", 500) : json({ data: [] })))
  await assert.rejects(fetchFeed(), /Cline model list: HTTP 500/)
  fake(() => json({ data: {} }))
  await assert.rejects(fetchFeed(), /Cline listed no models/)
})

test("provider.models hook: runtime models, or what magpie had when the feed fails", async () => {
  const h = await ClinePlugin({})
  fake((url) => (url.endsWith("/recommended-models") ? json({ data: { free: ["cline-free/m"] } }) : json({ data: [] })))
  const ms = await h.provider.models({})
  assert.equal(ms["cline-free/m"].free, true)
  assert.equal(ms["cline-free/m"].providerID, "cline")
  assert.deepEqual(ms["cline-free/m"].limit, { context: 0, output: 0 })
  assert.equal(ms["cline-free/m"].api.url, API)
  fake(() => json("x", 500))
  const have = { keep: { id: "keep" } }
  assert.equal(await h.provider.models({ models: have }), have)
})

// the signed fetch the loader hands OpenCode / magpie
async function loaded(auth, options, provider) {
  const h = await ClinePlugin({ client: {} }, options)
  return h.auth.loader(async () => auth, provider)
}
const signedIn = () => ({ type: "oauth", access: "a", refresh: "r", expires: inMin(30) })

test("loader: no sign-in loads nothing; a sign-in loads Cline's base URL", async () => {
  assert.deepEqual(await loaded(undefined), {})
  assert.deepEqual(await loaded({ type: "wellknown" }), {})
  const l = await loaded(signedIn())
  assert.equal(l.baseURL, API)
  assert.equal(typeof l.fetch, "function")
})

test("loader fetch: only chat completions, and only chat objects", async () => {
  const l = await loaded(signedIn())
  const calls = fake(() => json({}))
  const notChat = await l.fetch(`${API}/models`, { method: "POST", body: "{}" })
  assert.equal(notChat.status, 404)
  const bad = await l.fetch(`${API}/chat/completions`, { method: "POST", body: "[1]" })
  assert.equal(bad.status, 400)
  assert.equal(calls.length, 0)
})

test("loader fetch: shapes the request, signs it, unwraps the answer and marks the sign-in kept", async () => {
  const l = await loaded(signedIn(), { pinUpstream: "true" })
  const calls = fake(() => json({ data: { choices: [{ message: { content: "hi" } }] } }))
  const body = '{"model":"cline-pass/deepseek-v4-pro","messages":[]}'
  const res = await l.fetch(`${API}/chat/completions`, { method: "POST", body, headers: { "x-magpie-cline-session": "s1", "content-length": "5" } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await res.json(), { choices: [{ message: { content: "hi" } }] })
  const sent = calls[0]
  assert.equal(sent.url, `${API}/chat/completions`)
  assert.equal(sent.init.method, "POST")
  assert.equal(sent.init.headers.get("authorization"), "Bearer workos:a")
  assert.equal(sent.init.headers.get("x-task-id"), taskIdOf("s1"))
  assert.equal(sent.init.headers.get("x-magpie-cline-session"), null)
  assert.deepEqual(JSON.parse(sent.init.body).providerOptions, { gateway: { only: ["deepseek"] } })
})

test("loader fetch: pinUpstream can come from the provider's own options, and is off by default", async () => {
  const body = '{"model":"cline-pass/deepseek-v4-pro"}'
  for (const [opts, prov, pinnedExpected] of [[{}, undefined, false], [undefined, { options: { pinUpstream: true } }, true]]) {
    const l = await loaded(signedIn(), opts, prov)
    const calls = fake(() => json({}))
    await l.fetch(`${API}/chat/completions`, { method: "POST", body })
    assert.equal("providerOptions" in JSON.parse(calls[0].init.body), pinnedExpected)
  }
})

test("loader fetch: Cline's refusals come back in OpenAI's shape, the sign-in unmarked unless renewed", async () => {
  const l = await loaded(signedIn())
  fake(() => json({ error: { message: "nope", code: "insufficient_credits", current_balance: 0 } }, 402))
  const res = await l.fetch(`${API}/chat/completions`, { method: "POST", body: '{"model":"a/b"}' })
  assert.equal(res.status, 429)
  assert.equal((await res.json()).error.type, "cline_error")
  assert.equal(res.headers.get("x-magpie-sign-in"), null)
  globalThis.fetch = async () => {
    throw new Error("offline")
  }
  const net = await l.fetch(`${API}/chat/completions`, { method: "POST", body: '{"model":"a/b"}' })
  assert.equal(net.status, 502)
})

test("loader fetch: a token near its end is renewed first, and the answer says so", async () => {
  const old = { type: "oauth", access: "a", refresh: "r0", expires: inMin(1) }
  const h = await ClinePlugin({ client: {} })
  const l = await h.auth.loader(async () => old)
  const calls = fake((url) => (url.endsWith("/auth/refresh") ? refreshed("n1", "r1") : json({ choices: [] })))
  const res = await l.fetch(`${API}/chat/completions`, { method: "POST", body: '{"model":"a/b"}' })
  assert.equal(res.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(calls[1].init.headers.get("authorization"), "Bearer workos:n1")
  // a sign-in the refresh can't save: 401 marked expired
  fake(() => json({ error: "invalid_grant" }, 400))
  const l2 = await (await ClinePlugin({ client: {} })).auth.loader(async () => ({ type: "oauth", access: "", refresh: "dead", expires: 1 }))
  const gone = await l2.fetch(`${API}/chat/completions`, { method: "POST", body: '{"model":"a/b"}' })
  assert.equal(gone.status, 401)
  assert.equal(gone.headers.get("x-magpie-sign-in"), "expired")
})

test("loader fetch: an API key goes as a plain Bearer", async () => {
  const l = await loaded({ type: "api", key: "sk-cline" })
  const calls = fake(() => json({}))
  await l.fetch(`${API}/chat/completions`, { method: "POST", body: '{"model":"a/b"}' })
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer sk-cline")
})
