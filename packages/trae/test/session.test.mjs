import test from "node:test"
import assert from "node:assert/strict"
import { createPublicKey, verify } from "node:crypto"
import { jwtExp, parseJSON, whenOf } from "../src/values.mjs"
import { SITES, accountOf, authHostOf, traeHost } from "../src/sites.mjs"
import { deviceInfo, newDevice, proofOf } from "../src/device.mjs"
import { boundExchange, exchange } from "../src/api.mjs"
import { Expired } from "../src/errors.mjs"
import { createSessions, fromAuth, renewal, toAuth } from "../src/session.mjs"
import { signedIn } from "../src/signin.mjs"
import { DEVICE_KEYS, NOW, auth, fake, json, jwt, restoreFetch } from "./fake.mjs"

const cn = SITES["trae-cn"]
const global = SITES["trae-global"]
test.afterEach(restoreFetch)

test("whenOf: seconds, milliseconds, ISO, nothing", () => {
  assert.equal(whenOf(1_700_000_000), 1_700_000_000_000)
  assert.equal(whenOf("1700000000"), 1_700_000_000_000)
  assert.equal(whenOf(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(whenOf("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"))
  for (const v of [undefined, null, "", "nope", 0, -3, NaN]) assert.equal(whenOf(v), 0)
})

test("jwtExp / parseJSON", () => {
  assert.equal(jwtExp(jwt(100)), Math.floor(NOW / 1000) * 1000 + 100_000)
  assert.equal(jwtExp("not.a.jwt"), 0)
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJSON('"text"'), {})
  assert.deepEqual(parseJSON(undefined), {})
  const o = { x: 1 }
  assert.equal(parseJSON(o), o)
})

test("traeHost: only a plain https host on Trae's domains", () => {
  assert.equal(traeHost(" https://api.trae.cn/ "), "https://api.trae.cn")
  assert.equal(traeHost("https://x.trae.ai/p/q/"), "https://x.trae.ai/p/q")
  assert.equal(traeHost("https://a.b.mchost.guru"), "https://a.b.mchost.guru")
  for (const bad of ["http://trae.cn", "https://trae.cn:8080", "https://u:p@trae.cn", "https://trae.cn/?x=1", "https://nottrae.cn", "https://evil.com", "", null, "junk"]) assert.equal(traeHost(bad), "", String(bad))
  assert.equal(authHostOf("https://tenant.trae.cn", cn), "https://tenant.trae.cn")
  assert.equal(authHostOf("https://x.trae.ai", cn), "") // another realm's
})

test("accountOf: kind-of-account fields only, never a secret", () => {
  assert.deepEqual(accountOf({ TenantID: 7, enterprise: true, loginType: "sso", userToken: "x", sessionTeam: "y", nested: { a: 1 }, name: "n", orgName: null }), { TenantID: 7, enterprise: true, loginType: "sso", orgName: null })
})

test("the model host an account is asked through, per realm", () => {
  assert.equal(cn.apiOf({}), "https://trae-api-cn.mchost.guru")
  assert.equal(cn.apiOf({ api: "https://tenant.trae.cn" }), "https://tenant.trae.cn")
  assert.equal(cn.apiOf({ api: "https://www.trae.cn" }), "https://trae-api-cn.mchost.guru") // the consumer site's own is no model host
  assert.equal(cn.apiOf({ api: "https://evil.example" }), "https://trae-api-cn.mchost.guru")
  assert.equal(global.apiOf({}), "https://coresg-normal.trae.ai")
  assert.equal(global.apiOf({ region: "us-east" }), "https://coreva-normal.trae.ai")
  assert.equal(global.apiOf({ api: "https://api-us-east.trae.ai" }), "https://coreva-normal.trae.ai")
  assert.equal(global.apiOf({ api: "https://tenant.trae.ai" }), "https://tenant.trae.ai")
  assert.equal(global.apiOf({ api: "https://www.trae.ai" }), "https://coresg-normal.trae.ai")
  assert.equal(cn.modelHost("https://trae-api-cn.mchost.guru"), true)
  assert.equal(cn.modelHost("https://api.trae.cn"), false)
  assert.equal(global.modelHost("https://api-us-east.trae.ai"), true)
})

test("ownPage: Trae CN's /trae/api/ pages on its auth host only", () => {
  assert.equal(cn.ownPage("https://api.trae.cn/trae/api/v2/ug/checkin_credits/status"), true)
  assert.equal(cn.ownPage("https://api.trae.cn/other"), false)
  assert.equal(cn.ownPage("https://elsewhere.cn/trae/api/x"), false)
  assert.equal(cn.ownPage("junk"), false)
  assert.equal(global.ownPage("https://growsg-normal.trae.ai/trae/api/x"), false)
})

test("the fallback lists start from the model defaults", () => {
  const m = cn.models["glm-5.2"]
  assert.equal(m.tool_call, true)
  assert.deepEqual(m.limit, { context: 200_000, output: 32_000 })
  assert.deepEqual(cn.models["glm-5"].limit, { context: 128_000, output: 0 })
  assert.equal(global.models["gemini-3-flash"].limit.context, 1_000_000)
})

test("newDevice / proofOf: 19 digits, a key whose signature verifies the proof", () => {
  const d = newDevice()
  assert.match(d.deviceId, /^[1-9][0-9]{18}$/)
  assert.match(d.machineId, /^[0-9a-f]{32}$/)
  const p = proofOf("/p", "client", "refresh", d.devicePrivateKey, 1700000000, "nonce")
  assert.equal(p.Timestamp, 1700000000)
  assert.equal(p.Nonce, "nonce")
  const text = ["POST", "/p", "client", "refresh", "1700000000", "nonce"].join("\n")
  assert.equal(verify("sha256", Buffer.from(text), createPublicKey(d.devicePublicKey), Buffer.from(p.Signature, "base64")), true)
  const info = deviceInfo(d, cn.deviceExchange.as[0], cn)
  assert.equal(info.PlatformCode, "SOLO_PC")
  assert.equal(info.DevicePublicKey, d.devicePublicKey)
})

test("toAuth / fromAuth: the sign-in as OpenCode keeps it, and back", () => {
  const s = { token: jwt(), refresh: "R", expires: 0, uid: "u", name: "n", deviceId: "d", machineId: "m", devicePublicKey: "pub", devicePrivateKey: "priv", api: "https://tenant.trae.cn", host: "https://tenant.trae.cn/", authHost: "https://evil.example", account: { tenant: 1 }, region: "" }
  const kept = toAuth(s, cn)
  assert.equal(kept.type, "oauth")
  assert.equal(kept.access, s.token)
  assert.equal(kept.expires, jwtExp(s.token)) // the JWT's own end when the pair gave none
  assert.equal(kept.accountId, "n")
  assert.equal(kept.clientId, cn.clientId)
  assert.equal(kept.api, "https://tenant.trae.cn")
  assert.equal(kept.host, "https://tenant.trae.cn")
  assert.equal("authHost" in kept, false) // not on the site's own domain
  assert.equal("region" in kept, false)
  assert.equal("api" in toAuth({ ...s, api: "https://evil.example" }, cn), false)
  const back = fromAuth(kept, cn)
  assert.equal(back.token, s.token)
  assert.equal(back.uid, "u")
  assert.equal(back.devicePrivateKey, "priv")
  assert.deepEqual(back.account, { tenant: 1 })
  assert.equal(fromAuth({ type: "api" }, cn), null)
  assert.equal(fromAuth({ type: "oauth" }, cn), null)
  assert.equal(fromAuth({ type: "oauth", access: "t", region: "US" }, global).region, "US")
  assert.equal(fromAuth({ type: "oauth", access: "t", region: "US" }, cn).region, "")
})

test("exchange: the pair and the account from Result; a spent token is Expired; anything else is an error", async () => {
  const calls = fake(() => json({ Result: { Token: jwt(60), RefreshToken: "R2", ClientID: "c", UserInfo: { ScreenName: "bob", UserID: 5, Host: "https://trae-api-cn.mchost.guru", AIRegion: "US", tenantId: 3 } } }))
  const x = await exchange("R1", "", cn)
  assert.equal(calls[0].url, "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken")
  assert.deepEqual(JSON.parse(calls[0].body), { ClientID: "ono9krqynydwx5", RefreshToken: "R1", ClientSecret: "-", UserID: "" })
  assert.equal(x.refresh, "R2")
  assert.equal(x.uid, "5")
  assert.equal(x.name, "bob")
  assert.equal(x.region, "") // Trae CN's account carries none
  assert.deepEqual(x.account, { tenantId: 3 })
  assert.equal(x.expires, jwtExp(x.token))
  assert.equal((await exchange("R1", "", global)).region, "US")
  fake(() => json({ code: 10101, message: "x" }, 200))
  await assert.rejects(exchange("R", "", cn), (e) => e instanceof Expired && /Trae CN's sign-in has expired/.test(e.message))
  fake(() => json({ message: "gateway" }, 502))
  await assert.rejects(exchange("R", "", cn), (e) => !(e instanceof Expired) && e.message === "Trae CN: renewing the sign-in: 502 Bad Gateway gateway")
  fake(() => {
    throw new Error("offline")
  })
  await assert.rejects(exchange("R", "", cn), /Trae CN: renewing the sign-in: offline/)
})

test("boundExchange: tries SOLO, then the IDE; the refresh token is kept; the proof names the client", async () => {
  const d = newDevice()
  const calls = fake((url, init, seen) => (seen.length === 1 ? json({ message: "no" }, 400) : json({ Result: { Token: jwt(60), TokenExpireAt: 1_900_000_000 } })))
  const x = await boundExchange({ token: "old", refresh: "R1", ...d }, cn)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, "https://api.trae.cn/trae/api/v3/oauth/ExchangeToken")
  assert.equal(calls[0].init.headers.Authorization, "Cloud-IDE-JWT old")
  const [first, second] = calls.map((c) => JSON.parse(c.body))
  assert.equal(first.ClientID, "en1oxy7wnw8j9n")
  assert.equal(first.DeviceInfo.PlatformCode, "SOLO_PC")
  assert.equal(second.ClientID, "ono9krqynydwx5")
  assert.equal(second.IDEVersion, "3.3.99")
  assert.equal(second.DeviceInfo.DeviceID, d.deviceId)
  assert.equal(x.refresh, "R1") // not spent
  assert.equal(x.expires, 1_900_000_000_000)
  fake(() => json({ ResponseMetadata: { Error: { Code: "c", Message: "bad" } } }, 500))
  await assert.rejects(boundExchange({ refresh: "R", ...d }, cn), /renewing the sign-in for its device: 500 Internal Server Error bad/)
})

test("boundExchange: an account with no key is given one", async () => {
  const calls = fake(() => json({ Result: { Token: jwt(60) } }))
  const x = await boundExchange({ refresh: "R" }, cn)
  assert.match(x.devicePrivateKey, /BEGIN PRIVATE KEY/)
  assert.equal(JSON.parse(calls[0].body).DeviceInfo.DevicePublicKey, x.devicePublicKey)
})

test("renewal: CN renews bound to the device and falls back to /cloudide/; Global only the latter", async () => {
  const a = fromAuth(auth({ devicePublicKey: "", devicePrivateKey: "" }), cn)
  const bound = fake(() => json({ Result: { Token: jwt(60), RefreshToken: "RB" } }))
  const x = await renewal(a, cn)
  assert.equal(bound.length, 1)
  assert.equal(x.refresh, "RB")
  assert.match(x.devicePrivateKey, /PRIVATE KEY/) // made for the account, kept with the sign-in
  const fallback = fake((url) => (url.includes("/trae/api/v3/oauth/") ? json({}, 500) : json({ Result: { Token: jwt(60), RefreshToken: "RC" } })))
  const y = await renewal(a, cn)
  assert.equal(fallback.length, 3) // both bound clients, then /cloudide/
  assert.equal(y.refresh, "RC")
  assert.ok(y.devicePrivateKey)
  const g = fake(() => json({ Result: { Token: jwt(60), RefreshToken: "RG" } }))
  const z = await renewal(fromAuth(auth(), global), global)
  assert.equal(g.length, 1)
  assert.equal(g[0].url, "https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken")
  assert.equal("devicePrivateKey" in z, false)
  // the token host the sign-in named takes the renewal
  const named = fake(() => json({ Result: { Token: jwt(60) } }))
  await renewal(fromAuth(auth({ authHost: "https://tenant.trae.ai" }), global), global)
  assert.equal(named[0].url, "https://tenant.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken")
})

test("sessions.fresh: a token with time left is used as is; one near its end is renewed and saved", async () => {
  const saved = []
  const sessions = createSessions(global, { auth: { set: async (x) => saved.push(x) } })
  const calls = fake(() => json({ Result: { Token: jwt(7200), RefreshToken: "R2" } }))
  const ok = await sessions.fresh(async () => auth())
  assert.equal(calls.length, 0)
  assert.equal(ok.renewed, undefined)
  const renewed = await sessions.fresh(async () => auth({ expires: NOW + 30_000 }))
  assert.equal(calls.length, 1)
  assert.equal(renewed.renewed, true)
  assert.equal(renewed.refresh, "R2")
  assert.equal(saved.length, 1)
  assert.equal(saved[0].path.id, "trae-global")
  assert.equal(saved[0].body.refresh, "R2")
  assert.equal(saved[0].body.access, renewed.token)
})

test("sessions.fresh: a sign-in the plugin has already renewed is not renewed again with a spent token", async () => {
  const sessions = createSessions(global, null)
  const calls = fake(() => json({ Result: { Token: jwt(7200), RefreshToken: "R2" } }))
  const stale = auth({ expires: NOW + 30_000 })
  const first = await sessions.fresh(async () => stale)
  const second = await sessions.fresh(async () => stale) // the stored sign-in still has R1
  assert.equal(calls.length, 1)
  assert.equal(second.token, first.token)
  assert.equal(second.renewed, false)
})

test("sessions.fresh: concurrent renewals share one request (Trae spends a refresh token once)", async () => {
  const sessions = createSessions(global, null)
  const calls = fake(async () => json({ Result: { Token: jwt(7200), RefreshToken: "R2" } }))
  const stale = auth({ expires: NOW + 30_000 })
  const [a, b] = await Promise.all([sessions.fresh(async () => stale), sessions.fresh(async () => stale)])
  assert.equal(calls.length, 1)
  assert.equal(a.token, b.token)
})

test("sessions.fresh: a hiccup uses the token in hand; a refused refresh token or no sign-in throws Expired", async () => {
  const sessions = createSessions(global, null)
  fake(() => json({ message: "down" }, 500))
  const a = await sessions.fresh(async () => auth({ expires: NOW + 30_000 }))
  assert.equal(a.refresh, "R1")
  fake(() => json({ message: "down" }, 500))
  await assert.rejects(createSessions(global, null).fresh(async () => auth({ expires: NOW - 1000 })), (e) => !(e instanceof Expired))
  fake(() => json({ message: "refresh token expired" }, 400))
  await assert.rejects(createSessions(global, null).fresh(async () => auth({ expires: NOW + 30_000 })), Expired)
  await assert.rejects(sessions.fresh(async () => ({ type: "api" })), /Trae Global: not signed in/)
  const { refusal } = await sessions.freshOrRefusal(async () => ({ type: "api" }), { name: "bob" })
  assert.equal(refusal.status, 401)
  assert.equal(refusal.headers.get("x-magpie-sign-in"), "expired")
})

test("sessions.refresh: magpie's auth.refresh answers with the fields that changed", async () => {
  const sessions = createSessions(cn, null)
  fake(() => json({ Result: { Token: jwt(7200), RefreshToken: "R2", TokenExpireAt: 1_900_000_000 } }))
  const out = await sessions.refresh(auth({ devicePrivateKey: "", devicePublicKey: "" }))
  assert.equal(out.refresh, "R2")
  assert.equal(out.expires, 1_900_000_000_000)
  assert.ok(out.devicePrivateKey) // a key made for the account goes with it
  const kept = await createSessions(cn, null).refresh(auth())
  assert.equal("devicePrivateKey" in kept, false)
  assert.equal(await sessions.refresh({ type: "oauth", access: "t", refresh: "" }), undefined)
  assert.equal(await sessions.refresh(null), undefined)
})

test("signedIn: userJwt and userInfo are the account; a refresh token alone is exchanged; none is an error", async () => {
  const device = { deviceId: "D", machineId: "M", ...DEVICE_KEYS }
  const q = new URLSearchParams({ userJwt: JSON.stringify({ Token: "T", RefreshToken: "R", TokenExpireAt: 1_900_000_000 }), userInfo: JSON.stringify({ ScreenName: "bob", UserID: 9, Host: "https://trae-api-cn.mchost.guru", tenant: "t" }) })
  fake(() => json({}, 500)) // the device-bound renewal is turned away: the page's token does as is
  const s = await signedIn(q, device, cn)
  assert.equal(s.token, "T")
  assert.equal(s.name, "bob")
  assert.equal(s.uid, "9")
  assert.equal(s.deviceId, "D")
  assert.equal(s.expires, 1_900_000_000_000)
  assert.deepEqual(s.account, { tenant: "t" })
  const bound = fake(() => json({ Result: { Token: "T2", RefreshToken: "R2", TokenExpireAt: 1_950_000_000 } }))
  const renewed = await signedIn(q, device, cn)
  assert.equal(bound.length, 1)
  assert.equal(renewed.token, "T2")
  assert.equal(renewed.refresh, "R2")
  const old = fake((url) => json(url.includes("/cloudide/") ? { Result: { Token: "TX", RefreshToken: "RX", UserInfo: { ScreenName: "x", UserID: 1 } } } : {}, url.includes("/cloudide/") ? 200 : 500))
  const viaRefresh = await signedIn(new URLSearchParams({ refreshToken: "R0" }), device, global)
  assert.equal(old.length, 1)
  assert.equal(viaRefresh.token, "TX")
  assert.equal(viaRefresh.uid, "1")
  await assert.rejects(signedIn(new URLSearchParams({ userJwt: "{}" }), device, cn), /trae\.cn sent back no token/)
  await assert.rejects(signedIn(new URLSearchParams({ userJwt: '{"Token":"T"}' }), device, cn), /trae\.cn sent back no refresh token/)
})
