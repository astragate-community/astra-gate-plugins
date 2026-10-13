import test from "node:test"
import assert from "node:assert/strict"
import { call } from "../src/api.mjs"
import { jwtExpired, jwtExpiry, keyOf, stateOf } from "../src/session.mjs"
import { teamKeys } from "../src/keys.mjs"
import { entry, model, modelsOf, planID } from "../src/models.mjs"
import { authorizeUrl, pollToken } from "../src/signin.mjs"
import { bizRoot, rootOf } from "../src/sites.mjs"
import { first, num, startNum, who } from "../src/util.mjs"
import { fakeFetch, jwtExpiring, ok } from "./support.mjs"

test("call unwraps {code, msg, data} and words a refusal", async () => {
  fakeFetch([["/good", ok({ a: 1 })], ["/null", { body: { code: 0 } }], ["/bad", { status: 400, body: { code: 1001, msg: "nope" } }], ["/plain", { status: 503, body: "x" }], ["/odd", { status: 409, body: "x" }], ["/soft", { body: { code: 7, msg: "denied" } }]])
  assert.deepEqual(await call("GET", "https://x/good"), { a: 1 })
  assert.equal(await call("GET", "https://x/null"), null)
  await assert.rejects(() => call("GET", "https://x/bad"), (e) => e.status === 400 && e.message === "nope (400, code 1001)")
  await assert.rejects(() => call("GET", "https://x/plain"), /^Error: Service Unavailable$/)
  await assert.rejects(() => call("GET", "https://x/odd"), /^Error: 409/)
  await assert.rejects(() => call("GET", "https://x/soft"), /denied/)
})

test("call tells zcode.z.ai the device, and only zcode.z.ai", async () => {
  const calls = fakeFetch([["", ok(null)]])
  await call("GET", "https://zcode.z.ai/a", { device: "dev-9", auth: "Bearer t" })
  await call("GET", "https://api.z.ai/a")
  assert.equal(calls[0].headers.get("x-device-mid"), "dev-9")
  assert.equal(calls[0].headers.get("authorization"), "Bearer t")
  assert.equal(calls[1].headers.get("x-device-mid"), null)
})

test("a session token's expiry is its exp claim", () => {
  assert.equal(jwtExpired(jwtExpiring(3600)), false)
  assert.equal(jwtExpired(jwtExpiring(-5)), true)
  assert.equal(jwtExpiry("nonsense"), 0)
  assert.equal(jwtExpired("nonsense"), false)
})

test("stateOf reads an OAuth sign-in's state and an API key's site", () => {
  const s = stateOf({ type: "oauth", access: "k.s", refresh: JSON.stringify({ site: "bigmodel", plan: "Pro" }) })
  assert.equal(s.site, "bigmodel")
  assert.equal(s.base, "https://open.bigmodel.cn/api/anthropic")
  assert.equal(s.key, "k.s")
  assert.equal(s.plan, "Pro")
  assert.equal(stateOf({ type: "oauth", access: "tok", refresh: JSON.stringify({ jwt: "tok" }) }).key, "")
  const a = stateOf({ type: "api", key: " k.s ", metadata: { site: "other" } })
  assert.deepEqual([a.site, a.key, a.base], ["zai", "k.s", "https://api.z.ai/api/anthropic"])
  assert.equal(stateOf(undefined), null)
})

test("a team seat's key is made once, kept for the next read and written back", async () => {
  teamKeys.clear()
  const calls = fakeFetch([
    ["/api_keys/copy/", ok({ secretKey: "sec" })],
    ["/api_keys", (u, init) => (init.method === "POST" ? ok({ apiKey: "id1" }) : ok([]))],
  ])
  const written = []
  const client = { auth: { set: async (x) => written.push(x) } }
  const s = { site: "zai", base: "https://api.z.ai/api/anthropic", key: "", token: "Bearer t", org: "o", project: "p" }
  const auth = { type: "oauth", refresh: JSON.stringify(s), access: "" }
  assert.equal(await keyOf(s, auth, client, "zcode"), "id1.sec")
  assert.equal(written[0].path.id, "zcode")
  assert.equal(written[0].body.access, "id1.sec")
  assert.equal(JSON.parse(written[0].body.refresh).key, "id1.sec")
  const n = calls.length
  assert.equal(await keyOf(s, auth, client, "zcode"), "id1.sec")
  assert.equal(calls.length, n)
  assert.equal(await keyOf({ ...s, org: "", project: "", key: "own" }, auth, client), "own")
  teamKeys.clear()
})

test("modelsOf reads a plan's models, switched-off ones out, limits from the matching rules", () => {
  const cfg = {
    config: {
      providerConfigRules: { providerRules: [{ providerId: "account:zai-individual-coding-plan", builtinModelIds: ["GLM-5.2", "GLM-5.3"] }] },
      modelConfigRules: {
        builtinProviderModelRules: [{ providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3", config: { enabled: false } }],
        modelRules: [
          { modelMatch: "glm-5\\..*", config: { properties: { contextWindow: 1000, inputFormat: { supportsImage: true } }, optionSpecs: { maxOutputTokens: { max: 64 }, reasoningLevel: { values: ["disabled", "enabled", "max"] } } } },
        ],
      },
    },
  }
  assert.deepEqual(modelsOf(cfg, planID("https://api.z.ai/api/anthropic")), [{ id: "GLM-5.2", context: 1000, output: 64, image: true, efforts: ["none", "high", "max"] }])
  assert.deepEqual(modelsOf(null, "x"), [])
})

test("planID by base, and entry/model declare a model with its efforts", () => {
  assert.equal(planID("https://zcode.z.ai/api/v1/zcode-plan/anthropic"), "account:zai-start-plan")
  assert.equal(planID("https://open.bigmodel.cn/api/anthropic"), "account:bigmodel-individual-coding-plan")
  const e = entry({ id: "M", context: 5, output: 2, efforts: ["none", "low"] })
  assert.equal(e.reasoning, true)
  assert.deepEqual(e.variants, { none: { thinking: { type: "disabled" } }, low: { thinking: { type: "enabled", budgetTokens: 4096 } } })
  assert.deepEqual(e.limit, { context: 5, output: 2 })
  assert.equal(entry({ id: "N", efforts: [] }).reasoning, false)
  const m = model({ id: "M", efforts: ["max"], image: true }, "https://u/v1")
  assert.equal(m.api.url, "https://u/v1")
  assert.equal(m.capabilities.input.image, true)
})

test("sign-in helpers: the browser comes back through zcode.z.ai, the poll's token is per site", () => {
  const z = new URL(authorizeUrl("https://z.ai/auth?x=1", "zai"))
  assert.match(z.searchParams.get("redirect_uri"), /^https:\/\/zcode\.z\.ai\/app\/oauth\/login\?/)
  assert.ok(new URL(authorizeUrl("https://bigmodel.cn/auth", "bigmodel")).searchParams.has("redirect"))
  assert.equal(pollToken({ bigmodel: { accessToken: " t " } }, "bigmodel"), "t")
  assert.equal(pollToken({ zai: { access_token: "z" } }, "zai"), "z")
  assert.equal(pollToken({ zai: { access_token: "z" } }, "bigmodel"), "")
})

test("small readers", () => {
  assert.equal(first(null, "  ", " a "), "a")
  assert.equal(num("12x"), 12)
  assert.equal(startNum("12x"), undefined)
  assert.equal(startNum(" 7 "), 7)
  assert.equal(who({ email: "a@b.c" }), "a@b.c")
  assert.equal(who({ email: "13800@phone.local", name: "N" }), "13800")
  assert.equal(who({ name: "N" }), "N")
  assert.equal(who(null), "ZCode")
  assert.equal(rootOf("https://open.bigmodel.cn/api/anthropic"), "https://open.bigmodel.cn")
  assert.equal(bizRoot("https://open.bigmodel.cn/api/anthropic"), "https://bigmodel.cn")
  assert.equal(bizRoot("https://api.z.ai/api/anthropic"), "https://api.z.ai")
})
