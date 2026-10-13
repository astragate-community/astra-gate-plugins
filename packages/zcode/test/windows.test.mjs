import test from "node:test"
import assert from "node:assert/strict"
import { beijing, compact, limitWindows, periodOf, spanOf, termOf, when, windowName } from "../src/windows.mjs"

test("spanOf counts a limit's window in seconds, a team's five hours with no count", () => {
  assert.equal(spanOf(3, 5), 5 * 3600)
  assert.equal(spanOf(3, 0), 5 * 3600)
  assert.equal(spanOf(6, 1), 7 * 86400)
  assert.equal(spanOf(5, 1), 30 * 86400)
  assert.equal(spanOf(9, 1), 0)
})

test("windowName", () => {
  assert.equal(windowName(0), "Credits")
  assert.equal(windowName(5 * 3600), "5 hours")
  assert.equal(windowName(7 * 86400), "Weekly")
  assert.equal(windowName(30 * 86400), "Monthly")
  assert.equal(windowName(3 * 86400), "3 days")
})

test("compact says a whole count whole and a fraction to two places", () => {
  assert.equal(compact(12), "12")
  assert.equal(compact(1.5), "1.5")
  assert.equal(compact(1 / 3), "0.33")
})

test("limitWindows: used from the whole and what remains, else the percentage", () => {
  const w = limitWindows({
    limits: [
      { unit: 3, number: 5, usage: 200, remaining: 150, percentage: 25, nextResetTime: 1_800_000_000_000 },
      { unit: 6, number: 1, percentage: 40 },
      { unit: 5, number: 1, type: "TIME_LIMIT", usage: 100, currentValue: 10 },
      { unit: 6, number: 1, usage: 0, percentage: 100 },
    ],
  })
  assert.deepEqual(w[0], { name: "5 hours", used: 25, amount: 50, limit: 200, display: "50 / 200", resetsAt: new Date(1_800_000_000_000).toISOString(), span: 18000 })
  assert.deepEqual(w[1], { name: "Weekly", used: 40, span: 604800 })
  assert.equal(w[2].name, "MCP · Month")
  assert.equal(w[2].aside, true)
  assert.equal(w[2].used, 10)
  assert.equal(w[3].used, 0)
  assert.equal(w[3].aside, true)
})

test("beijing reads the plan's times as +08:00", () => {
  assert.equal(beijing("2026-10-18 12:00:00"), Date.parse("2026-10-18T12:00:00+08:00"))
  assert.equal(beijing("2026-10-18"), Date.parse("2026-10-18T00:00:00+08:00"))
  assert.equal(beijing("soon"), 0)
})

test("termOf: a renewal says auto or off, else the last date of the valid span", () => {
  assert.deepEqual(termOf([{ status: "valid", nextRenewTime: "2026-10-18 12:00:00", autoRenew: true }]), { until: new Date("2026-10-18T04:00:00Z").toISOString(), renew: "auto" })
  assert.deepEqual(termOf([{ status: "VALID", valid: "2026-09-01 ~ 2026-10-01 00:00:00" }]), { until: new Date("2026-09-30T16:00:00Z").toISOString(), renew: "off" })
  assert.deepEqual(termOf([{ status: "EXPIRED" }]), {})
  assert.deepEqual(termOf(null), {})
})

test("when reads a Beijing time or a Unix time in seconds or ms", () => {
  assert.equal(when("2026-10-18 12:00:00"), Date.parse("2026-10-18T12:00:00+08:00"))
  assert.equal(when(1_800_000_000), 1_800_000_000_000)
  assert.equal(when("1800000000000"), 1_800_000_000_000)
  assert.equal(when(null), 0)
})

test("periodOf", () => {
  assert.equal(periodOf("Daily"), 86400)
  assert.equal(periodOf("weekly"), 604800)
  assert.equal(periodOf("monthly"), 30 * 86400)
  assert.equal(periodOf("never"), 0)
})
