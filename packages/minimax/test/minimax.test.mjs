import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "../src/index.mjs"
import { SITES, chatBase } from "../src/constants.mjs"
import { md5, signed, checked, AccountRefused } from "../src/api.mjs"
import { MODELS, variants, configModels, modelOf, parseModels, liveModels } from "../src/models.mjs"
import { answer } from "../src/response.mjs"
import { membershipOf, planWindows, credits, usageOf, membership } from "../src/usage.mjs"
import { startDevice, pollDevice, signedInResult } from "../src/signin.mjs"
import { latest, renew, renewed, renewing, token, freshOf, SignInExpired } from "../src/session.mjs"

const site = SITES["minimax-code"]
const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
// a faked fetch answering from a queue (a function answers by url); records the calls
function fake(...replies) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = typeof replies[0] === "function" ? replies[0](String(url), init) : replies.shift()
    return r
  }
  return calls
}
const jwtOf = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s"

test("two plugins, one per site", async () => {
  for (const [P, id] of [[MiniMaxCodeAuthPlugin, "minimax-code"], [MiniMaxCodeGlobalAuthPlugin, "minimax-code-global"]]) {
    const h = await P({ client: {} })
    assert.equal(h.auth.provider, id)
    assert.equal(h.provider.id, id)
    assert.equal(h.auth.refreshLead, 600000)
    assert.equal(h.auth.methods[0].type, "oauth")
  }
})

test("config adds the provider and the built-in models, keeping the user's", async () => {
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const cfg = { provider: { "minimax-code": { models: { mine: { name: "mine" } } } } }
  await h.config(cfg)
  const p = cfg.provider["minimax-code"]
  assert.equal(p.name, "MiniMax Code")
  assert.equal(p.npm, "@ai-sdk/anthropic")
  assert.equal(p.api, "https://agent.minimax.cn/mavis/api/v1/llm/v1")
  assert.ok(p.models.mine && p.models["MiniMax-M3"])
})

test("chat.headers passes the session id for its own provider only", async () => {
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const out = { headers: {} }
  await h["chat.headers"]({ model: { providerID: "other" }, sessionID: "s1" }, out)
  assert.deepEqual(out.headers, {})
  await h["chat.headers"]({ model: { providerID: "minimax-code" }, sessionID: "s1" }, out)
  assert.equal(out.headers["X-Mavis-Session-Id"], "s1")
})

test("the chat base of each site", () => {
  assert.equal(chatBase(SITES["minimax-code-global"]), "https://agent.minimax.io/mavis/api/v1/llm/v1")
})

// ---- signed account requests ------------------------------------------------------

test("a GET is signed over '{}' and the time", () => {
  const now = 1700000000123
  const { url, init } = signed(site, "/v1/api/user/info", { access: "AT", now, tz: 28800, platform: "linux" })
  const u = new URL(url)
  assert.equal(u.origin, "https://agent.minimaxi.com")
  assert.equal(u.searchParams.get("user_id"), "0")
  assert.equal(u.searchParams.get("timezone_offset"), "28800")
  assert.equal(u.searchParams.get("lang"), "zh")
  assert.equal(init.method, "GET")
  assert.equal(init.body, undefined)
  const ts = Math.floor(now / 1000)
  assert.equal(init.headers["x-timestamp"], String(ts))
  assert.equal(init.headers["x-signature"], md5(ts + "I*7Cf%WZ#S&%1RlZJ&C2"))
  assert.equal(init.headers.yy, md5(`${encodeURIComponent(u.pathname + u.search)}_{}${md5(String(now))}ooui`))
  assert.equal(init.headers.Authorization, "Bearer AT")
})

test("a POST signs its body too and carries the user id", () => {
  const now = 1700000000000
  const { url, init } = signed(SITES["minimax-code-global"], "/x", { access: "AT", userID: " 42 ", body: { a: 1 }, now, tz: 0 })
  const u = new URL(url)
  assert.equal(u.searchParams.get("user_id"), "42")
  assert.equal(u.searchParams.get("lang"), "en")
  assert.equal(init.method, "POST")
  assert.equal(init.body, '{"a":1}')
  const ts = Math.floor(now / 1000)
  assert.equal(init.headers["x-signature"], md5(`${ts}I*7Cf%WZ#S&%1RlZJ&C2{"a":1}`))
  assert.equal(init.headers.yy, md5(`${encodeURIComponent(u.pathname + u.search)}_{"a":1}${md5(String(now))}ooui`))
})

test("md5 is md5", () => assert.equal(md5("a"), createHash("md5").update("a").digest("hex")))

test("checked reads the account API's failures", () => {
  assert.deepEqual(checked({ ok: 1 }, "x"), { ok: 1 })
  assert.throws(() => checked({ statusInfo: { code: 1000048 } }, "x"), AccountRefused)
  assert.throws(() => checked({ statusInfo: { code: 5, message: "bad" } }, "x"), /x: bad/)
  assert.throws(() => checked({ statusInfo: { code: 5 } }, "x"), /status 5/)
  assert.throws(() => checked({ base_resp: { status_code: 2, status_msg: "nope" } }, "x"), /x: nope/)
  assert.deepEqual(checked({ statusInfo: { code: 0 }, base_resp: { status_code: 0 } }, "x").statusInfo, { code: 0 })
})

// ---- models -----------------------------------------------------------------------

test("variants follow the thinking mode", () => {
  assert.deepEqual(variants({ thinking: "on", efforts: [] }), {})
  assert.deepEqual(variants({ thinking: "switchable", efforts: [] }), { none: { thinking: { type: "disabled" } }, high: { thinking: { type: "adaptive" } } })
  assert.deepEqual(Object.keys(variants({ thinking: "forced_on", efforts: ["low", "max"] })), ["low", "max"])
  assert.deepEqual(variants({ thinking: "forced_on", efforts: ["low"] }).low, { thinking: { type: "adaptive" }, effort: "low" })
})

test("the built-in models become config and provider models", () => {
  const cfg = configModels()
  assert.deepEqual(Object.keys(cfg), MODELS.map((m) => m.id))
  assert.deepEqual(cfg["MiniMax-M2.7"].modalities.input, ["text"])
  assert.equal(cfg["MiniMax-M3"].attachment, true)
  const m = modelOf(site, { id: "minimax-code" }, MODELS[1])
  assert.equal(m.api.url, "https://agent.minimax.cn/mavis/api/v1/llm/v1")
  assert.equal(m.capabilities.input.image, true)
  assert.equal(m.providerID, "minimax-code")
})

test("parseModels reads MiniMax Code's model config", () => {
  const body = {
    providers: [
      { providerId: "other", config: { models: { x: {} } } },
      {
        providerId: "minimax",
        config: {
          model_order: ["b", "ghost"],
          models: {
            a: { name: "A", limit: { context: "1000", output: 10 }, modalities: { input: ["text", "image"] }, thinking_config: { mode: "switchable" } },
            b: { thinking_config: { mode: "forced_on" }, thinking: { effortOptions: ["default", "none", "low", 3, "high"] }, attachment: true },
            c: { reasoning: false },
            " ": {},
          },
        },
      },
    ],
  }
  const ms = parseModels(body)
  assert.deepEqual(ms.map((m) => m.id), ["b", "a", "c"])
  assert.deepEqual(ms[0], { id: "b", name: "b", context: 0, output: 0, images: true, thinking: "forced_on", efforts: ["low", "high"] })
  assert.equal(ms[1].context, 1000)
  assert.equal(ms[1].thinking, "switchable")
  assert.equal(ms[2].thinking, "off")
  assert.deepEqual(parseModels({}), [])
  assert.deepEqual(parseModels({ providers: [{ providerId: "minimax" }] }), [])
})

test("liveModels retries without the account when it is refused", async () => {
  const calls = fake(new Response("", { status: 401 }), json({ providers: [{ providerId: "minimax", config: { models: { m: {} } } }] }))
  const ms = await liveModels(site, "AT")
  assert.equal(ms[0].id, "m")
  assert.equal(calls[0].init.headers.Authorization, "Bearer AT")
  assert.equal(calls[1].init.headers.Authorization, undefined)
  assert.match(calls[0].url, /agent\.minimax\.cn\/mavis\/api\/v1\/models\?region=cn&buildEnv=prod/)
  fake(new Response("", { status: 500 }))
  await assert.rejects(liveModels(site, "AT"), /MiniMax Code's models: HTTP 500/)
})

test("provider.models falls back to the built-in list", async () => {
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const provider = { id: "minimax-code", models: { keep: 1 } }
  assert.equal(await h.provider.models(provider, { auth: undefined }), provider.models)
  fake(new Response("", { status: 500 }))
  const auth = { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 3600e3 }
  assert.equal(await h.provider.models(provider, { auth }), provider.models)
  fake(json({ providers: [{ providerId: "minimax", config: { models: { m: { name: "M" } } } }] }))
  const live = await h.provider.models(provider, { auth })
  assert.deepEqual(Object.keys(live), ["m"])
  assert.equal(live.m.name, "M")
})

// ---- replies ----------------------------------------------------------------------

test("answer notes the sign-in and passes a good body through", async () => {
  const r = await answer(new Response("hi", { status: 200 }), false)
  assert.equal(r.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(await r.text(), "hi")
  assert.equal((await answer(new Response("hi"), true)).headers.get("x-magpie-sign-in"), "renewed")
  assert.equal((await answer(new Response("bad", { status: 400 }), true)).headers.get("x-magpie-sign-in"), "kept")
})

test("answer turns an out-of-credits refusal into a 429", async () => {
  const r = await answer(new Response(JSON.stringify({ error: { message: "balance not enough" } }), { status: 402, headers: { "content-length": "3" } }), false)
  assert.equal(r.status, 429)
  assert.equal(r.headers.get("content-length"), null)
  assert.deepEqual(await r.json(), { type: "error", error: { type: "rate_limit_error", message: "usage limit reached: balance not enough" } })
  const zh = await answer(new Response("余额不足", { status: 403 }), false)
  assert.equal(zh.status, 429)
  assert.match((await zh.json()).error.message, /余额不足/)
  const other = await answer(new Response("forbidden", { status: 403 }), false)
  assert.equal(other.status, 403)
  assert.equal(await other.text(), "forbidden")
  assert.equal((await answer(new Response("quota", { status: 429 }), false)).status, 429)
})

// ---- the usage card ---------------------------------------------------------------

test("credits says a count", () => {
  assert.equal(credits("1234.50"), "1234.5 credits")
  assert.equal(credits("10"), "10 credits")
  assert.equal(credits(3.14159), "3.14 credits")
  assert.equal(credits("x"), "x")
})

test("membershipOf reads both shapes", () => {
  assert.deepEqual(membershipOf({ has_token_plan: true, token_plan_tier: " Plus ", token_plan_expires_at: "1800000000", op_group_id: "g", op_credit_summary: { total_remaining_amount: "5" } }), {
    hasTokenPlan: true, opGroupId: "g", tier: "Plus", expiresAt: 1800000000, balance: "5",
  })
  assert.deepEqual(membershipOf({ data: { has_token_plan: false, opcredit_balance: 7 } }), { hasTokenPlan: false, balance: "7" })
  assert.deepEqual(membershipOf(undefined), {})
})

test("usageOf names the plan", () => {
  assert.deepEqual(usageOf({}), { plan: "Free", windows: [] })
  assert.equal(usageOf({ hasTokenPlan: true }).plan, "M Plan")
  const u = usageOf({ hasTokenPlan: true, tier: "Pro", expiresAt: 1800000000, balance: "2.50" }, [1])
  assert.deepEqual(u, { plan: "M Plan Pro", until: "2027-01-15T08:00:00.000Z", balance: "2.5 credits", windows: [1] })
  assert.equal(usageOf({ hasTokenPlan: true, expiresAt: 1800000000000 }).until, "2027-01-15T08:00:00.000Z")
  assert.equal(usageOf({ hasTokenPlan: false, expiresAt: 1800000000 }).until, undefined)
})

test("planWindows reads the plan's intervals and weeks", () => {
  const H = 3600_000
  const ws = planWindows({
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: "general", current_interval_remaining_percent: 40, current_interval_status: 1, start_time: 1700000000000, end_time: 1700000000000 + 5 * H, current_weekly_remaining_percent: 90, current_weekly_status: 1, weekly_end_time: 1700000000 },
      { model_name: "video", current_interval_status: 2, start_time: 1700000000, end_time: 1700000000 + 1800, current_weekly_status: 3 },
      { model_name: "dead", current_interval_status: 3, current_weekly_status: 3, current_interval_total_count: 0, current_weekly_total_count: "0" },
      { model_name: " " },
    ],
  })
  assert.equal(ws.length, 3)
  assert.deepEqual(ws[0], { used: 60, span: 5 * 3600, resetsAt: new Date(1700000000000 + 5 * H).toISOString(), name: "5 hours" })
  assert.equal(ws[1].name, "7 days")
  assert.equal(ws[1].used, 10)
  assert.equal(ws[1].span, 7 * 86400)
  assert.equal(ws[2].name, "Video · 30 minutes")
  assert.equal(ws[2].used, 100)
  assert.equal(ws[2].aside, true)
})

test("planWindows refuses a reply without a plan", () => {
  assert.throws(() => planWindows({}), /no plan in the reply/)
  assert.throws(() => planWindows({ base_resp: { status_code: 9, status_msg: "bad" } }), /bad/)
  assert.throws(() => planWindows({ base_resp: { status_code: 9 } }), /MiniMax said 9/)
  assert.deepEqual(planWindows({ base_resp: { status_code: 0 } }), [])
})

test("membership joins the workspace and the membership answers", async () => {
  const env = (extra) => json({ statusInfo: { code: 0 }, ...extra })
  fake(
    env({ workspaces: [{ workspace_type: 1, workspace_id: 9 }, { workspace_type: 0, workspace_id: 7, op_group_id: "g7" }] }),
    env({ has_token_plan: true, token_plan_tier: "Max", opcredit_balance: "12" }),
  )
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (u, i) => (calls.push(JSON.parse(i.body ?? "null")), orig(u, i))
  assert.deepEqual(await membership(site, "AT", "u"), { opGroupId: "g7", hasTokenPlan: true, tier: "Max", balance: "12" })
  assert.deepEqual(calls[1], { workspace_id: 7 })
})

test("membership falls back to the membership answer alone, and passes a refusal on", async () => {
  fake(new Response("", { status: 500 }), json({ has_token_plan: false }))
  assert.deepEqual(await membership(site, "AT", "u"), { hasTokenPlan: false })
  fake(new Response("", { status: 401 }))
  await assert.rejects(membership(site, "AT", "u"), AccountRefused)
  fake(json({ workspaces: [] }))
  assert.deepEqual(await membership(site, "AT", "u"), {})
})

// ---- sign-in ----------------------------------------------------------------------

test("token reads an answer, keeping the old refresh token when none is sent", () => {
  const access = jwtOf({ sub: "s", account_id: "acc" })
  const t = token({ access_token: access, expires_in: 60 }, "OLD")
  assert.equal(t.refresh, "OLD")
  assert.equal(t.subject, "s")
  assert.equal(t.accountID, "acc")
  assert.ok(t.expires > Date.now() + 59000)
  assert.equal(token({ access_token: "x", refresh_token: "NEW", expires_in: 1 }, "OLD").refresh, "NEW")
  assert.throws(() => token({ access_token: "x" }), /invalid_token_response/)
})

test("startDevice reads the standard device answer", async () => {
  const calls = fake(json({ device_code: "D", user_code: "U", verification_uri: "https://v", verification_uri_complete: "https://v?c=U", expires_in: 100, interval: 2 }))
  const d = await startDevice(site)
  assert.equal(calls[0].url, "https://account.minimax.cn/oauth2/device/code")
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get("client_id"), "mcode-public")
  assert.equal(form.get("code_challenge"), createHash("sha256").update(d.verifier).digest("base64url"))
  assert.equal(form.get("code_challenge_method"), "S256")
  assert.deepEqual(d.poll, { device_code: "D" })
  assert.equal(d.url, "https://v?c=U")
  assert.equal(d.intervalMs, 2000)
  assert.ok(d.deadline > Date.now() + 99000)
})

test("startDevice reads MiniMax's own variant (user code polled, interval in ms)", async () => {
  fake(json({ user_code: "U", verification_url: "https://v", expired_in: Date.now() + 60000, interval: 1500 }))
  const d = await startDevice(site)
  assert.deepEqual(d.poll, { user_code: "U" })
  assert.equal(d.intervalMs, 1500)
  assert.equal(d.url, "https://v")
  assert.ok(d.deadline > Date.now() + 50000 && d.deadline < Date.now() + 61000)
})

test("startDevice refuses an incomplete or failed answer", async () => {
  fake(json({ user_code: "U", verification_uri: "https://v" }))
  await assert.rejects(startDevice(site), /invalid_device_authorization_response/)
  fake(json({ error: "invalid_client" }, 400))
  await assert.rejects(startDevice(site), /invalid_client \(HTTP 400\)/)
  fake(new Response("<html>", { status: 502 }))
  await assert.rejects(startDevice(site), /invalid_json_response \(HTTP 502\)/)
})

test("pollDevice waits through pending, then returns the token", async () => {
  const calls = fake(json({ status: "pending" }), json({ error: "authorization_pending" }, 400), json({ access_token: "A", refresh_token: "R", expires_in: 60 }))
  const t = await pollDevice(site, { intervalMs: 0, deadline: Date.now() + 5000, verifier: "V", poll: { device_code: "D" } })
  assert.equal(t.access, "A")
  assert.equal(calls.length, 3)
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
  assert.equal(form.get("device_code"), "D")
  assert.equal(form.get("code_verifier"), "V")
})

test("pollDevice ends on a refusal, a denial or the deadline", async () => {
  const d = { intervalMs: 0, deadline: Date.now() + 5000, verifier: "V", poll: { device_code: "D" } }
  fake(json({ status: "denied" }))
  await assert.rejects(pollDevice(site, d), /turned down/)
  fake(json({ status: "expired_token" }))
  await assert.rejects(pollDevice(site, d), /expired/)
  fake(json({ error: "access_denied" }, 400))
  await assert.rejects(pollDevice(site, d), /access_denied/)
  await assert.rejects(pollDevice(site, { ...d, deadline: Date.now() - 1 }), /expired/)
})

test("signedInResult names the account", () => {
  const t = { access: "A", refresh: "R", expires: 5, accountID: "acc", subject: "sub" }
  assert.deepEqual(signedInResult(site, t, { realUserID: "9", email: "e@x", name: "N" }), {
    type: "success", access: "A", refresh: "R", expires: 5, accountId: "e@x", uid: "9", realUserID: "9", email: "e@x", name: "N",
  })
  assert.deepEqual(signedInResult(site, t, {}), { type: "success", access: "A", refresh: "R", expires: 5, accountId: "acc", uid: "acc" })
  assert.equal(signedInResult(site, { access: "A", refresh: "", expires: 5 }, {}).accountId, "MiniMax Code")
})

// ---- refreshing -------------------------------------------------------------------

const tokenAnswer = (access, refresh) => json({ access_token: access, refresh_token: refresh, expires_in: 3600 })
const stored = (o = {}) => ({ type: "oauth", access: "A0", refresh: "R0", expires: Date.now() + 3600e3, ...o })
function reset() {
  renewed.clear()
  renewing.clear()
}

test("a token far from its end is used as is", async () => {
  reset()
  const calls = fake()
  const fresh = freshOf(site, async () => true)
  const r = await fresh(async () => stored())
  assert.equal(r.a.access, "A0")
  assert.equal(r.renewed, false)
  assert.equal(calls.length, 0)
})

test("a token near its end is refreshed once and saved", async () => {
  reset()
  const calls = fake(tokenAnswer("A1", "R1"))
  const saved = []
  const fresh = freshOf(site, async (a) => (saved.push(a), true))
  const auth = stored({ refresh: "R-near", expires: Date.now() + 60e3 })
  const [x, y] = await Promise.all([fresh(async () => auth), fresh(async () => auth)])
  assert.equal(calls.length, 1)
  assert.equal(x.a.access, "A1")
  assert.equal(y.a.access, "A1")
  assert.equal(x.renewed, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].refresh, "R1")
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get("grant_type"), "refresh_token")
  assert.equal(form.get("refresh_token"), "R-near")
  // a later request reading the old token joins the refresh rather than spending it again
  const z = await fresh(async () => auth)
  assert.equal(z.a.access, "A1")
  assert.equal(calls.length, 1)
})

test("latest follows renewals, and lets go a saved one after a minute", async () => {
  reset()
  fake(tokenAnswer("A1", "R1"))
  const a = stored({ refresh: "R-chain", expires: 0 })
  await renew(site, a, async () => true)
  assert.equal(latest(site, a).access, "A1")
  const done = renewed.get(site.id + "\nR-chain")
  done.at = Date.now() - 61000
  assert.equal(latest(site, a).access, "A0")
  done.saved = false
  assert.equal(latest(site, a).access, "A1")
})

test("a rejected token is refreshed unless a newer one is had", async () => {
  reset()
  const fresh = freshOf(site, async () => true)
  const r = await fresh(async () => stored({ access: "NEW" }), "OLD")
  assert.deepEqual([r.a.access, r.renewed], ["NEW", true])
  fake(tokenAnswer("A9", "R9"))
  const f = await fresh(async () => stored({ refresh: "R-rej" }), "A0")
  assert.deepEqual([f.a.access, f.renewed], ["A9", true])
})

test("invalid_grant (400) signs out, another failure keeps the token in hand", async () => {
  reset()
  const near = stored({ refresh: "R-bad", expires: Date.now() + 60e3 })
  fake(json({ error: "invalid_grant" }, 400))
  const fresh = freshOf(site, async () => true)
  await assert.rejects(fresh(async () => near), (e) => e instanceof SignInExpired && e.signIn === "expired")
  reset()
  fake(json({ error: "server_error" }, 500))
  const r = await fresh(async () => ({ ...near, refresh: "R-bad2" }))
  assert.equal(r.a.access, "A0")
  reset()
  fake(json({ error: "server_error" }, 500))
  await assert.rejects(fresh(async () => ({ ...near, refresh: "R-bad3", expires: Date.now() - 1 })), (e) => e.signIn === "kept" && /token refresh/.test(e.message))
})

test("a refresh token spent elsewhere is not a sign-out when the new one is stored", async () => {
  reset()
  fake(json({ error: "invalid_grant" }, 400))
  let reads = 0
  const getAuth = async () => (++reads === 1 ? stored({ refresh: "R-old", expires: Date.now() + 60e3 }) : stored({ access: "ELSEWHERE", refresh: "R-else" }))
  const r = await freshOf(site, async () => true)(getAuth)
  assert.equal(r.a.access, "ELSEWHERE")
})

test("an account with no refresh token expires with its access token", async () => {
  reset()
  const fresh = freshOf(site, async () => true)
  const ok = await fresh(async () => stored({ refresh: "", expires: Date.now() + 60e3 }))
  assert.equal(ok.a.access, "A0")
  await assert.rejects(fresh(async () => stored({ refresh: "", expires: Date.now() - 1 })), SignInExpired)
  await assert.rejects(fresh(async () => undefined), /isn't signed in/)
})

test("auth.refresh renews for magpie without saving, and refuses signed-out accounts", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  assert.equal(await h.auth.refresh({ type: "api" }), undefined)
  fake(tokenAnswer("A2", "R2"))
  const got = await h.auth.refresh(stored({ refresh: "R-magpie" }))
  assert.equal(got.access, "A2")
  fake(json({ error: "invalid_grant" }, 400))
  await assert.rejects(h.auth.refresh(stored({ refresh: "R-magpie2" })), SignInExpired)
})

// ---- the chat request -------------------------------------------------------------

test("the loader sends MiniMax Code's headers", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const opts = await h.auth.loader(async () => stored())
  assert.equal(opts.baseURL, "https://agent.minimax.cn/mavis/api/v1/llm/v1")
  assert.equal(opts.apiKey, "sk-xxx")
  const calls = fake(new Response("{}", { status: 200 }))
  const res = await opts.fetch("https://agent.minimax.cn/mavis/api/v1/llm/v1/messages", { method: "POST", body: "{}", headers: { "content-length": "2", "anthropic-version": "x" } })
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  const hd = calls[0].init.headers
  assert.equal(hd.get("authorization"), "Bearer A0")
  assert.equal(hd.get("x-api-key"), "sk-xxx")
  assert.equal(hd.get("user-agent"), "MiniMaxAgent")
  assert.equal(hd.get("x-mavis-agent-id"), "main")
  assert.match(hd.get("x-mavis-timezone-offset"), /^-?\d+$/)
  assert.ok(hd.get("x-mavis-session-id"))
  assert.equal(hd.get("anthropic-version"), "x")
  assert.equal(hd.get("content-length"), null)
  assert.equal(await h.auth.loader(async () => ({ type: "api" })).then((o) => Object.keys(o).length), 0)
})

test("the loader keeps a given session id and defaults anthropic-version", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const opts = await h.auth.loader(async () => stored())
  const calls = fake(new Response("{}"))
  await opts.fetch(new Request("https://x/messages", { method: "POST", body: "{}", headers: { "X-Mavis-Session-Id": "mine" } }), undefined)
  const hd = calls[0].init.headers
  assert.equal(hd.get("x-mavis-session-id"), "mine")
  assert.equal(hd.get("anthropic-version"), "2023-06-01")
  assert.equal(calls[0].init.body, "{}")
})

test("a 401 is sent again once with a refreshed token", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const opts = await h.auth.loader(async () => stored({ refresh: "R-401" }))
  const calls = fake(new Response("", { status: 401 }), tokenAnswer("A5", "R5"), new Response("ok", { status: 200 }))
  const res = await opts.fetch("https://x/messages", { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(calls.length, 3)
  assert.equal(calls[2].init.headers.get("authorization"), "Bearer A5")
})

// ---- the usage hook ---------------------------------------------------------------

test("usage reports a missing sign-in and an expired one", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  assert.deepEqual(await h.auth.usage(async () => undefined), { error: "not signed in" })
  const r = await h.auth.usage(async () => stored({ refresh: "", expires: Date.now() - 1 }))
  assert.equal(r.signIn, "expired")
})

test("usage builds the card from the account's plan and windows", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const ok = (b) => json({ statusInfo: { code: 0 }, ...b })
  fake((url) => {
    if (url.includes("/v1/api/user/info")) return ok({ data: { userInfo: { realUserID: "42", email: "me@x" } } })
    if (url.includes("get_user_extra_info")) return ok({ workspaces: [{ workspace_type: 0, workspace_id: 1 }] })
    if (url.includes("get_membership_info")) return ok({ has_token_plan: true, token_plan_tier: "Pro", op_group_id: "g", opcredit_balance: "8" })
    if (url.includes("coding_plan/remains")) return json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 75, current_interval_status: 1, start_time: 1700000000, end_time: 1700000000 + 18000 }] })
    return new Response("", { status: 404 })
  })
  const r = await h.auth.usage(async () => stored())
  assert.equal(r.plan, "M Plan Pro")
  assert.equal(r.balance, "8 credits")
  assert.equal(r.user, "me@x")
  assert.equal(r.signIn, "kept")
  assert.equal(r.windows[0].used, 25)
  assert.equal(r.error, undefined)
})

test("usage keeps the card when only the plan's windows fail", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  const ok = (b) => json({ statusInfo: { code: 0 }, ...b })
  fake((url) => {
    if (url.includes("get_user_extra_info")) return ok({ workspaces: [] })
    if (url.includes("coding_plan")) return new Response("", { status: 500 })
    return ok({})
  })
  const r = await h.auth.usage(async () => stored({ realUserID: "42", name: "N" }))
  assert.equal(r.plan, "Free")
  assert.equal(r.user, "N")
})

test("usage reports a failed account call and keeps the sign-in", async () => {
  reset()
  const h = await MiniMaxCodeAuthPlugin({ client: {} })
  fake(new Response("", { status: 500 }))
  const r = await h.auth.usage(async () => stored())
  assert.deepEqual(r, { error: "account: HTTP 500", signIn: "kept" })
})
