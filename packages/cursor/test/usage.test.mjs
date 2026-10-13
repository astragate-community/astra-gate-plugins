import test from "node:test"
import assert from "node:assert/strict"
import { onDemandOf, poolBase, allowance, botUsage } from "../src/usage.mjs"
import { planOf } from "../src/api.mjs"
import { fakeFetch, jwt } from "./fake.mjs"

test("poolBase strips cursor-, the context size and the effort and speed the CLI adds", () => {
  assert.equal(poolBase("cursor-Composer-2-fast"), "composer-2")
  assert.equal(poolBase("grok-4.7@256k"), "grok-4.7")
  assert.equal(poolBase("claude-opus-5-5-high-thinking"), "claude-opus-5-5")
})

test("on-demand: a limit of the user's, none, and the team's pool", () => {
  assert.deepEqual(onDemandOf({ spendLimitUsage: { individualUsed: 250, individualLimit: 1000 } }, undefined), { kind: "fixed", usedDollars: 2.5, limitDollars: 10 })
  assert.deepEqual(onDemandOf({}, { noUsageBasedAllowed: true }), { kind: "disabled", usedDollars: 0 })
  assert.deepEqual(onDemandOf({}, { hardLimit: 2147483647 }), { kind: "unlimited", usedDollars: 0 })
  assert.deepEqual(onDemandOf({}, undefined), { kind: "unavailable", usedDollars: 0 })
  const team = { spendLimitUsage: { limitType: "team", individualUsed: 500, pooledLimit: "45120000", pooledUsed: 1000 } }
  assert.deepEqual(onDemandOf(team, { hardLimit: 10 }), { kind: "fixed", usedDollars: 10, limitDollars: 451200, mineDollars: 5 })
})

const period = { planUsage: { autoPercentUsed: 10, apiPercentUsed: 20, totalPercentUsed: 30 }, billingCycleEnd: "1893456000000", autoBucketModels: ["claude-x"] }

test("allowance: two pools, on-demand spend and the total, each with the reset", async () => {
  const f = fakeFetch((c) => (c.url.endsWith("GetHardLimit") ? { body: { hardLimit: 50 } } : { body: period }))
  try {
    const { windows } = await allowance("tok", ["claude-x@1m"])
    assert.deepEqual(windows.map((w) => w.name), ["Cursor Models", "Other Models", "On-demand", "Total"])
    assert.equal(windows[0].used, 10)
    assert.equal(windows[1].used, 20)
    assert.ok(windows[0].models.includes("auto") && windows[0].models.includes("claude-x@1m") && windows[0].models.includes("claude-x"))
    assert.equal(windows[0].aside, true)
    assert.equal(windows[2].display, "$0.00 / $50.00")
    assert.equal(windows[2].resetsAt, "2030-01-01T00:00:00.000Z")
    assert.equal(windows[2].aside, undefined)
    assert.equal(windows[3].aside, true)
    assert.equal(f.calls[0].headers.Authorization, "Bearer tok")
  } finally {
    f.restore()
  }
})

test("allowance: a refused call says its status, an enterprise plan has no windows", async () => {
  let reply = { status: 503 }
  const f = fakeFetch(() => reply)
  try {
    assert.deepEqual(await allowance("tok", []), { error: "Service Unavailable", windows: [] })
    reply = { body: {} }
    assert.deepEqual(await allowance("tok", []), { windows: [] })
  } finally {
    f.restore()
  }
})

test("botUsage: only a paid or trial account with a percentage, called as the dashboard's session", async () => {
  const tok = jwt({ sub: "auth0|user_1" })
  const f = fakeFetch(() => ({ body: { includedLimitZero: false, usagePercent: 140 } }))
  try {
    const w = await botUsage(tok)
    assert.deepEqual(w, [{ name: "Grok Bot", used: 100, aside: true }])
    assert.equal(f.calls[0].headers.Cookie, "WorkosCursorSessionToken=" + encodeURIComponent("user_1::" + tok))
  } finally {
    f.restore()
  }
  const g = fakeFetch(() => ({ body: { includedLimitZero: true, usagePercent: 5 } }))
  try {
    assert.deepEqual(await botUsage(tok), [])
  } finally {
    g.restore()
  }
  assert.deepEqual(await botUsage("garbage"), [])
})

test("planOf: the plan is asked once and remembered", async () => {
  const f = fakeFetch(() => ({ body: { planInfo: { planName: " Pro+ " } } }))
  try {
    assert.equal(await planOf("plan-tok"), "Pro+")
    assert.equal(await planOf("plan-tok"), "Pro+")
    assert.equal(f.calls.length, 1)
  } finally {
    f.restore()
  }
})
