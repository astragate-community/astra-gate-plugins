import test from "node:test"
import assert from "node:assert/strict"
import { CORE, MODELS, configModels } from "../src/models.mjs"
import { dollars, limitWindows, readUsage, windowEnd } from "../src/usage.mjs"
import { FactoryStatus, explain, orgRefused, refused, vendorError } from "../src/errors.mjs"

test("windowEnd reads an ISO time or epoch milliseconds, nothing else", () => {
  assert.equal(windowEnd("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z")
  assert.equal(windowEnd("1767225600000"), "2026-01-01T00:00:00.000Z")
  assert.equal(windowEnd(1767225600000), "2026-01-01T00:00:00.000Z")
  assert.equal(windowEnd("2026-01-01"), undefined)
  assert.equal(windowEnd(0), undefined)
  assert.equal(windowEnd(null), undefined)
})

test("dollars rounds a half cent to even, as Go's %.2f does", () => {
  assert.equal(dollars(1250), "$12.50")
  assert.equal(dollars(12.5), "$0.12")
  assert.equal(dollars(13.5), "$0.14")
  assert.equal(dollars(0), "$0.00")
})

test("limitWindows: spans, clamped percents, Core's own windows and the extra usage balance", () => {
  const windows = limitWindows({
    extraUsageAllowed: true,
    extraUsageBalanceCents: 500,
    limits: {
      standard: { fiveHour: { usedPercent: 12.5, windowEnd: "2026-01-01T00:00:00Z" }, weekly: { usedPercent: 140 }, monthly: { usedPercent: -3 } },
      core: { weekly: { usedPercent: 3 } },
    },
  })
  assert.deepEqual(windows.map((w) => [w.name, w.used, w.span]), [
    ["5 hours", 12.5, 18000],
    ["7 days", 100, 604800],
    ["30 days", 0, 2592000],
    ["Droid Core · 7 days", 3, 604800],
    ["Extra usage", 0, undefined],
  ])
  assert.equal(windows[0].resetsAt, "2026-01-01T00:00:00.000Z")
  assert.deepEqual(windows[0].notModels, CORE)
  assert.deepEqual(windows[3].models, CORE)
  assert.ok(windows.every((w) => w.aside), "with extra usage to spend, no window stops the account")
  assert.equal(windows[4].display, "$5.00")
})

test("limitWindows: without a balance the windows are not aside and there is no extra card", () => {
  const windows = limitWindows({ extraUsageAllowed: true, extraUsageBalanceCents: 0, limits: { standard: { weekly: { usedPercent: 1 } } } })
  assert.equal(windows.length, 1)
  assert.equal(windows[0].aside, undefined)
})

test("Droid Core counts the models of the open vendors only", () => {
  assert.ok(CORE.includes("glm-5.3") && CORE.includes("kimi-k3"))
  assert.ok(!CORE.includes("claude-opus-5") && !CORE.includes("gpt-6-sol") && !CORE.includes("grok-4.7"))
})

test("configModels: variants follow the wire the model is on", () => {
  const models = configModels()
  assert.equal(Object.keys(models).length, MODELS.length)
  assert.deepEqual(models["claude-opus-5"].variants.high, { effort: "high" })
  assert.deepEqual(models["gpt-6-sol"].variants.none, { reasoningEffort: "none" })
  assert.equal(models["glm-5.3"].provider.api, "https://api.factory.ai/api/llm/o/v1")
  assert.deepEqual(models["glm-5.3"].modalities.input, ["text"])
})

test("vendorError finds the message wherever Factory put it, else cuts the body", () => {
  assert.equal(vendorError('{"error":{"message":"no"}}', "403 Forbidden"), "no")
  assert.equal(vendorError('{"detail":"d"}', "x"), "d")
  assert.equal(vendorError('{"errors":[{"message":"first"}]}', "x"), "first")
  assert.equal(vendorError("<html>", "502 Bad Gateway"), "502 Bad Gateway")
  assert.equal(vendorError("  plain   words ", "500"), "500: plain words")
  assert.ok(vendorError("x".repeat(400), "500").endsWith("…"))
})

test("refusals: a 4xx but a rate limit is final; only a 403 about the org is the org's", () => {
  assert.equal(refused(new FactoryStatus(400, "")), true)
  assert.equal(refused(new FactoryStatus(429, "")), false)
  assert.equal(refused(new FactoryStatus(500, "")), false)
  assert.equal(refused(new Error("x")), false)
  assert.equal(orgRefused(403, "Requested active organization is not accessible by this user"), true)
  assert.equal(orgRefused(401, "Requested active organization is not accessible by this user"), false)
  assert.match(explain(403, "active organization is not accessible"), /sign in to it again/)
  assert.match(explain(403, "other"), /Factory refused the request/)
  assert.equal(explain(401, "x"), "")
})

test("readUsage: a renewal is reported, a plan with no limits is an error, a lapse is expired", async () => {
  const windows = { limits: { standard: { weekly: { usedPercent: 1 } } } }
  const account = (fresh) => ({ fresh, mendOrg: async () => false })
  const c = { access: "a", region: "", activeOrganizationId: "o" }
  globalThis.fetch = async () => new Response(JSON.stringify(windows), { status: 200 })
  assert.deepEqual(await readUsage(account(async (onRenew) => (onRenew(), c))), { windows: [{ name: "7 days", used: 1, span: 604800, notModels: CORE }], signIn: "renewed" })
  globalThis.fetch = async () => new Response("{}", { status: 200 })
  assert.deepEqual(await readUsage(account(async () => c)), { error: "Factory: the account reported no limits", signIn: "kept" })
  const lapsed = Object.assign(new Error("expired"), { lapsed: true })
  assert.deepEqual(await readUsage(account(async () => { throw lapsed })), { error: "expired", signIn: "expired" })
})
