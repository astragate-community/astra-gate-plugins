import test from "node:test"
import assert from "node:assert/strict"
import { planFetch, rebase } from "../src/fetch.mjs"
import { blocked } from "../src/gift.mjs"
import { routes } from "../src/routing.mjs"
import { balance, fakeFetch, jwtExpiring, ok } from "./support.mjs"

const ZAI = "https://api.z.ai/api/anthropic"
const asState = (s) => ({ type: "oauth", refresh: JSON.stringify({ site: "zai", base: ZAI, ...s }), access: s.key ?? "", accountId: "me" })
const send = (auth, body, init = {}) => planFetch(async () => auth)(ZAI + "/v1/messages", { method: "POST", body: JSON.stringify(body), ...init })

test("rebase moves a URL between plans' bases and leaves others alone", () => {
  assert.equal(rebase(ZAI + "/v1/messages", "https://open.bigmodel.cn/api/anthropic"), "https://open.bigmodel.cn/api/anthropic/v1/messages")
  assert.equal(rebase("https://x.test/y", "https://z"), "https://x.test/y")
})

test("a coding key goes as the key, the answer marked kept", async () => {
  const calls = fakeFetch([["/v1/messages", { body: { id: "m" } }]])
  const res = await send({ type: "api", key: "id.secret", metadata: { site: "zai" } }, { model: "GLM-5.2", messages: [] }, { headers: { authorization: "Bearer old" } })
  assert.equal(calls[0].url, ZAI + "/v1/messages")
  assert.equal(calls[0].headers.get("x-api-key"), "id.secret")
  assert.equal(calls[0].headers.get("authorization"), "Bearer id.secret")
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(JSON.parse(calls[0].init.body).model, "GLM-5.2")
})

test("a state with no key and no token says to sign in again", async () => {
  fakeFetch([])
  await assert.rejects(() => send({ type: "api", key: "", metadata: {} }, { messages: [] }), /sign in again/)
})

test("a Start Plan account sends the dressed body to zcode.z.ai with its token", async () => {
  routes.clear()
  const jwt = jwtExpiring(3600)
  const calls = fakeFetch([["/api/v1/zcode-plan/anthropic/v1/messages", { body: { ok: true } }]])
  await send(asState({ jwt, device: "dev", key: "" }), { model: "GLM-5.2", messages: [{ role: "user", content: "hi" }] }, { headers: { "x-magpie-work-dir": "%2Fw" } })
  assert.equal(calls[0].url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
  assert.equal(calls[0].headers.get("authorization"), "Bearer " + jwt)
  assert.equal(calls[0].headers.get("x-magpie-work-dir"), null)
  const b = JSON.parse(calls[0].init.body)
  assert.equal(b.system.length, 3)
  assert.match(b.system[2].text, /Primary working directory: \/w/)
  assert.equal(JSON.parse(b.metadata.user_id).device_id, "dev")
})

test("an expired Start Plan token says so before asking", async () => {
  routes.clear()
  const calls = fakeFetch([])
  await assert.rejects(() => send(asState({ jwt: jwtExpiring(-60), key: "" }), { messages: [] }), /expired/)
  assert.equal(calls.length, 0)
})

// a coding account that also holds a gift: the -Trial entry spends the gift
const dual = () => asState({ key: "a.b", jwt: jwtExpiring(3600), device: "dev" })
const dualRoutes = (gift) => [
  ["/subscription/list", ok([{ status: "VALID", productName: "Pro" }])],
  ["/billing/balance", ok(balance(gift))],
]

test("a -Trial model asks the gift under its raw name", async () => {
  routes.clear()
  blocked.clear()
  const calls = fakeFetch([...dualRoutes(), ["/zcode-plan/anthropic/v1/messages", { body: { ok: true } }]])
  await send(dual(), { model: "GLM-5.3-Flash-Trial", messages: [{ role: "user", content: "hi" }] })
  const asked = calls.find((c) => c.url.includes("/zcode-plan/anthropic/"))
  assert.equal(JSON.parse(asked.init.body).model, "glm-5.3-flash")
  assert.ok(asked.headers.get("authorization").startsWith("Bearer "))
  routes.clear()
})

test("a -Trial model the gift has none of is refused without asking", async () => {
  routes.clear()
  const calls = fakeFetch(dualRoutes({ models: ["glm-5.2"] }))
  const res = await send(dual(), { model: "GLM-5.3-Flash-Trial", messages: [] })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /no active limited quota/)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.ok(!calls.some((c) => c.url.includes("/zcode-plan/anthropic/")))
  routes.clear()
})

test("a spent gift's 200 body turns into a 429 and blocks the model for a minute", async () => {
  routes.clear()
  blocked.clear()
  fakeFetch([...dualRoutes(), ["/zcode-plan/anthropic/v1/messages", { body: { code: 1113, msg: "no package" } }]])
  const res = await send(dual(), { model: "GLM-5.3-Flash-Trial", messages: [{ role: "user", content: "hi" }] })
  assert.equal(res.status, 429)
  assert.equal(blocked.size, 1)
  const again = await send(dual(), { model: "GLM-5.3-Flash-Trial", messages: [] })
  assert.equal(again.status, 429)
  assert.match((await again.json()).error.message, /exhausted or temporarily unavailable/)
  blocked.clear()
  routes.clear()
})
