import { describe, expect, it } from 'vitest'
import { beijing, compact, limitWindows, periodOf, spanOf, termOf, when, windowName } from '../src/windows.js'

it("spanOf counts a limit's window in seconds, a team's five hours with no count", () => {
  expect(spanOf(3, 5)).toBe(5 * 3600)
  expect(spanOf(3, 0)).toBe(5 * 3600)
  expect(spanOf(6, 1)).toBe(7 * 86400)
  expect(spanOf(5, 1)).toBe(30 * 86400)
  expect(spanOf(9, 1)).toBe(0)
})

it("windowName", () => {
  expect(windowName(0)).toBe("Credits")
  expect(windowName(5 * 3600)).toBe("5 hours")
  expect(windowName(7 * 86400)).toBe("Weekly")
  expect(windowName(30 * 86400)).toBe("Monthly")
  expect(windowName(3 * 86400)).toBe("3 days")
})

it("compact says a whole count whole and a fraction to two places", () => {
  expect(compact(12)).toBe("12")
  expect(compact(1.5)).toBe("1.5")
  expect(compact(1 / 3)).toBe("0.33")
})

it("limitWindows: used from the whole and what remains, else the percentage", () => {
  const w = limitWindows({
    limits: [
      { unit: 3, number: 5, usage: 200, remaining: 150, percentage: 25, nextResetTime: 1_800_000_000_000 },
      { unit: 6, number: 1, percentage: 40 },
      { unit: 5, number: 1, type: "TIME_LIMIT", usage: 100, currentValue: 10 },
      { unit: 6, number: 1, usage: 0, percentage: 100 },
    ],
  })
  expect(w[0]).toEqual({ name: "5 hours", used: 25, amount: 50, limit: 200, display: "50 / 200", resetsAt: new Date(1_800_000_000_000).toISOString(), span: 18000 })
  expect(w[1]).toEqual({ name: "Weekly", used: 40, span: 604800 })
  expect(w[2].name).toBe("MCP · Month")
  expect(w[2].aside).toBe(true)
  expect(w[2].used).toBe(10)
  expect(w[3].used).toBe(0)
  expect(w[3].aside).toBe(true)
})

it("beijing reads the plan's times as +08:00", () => {
  expect(beijing("2026-10-18 12:00:00")).toBe(Date.parse("2026-10-18T12:00:00+08:00"))
  expect(beijing("2026-10-18")).toBe(Date.parse("2026-10-18T00:00:00+08:00"))
  expect(beijing("soon")).toBe(0)
})

it("termOf: a renewal says auto or off, else the last date of the valid span", () => {
  expect(termOf([{ status: "valid", nextRenewTime: "2026-10-18 12:00:00", autoRenew: true }])).toEqual({ until: new Date("2026-10-18T04:00:00Z").toISOString(), renew: "auto" })
  expect(termOf([{ status: "VALID", valid: "2026-09-01 ~ 2026-10-01 00:00:00" }])).toEqual({ until: new Date("2026-09-30T16:00:00Z").toISOString(), renew: "off" })
  expect(termOf([{ status: "EXPIRED" }])).toEqual({})
  expect(termOf(null)).toEqual({})
})

it("when reads a Beijing time or a Unix time in seconds or ms", () => {
  expect(when("2026-10-18 12:00:00")).toBe(Date.parse("2026-10-18T12:00:00+08:00"))
  expect(when(1_800_000_000)).toBe(1_800_000_000_000)
  expect(when("1800000000000")).toBe(1_800_000_000_000)
  expect(when(null)).toBe(0)
})

it("periodOf", () => {
  expect(periodOf("Daily")).toBe(86400)
  expect(periodOf("weekly")).toBe(604800)
  expect(periodOf("monthly")).toBe(30 * 86400)
  expect(periodOf("never")).toBe(0)
})
