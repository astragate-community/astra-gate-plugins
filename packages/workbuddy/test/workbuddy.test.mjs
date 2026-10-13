import test from "node:test"
import assert from "node:assert/strict"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from "../src/index.mjs"
import { SITES } from "../src/sites.mjs"
import { meter, postMeter } from "../src/api.mjs"
import { checkinOf } from "../src/checkin.mjs"

// a fetch that answers from a queue and remembers what it was asked
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r = replies.shift()
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
  return calls
}
const account = { type: "oauth", access: "tok", uid: "u1", refresh: "r", expires: Date.now() + 3600e3 }

test("both builds are plugins with a check-in", async () => {
  for (const P of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    const h = await P({ client: {} })
    assert.equal(typeof h.auth.checkin, "function")
    assert.equal(typeof h.auth.usage, "function")
  }
})

test("check-in: a first press is claimed, with credit and streak", async () => {
  const calls = fake({ status: 200, body: { code: 0, data: { credit: 100, streak_days: "15" } } })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "claimed", credit: 100, streak: 15 })
  assert.equal(calls[0].url, "https://copilot.tencent.com/billing/meter/daily-checkin")
  assert.equal(calls[0].headers.Authorization, "Bearer tok")
  assert.equal(calls[0].headers["X-User-Id"], "u1")
})

test("check-in: code 10001 is done today, and the streak is asked for", async () => {
  const calls = fake({ status: 400, body: { code: 10001 } }, { status: 200, body: { code: 0, data: { streak_days: 15, today_credit: 100 } } })
  assert.deepEqual(await checkinOf(SITES["workbuddy-ai"], account), { outcome: "done", credit: 100, streak: 15 })
  assert.equal(calls[1].url, "https://www.workbuddy.ai/billing/meter/checkin-activity-status")
})

test("check-in: done stands when the streak can't be read", async () => {
  fake({ status: 400, body: { code: 10001 } }, { status: 500, body: {} })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "done", credit: 0, streak: 0 })
})

test("check-in: a captcha and a failure say what WorkBuddy said", async () => {
  fake({ status: 400, body: { code: 20001, msg: "请完成验证码" } })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "captcha", message: "请完成验证码" })
  fake({ status: 503, body: {} })
  assert.deepEqual(await checkinOf(SITES.workbuddy, account), { outcome: "failed", message: "Service Unavailable" })
})

test("an enterprise account sends its enterprise on the meter", async () => {
  const calls = fake({ status: 200, body: { code: 0, data: null } })
  await postMeter(SITES.workbuddy, { ...account, enterpriseId: "e1" }, "/billing/meter/x")
  assert.equal(calls[0].headers["X-Enterprise-Id"], "e1")
  assert.equal(calls[0].headers["X-Tenant-Id"], "e1")
})

test("meter throws WorkBuddy's message, else its code, else the status", async () => {
  fake({ status: 200, body: { code: 0, data: { a: 1 } } })
  assert.deepEqual(await meter(SITES.workbuddy, account, "/p"), { a: 1 })
  fake({ status: 400, body: { code: 10001, msg: "uid or enterpriseID is empty" } })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /uid or enterpriseID is empty/)
  fake({ status: 400, body: { code: 7 } })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /error 7/)
  fake({ status: 502, body: {} })
  await assert.rejects(meter(SITES.workbuddy, account, "/p"), /Bad Gateway/)
})
