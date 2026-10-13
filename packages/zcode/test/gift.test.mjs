import test from "node:test"
import assert from "node:assert/strict"
import { blocked, giftID, giftModel, giftServes, giftSpent, giftUsable, spentUp, startPlan } from "../src/gift.mjs"
import { plansOf, routes } from "../src/routing.mjs"
import { giftOf } from "../src/balance.mjs"
import { bestBuckets, savedCard, startUsage } from "../src/usage.mjs"
import { balance, fakeFetch, jwtExpiring, ok } from "./support.mjs"

test("giftID is the catalog spelling plus -trial, and giftModel finds the raw name again", () => {
  assert.equal(giftID("glm-5.3-flash"), "GLM-5.3-Flash-Trial")
  assert.equal(giftID("other"), "other-Trial")
  assert.equal(giftModel({ models: ["glm-5.3-flash"] }, "glm-5.3-flash-trial"), "glm-5.3-flash")
  assert.equal(giftModel(null, "x-trial"), undefined)
})

test("giftSpent: remaining says it, else used against total", () => {
  assert.equal(giftSpent({ remaining_units: 0 }), true)
  assert.equal(giftSpent({ remaining_units: "3" }), false)
  assert.equal(giftSpent({ total_units: 10, used_units: 10 }), true)
  assert.equal(giftSpent({}), false)
})

test("spentUp: every 429 and the gift's quota codes, in a 200 too", () => {
  assert.equal(spentUp("", 429), true)
  assert.equal(spentUp('{"code":1113}', 200), true)
  assert.equal(spentUp('{"error":{"code":"1005"}}', 400), true)
  assert.equal(spentUp('{"code":1000}', 200), false)
  assert.equal(spentUp("not json", 200), false)
})

test("startPlan keeps live buckets' models and the earliest end as ttl", async () => {
  const now = Math.floor(Date.now() / 1000)
  const b = balance({ models: ["glm-5.3-flash", "glm-5.2"] })
  b.plans[0].ends_at = now + 100
  b.balances.push({ plan_id: "p1", capabilities: ["glm-5-turbo"], remaining_units: 0, total_units: 5 })
  fakeFetch([["/billing/balance", ok(b)]])
  const g = await startPlan(jwtExpiring(3600), "dev")
  assert.deepEqual(g.models, ["glm-5.3-flash", "glm-5.2"])
  assert.deepEqual(g.allModels, ["glm-5.3-flash", "glm-5.2", "glm-5-turbo"])
  assert.equal(g.name, "Start Plan")
  assert.ok(g.ttl <= 100_000 && g.ttl > 90_000)
})

test("startPlan is null with no active plan, and refuses a missing or expired token", async () => {
  fakeFetch([["/billing/balance", ok({ plans: [{ plan_id: "p", status: "expired" }], balances: [] })]])
  assert.equal(await startPlan(jwtExpiring(3600), "d"), null)
  await assert.rejects(() => startPlan("", "d"), /not signed in to ZCode/)
  await assert.rejects(() => startPlan(jwtExpiring(-10), "d"), /expired/)
})

test("giftUsable: served, not expired, and not blocked for a minute", () => {
  const s = { key: "k", jwt: jwtExpiring(3600) }
  const gift = { models: ["glm-5.3-flash"] }
  assert.equal(giftServes(gift, "GLM-5.3-Flash"), true)
  assert.equal(giftUsable(s, gift, "GLM-5.3-Flash"), true)
  blocked.set(s.key + "\0" + s.jwt + "\0glm-5.3-flash", Date.now() + 60_000)
  assert.equal(giftUsable(s, gift, "GLM-5.3-Flash"), false)
  blocked.clear()
})

test("plansOf: no plan on the key sends everything to the gift; a plan keeps the coding route and the gift", async () => {
  routes.clear()
  const s = { key: "a.b", jwt: jwtExpiring(3600), base: "https://api.z.ai/api/anthropic", device: "d" }
  fakeFetch([["/subscription/list", ok([])], ["/billing/balance", ok(balance())]])
  assert.equal((await plansOf(s)).start, true)
  routes.clear()
  fakeFetch([["/subscription/list", ok([{ status: "VALID", productName: "Pro" }])], ["/billing/balance", ok(balance())]])
  const r = await plansOf(s)
  assert.equal(r.start, false)
  assert.deepEqual(r.gift.models, ["glm-5.3-flash"])
  // answered from the cache the second time
  const calls = fakeFetch([])
  await plansOf(s)
  assert.equal(calls.length, 0)
  routes.clear()
})

test("plansOf: no token or a team seat never reads a plan", async () => {
  const calls = fakeFetch([])
  assert.deepEqual(await plansOf({ key: "k", base: "x" }), { start: false, gift: null })
  assert.deepEqual(await plansOf({ key: "k", jwt: "j", org: "o", project: "p" }), { start: false, gift: null })
  assert.equal(calls.length, 0)
})

test("giftOf: a window per live bucket, a spent one full", async () => {
  const b = balance({ models: ["glm-5.3-flash"], remaining: 0, total: 100 })
  b.balances[0].show_name = "Flash"
  fakeFetch([["/billing/balance", ok(b)]])
  const g = await giftOf({ jwt: jwtExpiring(3600), device: "d" })
  assert.equal(g.plan, "Start Plan")
  assert.equal(g.windows.length, 1)
  assert.deepEqual(g.windows[0], { name: "Flash", used: 100, _plan: "Start Plan", _spent: true, amount: 100, limit: 100, display: "100 / 100", models: ["glm-5.3-flash"] })
})

test("bestBuckets prefers a live bucket, then the least used", () => {
  const best = bestBuckets([
    { models: ["m"], used: 10, _spent: false },
    { models: ["m"], used: 5, _spent: false },
    { models: ["n"], used: 100, _spent: true },
    { models: ["n"], used: 100, _spent: false },
  ])
  assert.equal(best.get("m"), 1)
  assert.equal(best.get("n"), 3)
})

test("startUsage names the trial entry of the bucket a model spends", async () => {
  fakeFetch([["/billing/balance", ok(balance())]])
  const card = await startUsage({ jwt: jwtExpiring(3600), device: "d" })
  assert.deepEqual(card.windows[0].models, ["glm-5.3-flash", "GLM-5.3-Flash-Trial"])
  fakeFetch([["/billing/balance", ok({ plans: [], balances: [] })]])
  assert.match((await startUsage({ jwt: jwtExpiring(3600), device: "d" })).error, /no GLM Coding Plan/)
})

test("savedCard keeps the saved plan, the MCP window last, and the sign-in", () => {
  const card = savedCard({ windows: [{ name: "MCP · Month" }, { name: "Weekly" }] }, "Pro")
  assert.equal(card.plan, "Pro")
  assert.deepEqual(card.windows.map((w) => w.name), ["Weekly", "MCP · Month"])
  assert.equal(card.signIn, "kept")
  assert.equal(savedCard({ plan: "Lite" }, "Pro").plan, "Lite")
})
