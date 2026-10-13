import test from "node:test"
import assert from "node:assert/strict"
import { MimoAuthPlugin } from "../src/index.mjs"
import { credits, creditWindow } from "../src/platform.mjs"
import { serverTime, planOf, weekOf } from "../src/usage.mjs"
import { vendorError, statusLine } from "../src/errors.mjs"
import { Jar, cookieHeader } from "../src/cookies.mjs"
import { fromAuth, toAuth } from "../src/store.mjs"
import { renamedModel, withAutoModel, planPath, said, bodyText } from "../src/request.mjs"
import { TP_MODELS, RENEW_AFTER } from "../src/constants.mjs"

const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})

// a fetch that answers from a function and remembers what it was asked
function fake(answer) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return answer(String(url), init, calls.length)
  }
  return calls
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

const creds = { userId: "42", passToken: "pt", cUserId: "c", deviceId: "d", region: "SGP", base: "https://mimo-server-sgp.xiaomimimo.com/api" }
const stored = (over = {}) => ({ ...toAuth(creds, { serviceToken: "st", userId: "42" }, Date.now()), ...over })

test("serverTime reads zoneless times as Beijing time", () => {
  assert.equal(serverTime("2026-10-01T00:00:00"), "2026-09-30T16:00:00.000Z")
  assert.equal(serverTime("2026-10-01 08:00:00"), "2026-10-01T00:00:00.000Z")
  assert.equal(serverTime("2026-10-01"), "2026-09-30T16:00:00.000Z")
  assert.equal(serverTime("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00.000Z")
  assert.equal(serverTime("soon"), undefined)
})

test("credits shortens a count", () => {
  assert.equal(credits(6_810_000), "6.81M")
  assert.equal(credits(4.1e9), "4.1B")
  assert.equal(credits(1500), "1.5K")
  assert.equal(credits(12), "12")
})

test("vendorError finds the vendor's message, else cuts the body", () => {
  assert.equal(vendorError('{"error":{"message":"no"}}', "403 Forbidden"), "no")
  assert.equal(vendorError('{"detail":"d"}', "x"), "d")
  assert.equal(vendorError('{"msg":"m"}', "x"), "m")
  assert.equal(vendorError("<html>", "502 Bad Gateway"), "502 Bad Gateway")
  assert.equal(vendorError("a  b\n c", "500"), "500: a b c")
  assert.equal(statusLine(502), "502 Bad Gateway")
})

test("the app's plan and the week's allowance become a card", () => {
  assert.deepEqual(planOf({ title: " ", planTier: 3, endTime: "2026-10-01", renewalMode: "MONTHLY" }), {
    plan: "Pro",
    until: "2026-09-30T16:00:00.000Z",
    renew: "auto",
  })
  assert.equal(planOf({ planCode: "X", renewalMode: "ONE_TIME" }).renew, "off")
  assert.deepEqual(weekOf({ percent: 80, resetDate: "2026-10-01" }), { name: "7 days", used: 20, span: 604800, resetsAt: "2026-09-30T16:00:00.000Z" })
  assert.equal(weekOf({ percent: 80 }), null)
  assert.equal(weekOf({ percent: 120, resetDate: "x" }).used, 0)
})

test("the Token Plan's credits are an aside beside an app plan", () => {
  const page = { monthUsage: { items: [{ name: "month_total_token", used: 2e6, limit: 8e6 }] } }
  assert.deepEqual(creditWindow(page, true), { name: "Token Plan · API key", used: 25, display: "2M / 8M credits", aside: true })
  assert.equal(creditWindow(page, false).aside, undefined)
  assert.equal(creditWindow({ usage: { items: [{ name: "plan_total_token", used: 1, limit: 0 }] } }, false), null)
})

test("the stored sign-in round-trips and defaults the server", () => {
  const a = fromAuth(stored())
  assert.equal(a.creds.userId, "42")
  assert.deepEqual(a.cookies, { serviceToken: "st", userId: "42" })
  assert.ok(Math.abs(a.expires - (Date.now() + RENEW_AFTER)) < 5000)
  const old = { type: "oauth", refresh: JSON.stringify({ userId: "1", passToken: "p", region: "IN" }), access: "not json", expires: 5 }
  const b = fromAuth(old)
  assert.equal(b.creds.base, "https://mimo-server-in.xiaomimimo.com/api")
  assert.deepEqual(b.cookies, {})
  assert.equal(fromAuth({ type: "api" }), null)
  assert.equal(fromAuth({ type: "oauth", refresh: "{}" }), null)
})

test("the jar keeps cookies for their domain and path, and drops expired ones", () => {
  const jar = new Jar()
  const res = new Response(null, { headers: [["set-cookie", "a=1; Domain=.xiaomi.com; Path=/; Secure"], ["set-cookie", "b=2"]] })
  jar.take(res, "https://account.xiaomi.com/pass/x")
  assert.equal(jar.header("https://account.xiaomi.com/pass/x"), "a=1; b=2")
  assert.equal(jar.header("https://api.xiaomi.com/"), "a=1")
  assert.equal(jar.header("http://api.xiaomi.com/"), "")
  jar.take(new Response(null, { headers: { "set-cookie": "a=; Max-Age=0; Domain=xiaomi.com; Path=/" } }), "https://account.xiaomi.com/")
  assert.equal(jar.header("https://api.xiaomi.com/"), "")
  assert.equal(cookieHeader({ x: "1", userId: "u", serviceToken: "s" }), "serviceToken=s; userId=u; x=1")
})

test("model names are rewritten only where they should be", () => {
  assert.equal(withAutoModel('{"model":"mimo-auto","a":1}'), '{"model":"mimo-pro","a":1}')
  assert.equal(withAutoModel('{"model":"mimo-flash"}'), '{"model":"mimo-flash"}')
  assert.equal(withAutoModel("not json mimo-auto"), "not json mimo-auto")
  assert.equal(renamedModel('{"model":"mimo-pro"}', TP_MODELS), '{"model":"mimo-v2.6-pro"}')
  assert.equal(renamedModel('{"model":"other"}', TP_MODELS), '{"model":"other"}')
  assert.equal(renamedModel(undefined, TP_MODELS), undefined)
  assert.equal(bodyText(new TextEncoder().encode("hi")), "hi")
  assert.equal(planPath("https://h/api/route/v1/chat/completions"), "/v1/chat/completions")
})

test("said marks the answer and drops the encoding of a body already read", async () => {
  const res = new Response("zz", { status: 403, headers: { "content-encoding": "gzip", "content-length": "9" } })
  const out = said(res, "renewed", "plain")
  assert.equal(out.status, 403)
  assert.equal(out.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(out.headers.get("content-encoding"), null)
  assert.equal(await out.text(), "plain")
})

test("the plugin configures its provider and loads a fetch for a signed-in account", async () => {
  const h = await MimoAuthPlugin({ client: {} })
  const config = { provider: { "mimo-app": { models: { custom: {} } } } }
  await h.config(config)
  assert.deepEqual(Object.keys(config.provider["mimo-app"].models), ["mimo-pro", "mimo-flash", "custom"])
  assert.equal(config.provider["mimo-app"].api, "https://mimo-server-sgp.xiaomimimo.com/api/route")
  assert.deepEqual(await h.auth.loader(async () => undefined), {})
  const l = await h.auth.loader(async () => stored())
  assert.equal(l.baseURL, "https://mimo-server-sgp.xiaomimimo.com/api/route")
})

test("a request carries the session's cookies and the app's identity, and mimo-auto becomes mimo-pro", async () => {
  const calls = fake(() => json({ ok: 1 }))
  const h = await MimoAuthPlugin({ client: {} })
  const l = await h.auth.loader(async () => stored())
  const res = await l.fetch("https://mimo-server-sgp.xiaomimimo.com/api/route/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer mimo", "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-auto" }),
  })
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(calls.length, 1)
  const sent = calls[0].init
  assert.equal(JSON.parse(sent.body).model, "mimo-pro")
  assert.equal(sent.headers.get("authorization"), null)
  assert.equal(sent.headers.get("cookie"), "serviceToken=st; userId=42")
  assert.equal(sent.headers.get("x-mimo-source"), "mimocode-cli-free")
})

test("an account the app refuses is asked at its Token Plan with the plan's key and names", async () => {
  // the platform answers a page with no session 401 and a serviceLogin URL; the account sends it back with a cookie
  let page = ""
  const data = (url) =>
    url.endsWith("/tokenPlan/detail")
      ? { planName: "Lite", expired: false }
      : url.endsWith("/tokenPlan/apiKey")
        ? { openaiBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1/" }
        : "tp-secret"
  const calls = fake((url, init) => {
    if (url.includes("/api/route/")) return json({ error: { code: "membership_required" } }, 403)
    if (url.startsWith("https://token-plan-sgp")) return json({ answered: true })
    if (url.startsWith("https://account.xiaomi.com/")) return new Response(null, { status: 302, headers: { location: "https://platform.xiaomimimo.com/sts" } })
    if (url === "https://platform.xiaomimimo.com/sts") return new Response(null, { status: 302, headers: { location: page, "set-cookie": "ps=1; Path=/" } })
    if (url.startsWith("https://platform.xiaomimimo.com/api/v1/tokenPlan")) {
      if (!init.headers.Cookie) {
        page = url
        return json({ loginUrl: "https://account.xiaomi.com/serviceLogin?sid=api-platform" }, 401)
      }
      return json({ code: 0, data: data(url) })
    }
    throw new Error("unexpected " + url)
  })
  const h = await MimoAuthPlugin({ client: {} })
  const l = await h.auth.loader(async () => stored())
  const res = await l.fetch("https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions", { method: "POST", body: '{"model":"mimo-pro"}' })
  assert.deepEqual(await res.json(), { answered: true })
  const last = calls.at(-1)
  assert.equal(last.url, "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions")
  assert.equal(last.init.headers.get("authorization"), "Bearer tp-secret")
  assert.equal(JSON.parse(last.init.body).model, "mimo-v2.6-pro")
  // the account is remembered as on the plan: no second try at the app
  const before = calls.length
  await l.fetch("https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions", { method: "POST", body: "{}" })
  assert.ok(!calls.slice(before).some((c) => c.url.includes("/api/route/")))
})

test("a stale session is signed on again before the request, and saved", async () => {
  const saved = []
  const calls = fake((url) => {
    if (url.endsWith("/user/xiaomi/me")) {
      return json({ code: 0, data: { userId: "42" } }, 200, { "set-cookie": "serviceToken=fresh; Path=/" })
    }
    return json({ ok: 1 })
  })
  const h = await MimoAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  const l = await h.auth.loader(async () => stored({ expires: Date.now() - 1 }))
  const res = await l.fetch("https://mimo-server-sgp.xiaomimimo.com/api/route/x", { method: "POST", body: "{}" })
  assert.equal(res.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(JSON.parse(saved[0].body.access).serviceToken, "fresh")
  assert.equal(calls.at(-1).init.headers.get("cookie"), "serviceToken=fresh")
})

test("a passToken Xiaomi no longer takes fails the request as expired", async () => {
  fake(() => new Response("<html>login</html>", { status: 200 }))
  const h = await MimoAuthPlugin({ client: {} })
  const l = await h.auth.loader(async () => stored({ expires: 0 }))
  const res = await l.fetch("https://mimo-server-sgp.xiaomimimo.com/api/route/x", { method: "POST", body: "{}" })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
  assert.match((await res.json()).error.message, /^42: the Xiaomi MiMo sign-in has expired/)
  await assert.rejects(h.auth.refresh(stored({ expires: 0 })), (e) => e.signIn === "expired")
})

test("refresh hands back a session signed on again a day ahead, once", async () => {
  let n = 0
  fake((url) => {
    if (url.endsWith("/user/xiaomi/me")) {
      n++
      return json({ code: 0, data: { userId: "42" } }, 200, { "set-cookie": "serviceToken=t" + n + "; Path=/" })
    }
    throw new Error("unexpected " + url)
  })
  const h = await MimoAuthPlugin({ client: {} })
  const auth = stored({ expires: Date.now() + 60_000 })
  const a = await h.auth.refresh(auth)
  assert.equal(JSON.parse(a.access).serviceToken, "t1")
  assert.ok(a.expires > Date.now() + RENEW_AFTER - 5000)
  // the store still holds the old one: the session signed on here is given again
  assert.equal((await h.auth.refresh(auth)).access, a.access)
  assert.equal(n, 1)
  assert.equal(await h.auth.refresh({ type: "api" }), undefined)
})

test("usage reads the plan and the week's allowance", async () => {
  fake((url) => {
    if (url.endsWith("/user/xiaomi/subscription/self")) return json({ code: 0, data: { current: { title: "Plus", endTime: "2026-10-01", renewalMode: "YEARLY" } } })
    if (url.endsWith("/user/usage")) return json({ code: 0, data: { percent: 60, resetDate: "2026-10-01" } })
    if (url.includes("platform.xiaomimimo.com")) return json({ code: 0, data: null })
    throw new Error("unexpected " + url)
  })
  const h = await MimoAuthPlugin({ client: {} })
  const out = await h.auth.usage(async () => stored())
  assert.equal(out.plan, "Plus")
  assert.equal(out.renew, "auto")
  assert.equal(out.signIn, "kept")
  assert.deepEqual(out.windows, [{ name: "7 days", used: 40, span: 604800, resetsAt: "2026-09-30T16:00:00.000Z" }])
})

test("usage says the sign-in is gone when the server turns the session away twice", async () => {
  fake((url) => (url.endsWith("/user/xiaomi/me") ? new Response("<html>", { status: 200 }) : new Response("", { status: 401 })))
  const h = await MimoAuthPlugin({ client: {} })
  const out = await h.auth.usage(async () => stored())
  assert.equal(out.signIn, "expired")
  assert.match(out.error, /sign in again/)
})
